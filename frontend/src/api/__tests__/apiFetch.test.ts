import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, isNetworkError, isRateLimited, isRetryable } from "../client";
import { ApiError } from "@/types/api";

function setCsrf(token: string): void {
  document.cookie = `csrftoken=${token}`;
}
function clearCookies(): void {
  document.cookie.split(";").forEach((c) => {
    const eq = c.indexOf("=");
    const name = (eq > -1 ? c.slice(0, eq) : c).trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const throttled = (retryAfter?: string) =>
  new Response(JSON.stringify({ detail: "Request was throttled." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });

describe("429 handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies a 429 as rate-limited and retryable, but not a network error", () => {
    const e = new ApiError(429, { detail: "Request was throttled." });
    expect(isRateLimited(e)).toBe(true);
    expect(isRetryable(e)).toBe(true);
    expect(isNetworkError(e)).toBe(false);
  });

  it("retries a throttled GET and returns the eventual success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(throttled("1"))
      .mockResolvedValueOnce(okJson({ ok: true }));
    const p = apiFetch("/api/x/");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retries a throttled write that carries an event_id (replay is deduped)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(okJson({ ok: true }));
    const p = apiFetch("/api/matches/m1/score/", {
      method: "POST",
      body: { set_scores: [[11, 7]], event_id: "e-1" },
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does NOT retry a write with no idempotency key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(throttled());
    await expect(
      apiFetch("/api/x/", { method: "POST", body: { a: 1 } }),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of retries rather than hanging", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(throttled("1"));
    const p = apiFetch("/api/x/");
    const assertion = expect(p).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    clearCookies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT attach X-CSRFToken on GET", async () => {
    setCsrf("safe-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJson({ ok: true }));
    await apiFetch("/api/x/");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.has("X-CSRFToken")).toBe(false);
    expect(init.credentials).toBe("include");
  });

  it("attaches X-CSRFToken on POST when cookie present", async () => {
    setCsrf("post-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJson({ ok: true }));
    await apiFetch("/api/x/", { method: "POST", body: { a: 1 } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("X-CSRFToken")).toBe("post-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("attaches X-CSRFToken on PATCH/PUT/DELETE", async () => {
    setCsrf("mutate-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(okJson({ ok: true })));
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      await apiFetch("/api/x/", { method });
    }
    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(3);
    for (const [, init] of calls) {
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.get("X-CSRFToken")).toBe("mutate-token");
    }
  });

  it("omits X-CSRFToken when no cookie is present", async () => {
    clearCookies();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJson({ ok: true }));
    await apiFetch("/api/x/", { method: "POST", body: { a: 1 } });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.has("X-CSRFToken")).toBe(false);
  });

  it("respects skipCsrf option", async () => {
    setCsrf("ignored");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJson({ ok: true }));
    await apiFetch("/api/x/", {
      method: "POST",
      body: { a: 1 },
      skipCsrf: true,
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.has("X-CSRFToken")).toBe(false);
  });

  it("throws ApiError with payload on non-2xx", async () => {
    const makeResp = () =>
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(makeResp()),
    );
    await expect(apiFetch("/api/x/")).rejects.toBeInstanceOf(ApiError);
    try {
      await apiFetch("/api/x/");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(400);
      expect(err.payload.detail).toBe("nope");
    }
  });

  it("recognises password_reauth_required signal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: "password_reauth_required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    try {
      await apiFetch("/api/x/", { method: "POST" });
    } catch (e) {
      const err = e as ApiError;
      expect(err.isPasswordReauthRequired).toBe(true);
    }
  });
});

describe("apiFetch timeout (H2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts a hung request after timeoutMs so courtside writes fail fast", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              (init.signal as AbortSignal).reason ??
                new DOMException("timeout", "TimeoutError"),
            ),
          );
        }),
    );
    const err = await apiFetch("/api/x/", { method: "POST", timeoutMs: 20 }).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(isNetworkError(err)).toBe(true);
  });

  it("timeoutMs: 0 disables the abort signal entirely", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJson({ ok: true }));
    await apiFetch("/api/x/", { timeoutMs: 0 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal ?? null).toBeNull();
  });
});

describe("isNetworkError (H2)", () => {
  it("classifies offline/timeout as network, server responses as not", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isNetworkError(new DOMException("a", "AbortError"))).toBe(true);
    expect(isNetworkError(new ApiError(400, { detail: "nope" }))).toBe(false);
    expect(isNetworkError(new ApiError(500, {}))).toBe(false);
    expect(isNetworkError(new Error("misc"))).toBe(false);
  });
});
