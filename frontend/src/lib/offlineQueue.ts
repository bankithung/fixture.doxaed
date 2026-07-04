/** Offline replay queue for idempotent match writes (H2).
 *
 * A courtside tap that fails because the SERVER WAS UNREACHABLE (offline,
 * DNS, timeout) is queued here and replayed when connectivity returns. Every
 * entry carries the write's `event_id`, so a replay of a
 * committed-but-timed-out request is deduped server-side (invariant 3) —
 * replay is always safe. Writes the server actually REJECTED (4xx/5xx) are
 * never queued or retried: the server saw them and decided.
 */
import { useSyncExternalStore } from "react";

import { api, isNetworkError } from "@/api/client";

export interface QueuedWrite {
  /** The write's idempotency key (event_id) — one logical tap, one entry. */
  id: string;
  path: string;
  body: Record<string, unknown>;
  queuedAt: number;
}

const KEY = "fixture.offline-writes.v1";
const RETRY_MS = 10_000;

type Listener = () => void;
const listeners = new Set<Listener>();
let flushing = false;
let armed = false;

function read(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as QueuedWrite[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: QueuedWrite[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage full/blocked: the in-flight toast already told the scorer.
  }
  for (const fn of listeners) fn();
}

export function pendingWrites(): number {
  return read().length;
}

export function subscribeOfflineQueue(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Pending-count as reactive state (for the console's sync pill). */
export function useOfflineQueue(): number {
  return useSyncExternalStore(subscribeOfflineQueue, pendingWrites, () => 0);
}

/** Arm the replay triggers (browser back online + a slow retry tick) and
 * attempt an immediate flush of anything left from a previous session. */
export function initOfflineQueue(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  window.addEventListener("online", () => {
    void flushWrites();
  });
  window.setInterval(() => {
    if (pendingWrites() > 0) void flushWrites();
  }, RETRY_MS);
  if (pendingWrites() > 0) void flushWrites();
}

export function enqueueWrite(w: Omit<QueuedWrite, "queuedAt">): void {
  const items = read();
  if (items.some((i) => i.id === w.id)) return;
  items.push({ ...w, queuedAt: Date.now() });
  write(items);
  initOfflineQueue();
}

/** Replay FIFO. Stops (keeping the tail) while the server stays unreachable;
 * drops entries the server rejected and returns them so the caller can
 * surface what did not count. */
export async function flushWrites(): Promise<QueuedWrite[]> {
  if (flushing) return [];
  flushing = true;
  const rejected: QueuedWrite[] = [];
  try {
    let items = read();
    while (items.length > 0) {
      const head = items[0];
      try {
        await api.post(head.path, head.body);
      } catch (e) {
        if (isNetworkError(e)) return rejected;
        rejected.push(head);
      }
      items = read().filter((i) => i.id !== head.id);
      write(items);
    }
    return rejected;
  } finally {
    flushing = false;
  }
}

/** Test hook: wipe the queue. */
export function clearWrites(): void {
  write([]);
}
