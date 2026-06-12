import { describe, expect, it } from "vitest";
import type {
  FixtureReadiness,
  MatchRow,
  ReadinessCheck,
  TeamRow,
} from "@/api/tournaments";
import {
  competitionSentence,
  enoughTeams,
  groupsDone,
  journeyStep,
  statusOf,
  swissRoundDone,
  type Competition,
} from "../setupJourney";

function team(id: string, seed: number | null = null): TeamRow {
  return {
    id, name: id, short_name: id, school: "S", pool: "", sport: "football",
    leaf_key: "football.u15", status: "registered", seed, player_count: 7,
  } as TeamRow;
}

function match(over: Partial<MatchRow>): MatchRow {
  return {
    id: "m1", stage: "group", group_label: "A", round_no: 1, match_no: 1,
    status: "scheduled", home_team: null, away_team: null,
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
    ...over,
  } as MatchRow;
}

function comp(over: Partial<Competition> = {}): Competition {
  return {
    leafKey: "football.u15",
    label: "Football · U15",
    sport: "football",
    teams: [team("a"), team("b")],
    matches: [],
    ...over,
  };
}

function withChecks(
  checks: ReadinessCheck[],
  ready = !checks.some((c) => c.status === "fail"),
  over: Partial<Competition> = {},
): Competition {
  return comp({
    readiness: {
      leaf_key: "football.u15", label: "Football · U15",
      ready, summary: "3/5", checks,
    },
    ...over,
  });
}

function readinessFor(globalOk: boolean): FixtureReadiness {
  return {
    global: {
      checks: [
        { id: "calendar_set", status: globalOk ? "ok" : "fail" },
        { id: "venues_defined", status: globalOk ? "ok" : "fail" },
      ],
    },
    competitions: [],
  };
}

describe("journeyStep", () => {
  it("is 1 while the global calendar/venue checks fail (the stage gate)", () => {
    expect(journeyStep(readinessFor(false), [comp()])).toBe(1);
  });

  it("is 2 while no eligible competition has a draw", () => {
    expect(journeyStep(readinessFor(true), [comp()])).toBe(2);
    // 0-team leaves are not eligible — they don't hold the journey at 2
    expect(
      journeyStep(readinessFor(true), [
        comp({ teams: [], readiness: undefined }),
      ]),
    ).toBe(2);
  });

  it("is 3 (mixed) while some eligible competitions are drawn and others are not", () => {
    expect(
      journeyStep(readinessFor(true), [
        comp({ matches: [match({})] }),
        comp({ leafKey: "football.u17" }),
      ]),
    ).toBe(3);
  });

  it("is done when every competition with enough teams has a draw", () => {
    expect(
      journeyStep(readinessFor(true), [
        comp({ matches: [match({})] }),
        // waiting-for-teams leaves don't block done
        comp({ leafKey: "football.u17", teams: [] }),
      ]),
    ).toBe("done");
  });
});

describe("statusOf / helpers", () => {
  it("derives the funnel status", () => {
    expect(statusOf(comp({ matches: [match({ status: "live" })] }))).toBe("live");
    expect(statusOf(comp({ matches: [match({})] }))).toBe("drawn");
    expect(statusOf(comp({ teams: [team("a")] }))).toBe("needs_teams");
    expect(statusOf(comp())).toBe("ready");
    expect(
      statusOf(
        withChecks([{ id: "seeds_set", status: "fail" }], false),
      ),
    ).toBe("needs_setup");
  });

  it("enough_teams follows the server verdict over the local count", () => {
    // 5 teams but the server says fail → fail wins
    expect(
      enoughTeams(
        withChecks([{ id: "enough_teams", status: "fail" }], false, {
          teams: [team("a"), team("b"), team("c"), team("d"), team("e")],
        }),
      ),
    ).toBe(false);
  });

  it("groupsDone requires every group match final and no knockout yet", () => {
    expect(
      groupsDone(comp({ matches: [match({ status: "completed" })] })),
    ).toBe(true);
    expect(
      groupsDone(
        comp({
          matches: [
            match({ status: "completed" }),
            match({ id: "m2", stage: "knockout" }),
          ],
        }),
      ),
    ).toBe(false);
    expect(groupsDone(comp({ matches: [match({})] }))).toBe(false);
  });

  it("swissRoundDone treats cancelled as final", () => {
    expect(
      swissRoundDone(
        comp({
          matches: [
            match({ stage: "swiss", status: "completed" }),
            match({ id: "m2", stage: "swiss", status: "cancelled" }),
          ],
        }),
      ),
    ).toBe(true);
    expect(
      swissRoundDone(
        comp({ matches: [match({ stage: "swiss", status: "scheduled" })] }),
      ),
    ).toBe(false);
  });
});

