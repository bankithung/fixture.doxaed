import { useEffect, useRef, useState } from "react";

/** One thin SSE tick — ids only; clients refetch (control room spec §2.c). */
export interface StreamTick {
  tournament_id?: string;
  match_id?: string | null;
  kind?: string;
}

/** Backoff ceiling. 30 s, not 60 s: after a deploy every viewer is dark until
 * it reconnects, and a broadcast overlay cannot wait a minute. */
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * Shared `EventSource` subscription for the public tournament tick stream.
 *
 * - Parses `event: tick` frames and hands them to `onTick` (kept in a ref, so
 *   an inline callback never re-subscribes).
 * - **Owns its reconnect; never relies on the browser's.** Per the WHATWG SSE
 *   spec a transport error is retried by the user agent, but a non-200 status
 *   or a wrong `Content-Type` is a HARD failure — "the user agent does not
 *   attempt to reconnect", `readyState` goes to CLOSED and stays there. A
 *   routine backend restart makes nginx answer 502 for a second, which is
 *   exactly that case: without our own retry every live viewer (and every
 *   broadcast overlay) would freeze on its last score, silently, for the rest
 *   of the tournament. So on ANY error we detach the handlers, close, and
 *   reconnect ourselves, forever.
 * - Backoff is exponential with **full jitter** (`random() * backoff`): six
 *   court overlays coming back in lockstep after a deploy is a self-inflicted
 *   thundering herd. Reset on a successful open.
 * - `connected` is the graceful-degradation flag: `false` until the stream is
 *   open (or whenever it errors / `EventSource` doesn't exist), so callers
 *   keep their polling fallback exactly while the stream cannot deliver.
 *
 * Pass `url: null` while the URL is unknown (e.g. the slug hasn't loaded).
 */
export function useEventStream(
  url: string | null,
  onTick: (tick: StreamTick) => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onTick);
  useEffect(() => {
    cb.current = onTick;
  });

  useEffect(() => {
    if (!url) return undefined;
    if (typeof EventSource === "undefined") {
      // No SSE in this environment — callers stay on their polling fallback,
      // and `connected` is already false.
      return undefined;
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = BASE_BACKOFF_MS;
    let disposed = false;

    /** Detach every handler before closing: a closed EventSource must not be
     * able to fire another error and schedule a second reconnect (that is how
     * you end up with N loops and N timers after a long outage). */
    const teardown = (): void => {
      if (!source) return;
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.close();
      source = null;
    };

    const schedule = (): void => {
      if (disposed || retry) return;
      // Full jitter: spread the herd across the whole window.
      const wait = Math.random() * backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, wait);
    };

    const connect = (): void => {
      if (disposed) return;
      teardown();
      const es = new EventSource(url);
      source = es;
      es.onopen = () => {
        backoffMs = BASE_BACKOFF_MS;
        setConnected(true);
      };
      es.addEventListener("tick", (e) => {
        let tick: StreamTick = {};
        try {
          tick = JSON.parse((e as MessageEvent).data ?? "{}") as StreamTick;
        } catch {
          // A malformed frame is still a tick — refetch anyway.
        }
        cb.current(tick);
      });
      es.onerror = () => {
        setConnected(false);
        // Do NOT distinguish CONNECTING from CLOSED and defer to the browser:
        // a 502 lands as CLOSED-forever, and even a retryable error is safer
        // re-driven by us with jitter than by the UA's fixed interval.
        teardown();
        schedule();
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      retry = null;
      teardown();
      setConnected(false);
    };
  }, [url]);

  return { connected };
}
