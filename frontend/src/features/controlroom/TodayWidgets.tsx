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
    <section className="flex flex-col rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {count != null ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
            {count}
          </span>
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
            <div key={m.id} className="flex flex-col gap-2 bg-card p-3">
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
                <span className="truncate text-right text-sm font-medium">
                  {teamName(m.home_team)}
                </span>
                <span className="px-2 font-tabular text-lg font-semibold">
                  {m.home_score ?? 0} - {m.away_score ?? 0}
                </span>
                <span className="truncate text-sm font-medium">
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
            <div key={v.venue || "unassigned"} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {v.venue || t("No court")}
                  </span>
                  {now && IN_PLAY.has(now.status) ? (
                    <span className="relative flex h-2 w-2" aria-label={t("Live now")}>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {now
                    ? `${teamName(now.home_team)} v ${teamName(now.away_team)}`
                    : next
                      ? `${t("Next")} ${fmtKickoff(next.scheduled_at, timeZone)} · ${teamName(next.home_team)} v ${teamName(next.away_team)}`
                      : t("Idle")}
                </p>
              </div>
              <div className="w-24 shrink-0">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1 text-right font-tabular text-[0.6875rem] text-muted-foreground">
                  {done}/{total}
                </p>
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
  const rows = [...byLeaf.values()].sort(
    (a, b) => b.done / b.total - a.done / a.total || a.label.localeCompare(b.label),
  );
  return (
    <Panel title={t("Competition progress")} icon={Trophy} count={rows.length}>
      <div className="flex flex-col divide-y divide-border">
        {rows.map((r) => {
          const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
          return (
            <div key={r.label} className="flex flex-col gap-1.5 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <LeafLabel label={r.label} className="min-w-0 flex-1" />
                {r.live > 0 ? (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
                    {r.live} {t("live")}
                  </span>
                ) : null}
                <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                  {r.done}/{r.total}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
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
            <div key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="w-12 shrink-0 font-tabular text-xs text-muted-foreground">
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
 * board (where every action lives) so tracking flows into acting.
 */
export function NeedsAttentionPanel({
  matches,
  timeZone,
  tournamentId,
}: {
  matches: ControlRoomMatch[];
  timeZone: string;
  tournamentId: string;
}): React.ReactElement {
  const items = matches
    .filter((m) => urgencyWeight(m) > 0 && !IN_PLAY.has(m.status))
    .sort(
      (a, b) =>
        urgencyWeight(b) - urgencyWeight(a) ||
        (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""),
    );
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
      {items.length === 0 ? (
        <p className="px-4 py-2.5 text-sm text-muted-foreground">
          {t("All caught up. Nothing needs you.")}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.slice(0, 7).map((m) => (
            <Link
              key={m.id}
              to={routes.tournamentMatches(tournamentId)}
              className={cn(
                "flex items-center gap-3 border-l-2 px-4 py-2 transition-colors hover:bg-secondary/40",
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
    <section
      data-testid="suspensions-panel"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">{t("Suspended players")}</h3>
        <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-tabular text-xs text-destructive">
          {active.length}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {active.map((s) => (
          <li
            key={`${s.player_id}-${s.triggered_match_id}`}
            className="flex items-center gap-3 px-4 py-2 text-sm"
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
    <section
      data-testid="leaders-panel"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{t("Leaders")}</h3>
        {!empty ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
            {d.played} {t("played")}
          </span>
        ) : null}
      </div>

      {empty ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t(
            "Top scorers, best defence and badges build here automatically as results come in.",
          )}
        </p>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="flex flex-col gap-1 p-3">
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
          <div className="flex flex-col gap-2 p-3">
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
