import { useEffect, useRef, useState } from "react";

/** One thin SSE tick — ids only; clients refetch (control room spec §2.c). */
export interface StreamTick {
  tournament_id?: string;
  match_id?: string | null;
  kind?: string;
}

/**
 * Shared `EventSource` subscription for the public tournament tick stream.
 *
 * - Parses `event: tick` frames and hands them to `onTick` (kept in a ref, so
 *   an inline callback never re-subscribes).
 * - Leans on the browser's native auto-reconnect; when the source closes for
 *   good it re-creates the connection with a capped backoff.
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
  cb.current = onTick;

  useEffect(() => {
    if (!url) return undefined;
    if (typeof EventSource === "undefined") {
      // No SSE in this environment — callers stay on their polling fallback.
      setConnected(false);
      return undefined;
    }

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 5_000;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      source = new EventSource(url);
      source.onopen = () => {
        backoffMs = 5_000;
        setConnected(true);
      };
      source.addEventListener("tick", (e) => {
        let tick: StreamTick = {};
        try {
          tick = JSON.parse((e as MessageEvent).data ?? "{}") as StreamTick;
        } catch {
          // A malformed frame is still a tick — refetch anyway.
        }
        cb.current(tick);
      });
      source.onerror = () => {
        setConnected(false);
        // While CONNECTING the browser retries by itself; only a CLOSED
        // stream needs a manual re-create (capped exponential backoff).
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      setConnected(false);
    };
  }, [url]);

  return { connected };
}
