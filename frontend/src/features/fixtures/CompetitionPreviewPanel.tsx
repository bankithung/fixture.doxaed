import { useMemo, useState } from "react";
import type {
  MatchRow,
  MatchSource,
  MiniTeam,
  PreviewMatch,
  PreviewSide,
} from "@/api/tournaments";
import { FifaBracket } from "@/features/tournaments/FifaBracket";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "@/components/ui/star-border.css";
import { shortGroupName } from "./groupSlotLabel";
import { LeafLabel } from "./LeafLabel";
import { GroupCompositionView } from "./GroupCompositionView";
import { sideCrest } from "./sideName";

/** Adapt a previewed (placeholder) match to the MatchRow shape the FIFA
 * bracket renders — no scores yet, typed pointers passed through so an
 * unresolved slot shows the clean "Group A #1" label. */
export function previewToMatchRow(
  pm: PreviewMatch,
  teamNames: ReadonlyMap<string, string>,
  /** `{team_id: crest URL}` — the bracket node renders `MiniTeam.crest`. */
  teamCrests: ReadonlyMap<string, string> = new Map(),
): MatchRow {
  const team = (s: PreviewSide): MiniTeam | null =>
    s.team_id
      ? {
          id: s.team_id,
          name: teamNames.get(s.team_id) ?? t("TBD"),
          short_name: "",
          crest: sideCrest(s, teamCrests),
        }
      : null;
  const source = (s: PreviewSide): MatchSource | null =>
    (s.source as MatchSource | undefined) ?? null;
  return {
    id: pm.ref,
    stage: pm.stage,
    group_label: pm.group_label,
    round_no: pm.round_no,
    match_no: 0,
    status: "scheduled",
    home_team: team(pm.home),
    away_team: team(pm.away),
    home_score: null,
    away_score: null,
    sport: "",
    set_scores: [],
    leaf_key: pm.leaf_key,
    venue: pm.venue ?? "",
    scoring: null,
    scheduled_at: pm.scheduled_at,
    home_source: source(pm.home),
    away_source: source(pm.away),
  };
}

interface GroupBucket {
  name: string;
  members: string[];
  matches: PreviewMatch[];
}

type StageTab = "groups" | "knockout";

/**
 * ONE competition's STRUCTURE, Google-sports-panel style (owner ask
 * 2026-07-13): its own header + stage tabs — "Group stage" (each group's
 * teams and fixtures together) and "Knockout" (the bracket, byes shown as
 * explicit Bye cards). The calendar itself lives in the preview spreadsheet
 * (owner 2026-08-15), so this panel answers "who plays whom", never "when".
 */
export function CompetitionPreviewPanel({
  label,
  matches,
  teamNames,
  teamCrests,
  unscheduled,
}: {
  label: string;
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
  /** `{team_id: crest URL}`; absent or empty just means no badges. */
  teamCrests?: ReadonlyMap<string, string>;
  unscheduled: readonly string[];
}): React.ReactElement {
  const { groups, ko, teamsCount, untimed } = useMemo(() => {
    const koMatches: PreviewMatch[] = [];
    const byGroup = new Map<string, GroupBucket>();
    const teamIds = new Set<string>();
    const unscheduledSet = new Set(unscheduled);
    const untimedRows: PreviewMatch[] = [];
    for (const m of matches) {
      for (const s of [m.home, m.away]) if (s.team_id) teamIds.add(s.team_id);
      if (unscheduledSet.has(m.ref)) untimedRows.push(m);
      if (m.stage === "knockout") {
        koMatches.push(m);
        continue;
      }
      const name = m.group_label
        ? `${t("Group")} ${shortGroupName(m.group_label)}`
        : t("Matches");
      let bucket = byGroup.get(name);
      if (!bucket) {
        bucket = { name, members: [], matches: [] };
        byGroup.set(name, bucket);
      }
      bucket.matches.push(m);
      for (const s of [m.home, m.away]) {
        const n = s.team_id ? teamNames.get(s.team_id) : undefined;
        if (n && !bucket.members.includes(n)) bucket.members.push(n);
      }
    }
    for (const b of byGroup.values()) {
      b.members.sort((a, c) => a.localeCompare(c));
      // Round FIRST, then kickoff: a group reads as its competition flows
      // (round 3 on day 2 must not sort above round 2's afternoon).
      b.matches.sort((a, c) => {
        if ((a.round_no ?? 0) !== (c.round_no ?? 0)) {
          return (a.round_no ?? 0) - (c.round_no ?? 0);
        }
        const ta = a.scheduled_at ?? "~";
        const tc = c.scheduled_at ?? "~";
        if (ta !== tc) return ta < tc ? -1 : 1;
        return a.ref < c.ref ? -1 : 1;
      });
    }
    return {
      groups: [...byGroup.values()].sort((a, c) => a.name.localeCompare(c.name)),
      ko: koMatches,
      teamsCount: teamIds.size,
      untimed: untimedRows,
    };
  }, [matches, teamNames, unscheduled]);

  const tabs = useMemo(() => {
    const out: [StageTab, string][] = [];
    if (groups.length) out.push(["groups", t("Group stage")]);
    if (ko.length) out.push(["knockout", t("Knockout")]);
    return out;
  }, [groups.length, ko.length]);
  const [tab, setTab] = useState<StageTab>(groups.length ? "groups" : "knockout");

  const bracketColumns = useMemo(() => {
    const byRound = new Map<number, MatchRow[]>();
    for (const m of ko) {
      const list = byRound.get(m.round_no);
      const row = previewToMatchRow(m, teamNames, teamCrests);
      if (list) list.push(row);
      else byRound.set(m.round_no, [row]);
    }
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
  }, [ko, teamNames, teamCrests]);

  const timed = matches.length - untimed.length;

  return (
    <section
      data-testid="competition-panel"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <LeafLabel label={label} />
        <span className="font-tabular text-xs text-muted-foreground">
          {teamsCount} {t("teams")} · {matches.length} {t("matches")}
        </span>
        {untimed.length ? (
          <span className="rounded-full border border-warning/50 bg-warning-muted px-2 py-0.5 font-tabular text-[0.6875rem] font-medium text-warning">
            {untimed.length} {t("without a time")}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-[0.6875rem] text-muted-foreground">
            {timed} {t("timed")}
          </span>
        )}
        {tabs.length > 1 ? (
          <div
            role="radiogroup"
            aria-label={t("Competition view")}
            className="ml-auto inline-flex shrink-0 rounded-lg border border-border bg-muted/20 p-0.5"
          >
            {tabs.map(([key, lbl]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={tab === key}
                data-testid={`stage-tab-${key}`}
                onClick={() => setTab(key)}
                className={cn(
                  "h-8 rounded-md px-3 text-xs font-medium transition-colors",
                  tab === key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {lbl}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {tab === "groups" ? (
        <div data-testid="stage-groups">
          {/* The same spreadsheet the rest of the preview uses: one line per
              team, group and slot as columns (owner 2026-08-15). The fixtures
              themselves live in the schedule sheet. */}
          <GroupCompositionView
            matches={matches}
            teamNames={teamNames}
            teamCrests={teamCrests}
          />
        </div>
      ) : null}

      {tab === "knockout" ? (
        <div data-testid="preview-bracket">
          <FifaBracket columns={bracketColumns} />
        </div>
      ) : null}

    </section>
  );
}
