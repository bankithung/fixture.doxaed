import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Award } from "lucide-react";
import {
  publicRecordsApi,
  type PublicSchoolRecord,
  type SchoolTeamRow,
  type SchoolTotals,
} from "@/api/publicRecords";
import { Select } from "@/components/ui/Select";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const FORM_CLS: Record<string, string> = {
  W: "bg-primary text-primary-foreground",
  D: "bg-muted text-muted-foreground",
  L: "bg-destructive/15 text-destructive",
};

/** The URL value that means "every tournament at once". */
const ALL = "all";

/** One tournament's worth of this school: the numbers and the teams. The
 * current tournament and every past one are read through the SAME shape, so
 * the page has one layout for any of them (owner 2026-08-28: "only one
 * combined section"). */
type Entry = {
  id: string;
  name: string;
  slug: string;
  season: string;
  starts_at: string | null;
  totals: SchoolTotals;
  teams: SchoolTeamRow[];
};

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2">
      <span className="font-tabular text-xl font-semibold">{value}</span>
      <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function TeamRow({
  team,
  entry,
}: {
  team: SchoolTeamRow;
  entry: Entry;
}): React.ReactElement {
  const form = team.form ?? [];
  return (
    <li>
      <Link
        to={routes.publicTeam(entry.slug, entry.id, team.team_id)}
        data-testid={`school-team-${team.team_id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
      >
        <TeamCrest src={team.crest} name={team.team_name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{team.team_name}</p>
          {/* The competition as people SAY it, never the raw key: the page
              was printing `table_tennis.u_14.boys.singles` under every team
              (owner 2026-08-28). */}
          <LeafLabel label={team.leaf_label || team.leaf_key} className="mt-0.5" />
        </div>
        {form.length > 0 ? (
          <div className="flex items-center gap-1" aria-label={t("Recent form")}>
            {form.map((r, i) => (
              <span
                key={i}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-md text-[0.6875rem] font-semibold",
                  FORM_CLS[r] ?? "bg-muted",
                )}
              >
                {r}
              </span>
            ))}
          </div>
        ) : null}
        <span className="font-tabular text-sm text-muted-foreground">
          {team.wins}-{team.draws}-{team.losses}
        </span>
      </Link>
    </li>
  );
}

function sumTotals(entries: Entry[]): SchoolTotals {
  const out: SchoolTotals = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    scored: 0,
    conceded: 0,
    difference: 0,
  };
  for (const e of entries) {
    out.played += e.totals.played;
    out.wins += e.totals.wins;
    out.draws += e.totals.draws;
    out.losses += e.totals.losses;
    out.scored += e.totals.scored;
    out.conceded += e.totals.conceded;
  }
  out.difference = out.scored - out.conceded;
  return out;
}

/** The current tournament first, then the rest newest first. */
function schoolEntries(school: PublicSchoolRecord): Entry[] {
  const past = school.history
    .flatMap((s) => s.tournaments)
    .filter((row) => row.tournament_id !== school.tournament_id);
  const fromHistory = school.history
    .flatMap((s) => s.tournaments)
    .find((row) => row.tournament_id === school.tournament_id);
  const current: Entry = {
    id: school.tournament_id,
    name:
      school.tournament_name ??
      fromHistory?.tournament_name ??
      t("This tournament"),
    slug: school.tournament_slug ?? fromHistory?.tournament_slug ?? "",
    season: school.season ?? fromHistory?.season ?? "",
    starts_at: fromHistory?.starts_at ?? null,
    // The top-level rollup is the richer read (full team records); history
    // carries the same tournament again only to name and date it.
    totals: school.totals,
    teams: school.teams,
  };
  const when = (e: Entry): number =>
    e.starts_at ? Date.parse(e.starts_at) : Number.NEGATIVE_INFINITY;
  const rest: Entry[] = past
    .map((row) => ({
      id: row.tournament_id,
      name: row.tournament_name,
      slug: row.tournament_slug,
      season: row.season,
      starts_at: row.starts_at,
      totals: row.totals,
      teams: row.teams,
    }))
    .sort((a, b) => when(b) - when(a));
  return [current, ...rest];
}

/**
 * Public school profile (P6, the owner's "schools can see their data any
 * time"): the page a headmaster forwards to the school WhatsApp group.
 *
 * Redrawn 2026-08-28 (owner: "show only the current one, only one combined
 * section, a filter to view all other tournaments, and the logo is not
 * visible"). The first cut stacked four sections — totals, teams,
 * achievements, a season-grouped history — and the totals silently mixed in
 * a test tournament and two empty ones, so "16 played, 6 won" was not the
 * number of the tournament on the banner. Now:
 *
 * - **One tournament at a time, the current one by default.** The numbers and
 *   the teams are read for ONE tournament, named in the filter, so nothing on
 *   the page is a sum of things a parent did not ask about.
 * - **One section.** Totals across the top of the card, the teams under
 *   them, the school's achievements along the bottom — one card, read top to
 *   bottom.
 * - **The filter is the history.** Every other public tournament the school
 *   entered is an option, and "All tournaments" sums them with each
 *   tournament's teams under its own name — which is what the History list
 *   was for, without a second section to hold it. The choice rides the URL
 *   (`?t=`), so a forwarded link opens on the same year.
 * - **The school's badge is the page's identity**, exactly as the team page
 *   already does; the generic shield icon was standing in for a logo the
 *   API had been sending all along.
 */
export function PublicSchoolPage(): React.ReactElement {
  const { slug = "", id = "", instId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useQuery({
    queryKey: ["public-school", instId],
    queryFn: () => publicRecordsApi.school(slug, id, instId),
    staleTime: 30_000,
  });
  const entries = useMemo(
    () => (q.data ? schoolEntries(q.data) : []),
    [q.data],
  );

  if (q.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <div className="h-32 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load this school.")}
        </p>
        <Link
          to={routes.publicSchedule(slug, id)}
          className="text-sm text-primary hover:underline"
        >
          {t("Back to the schedule")}
        </Link>
      </div>
    );
  }
  const school = q.data;
  const current = entries[0]!;

  // An unknown `?t=` (a tournament this school never entered, a typo) falls
  // back to the current tournament rather than to an empty page.
  const wanted = params.get("t") ?? "";
  const selected =
    wanted === ALL
      ? ALL
      : entries.some((e) => e.id === wanted)
        ? wanted
        : current.id;
  const shown =
    selected === ALL ? entries : entries.filter((e) => e.id === selected);
  const totals = selected === ALL ? sumTotals(shown) : shown[0]!.totals;
  const teamCount = shown.reduce((n, e) => n + e.teams.length, 0);
  // Badges are awarded within the current tournament (the API scopes them to
  // this institution row), so they belong to its view and to the sum of all.
  const showBadges =
    school.badges.length > 0 && (selected === ALL || selected === current.id);

  const options = [
    ...entries.map((e) => ({
      value: e.id,
      label: e.season && !e.name.includes(e.season) ? `${e.name} · ${e.season}` : e.name,
    })),
    ...(entries.length > 1 ? [{ value: ALL, label: t("All tournaments") }] : []),
  ];

  const pick = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === current.id) next.delete("t");
    else next.set("t", value);
    setParams(next, { replace: true });
  };

  return (
    <div className="min-h-screen text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <Link
          to={routes.publicSchedule(slug, id)}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Back to the schedule")}
        </Link>

        {/* ONE section, and everything in it (owner 2026-08-28: "only one
            section and all content should be inside that section"): who the
            school is and which tournament is being read, then the numbers,
            the teams under them, the achievements along the bottom. */}
        <section
          data-testid="school-record"
          className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        >
          <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-4">
            {/* The school's OWN badge, whole; initials when it never uploaded
                one. Not a generic icon (owner 2026-08-28: "the logo is not
                visible"). */}
            <TeamCrest
              src={school.crest}
              name={school.institution_name}
              size="xl"
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold">
                {school.institution_name}
              </h1>
              <p className="text-xs text-muted-foreground">
                {teamCount} {teamCount === 1 ? t("team") : t("teams")}{" "}
                {selected === ALL
                  ? t("across all tournaments")
                  : `${t("in")} ${shown[0]!.name}`}
              </p>
            </div>
            {/* One tournament at a time; the whole history is a choice away. */}
            {entries.length > 1 ? (
              <div
                data-testid="school-tournament-filter"
                className="w-full sm:w-auto sm:min-w-[16rem]"
              >
                <Select
                  size="sm"
                  aria-label={t("Tournament")}
                  value={selected}
                  onChange={pick}
                  options={options}
                />
              </div>
            ) : null}
          </header>

          <div
            data-testid="school-totals"
            className="grid grid-cols-4 divide-x divide-border border-b border-border sm:grid-cols-7"
          >
            <Stat label={t("Played")} value={totals.played} />
            <Stat label={t("Won")} value={totals.wins} />
            <Stat label={t("Drawn")} value={totals.draws} />
            <Stat label={t("Lost")} value={totals.losses} />
            <div className="hidden sm:contents">
              <Stat label={t("Scored")} value={totals.scored} />
              <Stat label={t("Against")} value={totals.conceded} />
              <Stat label={t("Diff")} value={totals.difference} />
            </div>
          </div>

          {teamCount === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("No teams registered yet.")}
            </p>
          ) : (
            shown.map((entry) => (
              <div key={entry.id} data-testid={`school-entry-${entry.id}`}>
                {/* Only the sum of everything needs each tournament named
                    inside the card; a single tournament is named above it. */}
                {selected === ALL ? (
                  <Link
                    to={routes.publicSchedule(entry.slug, entry.id)}
                    className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="min-w-0 truncate">{entry.name}</span>
                    <span className="font-tabular shrink-0 normal-case tracking-normal">
                      {entry.totals.played} {t("played")}, {entry.totals.wins}{" "}
                      {t("won")}
                    </span>
                  </Link>
                ) : null}
                {entry.teams.length === 0 ? (
                  <p className="px-4 py-4 text-center text-sm text-muted-foreground">
                    {t("No teams in this tournament.")}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {entry.teams.map((team) => (
                      <TeamRow key={team.team_id} team={team} entry={entry} />
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}

          {showBadges ? (
            <div
              data-testid="school-badges"
              className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3"
            >
              <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-semibold">
                <Award aria-hidden="true" className="h-4 w-4 text-primary" />
                {t("Achievements")}
              </span>
              {school.badges.map((b) => (
                <span
                  key={b.id}
                  className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                >
                  {b.name}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