describe("competitionSentence (§7.2, first match wins)", () => {
  it("U1: waiting for teams", () => {
    const p = competitionSentence(
      withChecks([{ id: "enough_teams", status: "fail" }], false, {
        teams: [team("a")],
      }),
      "",
    );
    expect(p.sentence).toBe("Waiting for teams - 1 of 2 minimum.");
    expect(p.blocked).toBe(true);
    expect(p.actions).toEqual([
      { label: "See registered teams", kind: "link", action: "teams" },
    ]);
  });

  it("U2: seed numbers missing", () => {
    const p = competitionSentence(
      withChecks([{ id: "seeds_set", status: "fail" }], false, {
        teams: [team("a", 1), team("b"), team("c")],
      }),
      "",
    );
    expect(p.sentence).toBe(
      "2 team(s) still need a seed number before this draw can run.",
    );
    expect(p.actions[0]).toEqual({
      label: "Set seed numbers", kind: "primary", action: "seeds",
    });
    expect(p.blocked).toBe(true);
  });

  it("U3: leaf-level Step 1 gap", () => {
    const p = competitionSentence(
      withChecks([{ id: "calendar_set", status: "fail" }], false),
      "",
    );
    expect(p.sentence).toBe("Finish Step 1 first - dates or venues are missing.");
    expect(p.actions[0]).toEqual({
      label: "Open Step 1", kind: "primary", action: "step1",
    });
  });

  it("U4: ready, with the quiet format note on a format_chosen warn", () => {
    const ready = competitionSentence(withChecks([], true), "");
    expect(ready.sentence).toBe(
      "Ready to preview. Nothing is saved until you publish.",
    );
    expect(ready.actions[0]).toEqual({
      label: "Preview the draw", kind: "primary", action: "preview",
    });
    expect(ready.blocked).toBe(false);
    expect(ready.note).toBeUndefined();

    const noted = competitionSentence(
      withChecks([{ id: "format_chosen", status: "warn" }], true),
      "",
    );
    expect(noted.note).toEqual({
      text: "You haven't picked a format. Round robin will be used.",
      actionLabel: "Choose format",
    });
  });

  it("falls back to a blocked catch-all for other failing checks", () => {
    const p = competitionSentence(
      withChecks([{ id: "constraints_reviewed", status: "fail" }], false),
      "",
    );
    expect(p.sentence).toBe(
      "A few checks still need attention before the draw can run.",
    );
    expect(p.blocked).toBe(true);
    expect(p.actions).toEqual([]);
  });

  it("D1: live matches beat everything", () => {
    const p = competitionSentence(
      comp({
        matches: [
          match({ id: "m1", status: "live" }),
          match({ id: "m2", status: "completed" }),
        ],
      }),
      "",
    );
    expect(p.sentence).toBe("Matches are being played - 1 of 2 finished.");
    expect(p.actions[0]).toEqual({
      label: "Open match console", kind: "link", action: "console", matchId: "m1",
    });
  });

  it("D2: inputs drift renders the banner instead of a sentence, until kept", () => {
    const c = withChecks([{ id: "already_generated", status: "warn" }], true, {
      matches: [match({})],
    });
    expect(competitionSentence(c, "").staleBanner).toBe(true);
    // "Keep this draw" pressed → D5 takes over
    const keptP = competitionSentence(c, "", true);
    expect(keptP.staleBanner).toBe(false);
    expect(keptP.sentence).toContain("Drawn");
  });

  it("D3: finished group stage offers the bracket", () => {
    const p = competitionSentence(
      comp({ matches: [match({ status: "completed" })] }),
      "round_robin",
    );
    expect(p.sentence).toBe(
      "The group stage is finished. Build the knockout bracket from the standings.",
    );
    expect(p.actions[0]).toEqual({
      label: "Build the bracket", kind: "primary", action: "advance",
    });
  });

  it("D4: a decided Swiss round offers the next pairing", () => {
    const p = competitionSentence(
      comp({
        matches: [
          match({ stage: "swiss", round_no: 2, status: "completed" }),
        ],
      }),
      "swiss",
    );
    expect(p.sentence).toBe(
      "Round 2 is finished. Pair the next round from the standings.",
    );
    expect(p.actions[0]).toEqual({
      label: "Pair the next round", kind: "primary", action: "next_round",
    });
  });

  it("D5: scheduled and drawn-but-unscheduled wordings", () => {
    const scheduled = competitionSentence(
      comp({
        matches: [
          match({ id: "m1", scheduled_at: "2026-06-20T09:00:00" }),
          match({ id: "m2", scheduled_at: "2026-06-21T09:00:00" }),
        ],
      }),
      "",
    );
    expect(scheduled.sentence).toBe("Scheduled - 2 matches over 2 day(s).");
    expect(scheduled.actions.map((a) => a.action)).toEqual([
      "view_matches",
      "adjust_schedule",
    ]);

    const unscheduled = competitionSentence(comp({ matches: [match({})] }), "");
    expect(unscheduled.sentence).toBe("Drawn - 1 match, not yet scheduled.");
  });
});
