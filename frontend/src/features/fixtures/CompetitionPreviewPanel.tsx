import { useMemo, useState } from "react";
import { Users } from "lucide-react";
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
import { LEAF_ACCENTS, MatchChip, MatchesByDayGrid } from "./MatchesByDayGrid";

/** Adapt a previewed (placeholder) match to the MatchRow shape the FIFA
 * bracket renders — no scores yet, typed pointers passed through so an
 * unresolved slot shows the clean "Group A #1" label. */
export function previewToMatchRow(
  pm: PreviewMatch,
  teamNames: ReadonlyMap<string, string>,
): MatchRow {
  const team = (s: PreviewSide): MiniTeam | null =>
    s.team_id
      ? { id: s.team_id, name: teamNames.get(s.team_id) ?? t("TBD"), short_name: "" }
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

type StageTab = "groups" | "knockout" | "schedule";

/**
 * ONE competition, Google-sports-panel style (owner ask 2026-07-13): its own
 * header + stage tabs — "Group stage" (each group's teams and fixtures
 * together), "Knockout" (the bracket, byes shown as explicit Bye cards) and
 * "Schedule" (every timed match of this competition by day). Replaces the
 * everything-on-one-page stack for a selected category.
 */
export function CompetitionPreviewPanel({
  label,
  matches,
  teamNames,
  unscheduled,
  occupancy,
}: {
  label: string;
  matches: PreviewMatch[];
  teamNames: ReadonlyMap<string, string>;
  unscheduled: readonly string[];
  /** EVERY previewed match (all competitions) — court-gap truth for breaks. */
  occupancy?: PreviewMatch[];
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
      b.matches.sort((a, c) => {
        const ta = a.scheduled_at ?? "~";
        const tc = c.scheduled_at ?? "~";
        if (ta !== tc) return ta < tc ? -1 : 1;
        return (a.round_no ?? 0) - (c.round_no ?? 0);
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
    out.push(["schedule", t("Schedule")]);
    return out;
  }, [groups.length, ko.length]);
  const [tab, setTab] = useState<StageTab>(
    groups.length ? "groups" : ko.length ? "knockout" : "schedule",
  );

  const bracketColumns = useMemo(() => {
    const byRound = new Map<number, MatchRow[]>();
    for (const m of ko) {
      const list = byRound.get(m.round_no);
      const row = previewToMatchRow(m, teamNames);
      if (list) list.push(row);
      else byRound.set(m.round_no, [row]);
    }
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
  }, [ko, teamNames]);

  const accent = LEAF_ACCENTS[0];
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
        <div
          data-testid="stage-groups"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {groups.map((g) => (
            <div
              key={g.name}
              data-testid={`stage-group-${g.name}`}
              className="flex flex-col overflow-hidden bento-card star-rim rounded-xl border border-border bg-card shadow-sm"
            >
              <h4 className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-semibold">
                <Users aria-hidden="true" className="h-4 w-4 text-primary" />
                {g.name}
                <span className="font-tabular text-xs font-normal text-muted-foreground">
                  {g.members.length} {t("teams")} · {g.matches.length}{" "}
                  {t("matches")}
                </span>
              </h4>
              <ol className="flex flex-col border-b border-border">
                {g.members.map((s, i) => (
                  <li
                    key={s}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-sm"
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary font-tabular text-[0.6875rem] font-medium text-secondary-foreground">
                      {i + 1}
                    </span>
                    <span className="truncate">{s}</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-col gap-1.5 p-3">
                {g.matches.map((m) => (
                  <MatchChip
                    key={m.ref}
                    match={m}
                    accent={accent}
                    teamNames={teamNames}
                    showCompetition={false}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "knockout" ? (
        <div data-testid="preview-bracket">
          <FifaBracket columns={bracketColumns} />
        </div>
      ) : null}

      {tab === "schedule" ? (
        <div className="flex flex-col gap-3" data-testid="stage-schedule">
          <MatchesByDayGrid
            matches={matches.filter((m) => m.scheduled_at)}
            teamNames={teamNames}
            occupancy={occupancy}
          />
        </div>
      ) : null}
    </section>
  );
}
