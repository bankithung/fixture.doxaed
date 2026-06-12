import type { ControlRoomMatch, ScheduleChangeEntry } from "@/api/tournaments";

/** Statuses that count as in-play (live pulse + running score). */
export const IN_PLAY = new Set(["live", "half_time"]);

/** Statuses with a final result on the board. */
export const FINAL = new Set(["completed", "walkover"]);

/** "Called" is an annotation of `scheduled` (spec §2.b) — the UI ignores a
 * surviving `called_at` once the match has kicked off. */
export function isCalled(m: ControlRoomMatch): boolean {
  return m.status === "scheduled" && Boolean(m.called_at);
}

/** Kick-off in the TOURNAMENT's wall clock (invariant 14). */
export function fmtKickoff(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Compact day-chip label ("Sat, Jun 20") for an ISO tournament-TZ date. */
export function fmtDayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export interface SlotDelay {
  /** Positive minutes the slot moved by (its latest recorded change). */
  minutes: number;
  /** The new `scheduled_at` of that change — chips render only while the
   * match still sits on this slot. */
  at: string;
}

/**
 * Latest positive slot move per match, from the (reverse-chrono) schedule-
 * changes feed — drives the queue rail's "+25 min" delay chips (spec §1.1).
 */
export function delayMap(
  entries: ScheduleChangeEntry[],
): Map<string, SlotDelay> {
  const seen = new Set<string>();
  const out = new Map<string, SlotDelay>();
  for (const e of entries) {
    if (seen.has(e.match_id)) continue; // newest entry per match wins
    seen.add(e.match_id);
    const oldAt = e.old?.scheduled_at;
    const newAt = e.new?.scheduled_at;
    if (!oldAt || !newAt) continue; // lock/unlock rows carry no slots
    const minutes = Math.round(
      (new Date(newAt).getTime() - new Date(oldAt).getTime()) / 60_000,
    );
    if (minutes > 0) out.set(e.match_id, { minutes, at: newAt });
  }
  return out;
}

/** The delay chip for one match, or null (slot since moved again / no delay). */
export function delayFor(
  delays: Map<string, SlotDelay>,
  m: ControlRoomMatch,
): number | null {
  const d = delays.get(m.id);
  if (!d || !m.scheduled_at) return null;
  return new Date(d.at).getTime() === new Date(m.scheduled_at).getTime()
    ? d.minutes
    : null;
}
