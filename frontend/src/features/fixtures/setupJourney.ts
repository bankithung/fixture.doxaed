import type {
  FixtureReadiness,
  MatchRow,
  ReadinessCompetition,
  TeamRow,
} from "@/api/tournaments";
import { t } from "@/lib/t";

/**
 * The journey model of the fixture-setup clarity rebuild (spec §3): pure
 * presentation-layer mapping of the server's readiness + match data onto the
 * three-step journey. The FE never recomputes readiness — it only maps what
 * the server already said into "where am I, what's next".
 */

/** One competition (category leaf): teams + matches + server readiness. */
export interface Competition {
  leafKey: string; // "" = uncategorized/legacy bucket
  label: string;
  sport: string;
  teams: TeamRow[];
  matches: MatchRow[];
  readiness?: ReadinessCompetition;
}

const FINAL = new Set(["completed", "walkover"]);
const LIVE = new Set(["live", "half_time", "extra_time", "penalties"]);

/** Statuses that no longer block the next Swiss round (mirrors the backend's
 * `_SWISS_FINAL` — a cancelled match will never finish). */
const SWISS_FINAL = new Set(["completed", "walkover", "cancelled"]);

/** Funnel position of one competition (drives grouping + the card chip). */
export type CompStatus =
  | "needs_teams"
  | "needs_setup"
  | "ready"
  | "drawn"
  | "live";

/** `globalsUnset` = the tournament-level Step 1 gate (dates + venues) is not
 * satisfied — an undrawn competition can never read "ready" before Step 1
 * (belt-and-braces over the server's per-leaf calendar check). */
export function statusOf(c: Competition, globalsUnset = false): CompStatus {
  if (c.matches.length > 0) {
    return c.matches.some((m) => LIVE.has(m.status)) ? "live" : "drawn";
  }
  if (!enoughTeams(c)) return "needs_teams";
  const ready =
    !globalsUnset && (c.readiness ? c.readiness.ready : c.teams.length >= 2);
  return ready ? "ready" : "needs_setup";
}

/** The server's enough_teams verdict (fallback: a local 2-team floor). */
export function enoughTeams(c: Competition): boolean {
  return c.readiness
    ? c.readiness.checks.find((k) => k.id === "enough_teams")?.status !== "fail"
    : c.teams.length >= 2;
}

/** True when the competition has a finished group stage and no bracket yet —
 * the moment "Build the bracket" becomes possible. */
export function groupsDone(c: Competition): boolean {
  const groups = c.matches.filter((m) => m.stage === "group");
  return (
    groups.length > 0 &&
    groups.every((m) => FINAL.has(m.status)) &&
    !c.matches.some((m) => m.stage === "knockout")
  );
}

/** True when a Swiss draw exists and every round so far is decided — the
 * moment "Pair the next round" becomes possible (increment P). */
export function swissRoundDone(c: Competition): boolean {
  const swiss = c.matches.filter((m) => m.stage === "swiss");
  return swiss.length > 0 && swiss.every((m) => SWISS_FINAL.has(m.status));
}

// --- The three-step journey (spec §3) ---

export type JourneyStep = 1 | 2 | 3 | "done";

/**
 * Tournament-level journey pointer:
 * 1     while the global calendar/venue checks fail (the stage gate);
 * 2     while no eligible competition has a draw yet;
 * 3     while some competitions are drawn and others are still mid-path
 *       (the header highlights 2 and 3 together in this mixed state);
 * done  when every competition that has enough teams has a draw.
 */
export function journeyStep(
  readiness: FixtureReadiness | undefined,
  competitions: Competition[],
): JourneyStep {
  const globalFail = (readiness?.global.checks ?? []).some(
    (c) =>
      (c.id === "calendar_set" || c.id === "venues_defined") &&
      c.status === "fail",
  );
  if (globalFail) return 1;
  const eligible = competitions.filter(enoughTeams);
  if (eligible.length === 0) return 2;
  const drawn = eligible.filter((c) => c.matches.length > 0).length;
  if (drawn === eligible.length) return "done";
  return drawn > 0 ? 3 : 2;
}

// --- The one-sentence competition verdict (spec §3 + §7.2) ---

/** What the card's single action does — the hub routes these. */
export type CardActionKind =
  | "teams"
  | "seeds"
  | "step1"
  | "preview"
  | "format"
  | "console"
  | "advance"
  | "next_round"
  | "view_matches"
  | "adjust_schedule"
  /** "Keep this draw" — dismiss the inputs-drift banner for this session. */
  | "keep";

export interface CardAction {
  label: string;
  /** "primary" renders the single default-variant button; "link" a text link. */
  kind: "primary" | "link";
  action: CardActionKind;
  /** First live match (the "console" action's target). */
  matchId?: string;
}

export interface CompetitionPresentation {
  sentence: string;
  actions: CardAction[];
  /** Quiet format note under the sentence (format_chosen warn, U4-note). */
  note?: { text: string; actionLabel: string };
  /** True → the "See what's missing" checklist detail is available. */
  blocked: boolean;
  /** D2: the inputs-changed banner replaces the sentence + action. */
  staleBanner: boolean;
}

function failed(c: Competition, id: string): boolean {
  return c.readiness?.checks.some((k) => k.id === id && k.status === "fail") ?? false;
}

