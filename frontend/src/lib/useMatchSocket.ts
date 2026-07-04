import { useEffect, useRef, useState } from "react";

/** Reconnect backoff: quick first retries, capped for courtside dead zones. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * The scorer-room WebSocket (P3; invariant 11's two-way half). The backend
 * broadcasts every recorded event to `match_<id>` the moment it commits —
 * this hook finally gives that layer a client, so co-scorers and referees
 * see a tap in under a second instead of on the next 5s poll. Returns
 * connection state so the caller can relax its poll while the socket is up.
 * The message payload is ids-only; the caller refetches the snapshot (the
 * DB stays the system of record, invariant 4).
 */
export function useMatchSocket(
  matchId: string | null,
  onMessage: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onMessage);
  cb.current = onMessage;

  useEffect(() => {
    if (!matchId || typeof WebSocket === "undefined") return;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws/match/${matchId}/`);
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = () => cb.current();
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [matchId]);

  return { connected };
}
