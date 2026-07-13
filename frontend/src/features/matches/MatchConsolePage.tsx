import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Printer, Radio, Undo2 } from "lucide-react";
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
import { isNetworkError } from "@/api/client";
import { newEventId } from "@/lib/eventId";
import {
  enqueueWrite,
  initOfflineQueue,
  useOfflineQueue,
} from "@/lib/offlineQueue";
import { invalidateTournament } from "@/lib/queryKeys";
import { useMatchSocket } from "@/lib/useMatchSocket";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";
import { LineupPanel } from "./LineupPanel";
import { resolveConsole } from "./console/registry";
import { statusMeta } from "./console/shared";

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
    not_tournament_manager: t("Only a tournament manager can amend a final result."),
    amend_reason_required: t("Enter the reason for the correction."),
    only_completed_results_can_be_amended: t("Only a completed result can be amended."),
    amend_is_for_set_sports: t("Goal-based matches are corrected by undoing events."),
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
/** The frozen wire payload of one tap. Built (minute included) and given its
 * event_id at TAP time, so a retry or offline replay re-sends the SAME id
 * and the server dedupes instead of double-counting (H2, invariant 3). */
type RecordEventPayload = {
  event_type: string;
  side?: string;
  player_id?: string;
  related_player_id?: string;
  voids_seq?: number;
  minute?: number;
  event_id: string;
};

export function MatchConsolePage(): React.ReactElement {
  const { id = "", matchId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  // P3: the scorer-room WebSocket delivers every committed event instantly
  // (co-scorers see a tap sub-second); the poll stays as the fallback and
  // relaxes while the socket is healthy.
  const { connected: socketLive } = useMatchSocket(matchId || null, () => {
    qc.invalidateQueries({ queryKey: ["live", matchId] });
  });
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    refetchInterval: socketLive ? 30000 : 5000,
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
    mutationFn: (p: RecordEventPayload) => liveApi.recordEvent(matchId, p),
    onSuccess: () => {
      // A recorded event consumes the transient attribution + manual minute,
      // so the next tap starts clean (stale-minute timelines, P7a).
      setMinute("");
      refresh();
    },
    onError: (e, vars) => {
      if (isNetworkError(e)) {
        // Server unreachable: the tap is parked on this phone and replayed
        // when the connection returns; its event_id makes the replay safe.
        enqueueWrite({
          id: vars.event_id,
          path: `/api/matches/${matchId}/events/`,
          body: vars as unknown as Record<string, unknown>,
        });
        setMinute("");
        toast.push({
          kind: "info",
          title: t("No connection. The tap is saved on this phone and will sync."),
        });
        return;
      }
      onError(e);
    },
  });
  const fireEvent = (p: {
    event_type: string;
    side?: string;
    player_id?: string;
    related_player_id?: string;
    voids_seq?: number;
  }) =>
    ev.mutate({
      ...p,
      minute:
        p.event_type === "void"
          ? undefined
          : minute
            ? Number(minute)
            : (autoMinute ?? undefined),
      event_id: newEventId(),
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
    mutationFn: (v: { event_id: string }) =>
      liveApi.scoreShootout(matchId, {
        home_pens: Number(pens.home),
        away_pens: Number(pens.away),
        event_id: v.event_id,
      }),
    onSuccess: () => {
      setShootoutOpen(false);
      setPens({ home: "", away: "" });
      // The shootout decided it — complete for real now.
      tr.mutate("completed");
    },
    onError,
  });
  // Replay any taps parked by a previous (offline) session.
  const queued = useOfflineQueue();
  useEffect(() => {
    initOfflineQueue();
  }, []);

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
  // Sport-module resolution: the server's sport_meta names the console
  // family; legacy snapshots without it infer set sports from the scoring
  // shape. A null module = the chassis's own football (timed) surface.
  const family =
    match.sport_meta?.family ??
    (match.scoring?.type === "sets" ? "target" : "timed");
  const module = resolveConsole(match.sport ?? "", family);
  const timed = family === "timed";
  // Half time is a football notion; a set sport pauses between sets on its
  // own, so its live console offers Complete only.
  const actions = (STATE_ACTIONS[match.status] ?? []).filter(
    (a) => !(family === "target" && a.to === "half_time"),
  );
  const sm = statusMeta(match.status);
  const homeName = match.home_team?.name ?? t("TBD");
  const awayName = match.away_team?.name ?? t("TBD");
  const lastEvent = events[0];
  const canUndo = live && !!lastEvent;
  const isFinal = match.status === "completed" || match.status === "walkover";

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

  // The state-transition buttons render inside whichever scoreboard owns the
  // surface: the chassis's football card below, or the sport module's card.
  const actionButtons =
    actions.length > 0 ? (
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
    ) : null;

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
        {queued > 0 ? (
          <span
            data-testid="offline-queued"
            className="inline-flex items-center gap-1.5 rounded-md bg-warning-muted px-2 py-1 font-tabular text-xs font-medium text-warning"
          >
            {queued} {t("saved on this phone, will sync")}
          </span>
        ) : null}
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

      {/* Scoreboard: a registered sport module owns the whole scoring
          surface (scoreboard + score entry); otherwise the chassis renders
          its own football surface. */}
      {module ? (
        <module.Console
          matchId={matchId}
          match={match}
          homeName={homeName}
          awayName={awayName}
          live={live}
          isFinal={isFinal}
          refresh={refresh}
          onError={onError}
          actions={actionButtons}
        />
      ) : (
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
              <div className="font-tabular text-4xl font-semibold tabular-nums sm:text-6xl">
                {match.home_score ?? 0}
                <span className="px-2 text-muted-foreground">-</span>
                {match.away_score ?? 0}
              </div>
              <div className="min-w-0 text-left">
                <div className="truncate text-sm font-medium sm:text-base">{awayName}</div>
                <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                  {t("Away")}
                </div>
              </div>
            </div>

            {match.home_pens != null && match.away_pens != null ? (
              <p className="font-tabular text-xs text-muted-foreground">
                {t("Pens")} {match.home_pens}-{match.away_pens}
              </p>
            ) : null}

            {actionButtons}
          </div>
        </div>
      )}

      {/* Pre-kickoff team sheets (lineups freeze at kickoff). */}
      {match.status === "scheduled" ? (
        <LineupPanel
          matchId={matchId}
          homeTeam={match.home_team}
          awayTeam={match.away_team}
          sportKey={match.sport_meta?.key ?? match.sport ?? ""}
          family={family}
          playersPerSide={match.players_per_side ?? null}
        />
      ) : null}

      {/* Record event */}
      {live ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">
                {timed ? t("Record event") : t("Record discipline")}
              </h2>
            </div>
            {timed ? (
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
                fireEvent({ event_type, side, player_id: sel[side] });
              const playerLabel = side === "home" ? t("Home player") : t("Away player");
              const subLabel = side === "home" ? t("Home sub on") : t("Away sub on");
              const palette = timed ? EVENT_BUTTONS : SET_EVENT_BUTTONS;
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

                  <div className="grid grid-cols-3 gap-1.5">
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

                  {timed ? (
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
                          fireEvent({
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
                  fireEvent({ event_type: "void", voids_seq: lastEvent.sequence_no })
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
                        fireEvent({ event_type: "void", voids_seq: e.sequence_no })
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
            onClick={() => shootout.mutate({ event_id: newEventId() })}
            data-testid="confirm-shootout"
          >
            {t("Record shootout")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
