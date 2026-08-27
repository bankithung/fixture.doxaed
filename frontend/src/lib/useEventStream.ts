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
 * Pass `debounceMs` to coalesce bursts (leading + trailing); see `emit` below.
 */
export function useEventStream(
  url: string | null,
  onTick: (tick: StreamTick) => void,
  debounceMs = 0,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onTick);
  useEffect(() => {
    cb.current = onTick;
  });

  // Coalesce a burst of ticks into one callback. A tick carries no data — it
  // only says "something changed" — and the handler answers it by refetching a
  // tournament-wide aggregate, so firing once per tick means six scorers
  // tapping points cost every open board six full refetches a second. The
  // FIRST tick of a burst still fires immediately (the board moves on the
  // tap); the rest collapse into one trailing call. `debounceMs = 0` keeps the
  // original fire-on-every-tick behaviour for callers that do their own.
  const burst = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: StreamTick | null;
  }>({ timer: null, pending: null });
  useEffect(
    () => () => {
      if (burst.current.timer) clearTimeout(burst.current.timer);
      burst.current = { timer: null, pending: null };
    },
    [],
  );
  // Read the window through a ref: `emit` is created once, so closing over the
  // prop directly would pin whatever it was on first render.
  const windowMs = useRef(debounceMs);
  useEffect(() => {
    windowMs.current = debounceMs;
  }, [debounceMs]);
  const emit = useRef((tick: StreamTick): void => {
    const wait = windowMs.current;
    if (wait <= 0) {
      cb.current(tick);
      return;
    }
    const b = burst.current;
    if (b.timer) {
      b.pending = tick; // inside the window — fold into the trailing call
      return;
    }
    cb.current(tick); // leading edge
    b.timer = setTimeout(function close() {
      const trailing = b.pending;
      b.pending = null;
      b.timer = null;
      if (trailing) cb.current(trailing);
    }, wait);
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
        emit.current(tick);
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
