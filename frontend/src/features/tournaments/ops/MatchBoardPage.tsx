import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, MapPin, Radio, Search, SquarePen, UserCog } from "lucide-react";
import { liveApi } from "@/api/live";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { AssignDrawer } from "@/features/controlroom/AssignDrawer";
import {
  QuickResultDialog,
  type ControlRoomPerms,
} from "@/features/controlroom/MatchActionsMenu";
import { StatusPill } from "@/features/controlroom/MatchTile";
import {
  FINAL,
  IN_PLAY,
  fmtDayLabel,
  fmtKickoff,
} from "@/features/controlroom/format";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";

/** The tournament-local calendar date ("YYYY-MM-DD") a match falls on, or ""
 * (unscheduled). Tournament TZ, never the viewer's (invariant 14). */
function tzDate(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** Coarse lifecycle bucket the status filter + sort key off. */
function statusBucket(status: string): "live" | "upcoming" | "done" | "other" {
  if (IN_PLAY.has(status)) return "live";
  if (FINAL.has(status)) return "done";
  if (status === "scheduled") return "upcoming";
  return "other";
}

/** Humanize a leaf key as a last resort when the row carries no `leaf_label`. */
function humanizeLeaf(key: string): string {
  if (!key) return t("Tournament");
  return key
    .split(".")
    .map((seg) => seg.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(" · ");
}

function leafLabelOf(m: ControlRoomMatch): string {
  return m.leaf_label || humanizeLeaf(m.leaf_key);
}

type StatusFilter = "all" | "upcoming" | "live" | "done";
type GroupBy = "day" | "competition" | "venue" | "status";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "live", label: "Live" },
  { key: "done", label: "Done" },
];

const GROUP_LABEL: Record<GroupBy, string> = {
  day: "Day",
  competition: "Competition",
  venue: "Venue",
  status: "Status",
};

const STATUS_GROUP_LABEL: Record<string, string> = {
  live: "Live now",
  upcoming: "Upcoming",
  done: "Completed",
  other: "Other",
};
const STATUS_GROUP_ORDER = ["live", "upcoming", "done", "other"];

/** One match line on the board — time, match-up, competition + venue, crew
 * chips, score/status, and the permission-gated inline actions. */
