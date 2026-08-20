// Hooks shared by the native set-sport console modules (SepakConsole,
// TTConsole). Not part of the chassis contract — modules only.

import { useEffect, useRef, useState } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { useToast } from "@/components/ui/toast";
import { isRateLimited, isRetryable } from "@/api/client";
import { enqueueWrite } from "@/lib/offlineQueue";
import { t } from "@/lib/t";

/** A non-scoring scoresheet write: rally reasons, aces, kills, blocks,
 * timeouts. These annotate the match; the score of record stays
 * `set_scores` (set progress moves it, these never do). */
export interface AnnotationPayload {
  event_type: string;
  side?: "home" | "away";
  player_id?: string;
  detail?: Record<string, unknown>;
  event_id: string;
}

/** Annotation writes with the chassis's offline contract (H2): a tap that
 * fails because the server was UNREACHABLE is parked in the replay queue
 * under its own event_id (invariant 3) and replayed when the network
 * returns; a rejection (4xx/5xx) surfaces through `onError`. */
export function useAnnotate(
  matchId: string,
  onError: (e: unknown) => void,
  refresh: () => void,
): UseMutationResult<unknown, Error, AnnotationPayload> {
  const toast = useToast();
  return useMutation({
    mutationFn: (p: AnnotationPayload) => liveApi.recordEvent(matchId, p),
    onSuccess: () => refresh(),
    onError: (e, vars) => {
      if (isRetryable(e)) {
        enqueueWrite({
          id: vars.event_id,
          path: `/api/matches/${matchId}/events/`,
          body: vars as unknown as Record<string, unknown>,
        });
        toast.push({
          kind: "info",
          title: isRateLimited(e)
            ? t("Busy right now. The tap is saved and will sync.")
            : t("No connection. The tap is saved on this phone and will sync."),
        });
        return;
      }
      onError(e);
    },
  });
}

/** Keyboard scoring for a scorer on a laptop: one key per side, no modifier,
 * ignored while a field or a dialog has focus so corrections never score by
 * accident. The pad buttons stay the primary (and only) touch interaction. */
export function usePointKeys(
  enabled: boolean,
  onPoint: (side: 0 | 1) => void,
  homeKey = "q",
  awayKey = "p",
): void {
  const cb = useRef(onPoint);
  useEffect(() => {
    cb.current = onPoint;
  }, [onPoint]);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable ||
        el?.closest("[role='dialog']") != null
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k !== homeKey && k !== awayKey) return;
      e.preventDefault();
      cb.current(k === homeKey ? 0 : 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, homeKey, awayKey]);
}

const firstServerKey = (matchId: string): string =>
  `fixture.first-server.${matchId}`;

/** Who serves first (0 home, 1 away). Umpire-set via the scoreboard toggle
 * and kept per match on this phone, so reopening the console mid-match
 * remembers the toss. */
export function useFirstServer(matchId: string): [0 | 1, () => void] {
  const [firstServer, setFirstServer] = useState<0 | 1>(() => {
    try {
      return localStorage.getItem(firstServerKey(matchId)) === "1" ? 1 : 0;
    } catch {
      return 0;
    }
  });
  const toggle = (): void => {
    setFirstServer((s) => {
      const next: 0 | 1 = s === 0 ? 1 : 0;
      try {
        localStorage.setItem(firstServerKey(matchId), String(next));
      } catch {
        // Storage blocked: the toggle still works for this session.
      }
      return next;
    });
  };
  return [firstServer, toggle];
}
