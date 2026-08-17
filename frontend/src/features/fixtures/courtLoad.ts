import { t } from "@/lib/t";
import {
  blackoutLabel,
  fmtDayLabel,
  idleWindows,
  toMinutes,
  UNASSIGNED_VENUE,
  WEEKDAY_KEYS,
  type BlackoutWindow,
  type PreviewRow,
} from "./previewGrid";

/**
 * The court-time model behind the preview's Courts tab (owner 2026-08-17:
 * "show each court and see when the courts are free", plus "per game or
 * category how many minutes or hours are used").
 *
 * It answers two different questions off the SAME previewed matches, so the
 * numbers can never disagree with the sheet:
 *
 *  1. Per court per day: when is it playing, when is it standing empty, and
 *     which part of the empty time is a break you set versus court you have
 *     not used. That distinction is the whole point — the sheet deliberately
 *     stays quiet about unexplained gaps (a rule keeping two competitions
 *     apart, a round waiting on its feeders), so this is the one surface that
 *     names them.
 *  2. Per competition (and per sport): how much court time it consumes.
 *
 * Everything is wall-clock minutes since midnight in the tournament's own
 * timezone (invariant 14) — never Date math, so nothing drifts.
 */

/** One match as it sits on a court's day. */
export interface CourtBlock {
  ref: string;
  start: number;
  end: number;
  leafKey: string;
  sportKey: string;
  sportLabel: string;
  categoryLabel: string;
  competition: string;
  home: string;
  away: string;
}

/** A stretch of a court's day with no match on it. */
export interface CourtGap {
  key: string;
  start: number;
  end: number;
  minutes: number;
  /** "free" = court available and unused; "break" = a window you configured. */
  kind: "free" | "break";
  /** "Daily break", "Opening ceremony", or "Court free" for an unused stretch. */
  label: string;
}

export interface CourtDayLoad {
  key: string;
  day: string;
  dayLabel: string;
  court: string;
  /** The day's bounds on this court, widened to hold any match outside them. */
  windowStart: number;
  windowEnd: number;
  matches: number;
  busyMinutes: number;
  /** Empty court that no configured window explains — the usable headroom. */
  freeMinutes: number;
  /** Empty court a break or ceremony accounts for. */
  breakMinutes: number;
  /** busy / (window minus breaks): how much of the usable day is played. */
  utilization: number;
  /** The longest single free stretch, which is what an organiser can fill. */
  longestFree: CourtGap | null;
  firstStart: number | null;
  lastEnd: number | null;
  blocks: CourtBlock[];
  gaps: CourtGap[];
}

export interface CompetitionLoad {
  key: string;
  leafKey: string;
  sportKey: string;
  sportLabel: string;
  categoryLabel: string;
  competition: string;
  matches: number;
  /** Matches that actually got a time (the rest carry no court minutes). */
  scheduled: number;
  minutes: number;
  avgMinutes: number;
  /** Distinct days and courts this competition touches. */
  days: number;
  courts: number;
  /** Fraction of ALL scheduled court minutes in the preview. */
  share: number;
}

export interface SportLoad {
  sportKey: string;
  sportLabel: string;
  matches: number;
  scheduled: number;
  minutes: number;
  share: number;
  competitions: CompetitionLoad[];
}

/** 135 -> "2h 15m"; under an hour stays in the sheet's own "min" reading. */
export function fmtDuration(minutes: number): string {
  if (minutes <= 0) return `0 ${t("min")}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} ${t("min")}`;
  return m ? `${h}${t("h")} ${m}${t("m")}` : `${h}${t("h")}`;
}

/** The configured no-play windows that bite on one date, as clipped intervals. */
export function blockedOnDay(
  day: string,
  windows: readonly BlackoutWindow[],
  from: number,
  to: number,
): { span: [number, number]; label: string }[] {
  const weekday = day ? WEEKDAY_KEYS[new Date(`${day}T00:00:00`).getDay()] : "";
  const out: { span: [number, number]; label: string }[] = [];
  for (const w of windows) {
    if (w.days?.length && weekday && !w.days.includes(weekday)) continue;
    if (w.date && w.date !== day) continue;
    const s = Math.max(from, toMinutes(w.from));
    const e = Math.min(to, toMinutes(w.to));
    if (e > s) out.push({ span: [s, e], label: blackoutLabel(w.label) });
  }
  return out;
}

