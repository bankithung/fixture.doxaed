import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Minus, Plus, Printer, Radio, Undo2, X } from "lucide-react";
import { routes } from "@/lib/routes";
import { liveApi, type LiveTeam, type MiniPlayer } from "@/api/live";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";
import { LineupPanel } from "./LineupPanel";

const STATE_ACTIONS: Record<string, { label: string; to: string }[]> = {
  scheduled: [{ label: "Start match", to: "live" }],
  live: [
    { label: "Half time", to: "half_time" },
    { label: "Complete", to: "completed" },
  ],
  half_time: [
    { label: "Resume", to: "live" },
    { label: "Complete", to: "completed" },
  ],
};

// Event palette (live scorebox + set-piece logger). Goal counts toward score;
// the rest are non-scoring match events. `tone` maps to a token style.
const EVENT_BUTTONS: {
  type: string;
  label: string;
  tone: "primary" | "neutral" | "warn" | "danger";
}[] = [
  { type: "goal", label: "Goal", tone: "primary" },
  { type: "shot", label: "Shot", tone: "neutral" },
  { type: "save", label: "Save", tone: "neutral" },
  { type: "corner", label: "Corner", tone: "neutral" },
  { type: "free_kick", label: "Free kick", tone: "neutral" },
  { type: "foul", label: "Foul", tone: "neutral" },
  { type: "penalty_awarded", label: "Penalty", tone: "warn" },
  { type: "yellow_card", label: "Yellow", tone: "warn" },
  { type: "red_card", label: "Red", tone: "danger" },
];

// Set sports never see the goal palette (the server rejects goal events for
// them); discipline events remain recordable.
const SET_EVENT_BUTTONS = EVENT_BUTTONS.filter((b) =>
  ["yellow_card", "red_card", "foul"].includes(b.type),
);

// Token-only tone classes for the event palette buttons.
const TONE_CLS: Record<string, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover",
  neutral:
    "border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
  warn:
    "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80",
  danger:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

