import { useSyncExternalStore } from "react";

/**
 * Follow v1 (P6): star teams with NO account — follows live in
 * localStorage, shared across every public page through a
 * useSyncExternalStore-backed store (the same pattern as useBreakpoint).
 * A followed team's matches pin to the top of the public schedule and its
 * star survives reloads on the same phone.
 */
const KEY = "fixture.followed-teams.v1";

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

let snapshot: string[] = typeof localStorage === "undefined" ? [] : read();

function write(ids: string[]): void {
  snapshot = ids;
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Private mode: follows just don't persist.
  }
  listeners.forEach((l) => l());
}

export function toggleFollow(teamId: string): void {
  const cur = snapshot;
  write(
    cur.includes(teamId)
      ? cur.filter((x) => x !== teamId)
      : [...cur, teamId],
  );
}

export function isFollowed(teamId: string): boolean {
  return snapshot.includes(teamId);
}

/** Reactive follow list; identity-stable between writes. */
export function useFollows(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      // Cross-tab sync: another tab starring updates this one too.
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          snapshot = read();
          cb();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