function warned(c: Competition, id: string): boolean {
  return c.readiness?.checks.some((k) => k.id === id && k.status === "warn") ?? false;
}

/**
 * §7.2 sentence table, priority order, first match wins. `keptStale` is the
 * per-session "Keep this draw" dismissal of the inputs-changed banner;
 * `globalsUnset` demotes a would-be-ready card while the tournament-level
 * Step 1 gate (dates + venues) is unsatisfied — never offer Preview first.
 */
export function competitionSentence(
  c: Competition,
  drawFormat: string,
  keptStale = false,
  globalsUnset = false,
): CompetitionPresentation {
  const none: CompetitionPresentation = {
    sentence: "",
    actions: [],
    blocked: false,
    staleBanner: false,
  };

  if (c.matches.length > 0) {
    // D1 — any match live.
    const live = c.matches.find((m) => LIVE.has(m.status));
    if (live) {
      const done = c.matches.filter((m) => FINAL.has(m.status)).length;
      return {
        ...none,
        sentence: t(
          `Matches are being played - ${done} of ${c.matches.length} finished.`,
        ),
        actions: [
          { label: t("Open match console"), kind: "link", action: "console", matchId: live.id },
        ],
      };
    }
    // D2 — the draw's inputs drifted (invariant 10) and Keep wasn't pressed.
    if (warned(c, "already_generated") && !keptStale) {
      return { ...none, staleBanner: true };
    }
    // D3 — group stage finished, no bracket yet.
    if (groupsDone(c)) {
      return {
        ...none,
        sentence: t(
          "The group stage is finished. Build the knockout bracket from the standings.",
        ),
        actions: [{ label: t("Build the bracket"), kind: "primary", action: "advance" }],
      };
    }
    // D4 — Swiss round fully decided.
    if (drawFormat === "swiss" && swissRoundDone(c)) {
      const r = Math.max(
        ...c.matches.filter((m) => m.stage === "swiss").map((m) => m.round_no),
      );
      return {
        ...none,
        sentence: t(
          `Round ${r} is finished. Pair the next round from the standings.`,
        ),
        actions: [
          { label: t("Pair the next round"), kind: "primary", action: "next_round" },
        ],
      };
    }
    // D5 — scheduled / drawn.
    const m = c.matches.length;
    const days = new Set(
      c.matches
        .filter((x) => x.scheduled_at)
        .map((x) => String(x.scheduled_at).slice(0, 10)),
    ).size;
    return {
      ...none,
      sentence:
        days > 0
          ? t(`Scheduled - ${m} ${m === 1 ? "match" : "matches"} over ${days} day(s).`)
          : t(`Drawn - ${m} ${m === 1 ? "match" : "matches"}, not yet scheduled.`),
      actions: [
        { label: t("View matches"), kind: "link", action: "view_matches" },
        {
          label: t("Adjust this competition's schedule"),
          kind: "link",
          action: "adjust_schedule",
        },
      ],
    };
  }

  // U1 — not enough teams.
  if (failed(c, "enough_teams")) {
    return {
      ...none,
      sentence: t(`Waiting for teams - ${c.teams.length} of 2 minimum.`),
      actions: [{ label: t("See registered teams"), kind: "link", action: "teams" }],
      blocked: true,
    };
  }
  // U2 — seeds missing.
  if (failed(c, "seeds_set")) {
    const n = c.teams.filter((tm) => tm.seed == null).length || c.teams.length;
    return {
      ...none,
      sentence: t(
        `${n} team(s) still need a seed number before this draw can run.`,
      ),
      actions: [{ label: t("Set seed numbers"), kind: "primary", action: "seeds" }],
      blocked: true,
    };
  }
  // U3 — leaf-level calendar/venue fail (cannot occur past the gate).
  if (failed(c, "calendar_set") || failed(c, "venues_defined")) {
    return {
      ...none,
      sentence: t("Finish Step 1 first - dates or venues are missing."),
      actions: [{ label: t("Open Step 1"), kind: "primary", action: "step1" }],
      blocked: true,
    };
  }
  // U3b — the tournament-level Step 1 gate is unsatisfied (belt-and-braces:
  // a competition is never "Ready to preview" before dates + venues exist).
  if (globalsUnset) {
    return {
      ...none,
      sentence: t("Finish Step 1 (dates and venues) first."),
      actions: [{ label: t("Open Step 1"), kind: "primary", action: "step1" }],
      blocked: true,
    };
  }
  // U4 — ready (plus the quiet format note when format_chosen warns).
  const ready = c.readiness ? c.readiness.ready : c.teams.length >= 2;
  if (ready) {
    return {
      ...none,
      sentence: t("Ready to preview. Nothing is saved until you publish."),
      actions: [{ label: t("Preview the draw"), kind: "primary", action: "preview" }],
      note: warned(c, "format_chosen")
        ? {
            // "League" (not "round robin") — the Step 2 wizard's name for it.
            text: t(
              "You haven't picked a format. League (everyone plays everyone once) will be used.",
            ),
            actionLabel: t("Choose format"),
          }
        : undefined,
    };
  }
  // Fallback — some other check fails; the checklist detail carries the why.
  return {
    ...none,
    sentence: t("A few checks still need attention before the draw can run."),
    actions: [],
    blocked: true,
  };
}
