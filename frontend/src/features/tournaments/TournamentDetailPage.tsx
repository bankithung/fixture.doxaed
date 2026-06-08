import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ClipboardList,
  GitBranch,
  Link2,
  Trophy,
  Users,
  Wand2,
} from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type StandingsGroup,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { DisputesPanel } from "@/features/disputes/DisputesPanel";
import { StageStepper } from "./StageStepper";

const LINK_BTN =
  "inline-flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function ScoreRow({
  match,
  tournamentId,
}: {
  match: MatchRow;
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.score(match.id, {
        home_score: Number(home),
        away_score: Number(away),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-matches", tournamentId] });
      qc.invalidateQueries({ queryKey: ["t-standings", tournamentId] });
    },
  });
  const done = match.status === "completed";

  return (
    <div className="flex items-center gap-2 border-t border-border py-2 text-sm first:border-t-0">
      <span className="flex-1 truncate text-right font-medium">
        {match.home_team?.name ?? t("TBD")}
      </span>
      {done ? (
        <span className="w-16 shrink-0 text-center font-tabular text-base font-semibold">
          {match.home_score} <span className="text-muted-foreground">–</span>{" "}
          {match.away_score}
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <Input
            aria-label={t("Home score")}
            inputMode="numeric"
            value={home}
            onChange={(e) => setHome(e.target.value)}
            className="h-8 w-11 text-center font-tabular"
          />
          <span className="text-muted-foreground">–</span>
          <Input
            aria-label={t("Away score")}
            inputMode="numeric"
            value={away}
            onChange={(e) => setAway(e.target.value)}
            className="h-8 w-11 text-center font-tabular"
          />
          <Button
            size="sm"
            disabled={home === "" || away === "" || save.isPending}
            onClick={() => save.mutate()}
          >
            {t("Save")}
          </Button>
        </span>
      )}
      <span className="flex-1 truncate">{match.away_team?.name ?? t("TBD")}</span>
      <Link
        to={routes.matchConsole(tournamentId, match.id)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent/40 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("Live")}
      </Link>
    </div>
  );
}

function statusBadge(status: string): { label: string; cls: string } {
  if (status.startsWith("live")) return { label: "Live", cls: "bg-primary/15 text-primary" };
  const m: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    published: { label: "Published", cls: "bg-secondary text-secondary-foreground" },
    registration_open: { label: "Registration open", cls: "bg-secondary text-secondary-foreground" },
    scheduled: { label: "Scheduled", cls: "bg-secondary text-secondary-foreground" },
    completed: { label: "Completed", cls: "bg-accent text-accent-foreground" },
    archived: { label: "Archived", cls: "bg-muted text-muted-foreground" },
  };
  return m[status] ?? { label: status.replace(/_/g, " "), cls: "bg-muted text-muted-foreground" };
}

const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

/** KPI tile — matches the workspace dashboard's stat language for cohesion. */
function Stat({
  label,
  value,
  sub,
  live,
}: {
  label: string;
  value: number | string;
  sub?: string;
  live?: boolean;
}): React.ReactElement {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        ) : null}
        {label}
      </div>
      <div className="mt-1 font-tabular text-2xl font-semibold tracking-tight sm:text-3xl">
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/** One step of the "Get started" onboarding strip. */
function SetupStep({
  index,
  title,
  hint,
  state,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  state: "done" | "active" | "todo";
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4",
        state === "active"
          ? "border-primary/40 bg-primary/[0.04]"
          : "border-border bg-background",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-full font-tabular text-xs font-semibold",
            state === "done"
              ? "bg-primary text-primary-foreground"
              : state === "active"
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "bg-muted text-muted-foreground",
          )}
        >
          {state === "done" ? (
            <Check aria-hidden="true" className="h-4 w-4" />
          ) : (
            index
          )}
        </span>
        <span
          className={cn(
            "text-sm font-semibold",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {title}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      {children ? (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">{children}</div>
      ) : null}
    </li>
  );
}

const STAT_COLS = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts"] as const;

