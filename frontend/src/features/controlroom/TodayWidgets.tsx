import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, MapPin, Radio, Trophy } from "lucide-react";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type ControlRoomVenue,
} from "@/api/tournaments";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  FINAL,
  IN_PLAY,
  fmtKickoff,
  isCalled,
  isOverdue,
  urgencyWeight,
} from "./format";
import { StatusPill } from "./MatchTile";

const teamName = (tm: { name: string } | null): string => tm?.name || t("TBD");

/** Section shell — a titled card so every panel reads consistently. */
function Panel({
  title,
  icon: Icon,
  count,
  action,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="panel flex flex-col">
      <div className="panel-header">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <h3 className="panel-title">{title}</h3>
        {count != null ? (
          <span className="font-tabular text-xs text-muted-foreground">{count}</span>
        ) : null}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * LIVE NOW — the matches in play, big and glanceable: competition, teams,
 * running score, court, and a one-tap console link for the scorer.
 */
export function LiveNowPanel({
  matches,
  tournamentId,
}: {
  matches: ControlRoomMatch[];
  tournamentId: string;
}): React.ReactElement | null {
  const live = matches.filter((m) => IN_PLAY.has(m.status));
  // Nothing live: render nothing — the On-now KPI already says 0, and an
  // empty card was pure noise (owner: "it still looks the same").
  if (live.length === 0) return null;
  return (
    <Panel title={t("Live now")} icon={Radio} count={live.length}>
      {(
        <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
          {live.map((m) => (
            <div key={m.id} className="flex flex-col gap-1.5 bg-card p-2.5">
              <div className="flex items-center gap-2">
                <StatusPill match={m} idScope="live-" />
                {m.venue ? (
                  <span className="inline-flex items-center gap-0.5 text-[0.6875rem] text-muted-foreground">
                    <MapPin aria-hidden="true" className="h-3 w-3" />
                    {m.venue}
                  </span>
                ) : null}
              </div>
              <LeafLabel label={m.leaf_label} />
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span className="truncate text-right text-[13px] font-medium">
                  {teamName(m.home_team)}
                </span>
                <span className="px-2 font-tabular text-base font-semibold">
                  {m.home_score ?? 0} - {m.away_score ?? 0}
                </span>
                <span className="truncate text-[13px] font-medium">
                  {teamName(m.away_team)}
                </span>
              </div>
              <Link
                to={routes.matchConsole(tournamentId, m.id)}
                className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
              >
                {t("Open console")}
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/**
 * COURTS TODAY — one row per court: what is on it now (live/called), what is up
 * next, and how far through its day it is. The at-a-glance venue picture.
 */
export function CourtsPanel({
  venues,
  timeZone,
}: {
  venues: ControlRoomVenue[];
  timeZone: string;
}): React.ReactElement {
  return (
    <Panel title={t("Courts today")} icon={MapPin} count={venues.length}>
      <div className="flex flex-col divide-y divide-border">
        {venues.map((v) => {
          const now =
            v.matches.find((m) => IN_PLAY.has(m.status)) ??
            v.matches.find((m) => isCalled(m)) ??
            null;
          const next = v.matches.find(
            (m) => m.status === "scheduled" && !isCalled(m),
          );
          const done = v.matches.filter(
            (m) => FINAL.has(m.status) || m.status === "completed",
          ).length;
          const total = v.matches.length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          return (
            <div
              key={v.venue || "unassigned"}
              className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3 px-3 py-1.5 sm:grid-cols-[10rem_1fr_auto]"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {now && IN_PLAY.has(now.status) ? (
                  <span className="relative flex h-1.5 w-1.5 shrink-0" aria-label={t("Live now")}>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                ) : null}
                <span className="truncate text-[13px] font-medium">
                  {v.venue || t("No court")}
                </span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {now ? (
                  `${teamName(now.home_team)} v ${teamName(now.away_team)}`
                ) : next ? (
                  <>
                    <span className="font-tabular text-foreground">
                      {fmtKickoff(next.scheduled_at, timeZone)}
                    </span>
                    {` ${teamName(next.home_team)} v ${teamName(next.away_team)}`}
                  </>
                ) : (
                  t("Idle")
                )}
              </p>
              <div className="flex w-20 shrink-0 items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-8 text-right font-tabular text-[0.6875rem] text-muted-foreground">
                  {done}/{total}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** COMPETITION PROGRESS — a completion bar per competition leaf. */
export function CompetitionProgressPanel({
  matches,
}: {
  matches: ControlRoomMatch[];
}): React.ReactElement {
  const byLeaf = new Map<
    string,
    { label: string; total: number; done: number; live: number }
  >();
  for (const m of matches) {
    const key = m.leaf_label || m.leaf_key;
    const g = byLeaf.get(key) ?? { label: key, total: 0, done: 0, live: 0 };
    g.total += 1;
    if (FINAL.has(m.status) || m.status === "completed") g.done += 1;
    if (IN_PLAY.has(m.status)) g.live += 1;
    byLeaf.set(key, g);
  }
  // Group by sport (first label segment) so "Table Tennis" prints once as a
  // section header instead of on every row.
  const groups = new Map<
    string,
    { rest: string[]; total: number; done: number; live: number }[]
  >();
  for (const r of byLeaf.values()) {
    const segs = r.label.split(/\s+[\u00b7\u2014]\s+/);
    const sport = segs[0] || t("Uncategorized");
    const rows = groups.get(sport) ?? [];
    rows.push({ ...r, rest: segs.slice(1) });
    groups.set(sport, rows);
  }
  const sports = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const leafCount = byLeaf.size;
  return (
    <Panel title={t("Competition progress")} icon={Trophy} count={leafCount}>
      <div className="flex flex-col">
        {sports.map((sport) => {
          const rows = groups
            .get(sport)!
            .sort((a, b) => a.rest.join(" ").localeCompare(b.rest.join(" ")));
          const agg = rows.reduce(
            (acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
            { done: 0, total: 0 },
          );
          return (
            <div key={sport} className="border-b border-border last:border-b-0">
              <div className="flex items-baseline gap-2 bg-muted/40 px-3 py-1">
                <p className="text-xs font-semibold text-foreground">{sport}</p>
                <span className="font-tabular text-[0.6875rem] text-muted-foreground">
                  {agg.done}/{agg.total}
                </span>
              </div>
              <div className="flex flex-col divide-y divide-border/60">
                {rows.map((r) => {
                  const pct =
                    r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
                  return (
                    <div
                      key={`${sport}-${r.rest.join("-")}`}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-1"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-1">
                        {r.rest.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t("All matches")}
                          </span>
                        ) : (
                          r.rest.map((seg, i) => (
                            <span
                              key={`${i}-${seg}`}
                              className="rounded bg-muted px-1.5 py-px text-[0.6875rem] font-medium text-foreground"
                            >
                              {seg}
                            </span>
                          ))
                        )}
                      </span>
                      <div className="flex w-32 shrink-0 items-center gap-2">
                        {r.live > 0 ? (
                          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[0.625rem] font-medium leading-4 text-primary">
                            {r.live}
                          </span>
                        ) : null}
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-9 text-right font-tabular text-[0.6875rem] text-muted-foreground">
                          {r.done}/{r.total}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** RECENT RESULTS — the last handful of finished matches. */
export function RecentResultsPanel({
  matches,
  timeZone,
}: {
  matches: ControlRoomMatch[];
  timeZone: string;
}): React.ReactElement | null {
  const done = matches
    .filter((m) => FINAL.has(m.status) || m.status === "completed")
    .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? ""))
    .slice(0, 7);
  if (done.length === 0) return null;
  return (
    <Panel title={t("Recent results")} icon={CheckCircle2} count={done.length}>
      {(
        <div className="flex flex-col divide-y divide-border">
          {done.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
              <span className="w-11 shrink-0 font-tabular text-xs text-muted-foreground">
                {fmtKickoff(m.scheduled_at, timeZone)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {teamName(m.home_team)}{" "}
                <span className="text-muted-foreground">{t("v")}</span>{" "}
                {teamName(m.away_team)}
              </span>
              <span className="shrink-0 font-tabular font-semibold">
                {m.home_score ?? 0} - {m.away_score ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** One-line reason a match needs attention. */
function reason(m: ControlRoomMatch): string {
  if (isOverdue(m)) return t("Awaiting result");
  if (isCalled(m)) return t("Called, not started");
  if (!m.venue) return t("No court assigned");
  return t("Needs attention");
}

/**
 * NEEDS ATTENTION — the exceptions, ranked; each links straight into the Matches
 * board (where every action lives) so tracking flows into acting. Renders
 * nothing when caught up — the ops strip's "Needs you" cell already says so,
 * and an empty card was dead space (compact pass 2026-07-03).
 */
export function NeedsAttentionPanel({
  matches,
  timeZone,
  tournamentId,
}: {
  matches: ControlRoomMatch[];
  timeZone: string;
  tournamentId: string;
}): React.ReactElement | null {
  const items = matches
    .filter((m) => urgencyWeight(m) > 0 && !IN_PLAY.has(m.status))
    .sort(
      (a, b) =>
        urgencyWeight(b) - urgencyWeight(a) ||
        (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""),
    );
  if (items.length === 0) return null;
  return (
    <Panel
      title={t("Needs attention")}
      icon={CheckCircle2}
      count={items.length}
      action={
        <Link
          to={routes.tournamentMatches(tournamentId)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t("Open board")}
        </Link>
      }
    >
      {(
        <div className="flex flex-col divide-y divide-border">
          {items.slice(0, 7).map((m) => (
            <Link
              key={m.id}
              to={routes.tournamentMatches(tournamentId)}
              className={cn(
                "flex items-center gap-3 border-l-2 px-3 py-1.5 transition-colors hover:bg-secondary/40",
                isOverdue(m) ? "border-l-destructive" : "border-l-warning-foreground",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                  <StatusPill match={m} idScope="attn-" />
                  <span className="font-tabular">
                    {fmtKickoff(m.scheduled_at, timeZone)}
                  </span>
                  <span className="truncate">{reason(m)}</span>
                </div>
                <p className="truncate text-xs font-medium">
                  {teamName(m.home_team)} {t("v")} {teamName(m.away_team)}
                </p>
              </div>
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Card-derived suspensions (PRD 5.8) — who cannot be named today. Hidden
 * when nobody is serving a ban. */
export function SuspensionsPanel({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement | null {
  const q = useQuery({
    queryKey: ["t-suspensions", tournamentId],
    queryFn: () => tournamentsApi.suspensions(tournamentId),
    staleTime: 60_000,
  });
  const active = (q.data?.suspensions ?? []).filter((s) => s.active);
  if (active.length === 0) return null;
  const reasonLabel: Record<string, string> = {
    red_card: "Red card",
    second_yellow: "Second yellow",
    yellow_accumulation: "Yellow cards",
  };
  return (
    <section data-testid="suspensions-panel" className="panel">
      <div className="panel-header">
        <h3 className="panel-title">{t("Suspended players")}</h3>
        <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-tabular text-xs text-destructive">
          {active.length}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {active.map((s) => (
          <li
            key={`${s.player_id}-${s.triggered_match_id}`}
            className="flex items-center gap-3 px-3 py-1.5 text-[13px]"
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {s.player_name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {s.team_name}
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t(reasonLabel[s.reason] ?? s.reason)}
            </span>
            <span className="font-tabular text-xs text-muted-foreground">
              {s.served}/{s.banned_matches} {t("served")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * LEADERS — the owner's "best players, teams, scorers" surface, right on the
 * cockpit: top scorers, tightest defence, sharpest attack, latest badges.
 * Everything builds automatically as results land; before that it says so
 * instead of hiding (the feature must be discoverable on day zero).
 */
export function LeadersPanel({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const q = useQuery({
    queryKey: ["t-leaders", tournamentId],
    queryFn: () => tournamentsApi.leaders(tournamentId),
    staleTime: 60_000,
  });
  const d = q.data;
  const empty = !d || d.played === 0;

  return (
    <section data-testid="leaders-panel" className="panel">
      <div className="panel-header">
        <Trophy aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
        <h3 className="panel-title">{t("Leaders")}</h3>
        {!empty ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {d.played} {t("played")}
          </span>
        ) : null}
        <Link
          to={routes.tournamentLeaders(tournamentId)}
          className="ml-auto text-xs font-medium text-primary hover:underline"
        >
          {t("View all")}
        </Link>
      </div>

      {empty ? (
        // Day-zero: render the BOARD, not a sentence — ranked slots waiting
        // to fill, so the feature is unmistakable before results land.
        <div>
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[t("Top scorers"), t("Best defence"), t("Latest badges")].map(
              (col) => (
                <div key={col} className="flex flex-col gap-1.5 p-2.5">
                  <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {col}
                  </p>
                  {[1, 2, 3].map((rank) => (
                    <div key={rank} className="flex items-center gap-2">
                      <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground/60">
                        {rank}
                      </span>
                      <span className="h-2 flex-1 rounded-full bg-muted" />
                      <span className="h-2 w-6 rounded-full bg-muted" />
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>
          <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            {t("Fills automatically and updates live as results come in.")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="flex flex-col gap-1 p-2.5">
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t("Top scorers")}
            </p>
            {d.top_scorers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("No goal scorers yet (set sports rank by points below).")}
              </p>
            ) : (
              <ol className="flex flex-col gap-1">
                {d.top_scorers.map((s, i) => (
                  <li key={s.player_id} className="flex items-center gap-2 text-sm">
                    <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {s.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {s.team_name}
                    </span>
                    <span className="font-tabular text-sm font-semibold">
                      {s.goals}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="flex flex-col gap-2 p-2.5">
            <div>
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {t("Best defence")}
              </p>
              {d.best_defence.slice(0, 2).map((r) => (
                <p key={r.team_id} className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {r.team_name}
                  </span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {r.conceded} {t("conceded in")} {r.played}
                  </span>
                </p>
              ))}
            </div>
            <div>
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {t("Best attack")}
              </p>
              {d.best_attack.slice(0, 2).map((r) => (
                <p key={r.team_id} className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {r.team_name}
                  </span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {r.scored} {t("scored in")} {r.played}
                  </span>
                </p>
              ))}
            </div>
            {d.latest_badges.length > 0 ? (
              <div>
                <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t("Latest badges")}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {d.latest_badges.slice(0, 4).map((b) => (
                    <Link
                      key={b.id}
                      to={`/cert/${b.id}`}
                      className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[0.6875rem] font-medium text-primary hover:bg-primary/10"
                      title={b.subject}
                    >
                      <Trophy aria-hidden="true" className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {b.name} · {b.subject}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