function merged(spans: readonly [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function total(spans: readonly [number, number][]): number {
  return spans.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/**
 * Every court's day, built from the rows the preview produced.
 *
 * `dayStart`/`dayEnd` are the tournament's configured daily window — the hours
 * a court is actually available. A court whose play runs outside that window
 * widens its own bounds rather than reporting negative free time.
 */
export function courtDayLoads(
  rows: readonly PreviewRow[],
  dayStart: string,
  dayEnd: string,
  blackouts: readonly BlackoutWindow[] = [],
): CourtDayLoad[] {
  const byCourt = new Map<string, PreviewRow[]>();
  for (const r of rows) {
    // An unplaced match sits on no court, so it cannot occupy one.
    if (!r.placed || !r.day || !r.start || r.minutes == null) continue;
    const key = `${r.day}|${r.venue || t(UNASSIGNED_VENUE)}`;
    const list = byCourt.get(key);
    if (list) list.push(r);
    else byCourt.set(key, [r]);
  }

  const windowFrom = toMinutes(dayStart);
  const windowTo = toMinutes(dayEnd);

  const out: CourtDayLoad[] = [];
  for (const [key, list] of byCourt) {
    const day = key.slice(0, key.indexOf("|"));
    const court = key.slice(key.indexOf("|") + 1);
    const blocks: CourtBlock[] = list
      .map((r) => ({
        ref: r.ref,
        start: toMinutes(r.start),
        end: toMinutes(r.start) + (r.minutes ?? 0),
        leafKey: r.leafKey,
        sportKey: r.sportKey,
        sportLabel: r.sportLabel,
        categoryLabel: r.categoryLabel,
        competition: r.competition,
        home: r.home,
        away: r.away,
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const busy = merged(blocks.map((b): [number, number] => [b.start, b.end]));
    const firstStart = blocks.length ? blocks[0]!.start : null;
    const lastEnd = blocks.reduce((mx, b) => Math.max(mx, b.end), 0) || null;
    // Play outside the configured window still has to be shown truthfully.
    const windowStart = Math.min(windowFrom, firstStart ?? windowFrom);
    const windowEnd = Math.max(windowTo, lastEnd ?? windowTo);

    const blocked = blockedOnDay(day, blackouts, windowStart, windowEnd);
    const blockedSpans = merged(blocked.map((b) => b.span));

    // A break's own minutes are the part of it the court is not playing
    // through — a match that overruns into a break is busy time, not break.
    const gaps: CourtGap[] = [];
    for (const b of blocked) {
      for (const [s, e] of idleWindows(b.span[0], b.span[1], busy)) {
        gaps.push({
          key: `${key}|brk|${s}`,
          start: s,
          end: e,
          minutes: e - s,
          kind: "break",
          label: b.label,
        });
      }
    }
    for (const [s, e] of idleWindows(windowStart, windowEnd, [
      ...busy,
      ...blockedSpans,
    ])) {
      gaps.push({
        key: `${key}|free|${s}`,
        start: s,
        end: e,
        minutes: e - s,
        kind: "free",
        label: t("Court free"),
      });
    }
    gaps.sort((a, b) => a.start - b.start);

    const busyMinutes = total(busy);
    const breakMinutes = gaps
      .filter((g) => g.kind === "break")
      .reduce((sum, g) => sum + g.minutes, 0);
    const freeMinutes = gaps
      .filter((g) => g.kind === "free")
      .reduce((sum, g) => sum + g.minutes, 0);
    const usable = busyMinutes + freeMinutes;
    const longestFree = gaps
      .filter((g) => g.kind === "free")
      .reduce<CourtGap | null>(
        (best, g) => (!best || g.minutes > best.minutes ? g : best),
        null,
      );

    out.push({
      key,
      day,
      dayLabel: fmtDayLabel(day),
      court,
      windowStart,
      windowEnd,
      matches: blocks.length,
      busyMinutes,
      freeMinutes,
      breakMinutes,
      utilization: usable > 0 ? busyMinutes / usable : 0,
      longestFree,
      firstStart,
      lastEnd,
      blocks,
      gaps,
    });
  }

  return out.sort(
    (a, b) => a.day.localeCompare(b.day) || a.court.localeCompare(b.court),
  );
}

/**
 * Court minutes per competition, rolled up per sport.
 *
 * `minutes` counts only matches that got a time: an unplaced match consumes no
 * court, and counting its nominal duration would overstate the day.
 */
export function competitionLoads(rows: readonly PreviewRow[]): SportLoad[] {
  interface Acc extends CompetitionLoad {
    dayKeys: Set<string>;
    courtKeys: Set<string>;
  }
  const byLeaf = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byLeaf.get(r.leafKey);
    if (!acc) {
      acc = {
        key: r.leafKey,
        leafKey: r.leafKey,
        sportKey: r.sportKey,
        sportLabel: r.sportLabel,
        categoryLabel: r.categoryLabel,
        competition: r.competition,
        matches: 0,
        scheduled: 0,
        minutes: 0,
        avgMinutes: 0,
        days: 0,
        courts: 0,
        share: 0,
        dayKeys: new Set<string>(),
        courtKeys: new Set<string>(),
      };
      byLeaf.set(r.leafKey, acc);
    }
    acc.matches += 1;
    if (r.placed && r.day && r.minutes != null) {
      acc.scheduled += 1;
      acc.minutes += r.minutes;
      acc.dayKeys.add(r.day);
      acc.courtKeys.add(r.venue || t(UNASSIGNED_VENUE));
    }
  }

  const grand = [...byLeaf.values()].reduce((sum, a) => sum + a.minutes, 0);
  const bySport = new Map<string, SportLoad>();
  for (const acc of byLeaf.values()) {
    const comp: CompetitionLoad = {
      key: acc.key,
      leafKey: acc.leafKey,
      sportKey: acc.sportKey,
      sportLabel: acc.sportLabel,
      categoryLabel: acc.categoryLabel,
      competition: acc.competition,
      matches: acc.matches,
      scheduled: acc.scheduled,
      minutes: acc.minutes,
      avgMinutes: acc.scheduled ? Math.round(acc.minutes / acc.scheduled) : 0,
      days: acc.dayKeys.size,
      courts: acc.courtKeys.size,
      share: grand > 0 ? acc.minutes / grand : 0,
    };
    let sport = bySport.get(comp.sportKey);
    if (!sport) {
      sport = {
        sportKey: comp.sportKey,
        sportLabel: comp.sportLabel,
        matches: 0,
        scheduled: 0,
        minutes: 0,
        share: 0,
        competitions: [],
      };
      bySport.set(comp.sportKey, sport);
    }
    sport.matches += comp.matches;
    sport.scheduled += comp.scheduled;
    sport.minutes += comp.minutes;
    sport.competitions.push(comp);
  }

  const sports = [...bySport.values()];
  for (const s of sports) {
    s.share = grand > 0 ? s.minutes / grand : 0;
    s.competitions.sort(
      (a, b) => b.minutes - a.minutes || a.competition.localeCompare(b.competition),
    );
  }
  return sports.sort(
    (a, b) => b.minutes - a.minutes || a.sportLabel.localeCompare(b.sportLabel),
  );
}

/** The headline readings above both tables. */
export interface CourtTotals {
  courts: number;
  courtDays: number;
  busyMinutes: number;
  freeMinutes: number;
  breakMinutes: number;
  utilization: number;
  /** The single biggest reclaimable block anywhere in the schedule. */
  biggestFree: { court: string; dayLabel: string; gap: CourtGap } | null;
}

export function courtTotals(loads: readonly CourtDayLoad[]): CourtTotals {
  const busyMinutes = loads.reduce((s, l) => s + l.busyMinutes, 0);
  const freeMinutes = loads.reduce((s, l) => s + l.freeMinutes, 0);
  const breakMinutes = loads.reduce((s, l) => s + l.breakMinutes, 0);
  const usable = busyMinutes + freeMinutes;
  let biggestFree: CourtTotals["biggestFree"] = null;
  for (const l of loads) {
    if (l.longestFree && (!biggestFree || l.longestFree.minutes > biggestFree.gap.minutes)) {
      biggestFree = { court: l.court, dayLabel: l.dayLabel, gap: l.longestFree };
    }
  }
  return {
    courts: new Set(loads.map((l) => l.court)).size,
    courtDays: loads.length,
    busyMinutes,
    freeMinutes,
    breakMinutes,
    utilization: usable > 0 ? busyMinutes / usable : 0,
    biggestFree,
  };
}