function StandingsTable({ group }: { group: StandingsGroup }): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{group.group_label}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t("Team")}</th>
              {STAT_COLS.map((h) => (
                <th key={h} className="px-2 py-2 text-right font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr
                key={r.team_id}
                className="border-t border-border transition-colors hover:bg-accent/40"
              >
                <td className="px-4 py-2 font-medium">{r.name}</td>
                {[r.P, r.W, r.D, r.L, r.GF, r.GA, r.GD, r.Pts].map((v, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-2 py-2 text-right font-tabular",
                      i === 7
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TournamentDetailPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const tournament = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
  });
  const teams = useQuery({
    queryKey: ["t-teams", id],
    queryFn: () => tournamentsApi.teams(id),
  });
  const matches = useQuery({
    queryKey: ["t-matches", id],
    queryFn: () => tournamentsApi.matches(id),
  });
  const standings = useQuery({
    queryKey: ["t-standings", id],
    queryFn: () => tournamentsApi.standings(id),
  });

  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createLink = useMutation({
    mutationFn: () => tournamentsApi.createRegistrationLink(id),
    onSuccess: (r) =>
      setLinkUrl(`${window.location.origin}/register/${r.token}`),
  });
  const generate = useMutation({
    mutationFn: (format: "round_robin" | "knockout" | "knockout_from_groups") =>
      tournamentsApi.generateFixtures(id, { format }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-matches", id] });
      qc.invalidateQueries({ queryKey: ["t-standings", id] });
    },
  });

  const grouped = useMemo(() => {
    const g: Record<string, MatchRow[]> = {};
    for (const m of matches.data ?? []) {
      (g[m.group_label || "—"] ||= []).push(m);
    }
    return g;
  }, [matches.data]);

  const teamCount = teams.data?.length ?? 0;
  const matchCount = matches.data?.length ?? 0;
  const playerCount = (teams.data ?? []).reduce(
    (n, tm) => n + (tm.player_count ?? 0),
    0,
  );
  const hasKnockout = (matches.data ?? []).some((m) => m.stage === "knockout");
  const hasGroups = (matches.data ?? []).some((m) => m.stage === "group");
  const anyCompleted = (matches.data ?? []).some((m) => m.status === "completed");
  const setupDone = teamCount > 0 && matchCount > 0 && anyCompleted;

  const copyLink = async (): Promise<void> => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.push({
        kind: "success",
        title: t("Link copied"),
        description: t("Share it with schools so they can register."),
      });
    } catch {
      toast.push({
        kind: "error",
        title: t("Could not copy"),
        description: t("Copy the link manually instead."),
      });
    }
  };

  const name = tournament.data?.name ?? t("Tournament");
  const status = tournament.data?.status ?? "draft";
  const sport = tournament.data?.sport_code;
  const badge = statusBadge(status);

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Back link */}
      <Link
        to={routes.tournaments()}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("All tournaments")}
      </Link>

      {/* Identity header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight sm:text-3xl">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10">
              <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
            </span>
            <span className="truncate">{name}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-medium capitalize",
                badge.cls,
              )}
            >
              {t(badge.label)}
            </span>
            {sport ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium capitalize text-muted-foreground">
                {sport}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link to={routes.tournamentMembers(id)} className={LINK_BTN}>
            <Users aria-hidden="true" className="h-4 w-4" />
            {t("Members")}
          </Link>
          <Link to={routes.tournamentForms(id)} className={LINK_BTN}>
            <ClipboardList aria-hidden="true" className="h-4 w-4" />
            {t("Forms")}
          </Link>
          <Button onClick={() => createLink.mutate()} disabled={createLink.isPending}>
            <Link2 aria-hidden="true" className="h-4 w-4" />
            {t("Share registration link")}
          </Button>
        </div>
      </div>

      {/* Setup-stage stepper (WS4) — the staged-flow spine. */}
      <StageStepper tournamentId={id} />

      {/* KPI stat row — same language as the workspace dashboard. */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-xl border border-border bg-card shadow-sm md:grid-cols-4 md:divide-y-0">
        <Stat label={t("Teams")} value={teamCount} sub={t("registered")} />
        <Stat label={t("Fixtures")} value={matchCount} sub={t("scheduled")} />
        <Stat label={t("Players")} value={playerCount} sub={t("across teams")} />
        <Stat
          label={t("Status")}
          value={t(badge.label)}
          live={status.startsWith("live")}
        />
      </div>

      {/* Newly-created registration link banner. */}
      {linkUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.04] p-3 shadow-sm">
          <span className={cn(OVERLINE, "w-full")}>
            {t("Share this link with schools")}
          </span>
          <code className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-2 font-tabular text-xs">
            {linkUrl}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyLink()}
            aria-label={t("Copy registration link")}
          >
            {copied ? (
              <Check aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Link2 aria-hidden="true" className="h-4 w-4" />
            )}
            {copied ? t("Copied") : t("Copy")}
          </Button>
        </div>
      ) : null}

      {/* Get started — onboarding strip, hidden once the tournament is rolling. */}
      {!setupDone ? (
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className={cn(OVERLINE, "mb-3")}>{t("Get started")}</p>
          <ol className="grid gap-3 md:grid-cols-3">
            <SetupStep
              index={1}
              title={t("Add teams")}
              hint={t("Share the registration link or open a form so schools can enter.")}
              state={teamCount > 0 ? "done" : "active"}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => createLink.mutate()}
                disabled={createLink.isPending}
              >
                <Link2 aria-hidden="true" className="h-4 w-4" />
                {t("Share link")}
              </Button>
              <Link to={routes.tournamentForms(id)} className={LINK_BTN + " h-9 px-3 text-sm"}>
                <ClipboardList aria-hidden="true" className="h-4 w-4" />
                {t("Forms")}
              </Link>
            </SetupStep>

            <SetupStep
              index={2}
              title={t("Generate fixtures")}
              hint={
                teamCount < 2
                  ? t("Add at least 2 teams first.")
                  : t("Create a round-robin or knockout draw automatically.")
              }
              state={matchCount > 0 ? "done" : teamCount >= 2 ? "active" : "todo"}
            >
              {matchCount === 0 && teamCount >= 2 ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => generate.mutate("round_robin")}
                    disabled={generate.isPending}
                  >
                    <Wand2 aria-hidden="true" className="h-4 w-4" />
                    {t("Round-robin")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => generate.mutate("knockout")}
                    disabled={generate.isPending}
                  >
                    <GitBranch aria-hidden="true" className="h-4 w-4" />
                    {t("Knockout")}
                  </Button>
                </>
              ) : matchCount > 0 && hasGroups && !hasKnockout ? (
                <Button
                  size="sm"
                  onClick={() => generate.mutate("knockout_from_groups")}
                  disabled={generate.isPending}
                >
                  <GitBranch aria-hidden="true" className="h-4 w-4" />
                  {t("Generate knockout")}
                </Button>
              ) : null}
            </SetupStep>

            <SetupStep
              index={3}
              title={t("Score & track")}
              hint={t("Enter scores in Fixtures below; standings update automatically.")}
              state={anyCompleted ? "done" : matchCount > 0 ? "active" : "todo"}
            >
              {matchCount > 0 ? (
                <Link to={routes.tournamentBracket(id)} className={LINK_BTN + " h-9 px-3 text-sm"}>
                  <GitBranch aria-hidden="true" className="h-4 w-4" />
                  {t("Bracket")}
                </Link>
              ) : null}
            </SetupStep>
          </ol>
        </section>
      ) : null}

      {/* Teams */}
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Users aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("Teams")}</h2>
          <span className="font-tabular text-xs text-muted-foreground">
            {teamCount}
          </span>
        </div>
        <div className="p-4">
          {teams.isLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-lg border border-border bg-muted"
                />
              ))}
            </div>
          ) : teamCount === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Users
                aria-hidden="true"
                className="h-8 w-8 text-muted-foreground/40"
              />
              <p className="text-sm text-muted-foreground">
                {t(
                  "No teams yet — share the registration link so schools can enter.",
                )}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {teams.data!.map((tm) => (
                <div
                  key={tm.id}
                  className="rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <div className="truncate text-sm font-medium">{tm.name}</div>
                  <div className="mt-0.5 font-tabular text-xs text-muted-foreground">
                    {tm.pool || t("Unseeded")} · {tm.player_count}{" "}
                    {t("players")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Fixtures & scores */}
      {matchCount > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("Fixtures & scores")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(grouped).map(([label, ms]) => (
              <div
                key={label}
                className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              >
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold">{label}</h3>
                </div>
                <div className="px-4 py-2">
                  {ms.map((m) => (
                    <ScoreRow key={m.id} match={m} tournamentId={id} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Standings */}
      {(standings.data?.groups.length ?? 0) > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("Standings")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {standings.data!.groups.map((g) => (
              <StandingsTable key={g.group_label} group={g} />
            ))}
          </div>
        </section>
      ) : null}

      <DisputesPanel tournamentId={id} />
    </div>
  );
}