function BoardRow({
  match,
  tz,
  tournamentId,
  perms,
  onAssign,
  onResult,
}: {
  match: ControlRoomMatch;
  tz: string;
  tournamentId: string;
  perms: ControlRoomPerms;
  onAssign: () => void;
  onResult: () => void;
}): React.ReactElement {
  const officials = match.officials ?? [];
  const isScorer = match.scorer !== null && match.scorer.id === perms.userId;
  const showConsole = perms.canScore || isScorer;
  const showResult =
    showConsole && (match.status === "scheduled" || match.status === "live");
  const showScore = IN_PLAY.has(match.status) || FINAL.has(match.status);

  return (
    <div
      data-testid={`board-row-${match.id}`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm lg:flex-row lg:items-center"
    >
      {/* Time + matchup */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="w-12 shrink-0 font-tabular text-sm font-semibold tabular-nums">
          {match.scheduled_at ? fmtKickoff(match.scheduled_at, tz) : t("TBD")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
            <span className="truncate text-right font-medium">
              {match.home_team?.name ?? t("TBD")}
            </span>
            <span
              className={cn(
                "px-1 text-center font-tabular",
                showScore ? "font-semibold" : "text-xs text-muted-foreground",
              )}
            >
              {showScore
                ? `${match.home_score ?? 0} – ${match.away_score ?? 0}`
                : t("vs")}
            </span>
            <span className="truncate font-medium">
              {match.away_team?.name ?? t("TBD")}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{leafLabelOf(match)}</span>
            {match.venue ? (
              <span className="inline-flex items-center gap-0.5">
                <MapPin aria-hidden="true" className="h-3 w-3" />
                {match.venue}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      {/* Crew + status + actions */}
      <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
        {match.scorer ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
            <Radio aria-hidden="true" className="h-3 w-3" />
            {match.scorer.name}
          </span>
        ) : null}
        {officials.map((o) => (
          <span
            key={o.id}
            title={o.role}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground"
          >
            <UserCog aria-hidden="true" className="h-3 w-3" />
            {o.name}
          </span>
        ))}
        <StatusPill match={match} />

        {showResult ? (
          <Button
            size="sm"
            variant="outline"
            data-testid={`board-result-${match.id}`}
            className="border-primary/40 text-primary hover:bg-primary/10"
            onClick={onResult}
          >
            <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Result")}
          </Button>
        ) : null}
        {showConsole ? (
          <Link
            to={routes.matchConsole(tournamentId, match.id)}
            data-testid={`board-console-${match.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Radio aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Console")}
          </Link>
        ) : null}
        {perms.canSchedule ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`board-assign-${match.id}`}
            onClick={onAssign}
          >
            <UserCog aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Assign")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col bg-card p-4">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-tabular text-2xl font-semibold leading-none",
          muted && value > 0 && "text-warning-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Operations — Matches board (ops 2026-06-26). The whole generated fixture in
 * one place: every match across every day/competition/venue, filterable and
 * groupable, with inline result entry + crew assignment for managers and the
 * console link for scorers. This is the tournament-wide counterpart to the
 * per-day control room; it reads the enriched `…/matches/` endpoint and rides
 * the same public SSE tick so scores/crew advance with no refresh.
 */
export function MatchesBoardPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [comp, setComp] = useState<string>("all");
  const [venue, setVenue] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [needsScorer, setNeedsScorer] = useState(false);
  const [needsOfficial, setNeedsOfficial] = useState(false);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  const [assignMatch, setAssignMatch] = useState<ControlRoomMatch | null>(null);
  const [resultMatch, setResultMatch] = useState<ControlRoomMatch | null>(null);

  const tournamentQ = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
  });
  const matchesQ = useQuery({
    queryKey: qk.matches(id),
    queryFn: () => tournamentsApi.matchesEnriched(id),
  });
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });

  const canManage = stageQ.data?.can_manage ?? false;
  const modules = stageQ.data?.modules ?? [];
  const perms: ControlRoomPerms = {
    canManage,
    canSchedule: canManage || modules.includes("tournament.schedule_editor"),
    canScore: canManage || modules.includes("match.scoring_console"),
    userId: user?.id ?? null,
  };
  const isPlainMember = !perms.canManage && !perms.canSchedule;

  const tz = tournamentQ.data?.time_zone ?? "UTC";
  const slug = tournamentQ.data?.slug || null;

  // Live: the tournament tick refreshes the board (scores + crew advance).
  useEventStream(slug ? liveApi.streamUrl(slug, id) : null, () => {
    qc.invalidateQueries({ queryKey: qk.matches(id) });
  });

  const matches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);

  const competitions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of matches) map.set(m.leaf_key, leafLabelOf(m));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [matches]);
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) if (m.venue) set.add(m.venue);
    return [...set].sort();
  }, [matches]);

  // Headline counts (over the whole fixture, before filtering).
  const counts = useMemo(() => {
    let live = 0;
    let done = 0;
    let noScorer = 0;
    for (const m of matches) {
      const b = statusBucket(m.status);
      if (b === "live") live += 1;
      if (b === "done") done += 1;
      if (!m.scorer) noScorer += 1;
    }
    return { total: matches.length, live, done, noScorer };
  }, [matches]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return matches.filter((m) => {
      if (comp !== "all" && m.leaf_key !== comp) return false;
      if (venue !== "all" && m.venue !== venue) return false;
      if (status !== "all" && statusBucket(m.status) !== status) return false;
      if (needsScorer && m.scorer) return false;
      if (needsOfficial && (m.officials ?? []).length > 0) return false;
      if (mine && m.scorer?.id !== perms.userId) return false;
      if (needle) {
        const hay = `${m.home_team?.name ?? ""} ${m.away_team?.name ?? ""} ${leafLabelOf(m)} ${m.venue}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [matches, comp, venue, status, needsScorer, needsOfficial, mine, search, perms.userId]);

  // Group + sort. Time-ascending within a group; unscheduled last.
  const groups = useMemo(() => {
    const buckets = new Map<string, { label: string; sort: string; matches: ControlRoomMatch[] }>();
    for (const m of filtered) {
      let key: string;
      let label: string;
      let sort: string;
      if (groupBy === "day") {
        key = tzDate(m.scheduled_at, tz);
        label = key ? fmtDayLabel(key) : t("Unscheduled");
        sort = key || "9999";
      } else if (groupBy === "competition") {
        key = m.leaf_key;
        label = leafLabelOf(m);
        sort = label;
      } else if (groupBy === "venue") {
        key = m.venue || "_none";
        label = m.venue || t("No venue");
        sort = m.venue ? `0${m.venue}` : "1";
      } else {
        const b = statusBucket(m.status);
        key = b;
        label = t(STATUS_GROUP_LABEL[b] ?? b);
        sort = String(STATUS_GROUP_ORDER.indexOf(b));
      }
      let g = buckets.get(key);
      if (!g) {
        g = { label, sort, matches: [] };
        buckets.set(key, g);
      }
      g.matches.push(m);
    }
    const ordered = [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort));
    for (const g of ordered) {
      g.matches.sort((a, b) => {
        const at = a.scheduled_at ?? "~";
        const bt = b.scheduled_at ?? "~";
        if (at !== bt) return at.localeCompare(bt);
        return a.match_no - b.match_no;
      });
    }
    return ordered;
  }, [filtered, groupBy, tz]);

  const header = (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10">
        <ListChecks aria-hidden="true" className="h-5 w-5 text-primary" />
      </span>
      <div>
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {t("Operations")}
        </p>
        <h2 className="text-lg font-semibold tracking-tight">{t("Matches")}</h2>
      </div>
    </div>
  );

  if (matchesQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <div
          aria-busy="true"
          className="h-48 animate-pulse rounded-xl border border-border bg-card"
        />
      </div>
    );
  }
  if (matchesQ.isError) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load the matches.")}
        </p>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-sm font-medium">{t("No fixtures yet")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("Every generated match will appear here, ready to schedule, staff and score.")}
          </p>
        </section>
      </div>
    );
  }

  const toggle = (active: boolean, testid: string, label: string, onClick: () => void) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-foreground/30 bg-secondary text-secondary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex w-full flex-col gap-5">
      {header}

      {/* Headline counts over the whole fixture. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        <StatCell label={t("Matches")} value={counts.total} />
        <StatCell label={t("Live now")} value={counts.live} />
        <StatCell label={t("Completed")} value={counts.done} />
        <StatCell label={t("No scorer")} value={counts.noScorer} muted />
      </div>

      {/* Filter bar. */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={t("Search matches")}
              data-testid="board-search"
              placeholder={t("Search team, school or venue…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </label>
          <Select
            aria-label={t("Competition")}
            value={comp}
            onChange={setComp}
            options={[
              { value: "all", label: t("All competitions") },
              ...competitions.map(([key, label]) => ({ value: key, label })),
            ]}
          />
          {venues.length > 0 ? (
            <Select
              aria-label={t("Venue")}
              value={venue}
              onChange={setVenue}
              options={[
                { value: "all", label: t("All venues") },
                ...venues.map((v) => ({ value: v, label: v })),
              ]}
            />
          ) : (
            <span className="hidden lg:block" />
          )}
          <Select
            aria-label={t("Group by")}
            value={groupBy}
            onChange={(v) => setGroupBy(v as GroupBy)}
            options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({
              value: g,
              label: t("Group by {x}").replace("{x}", t(GROUP_LABEL[g]).toLowerCase()),
            }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div role="group" aria-label={t("Status")} className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((s) =>
              toggle(status === s.key, `board-status-${s.key}`, t(s.label), () =>
                setStatus(s.key),
              ),
            )}
          </div>
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
          {perms.canSchedule
            ? toggle(needsScorer, "board-needs-scorer", t("Needs scorer"), () =>
                setNeedsScorer((v) => !v),
              )
            : null}
          {perms.canSchedule
            ? toggle(needsOfficial, "board-needs-official", t("Needs official"), () =>
                setNeedsOfficial((v) => !v),
              )
            : null}
          {isPlainMember
            ? toggle(mine, "board-mine", t("My matches"), () => setMine((v) => !v))
            : null}
        </div>
      </div>

      {/* Grouped list. */}
      {filtered.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t("No matches fit these filters.")}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.label} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {g.label}
                </h3>
                <span className="font-tabular text-xs text-muted-foreground/70">
                  {g.matches.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {g.matches.map((m) => (
                  <BoardRow
                    key={m.id}
                    match={m}
                    tz={tz}
                    tournamentId={id}
                    perms={perms}
                    onAssign={() => setAssignMatch(m)}
                    onResult={() => setResultMatch(m)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {assignMatch ? (
        <AssignDrawer
          tournamentId={id}
          match={assignMatch}
          onClose={() => setAssignMatch(null)}
        />
      ) : null}
      {resultMatch ? (
        <QuickResultDialog
          tournamentId={id}
          match={resultMatch}
          onClose={() => setResultMatch(null)}
        />
      ) : null}
    </div>
  );
}
