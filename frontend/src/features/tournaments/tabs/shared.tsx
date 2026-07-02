import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  tournamentsApi,
  type MatchRow,
  type StandingsGroup,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/types/api";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

export function statusBadge(status: string): { label: string; cls: string } {
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

/** KPI tile. */
export function Stat({
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

// Set/game-based sports record per-set scores. The rules (sets to play, points
// per set, deciding-set variations) are resolved SERVER-side per match —
// sport profile merged with any organizer override — and arrive on
// `match.scoring`; nothing is mirrored or hardcoded here.

/** Compact set-by-set entry for racket/net sports (e.g. 11-8 9-11 11-6). */
function SetScoreEntry({
  match,
  tournamentId,
  rules,
}: {
  match: MatchRow;
  tournamentId: string;
  rules: { best_of: number; points: number };
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [sets, setSets] = useState<string[][]>(() =>
    Array.from({ length: rules.best_of }, () => ["", ""]),
  );
  const upd = (i: number, j: number, v: string): void =>
    setSets((prev) =>
      prev.map((s, k) => (k === i ? (j === 0 ? [v, s[1]] : [s[0], v]) : s)),
    );
  const filled = sets
    .filter(([h, a]) => h !== "" && a !== "")
    .map(([h, a]) => [Number(h), Number(a)]);
  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.scoreSets(match.id, {
        set_scores: filled,
        event_id: newEventId(),
      }),
    onSuccess: () => invalidateTournament(qc, tournamentId),
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Check the set scores"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  return (
    <span className="flex shrink-0 flex-wrap items-center justify-center gap-1.5">
      {sets.map((s, i) => (
        <span key={i} className="flex items-center gap-0.5" title={t(`Set ${i + 1}`)}>
          <Input
            aria-label={t(`Set ${i + 1} home`)}
            inputMode="numeric"
            value={s[0]}
            onChange={(e) => upd(i, 0, e.target.value)}
            className="h-8 w-9 px-1 text-center font-tabular"
          />
          <span className="text-xs text-muted-foreground">-</span>
          <Input
            aria-label={t(`Set ${i + 1} away`)}
            inputMode="numeric"
            value={s[1]}
            onChange={(e) => upd(i, 1, e.target.value)}
            className="h-8 w-9 px-1 text-center font-tabular"
          />
        </span>
      ))}
      <Button
        size="sm"
        disabled={filled.length < 2 || save.isPending}
        onClick={() => save.mutate()}
      >
        {t("Save")}
      </Button>
    </span>
  );
}

/** "Sat 1 Aug, 09:00 · Indoor Hall" — when the engine has scheduled a match. */
function scheduleMeta(match: MatchRow): string {
  const parts: string[] = [];
  if (match.scheduled_at) {
    parts.push(
      new Date(match.scheduled_at).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  if (match.venue) parts.push(match.venue);
  return parts.join(" · ");
}

export function ScoreRow({
  match,
  tournamentId,
}: {
  match: MatchRow;
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const rules = match.scoring;
  const meta = scheduleMeta(match);
  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.score(match.id, {
        home_score: Number(home),
        away_score: Number(away),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
    },
  });
  const done = match.status === "completed";
  const setDetail =
    rules && match.set_scores?.length
      ? match.set_scores.map((s) => `${s[0]}-${s[1]}`).join(", ")
      : "";

  return (
    <div className="border-t border-border py-2 first:border-t-0">
      {meta ? (
        <p className="pb-1 text-center font-tabular text-[0.6875rem] text-muted-foreground">
          {meta}
        </p>
      ) : null}
      <div className="flex items-center gap-2 text-sm">
      <span className="flex-1 truncate text-right font-medium">
        {match.home_team?.name ?? t("TBD")}
      </span>
      {done ? (
        <span className="shrink-0 text-center">
          <span className="block font-tabular text-base font-semibold">
            {match.home_score} <span className="text-muted-foreground">-</span>{""}
            {match.away_score}
          </span>
          {setDetail ? (
            <span className="block font-tabular text-[0.625rem] text-muted-foreground">
              {setDetail}
            </span>
          ) : null}
        </span>
      ) : rules ? (
        <SetScoreEntry match={match} tournamentId={tournamentId} rules={rules} />
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <Input
            aria-label={t("Home score")}
            inputMode="numeric"
            value={home}
            onChange={(e) => setHome(e.target.value)}
            className="h-8 w-11 text-center font-tabular"
          />
          <span className="text-muted-foreground">-</span>
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
    </div>
  );
}

const STAT_COLS = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts"] as const;

export function StandingsTable({ group }: { group: StandingsGroup }): React.ReactElement {
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
                      i === 7 ? "font-semibold text-foreground" : "text-muted-foreground",
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

/** Shared empty-state card for tabs. */
export function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card py-12 text-center">
      <div className="text-muted-foreground/40">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
      {children ? <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}
