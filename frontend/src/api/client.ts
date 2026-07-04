import { getCsrfToken } from "@/lib/csrf";
import { ApiError, type ApiErrorPayload } from "@/types/api";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

  let signal = callerSignal ?? null;
  if (timeoutMs > 0 && typeof AbortSignal.timeout === "function") {
    const timeout = AbortSignal.timeout(timeoutMs);
    signal =
      signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : timeout;
  }

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

  const res = await fetch(path, {
    ...rest,
    method,
    headers,
    body: serialisedBody,
    credentials: "include",
    ...(signal ? { signal } : {}),
  });

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