// Status -> badge presentation (tokens only).
function statusMeta(s: string): { label: string; badge: string; dot: string; live: boolean } {
  const live = s === "live" || s === "half_time";
  const map: Record<string, { label: string; badge: string; dot: string }> = {
    scheduled: { label: "Scheduled", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    live: { label: "Live", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    half_time: { label: "Half time", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    completed: { label: "Completed", badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
  };
  const m = map[s] ?? { label: s.replace(/_/g, " "), badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
  return { ...m, live };
}

/** Known server rejection codes -> scorer-readable messages. Every mutation
 * surfaces its failure — a tap must never silently do nothing. */
function errorMessage(e: unknown): string {
  const detail =
    e instanceof ApiError ? String(e.payload.detail ?? "") : "";
  const map: Record<string, string> = {
    not_allowed_to_score: t("You are not allowed to score this match."),
    set_based_sport_uses_set_scores: t(
      "This match is scored by sets. Enter the set scores below.",
    ),
    walkover_requires_winner: t("A walkover needs a winner recorded first."),
    knockout_match_cannot_end_drawn: t(
      "A knockout match cannot end level. Check the score.",
    ),
    event_not_found: t("That event no longer exists."),
    already_voided: t("That event was already undone."),
    cannot_void_a_void: t("Corrections cannot be undone."),
    player_not_found: t("That player was not found."),
    player_not_on_team: t("That player is not on this team."),
  };
  if (detail.startsWith("match_not_accepting_events")) {
    return t("The match is not accepting events in its current state.");
  }
  return map[detail] || detail || t("The action failed. Try again.");
}

/** Running match clock: minute derived from kickoff, ticking while live. */
function useAutoMinute(startedAt: string | null | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!active || !startedAt) return null;
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(Math.floor(ms / 60000) + 1, 200);
}

/** Header stopwatch: whole seconds elapsed since the scorer started the
 * match, ticking every second while in play (owner 2026-07-03). */
function useElapsedSeconds(
  startedAt: string | null | undefined,
  active: boolean,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!active || !startedAt) return null;
  const s = Math.floor((now - new Date(startedAt).getTime()) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Side = "home" | "away";
type SetRow = [string, string];
type SetScoring = {
  best_of?: number;
  points?: number;
  win_by?: number;
  cap?: number | null;
  deciding?: Record<string, unknown> | null;
} | null;

/** Sets won per side from the entered rows (client display only — the server
 * revalidates on completion). Mirrors the backend's lenient live counter: a
 * set counts only once it is legally WON (target reached with the margin, or
 * the cap hit); the running set counts for nobody, so 4-1 mid-set reads
 * "Sets 0-0", not 1-0. Without known rules any decided pair counts. */
function setsWon(rows: SetRow[], scoring: SetScoring): [number, number] {
  const needMinusOne = Math.floor((scoring?.best_of ?? 3) / 2);
  let h = 0;
  let a = 0;
  for (const [hs, as] of rows) {
    if (hs === "" || as === "") continue;
    const hn = Number(hs);
    const an = Number(as);
    if (!Number.isFinite(hn) || !Number.isFinite(an) || hn === an) continue;
    const deciding = h === a && h === needMinusOne;
    const d = (deciding ? scoring?.deciding : null) as {
      points?: number;
      win_by?: number;
      cap?: number | null;
    } | null;
    const target = d?.points ?? scoring?.points ?? 0;
    const winBy = d?.win_by ?? scoring?.win_by ?? 2;
    const cap = d?.cap ?? scoring?.cap ?? null;
    const hi = Math.max(hn, an);
    const lo = Math.min(hn, an);
    const won =
      target <= 0 ||
      (hi >= target && (hi - lo >= winBy || (cap != null && hi >= cap)));
    if (!won) continue;
    if (hn > an) h += 1;
    else a += 1;
  }
  return [h, a];
}

export function MatchConsolePage(): React.ReactElement {
  const { id = "", matchId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    refetchInterval: 5000,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["live", matchId] });
    // Keep the tournament's Fixtures/standings pages coherent with the score.
    if (id) invalidateTournament(qc, id);
  };

  const [minute, setMinute] = useState("");
  const [sel, setSel] = useState<{ home?: string; away?: string }>({});
  const [subOn, setSubOn] = useState<{ home?: string; away?: string }>({});
  const [confirmTo, setConfirmTo] = useState<string | null>(null);
  const [shootoutOpen, setShootoutOpen] = useState(false);
  const [pens, setPens] = useState<{ home: string; away: string }>({ home: "", away: "" });
  const [setRows, setSetRows] = useState<SetRow[]>([["", ""]]);
  const [confirmSets, setConfirmSets] = useState(false);
  // Tap scoring: how many points one +/- tap moves (owner 2026-07-03), and
  // the debounce plumbing that auto-saves the running points while live.
  const [step, setStep] = useState(1);
  const [stepText, setStepText] = useState("1");
  const seeded = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRows = useRef<SetRow[] | null>(null);

  const startedAt = query.data?.match.started_at;
  const isLiveNow = query.data?.match.status === "live";
  const inPlay =
    isLiveNow || query.data?.match.status === "half_time";
  const autoMinute = useAutoMinute(startedAt, Boolean(isLiveNow));
  const elapsedSec = useElapsedSeconds(startedAt, Boolean(inPlay));

  const onError = (e: unknown) => {
    const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
    if (detail === "knockout_draw_needs_shootout") {
      // The one blocked completion with a built-in way forward: record the
      // shootout right here, then complete again.
      setShootoutOpen(true);
      return;
    }
    toast.push({ kind: "error", title: errorMessage(e) });
  };

  const ev = useMutation({
    mutationFn: (p: {
      event_type: string;
      side?: string;
      player_id?: string;
      related_player_id?: string;
      voids_seq?: number;
    }) =>
      liveApi.recordEvent(matchId, {
        ...p,
        minute:
          p.event_type === "void"
            ? undefined
            : minute
              ? Number(minute)
              : (autoMinute ?? undefined),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      // A recorded event consumes the transient attribution + manual minute,
      // so the next tap starts clean (stale-minute timelines, P7a).
      setMinute("");
      refresh();
    },
    onError,
  });
  const tr = useMutation({
    mutationFn: (to: string) => liveApi.transition(matchId, to),
    onSuccess: () => {
      setConfirmTo(null);
      refresh();
    },
    onError: (e) => {
      setConfirmTo(null);
      onError(e);
    },
  });
  const shootout = useMutation({
    mutationFn: () =>
      liveApi.scoreShootout(matchId, {
        home_pens: Number(pens.home),
        away_pens: Number(pens.away),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      setShootoutOpen(false);
      setPens({ home: "", away: "" });
      // The shootout decided it — complete for real now.
      tr.mutate("completed");
    },
    onError,
  });
  // Seed the set editor from the server ONCE per mount so a live match
  // reopened mid-game shows its current points; afterwards local taps are
  // the source of truth (the 5 s poll must not clobber typing).
  const serverSetScores = query.data?.match.set_scores;
  useEffect(() => {
    if (seeded.current || !query.data) return;
    seeded.current = true;
    if (serverSetScores && serverSetScores.length > 0) {
      setSetRows(
        serverSetScores.map(([h, a]) => [String(h), String(a)] as SetRow),
      );
    }
  }, [query.data, serverSetScores]);
  useEffect(
    () => () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    },
    [],
  );

  // Live tap scoring: the running points save themselves (no Save button).
  const progress = useMutation({
    mutationFn: (rows: SetRow[]) =>
      liveApi.recordSetProgress(matchId, {
        set_scores: rows.map(([h, a]) => [Number(h || 0), Number(a || 0)]),
        event_id: newEventId(),
      }),
    onSuccess: refresh,
    onError,
  });

  const submitSets = useMutation({
    mutationFn: () =>
      liveApi.recordSetScores(matchId, {
        set_scores: setRows
          .filter(([h, a]) => h !== "" && a !== "")
          .map(([h, a]) => [Number(h), Number(a)]),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      setConfirmSets(false);
      toast.push({ kind: "success", title: t("Result recorded.") });
      refresh();
    },
    onError: (e) => {
      setConfirmSets(false);
      onError(e);
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load the match.")}
        </p>
        <Button size="sm" variant="outline" className="w-fit" onClick={() => query.refetch()}>
          {t("Retry")}
        </Button>
      </div>
    );
  }

  const { match, events } = query.data;
  const live = match.status === "live" || match.status === "half_time";
  const setBased = match.scoring?.type === "sets";
  const actions = STATE_ACTIONS[match.status] ?? [];
  const sm = statusMeta(match.status);
  const homeName = match.home_team?.name ?? t("TBD");
  const awayName = match.away_team?.name ?? t("TBD");
  const lastEvent = events[0];
  const canUndo = live && !!lastEvent;
  const isFinal = match.status === "completed" || match.status === "walkover";
  const [homeSets, awaySets] = setsWon(setRows, match.scoring ?? null);
  const completeSets = setRows.filter(([h, a]) => h !== "" && a !== "");
  // The set in play = the last editor row; its points are the BIG score for
  // set sports while the match runs (taps show up instantly, owner 2026-07-03).
  const currentSetRow = setRows[setRows.length - 1] ?? ["", ""];
  const currentSetPoints: [number, number] = [
    Number(currentSetRow[0] || 0),
    Number(currentSetRow[1] || 0),
  ];
  const finishedSetChips = setRows
    .slice(0, -1)
    .filter(([h, a]) => h !== "" && a !== "");

  // Tap scoring: every edit while LIVE auto-saves (debounced) — no Save
  // button. When the match has not started, edits stay local until the
  // result is recorded, exactly as before.
  const schedulePush = (rows: SetRow[]) => {
    if (!setBased || match.status !== "live") return;
    pendingRows.current = rows;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      if (pendingRows.current) progress.mutate(pendingRows.current);
    }, 500);
  };
  const setSide = (i: number, sideIdx: 0 | 1, value: string) => {
    const next = setRows.map((r, j) =>
      j === i ? ((sideIdx === 0 ? [value, r[1]] : [r[0], value]) as SetRow) : r,
    );
    setSetRows(next);
    schedulePush(next);
  };
  const bump = (i: number, sideIdx: 0 | 1, delta: number) => {
    const cur = Number(setRows[i]?.[sideIdx] || 0);
    setSide(i, sideIdx, String(Math.max(0, cur + delta)));
  };

  // Build player options for the custom <Select> (jersey prefix preserved).
  const playerOptions = (players: MiniPlayer[]) =>
    players.map((p) => ({
      value: p.id,
      label: `${p.jersey_no ? `#${p.jersey_no} ` : ""}${p.name}`,
    }));

  const fireTransition = (to: string) => {
    // Terminal states lock the result and fire bracket advancement — never
    // one accidental tap (P7a). Everything else fires immediately.
    if (to === "completed") {
      setConfirmTo(to);
      return;
    }
    tr.mutate(to);
  };

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentMatches(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground print:hidden"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to matches")}
      </Link>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-col gap-1">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Scoring console")}
          </p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {homeName} <span className="text-muted-foreground">{t("vs")}</span> {awayName}
          </h1>
        </div>
        {live && elapsedSec != null ? (
          // Stopwatch: runs from the moment the scorer started the match.
          <div
            data-testid="match-clock"
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 shadow-sm"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <span className="font-tabular text-2xl font-semibold leading-none tabular-nums">
              {fmtClock(elapsedSec)}
            </span>
          </div>
        ) : isFinal ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="print-match-report"
            onClick={() => window.print()}
          >
            <Printer aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {t("Print match report")}
          </Button>
        ) : null}
      </div>

      {/* Print-only official match report. */}
      <div data-testid="match-report" className="hidden print:block">
        <h1 className="text-xl font-semibold">{t("Official match report")}</h1>
        <p className="mt-1 text-2xl font-semibold">
          {homeName} {match.home_score ?? 0}-{match.away_score ?? 0} {awayName}
        </p>
        {match.home_pens != null && match.away_pens != null ? (
          <p className="font-tabular text-sm">
            {t("Penalties")} {match.home_pens}-{match.away_pens}
          </p>
        ) : null}
        {(match.set_scores?.length ?? 0) > 0 ? (
          <p className="font-tabular text-sm">
            {t("Sets")}: {(match.set_scores ?? []).map((x) => `${x[0]}-${x[1]}`).join(", ")}
          </p>
        ) : null}
        <p className="mt-1 text-sm capitalize">{t("Status")}: {t(match.status)}</p>
        <table className="mt-4 w-full border-collapse text-sm">
          <caption className="pb-1 text-left text-base font-semibold">
            {t("Timeline")}
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase">
              <th className="w-16 py-1 pr-2">{t("Minute")}</th>
              <th className="py-1 pr-2">{t("Event")}</th>
              <th className="py-1">{t("Player")}</th>
            </tr>
          </thead>
          <tbody>
            {[...events].reverse().map((e) => (
              <tr key={e.sequence_no} className="border-b border-border">
                <td className="py-1 pr-2 font-tabular">
                  {e.minute != null ? `${e.minute}'` : `#${e.sequence_no}`}
                </td>
                <td className="py-1 pr-2 capitalize">{t(e.type.replace(/_/g, " "))}</td>
                <td className="py-1">{e.player ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-6 text-xs">
          {t("Signatures")}: ____________________ ({t("Referee")}) ·
          ____________________ ({t("Scorer")})
        </p>
      </div>

      {/* Scoreboard */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm print:hidden">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex flex-col items-center gap-4 px-6 py-8">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
              sm.badge,
            )}
          >
            {sm.live ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            ) : (
              <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
            )}
            {t(sm.label)}
            {match.current_period ? (
              <span className="text-muted-foreground">
                · {t(match.current_period.replace(/_/g, " "))}
              </span>
            ) : null}
            {isLiveNow && autoMinute != null ? (
              <span className="font-tabular text-muted-foreground">{autoMinute}'</span>
            ) : null}
          </span>

          <div className="grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-medium sm:text-base">{homeName}</div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Home")}
              </div>
            </div>
            {setBased && !isFinal ? (
              // Set sport in play: the BIG number is the CURRENT SET's points,
              // straight from the editor rows so a tap shows up instantly.
              <div className="text-center">
                <div
                  data-testid="set-scoreboard"
                  className="font-tabular text-4xl font-semibold tabular-nums sm:text-6xl"
                >
                  {currentSetPoints[0]}
                  <span className="px-2 text-muted-foreground">-</span>
                  {currentSetPoints[1]}
                </div>
                <p className="mt-1 font-tabular text-sm text-muted-foreground">
                  {t("Set")} {setRows.length} · {t("Sets")} {homeSets}-{awaySets}
                </p>
              </div>
            ) : (
              <div className="font-tabular text-4xl font-semibold tabular-nums sm:text-6xl">
                {match.home_score ?? 0}
                <span className="px-2 text-muted-foreground">-</span>
                {match.away_score ?? 0}
              </div>
            )}
            <div className="min-w-0 text-left">
              <div className="truncate text-sm font-medium sm:text-base">{awayName}</div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Away")}
              </div>
            </div>
          </div>

          {setBased ? (
            (() => {
              // In play: finished sets from the local editor (instant); once
              // final, the server's recorded sets.
              const chips = isFinal ? (match.set_scores ?? []) : finishedSetChips;
              return chips.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-1.5">
                  {chips.map((s, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground"
                    >
                      {s[0]}-{s[1]}
                    </span>
                  ))}
                </div>
              ) : null;
            })()
          ) : null}

          {match.home_pens != null && match.away_pens != null ? (
            <p className="font-tabular text-xs text-muted-foreground">
              {t("Pens")} {match.home_pens}-{match.away_pens}
            </p>
          ) : null}

          {actions.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {actions.map((a) => (
                <Button
                  key={a.to}
                  variant={a.to === "live" || a.to === "completed" ? "default" : "outline"}
                  size="sm"
                  disabled={tr.isPending}
                  onClick={() => fireTransition(a.to)}
                >
                  {t(a.label)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Pre-kickoff team sheets (lineups freeze at kickoff). */}
      {match.status === "scheduled" ? (
        <LineupPanel
          matchId={matchId}
          homeTeam={match.home_team}
          awayTeam={match.away_team}
        />
      ) : null}

      {/* Set-sport result entry — the server rejects goal events for set
          sports, so the console never offers them (P7b). */}
      {setBased && (live || match.status === "scheduled") ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("Set scores")}</h2>
            </div>
            <span className="font-tabular text-xs text-muted-foreground">
              {t("Sets")} {homeSets}-{awaySets}
              {match.scoring?.best_of ? ` · ${t("best of")} ${match.scoring.best_of}` : ""}
            </span>
            {/* Points per tap: what one +/- press adds (any number works). */}
            <div
              role="group"
              aria-label={t("Points per tap")}
              className="ml-auto flex items-center gap-1"
            >
              <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Per tap")}
              </span>
              {[1, 2, 3, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={step === n}
                  data-testid={`tap-step-${n}`}
                  onClick={() => {
                    setStep(n);
                    setStepText(String(n));
                  }}
                  className={cn(
                    "inline-flex h-7 min-w-8 items-center justify-center rounded-md border px-1.5 font-tabular text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    step === n
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  +{n}
                </button>
              ))}
              <Input
                inputMode="numeric"
                aria-label={t("Custom points per tap")}
                value={stepText}
                onChange={(e) => {
                  setStepText(e.target.value);
                  const n = Math.floor(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 1) setStep(n);
                }}
                className="h-7 w-12 px-1 text-center font-tabular text-xs"
              />
            </div>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {/* Desktop column headers; mobile shows the name inside each
                stepper instead (the sides stack there). */}
            <div className="hidden grid-cols-[2.25rem_1fr_1fr_2rem] items-center gap-2 text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground sm:grid">
              <span />
              <span className="truncate text-center">{homeName}</span>
              <span className="truncate text-center">{awayName}</span>
              <span />
            </div>
            {setRows.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)_2rem] items-center gap-x-2 gap-y-1.5 sm:grid-cols-[2.25rem_1fr_1fr_2rem]"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {t("Set")} {i + 1}
                </span>
                {([0, 1] as const).map((sideIdx) => {
                  const teamLabel = sideIdx === 0 ? homeName : awayName;
                  const sideKey = sideIdx === 0 ? "home" : "away";
                  return (
                    <div
                      key={sideIdx}
                      className={cn(
                        "flex min-w-0 items-center gap-1",
                        sideIdx === 1 &&
                          "col-start-2 row-start-2 sm:col-auto sm:row-auto",
                      )}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`${t("Set")} ${i + 1} ${teamLabel} ${t("minus")} ${step}`}
                        data-testid={`set-${i}-${sideKey}-minus`}
                        className="h-11 w-10 shrink-0 p-0"
                        onClick={() => bump(i, sideIdx, -step)}
                      >
                        <Minus aria-hidden="true" className="h-4 w-4" />
                      </Button>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-center text-[0.6875rem] text-muted-foreground sm:hidden">
                          {teamLabel}
                        </span>
                        <Input
                          inputMode="numeric"
                          aria-label={`${t("Set")} ${i + 1} ${teamLabel}`}
                          value={row[sideIdx]}
                          onChange={(e) => setSide(i, sideIdx, e.target.value)}
                          className="h-11 w-full text-center font-tabular text-lg font-semibold"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        aria-label={`${t("Set")} ${i + 1} ${teamLabel} ${t("plus")} ${step}`}
                        data-testid={`set-${i}-${sideKey}-plus`}
                        className="h-11 w-14 shrink-0 p-0"
                        onClick={() => bump(i, sideIdx, step)}
                      >
                        <Plus aria-hidden="true" className="h-5 w-5" />
                      </Button>
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t("Remove set")} ${i + 1}`}
                  disabled={setRows.length === 1}
                  className="col-start-3 row-start-1 h-8 w-8 p-0 sm:col-auto sm:row-auto"
                  onClick={() => {
                    const next = setRows.filter((_, j) => j !== i);
                    setSetRows(next);
                    schedulePush(next);
                  }}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSetRows((rows) => [...rows, ["", ""]])}
              >
                <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t("Add set")}
              </Button>
              <div className="flex items-center gap-3">
                {match.status === "live" ? (
                  <span
                    data-testid="tap-sync-state"
                    className="text-xs text-muted-foreground"
                    aria-live="polite"
                  >
                    {progress.isPending ? t("Saving") : t("Saves as you tap")}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  disabled={submitSets.isPending || completeSets.length === 0}
                  onClick={() => setConfirmSets(true)}
                >
                  {t("Record result")}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {match.status === "live"
                ? t("Points update live for viewers. Record result finishes the match.")
                : t("Recording the result completes the match.")}
            </p>
          </div>
        </div>
      ) : null}

      {/* Record event */}
      {live ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">
                {setBased ? t("Record discipline") : t("Record event")}
              </h2>
            </div>
            {!setBased ? (
              <div className="flex items-center gap-2">
                <Label htmlFor="minute" className="text-xs text-muted-foreground">
                  {t("Minute")}
                </Label>
                <Input
                  id="minute"
                  inputMode="numeric"
                  placeholder={autoMinute != null ? String(autoMinute) : ""}
                  value={minute}
                  onChange={(e) => setMinute(e.target.value)}
                  className="h-9 w-16 text-center font-tabular"
                />
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            {(["home", "away"] as Side[]).map((side) => {
              const team: LiveTeam | null = side === "home" ? match.home_team : match.away_team;
              const players = team?.players ?? [];
              const fire = (event_type: string) =>
                ev.mutate({ event_type, side, player_id: sel[side] });
              const playerLabel = side === "home" ? t("Home player") : t("Away player");
              const subLabel = side === "home" ? t("Home sub on") : t("Away sub on");
              const palette = setBased ? SET_EVENT_BUTTONS : EVENT_BUTTONS;
              return (
                <div key={side} className="flex flex-col gap-3 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {team?.name ?? (side === "home" ? t("Home") : t("Away"))}
                    </span>
                    <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {side === "home" ? t("Home") : t("Away")}
                    </span>
                  </div>

                  <Select
                    aria-label={playerLabel}
                    value={sel[side] ?? ""}
                    onChange={(v) => setSel((s) => ({ ...s, [side]: v || undefined }))}
                    options={[
                      { value: "", label: t("Team (no player)") },
                      ...playerOptions(players),
                    ]}
                    placeholder={t("Team (no player)")}
                  />

                  <div className={cn("grid gap-1.5", setBased ? "grid-cols-3" : "grid-cols-3")}>
                    {palette.map((b) => (
                      <button
                        key={b.type}
                        type="button"
                        disabled={ev.isPending}
                        onClick={() => fire(b.type)}
                        className={cn(
                          "inline-flex items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
                          b.type === "goal" ? "h-12 text-base" : "h-9",
                          TONE_CLS[b.tone],
                        )}
                      >
                        {t(b.label)}
                      </button>
                    ))}
                  </div>

                  {!setBased ? (
                    <div className="flex items-end gap-2 border-t border-border pt-3">
                      <div className="flex flex-1 flex-col gap-1">
                        <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                          {t("Substitution")}
                        </span>
                        <Select
                          aria-label={subLabel}
                          value={subOn[side] ?? ""}
                          onChange={(v) => setSubOn((s) => ({ ...s, [side]: v || undefined }))}
                          options={[
                            { value: "", label: t("Sub on…") },
                            ...playerOptions(players),
                          ]}
                          placeholder={t("Sub on…")}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ev.isPending || !sel[side] || !subOn[side]}
                        onClick={() =>
                          ev.mutate({
                            event_type: "substitution",
                            side,
                            player_id: sel[side],
                            related_player_id: subOn[side],
                          })
                        }
                      >
                        {t("Sub")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Event log / timeline */}
      <div className="rounded-xl border border-border bg-card shadow-sm print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">{t("Event log")}</h2>
          <div className="flex items-center gap-1.5">
            {canUndo ? (
              <Button
                size="sm"
                variant="outline"
                disabled={ev.isPending}
                onClick={() =>
                  ev.mutate({ event_type: "void", voids_seq: lastEvent.sequence_no })
                }
              >
                <Undo2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t("Undo last event")}
              </Button>
            ) : null}
            <a
              href={liveApi.exportUrl(matchId)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Export timeline (CSV)")}
            </a>
          </div>
        </div>
        <div className="px-5 py-4">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No events yet.")}</p>
          ) : (
            <ol className="flex flex-col">
              {events.map((e, i) => (
                <li
                  key={e.sequence_no}
                  className={cn(
                    "group flex items-baseline gap-3 py-2 text-sm",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <span className="w-12 shrink-0 text-right font-tabular tabular-nums text-muted-foreground">
                    {e.minute != null ? `${e.minute}'` : `#${e.sequence_no}`}
                  </span>
                  <span className="flex-1 text-foreground">
                    {t(e.type.replace(/_/g, " "))}
                    {e.player ? (
                      <span className="text-muted-foreground"> · {e.player}</span>
                    ) : null}
                  </span>
                  {live ? (
                    <button
                      type="button"
                      aria-label={`${t("Undo")} ${t(e.type.replace(/_/g, " "))} #${e.sequence_no}`}
                      disabled={ev.isPending}
                      onClick={() =>
                        ev.mutate({ event_type: "void", voids_seq: e.sequence_no })
                      }
                      className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      {t("Undo")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* Confirm a terminal transition — completing locks the result and
          fires bracket advancement; a mis-tap must be catchable (P7a). */}
      <Dialog
        open={confirmTo != null}
        onOpenChange={(o) => !o && setConfirmTo(null)}
        ariaLabel={t("Confirm final result")}
      >
        <DialogHeader>
          <DialogTitle>{t("Complete this match?")}</DialogTitle>
          <DialogDescription>
            {homeName} {match.home_score ?? 0}-{match.away_score ?? 0} {awayName}
            {". "}
            {t("The result locks and the next round fills from it.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmTo(null)}>
            {t("Keep scoring")}
          </Button>
          <Button
            size="sm"
            disabled={tr.isPending}
            onClick={() => confirmTo && tr.mutate(confirmTo)}
            data-testid="confirm-complete"
          >
            {t("Complete match")}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Confirm the set result (completes the match). */}
      <Dialog
        open={confirmSets}
        onOpenChange={setConfirmSets}
        ariaLabel={t("Confirm set result")}
      >
        <DialogHeader>
          <DialogTitle>{t("Record this result?")}</DialogTitle>
          <DialogDescription>
            {homeName} {homeSets}-{awaySets} {awayName}
            {" ("}
            {completeSets.map(([h, a]) => `${h}-${a}`).join(", ")}
            {"). "}
            {t("Recording completes the match and locks the result.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmSets(false)}>
            {t("Keep editing")}
          </Button>
          <Button
            size="sm"
            disabled={submitSets.isPending}
            onClick={() => submitSets.mutate()}
            data-testid="confirm-sets"
          >
            {t("Record result")}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Penalty shootout — surfaced when completion is blocked by
          knockout_draw_needs_shootout, so the bracket never stalls. */}
      <Dialog
        open={shootoutOpen}
        onOpenChange={setShootoutOpen}
        ariaLabel={t("Penalty shootout")}
      >
        <DialogHeader>
          <DialogTitle>{t("Penalty shootout")}</DialogTitle>
          <DialogDescription>
            {t("The match is level. Enter the shootout result to decide it, then the match completes.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-3">
          {(["home", "away"] as const).map((side) => (
            <div key={side} className="flex flex-col gap-1">
              <Label htmlFor={`pens-${side}`} className="truncate text-xs">
                {side === "home" ? homeName : awayName}
              </Label>
              <Input
                id={`pens-${side}`}
                inputMode="numeric"
                value={pens[side]}
                onChange={(e) => setPens((p) => ({ ...p, [side]: e.target.value }))}
                className="h-10 text-center font-tabular text-base"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setShootoutOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={
              shootout.isPending ||
              pens.home === "" ||
              pens.away === "" ||
              Number(pens.home) === Number(pens.away)
            }
            onClick={() => shootout.mutate()}
            data-testid="confirm-shootout"
          >
            {t("Record shootout")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
