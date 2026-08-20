import { getCsrfToken } from "@/lib/csrf";
import { ApiError, type ApiErrorPayload } from "@/types/api";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** How many times a throttled request is re-sent before the caller sees it. */
const THROTTLE_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Honour the server's `Retry-After` (seconds), capped so a courtside tap
 * never freezes the pad; falls back to a short escalating wait. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("Retry-After"));
  const advised = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
  return Math.min(Math.max(advised, 400 * (attempt + 1)), 3_000);
}

/** A write is replay-safe when it carries its own idempotency key. */
function carriesEventId(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { event_id?: unknown }).event_id === "string"
  );
}

async function parseApiError(res: Response): Promise<ApiError> {
  let payload: ApiErrorPayload = {};
  try {
    const text = await res.text();
    payload = text ? (JSON.parse(text) as ApiErrorPayload) : {};
  } catch {
    payload = { detail: res.statusText };
  }
  return new ApiError(res.status, payload);
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** Already JSON-serialised, OR a plain object that we'll serialise. */
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  /** Disables auto-attachment of the X-CSRFToken header (e.g. for login). */
  skipCsrf?: boolean;
  /** Abort the request after this many ms (0 disables). Courtside phones on
   * weak connections must fail fast so idempotent writes can queue and
   * replay instead of freezing the UI on a hung socket. */
  timeoutMs?: number;
}

/** True when the server refused to PROCESS the request because it arrived
 * too fast (429). Unlike every other 4xx this is not a verdict on the
 * request — it is "not now" — so an idempotent write may safely replay it. */
export function isRateLimited(e: unknown): boolean {
  return e instanceof ApiError && e.status === 429;
}

/** True when a write may be replayed as-is: the server either never saw it
 * (offline/timeout) or refused to look at it yet (429). Both classes are
 * safe to re-send because every mutation carries an `event_id` and the
 * server dedupes replays (invariant 3). */
export function isRetryable(e: unknown): boolean {
  return isNetworkError(e) || isRateLimited(e);
}

/** True when the failure never reached the server (offline, DNS, abort or
 * timeout) — the class of error an idempotent write may safely queue and
 * replay. Server responses (ApiError) are never "network" failures. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof ApiError) return false;
  // Match abort/timeout by NAME, not instanceof: the AbortSignal.timeout
  // reason can come from a different realm than the page's DOMException.
  if (e && typeof e === "object" && "name" in e) {
    const name = (e as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
  }
  return e instanceof TypeError;
}

/**
 * Thin fetch wrapper that:
 *   - sends `credentials: "include"` (Django session cookie),
 *   - attaches `X-CSRFToken` on unsafe verbs (B.10),
 *   - serialises plain-object bodies as JSON,
 *   - throws `ApiError` on non-2xx so TanStack Query treats it as failure.
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const {
    body,
    skipCsrf,
    headers: callerHeaders,
    timeoutMs = 20_000,
    signal: callerSignal,
    ...rest
  } = opts;
  const method = (rest.method ?? "GET").toUpperCase();

  const headers = new Headers(callerHeaders);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let serialisedBody: BodyInit | null | undefined;
  if (body == null) {
    serialisedBody = body as null | undefined;
  } else if (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams
  ) {
    serialisedBody = body;
  } else {
    serialisedBody = JSON.stringify(body);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  if (!skipCsrf && UNSAFE_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRFToken", csrf);
  }

  // A throttled request (429) is not a verdict — the server never looked at
  // it. Reads are always safe to re-send, and a write is safe exactly when
  // it carries an `event_id` (invariant 3 dedupes the replay), which every
  // courtside write does. Retrying here is what keeps a shared login or a
  // venue full of spectators behind one NAT from seeing a hard error the
  // moment two people work at once.
  const replayable = SAFE_METHODS.has(method) || carriesEventId(body);
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    let signal = callerSignal ?? null;
    if (timeoutMs > 0 && typeof AbortSignal.timeout === "function") {
      const timeout = AbortSignal.timeout(timeoutMs);
      signal =
        signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, timeout])
          : timeout;
    }
    res = await fetch(path, {
      ...rest,
      method,
      headers,
      body: serialisedBody,
      credentials: "include",
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 429 || !replayable || attempt >= THROTTLE_RETRIES) break;
    await sleep(retryAfterMs(res, attempt));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    throw await parseApiError(res);
  }

  // Some endpoints (e.g. logout) return text/empty.
  const ctype = res.headers.get("Content-Type") ?? "";
  if (!ctype.includes("application/json")) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...opts, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: "POST",
      body: body as ApiFetchOptions["body"],
    }),
  put: <T = unknown>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: "PUT",
      body: body as ApiFetchOptions["body"],
    }),
  patch: <T = unknown>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
    apiFetch<T>(path, {
      ...opts,
      method: "PATCH",
      body: body as ApiFetchOptions["body"],
    }),
  delete: <T = unknown>(path: string, opts?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...opts, method: "DELETE" }),
};
