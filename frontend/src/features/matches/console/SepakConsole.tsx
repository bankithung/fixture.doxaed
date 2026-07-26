import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleDot, Plus, X } from "lucide-react";
import { liveApi, type MiniPlayer } from "@/api/live";
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
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { TargetSportConsoleProps } from "./TargetSportConsole";
import {
  buzz,
  gamePointSide,
  setProgress,
  setTargets,
  setsWon,
  type SetRow,
} from "./shared";
import { changeEndsPrompt, serveOfTurn, serveTurn, type ServeRules } from "./serve";
import { useAnnotate, useFirstServer, usePointKeys } from "./hooks";
import {
  ConsoleActionBar,
  ConsoleStrip,
  GameHistory,
  NextGamePrompt,
  PointFlag,
  ScoreEditor,
  ScorePad,
  SyncBadge,
  TargetRule,
  type StripCell,
  type SyncState,
} from "./Scoreboard";

// Point-winning fault vocabulary (sepak blueprint §3): one press scores the
// rally, an optional second tap explains it on the digital scoresheet.
const POINT_REASONS: { key: string; label: string }[] = [
  { key: "service_fault", label: "Service fault" },
  { key: "three_touch", label: "Three touch" },
  { key: "net", label: "Net" },
  { key: "out", label: "Out" },
];

const STAT_BUTTONS: { key: "ace" | "kill" | "block"; label: string }[] = [
  { key: "ace", label: "Ace" },
  { key: "kill", label: "Kill" },
  { key: "block", label: "Block" },
];

/** Native sepak takraw console (P2). ONE board, top to bottom: score pad
 * with explicit Point buttons (fault-reason chips after each rally), the
 * between-sets step ("Set 1 done. Start set 2"), the result gate that opens
 * exactly at the clinch (the server's own rule), the set track, scoresheet
 * stats, per-set timeouts, and collapsed rows for corrections, discipline
 * and the event log. */
export function SepakConsole({
  matchId,
  match,
  homeName,
  awayName,
  live,
  isFinal,
  refresh,
  onError,
  actions,
  extras,
  clock,
  back,
  title,
  titleActions,
}: TargetSportConsoleProps): React.ReactElement {
  const toast = useToast();
  const [setRows, setSetRows] = useState<SetRow[]>([["", ""]]);
  const [confirmSets, setConfirmSets] = useState(false);
  const seeded = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRows = useRef<SetRow[] | null>(null);

  // Seed the set editor from the server ONCE per mount so a live match
  // reopened mid-game shows its current points; afterwards local taps are
  // the source of truth (the 5 s poll must not clobber typing).
  const serverSetScores = match.set_scores;
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (serverSetScores && serverSetScores.length > 0) {
      setSetRows(
        serverSetScores.map(([h, a]) => [String(h), String(a)] as SetRow),
      );
    }
  }, [serverSetScores]);
  useEffect(
    () => () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    },
    [],
  );

  // Live tap scoring: the running points save themselves (no Save button).
  // The pad holds the truth locally, so a push lost to a dead connection is
  // never lost data: syncFailed flips on and the retry loop re-sends the
  // LATEST rows until the network returns.
  const [syncFailed, setSyncFailed] = useState(false);
  const progress = useMutation({
    mutationFn: (p: { rows: SetRow[]; event_id: string }) =>
      liveApi.recordSetProgress(matchId, {
        set_scores: p.rows.map(([h, a]) => [Number(h || 0), Number(a || 0)]),
        event_id: p.event_id,
      }),
    onSuccess: () => {
      setSyncFailed(false);
      refresh();
    },
    onError: (e, vars) => {
      if (isNetworkError(e)) {
        pendingRows.current = vars.rows;
        setSyncFailed(true);
        return;
      }
      setSyncFailed(false);
      onError(e);
    },
  });
  const progressMutate = progress.mutate;
  useEffect(() => {
    if (!syncFailed) return;
    const id = window.setInterval(() => {
      if (pendingRows.current) {
        progressMutate({ rows: pendingRows.current, event_id: newEventId() });
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [syncFailed, progressMutate]);

  const submitSets = useMutation({
    mutationFn: (v: { event_id: string }) =>
      liveApi.recordSetScores(matchId, {
        set_scores: setRows
          .filter(([h, a]) => h !== "" && a !== "")
          .map(([h, a]) => [Number(h), Number(a)]),
        event_id: v.event_id,
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

  // H3: audited manager correction of a COMPLETED set result. The bracket
  // re-fills from the corrected winner server-side.
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendRows, setAmendRows] = useState<SetRow[]>([["", ""]]);
  const [amendReason, setAmendReason] = useState("");
  const amend = useMutation({
    mutationFn: (v: { event_id: string }) =>
      liveApi.amendSetResult(matchId, {
        set_scores: amendRows
          .filter(([h, a]) => h !== "" && a !== "")
          .map(([h, a]) => [Number(h), Number(a)]),
        reason: amendReason.trim(),
        event_id: v.event_id,
      }),
    onSuccess: () => {
      setAmendOpen(false);
      setAmendReason("");
      toast.push({ kind: "success", title: t("Result amended.") });
      refresh();
    },
    onError,
  });

  // The digital scoresheet: non-scoring annotation events (invariant 4 —
  // the score of record stays set_scores; these never move it).
  const annotate = useAnnotate(matchId, onError, refresh);
  const [firstServer, toggleFirstServer] = useFirstServer(matchId);
  // Corrections live in a panel the scorer opens on purpose (rail button or
  // "Edit scores" on the history), never a stray tap away from the pads.
  const [editOpen, setEditOpen] = useState(false);

  const periodLabel = t(match.sport_meta?.terms?.period ?? "Set");
  const periodPlural = `${periodLabel}s`;
  const prog = setProgress(setRows, match.scoring ?? null, 3);
  const { homeSets, awaySets, bestOf, setNo, decided } = prog;
  const completeSets = setRows.filter(([h, a]) => h !== "" && a !== "");
  // The set in play = the last editor row; its points are the BIG score for
  // set sports while the match runs (taps show up instantly).
  const currentSetRow = setRows[setRows.length - 1] ?? ["", ""];
  const homePts = Number(currentSetRow[0] || 0);
  const awayPts = Number(currentSetRow[1] || 0);

  // Serve rotation from the resolved rules (istaf_legacy defaults when the
  // snapshot predates the serve block).
  const scoringServe = match.scoring?.serve;
  const scoringPoints = match.scoring?.points;
  const serveRules: ServeRules = useMemo(
    () => ({
      serves_per_turn: scoringServe?.serves_per_turn ?? 3,
      alternate_every_point: scoringServe?.alternate_every_point ?? false,
      points: scoringPoints ?? 21,
      change_ends_at: scoringServe?.change_ends_at ?? {
        regular: 11,
        deciding: 8,
      },
    }),
    [scoringServe, scoringPoints],
  );
  const perTurn = Math.max(1, Math.floor(serveRules.serves_per_turn ?? 1));
  const server = serveTurn(homePts, awayPts, serveRules, firstServer);
  const serveN = serveOfTurn(homePts, awayPts, serveRules);
  // Whether the set in play just finished (legally won under the rules).
  const prevWon = setsWon(setRows.slice(0, -1), match.scoring ?? null);
  const currentRowWon = homeSets + awaySets > prevWon[0] + prevWon[1];
  const rulesKnown = (match.scoring?.points ?? 0) > 0;
  const inPlay = live || match.status === "scheduled";
  // The explicit between-sets step: the finished set locks the Point
  // buttons until "Start set N+1" is pressed.
  const awaitingNext = inPlay && rulesKnown && currentRowWon && !decided;
  const canScore = inPlay && !decided && !awaitingNext;
  const winnerName = prog.leader == null ? null : prog.leader === 0 ? homeName : awayName;
  // What ends the set in play: the target score for the caption, and the
  // live "Set point / Match point" flag when the next point can finish it.
  const decidingSet = setNo === bestOf;
  const stageRule = setTargets(match.scoring ?? null, decidingSet);
  const targetPts = stageRule.points;
  const gpSide = canScore
    ? gamePointSide(homePts, awayPts, match.scoring ?? null, decidingSet)
    : null;
  const gpName = gpSide == null ? null : gpSide === 0 ? homeName : awayName;
  const gpIsMatch =
    gpSide != null && (gpSide === 0 ? homeSets : awaySets) + 1 >= prog.need;

  // Change-ends notice: latches once per set the moment a side first
  // reaches the trigger (11 in sets 1 and 2, 8 in the decider).
  const [endsOpen, setEndsOpen] = useState(false);
  const endsFiredFor = useRef(0);
  useEffect(() => {
    if (!live || endsFiredFor.current === setNo) return;
    if (changeEndsPrompt(setNo, bestOf, homePts, awayPts, serveRules)) {
      endsFiredFor.current = setNo;
      setEndsOpen(true);
    }
  }, [live, setNo, bestOf, homePts, awayPts, serveRules]);

  // Timeouts: one per regu per set; the counter resets when a new set opens.
  const [timeouts, setTimeouts] = useState({ home: 0, away: 0 });
  const timeoutSetRef = useRef(setNo);
  useEffect(() => {
    if (timeoutSetRef.current !== setNo) {
      timeoutSetRef.current = setNo;
      setTimeouts({ home: 0, away: 0 });
    }
  }, [setNo]);

  // Transient rally-reason chips: which side's point awaits a reason.
  const [reasonFor, setReasonFor] = useState<"home" | "away" | null>(null);
  // Which scoresheet stat awaits a player pick.
  const [statOpen, setStatOpen] = useState<"ace" | "kill" | "block" | null>(
    null,
  );

  // Tap scoring: every edit while LIVE auto-saves (debounced) — no Save
  // button. When the match has not started, edits stay local until the
  // result is recorded.
  const schedulePush = (rows: SetRow[]) => {
    if (match.status !== "live") return;
    pendingRows.current = rows;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      if (pendingRows.current) {
        // One debounced push = one logical write = one event_id.
        progress.mutate({ rows: pendingRows.current, event_id: newEventId() });
      }
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

  // The PRIMARY interaction: the Point button scores the rally, then a
  // transient reason chip row explains it (skipping logs nothing extra).
  const tapPoint = (sideIdx: 0 | 1) => {
    buzz();
    bump(setRows.length - 1, sideIdx, 1);
    if (live) setReasonFor(sideIdx === 0 ? "home" : "away");
  };
  const logReason = (reason: string) => {
    if (!reasonFor) return;
    annotate.mutate({
      event_type: "point",
      side: reasonFor,
      detail: { reason, scoring_side: reasonFor },
      event_id: newEventId(),
    });
    setReasonFor(null);
  };
  const logStat = (side: "home" | "away", playerId: string) => {
    if (!statOpen) return;
    annotate.mutate({
      event_type: statOpen,
      side,
      player_id: playerId || undefined,
      event_id: newEventId(),
    });
    setStatOpen(null);
  };
  const spendTimeout = (side: "home" | "away") => {
    if (timeouts[side] >= 1) return;
    setTimeouts((v) => ({ ...v, [side]: v[side] + 1 }));
    annotate.mutate({
      event_type: "timeout",
      side,
      event_id: newEventId(),
    });
  };
  const startNextSet = () => {
    buzz();
    setSetRows((rows) => [...rows, ["", ""]]);
    setEndsOpen(false);
  };

  const playerOptions = (players: MiniPlayer[]) => [
    { value: "", label: t("Team (no player)") },
    ...players.map((p) => ({
      value: p.id,
      label: `${p.jersey_no ? `#${p.jersey_no} ` : ""}${p.name}`,
    })),
  ];


  // Keyboard scoring for a scorer on a laptop; the pads stay the touch path.
  usePointKeys(canScore, tapPoint);

  const syncState: SyncState =
    match.status !== "live"
      ? "local"
      : progress.isPending
        ? "saving"
        : syncFailed
          ? "offline"
          : "saved";

  const stripCells: StripCell[] = [
    {
      key: "period",
      label: periodLabel,
      value: isFinal ? periodPlural : `${setNo} ${t("of")} ${bestOf}`,
    },
    {
      key: "match",
      label: t("Match score"),
      value: isFinal
        ? `${match.home_score ?? 0}-${match.away_score ?? 0}`
        : `${homeSets}-${awaySets}`,
      emphasis: true,
    },
  ];
  if (targetPts > 0) {
    stripCells.push({
      key: "target",
      label: t("Winning points"),
      value:
        stageRule.winBy > 1
          ? `${targetPts} · ${t("by")} ${stageRule.winBy}`
          : String(targetPts),
    });
  }
  if (clock) {
    stripCells.push({ key: "clock", label: t("Elapsed"), value: clock });
  }


  // Timeouts sit in the pad's own columns so each stays under its card. The
  // team name is only spelled out where there is room for it.
  const timeoutButton = (side: "home" | "away"): React.ReactElement => (
    <Button
      variant="outline"
      data-testid={`timeout-${side}`}
      aria-label={`${t("Timeout")} ${side === "home" ? homeName : awayName}`}
      disabled={timeouts[side] >= 1}
      onClick={() => spendTimeout(side)}
      className="h-11 w-full justify-between gap-2 px-2.5 text-xs sm:px-3 sm:text-sm"
    >
      <span className="min-w-0 truncate">
        {t("Timeout")}
        <span className="hidden sm:inline">
          {" · "}
          {side === "home" ? homeName : awayName}
        </span>
      </span>
      <span className="shrink-0 font-tabular text-xs text-muted-foreground">
        {timeouts[side]}/1
      </span>
    </Button>
  );

  return (
    <>
      {/* ONE board: everything the court official needs, in one section. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm print:hidden">
        <ConsoleStrip
          status={match.status}
          cells={stripCells}
          trailing={inPlay ? <SyncBadge state={syncState} live={live} /> : null}
          title={title}
          titleActions={titleActions}
        />

        <div className="flex flex-col gap-3 p-3">
            <ScorePad
              homeName={homeName}
              awayName={awayName}
              homeValue={isFinal ? (match.home_score ?? 0) : homePts}
              awayValue={isFinal ? (match.away_score ?? 0) : awayPts}
              server={isFinal || awaitingNext ? null : server}
              canScore={canScore}
              canEdit={inPlay}
              onPoint={tapPoint}
              onMinus={(s) => bump(setRows.length - 1, s, -1)}
              shortcuts={canScore ? ["q", "p"] : null}
              footers={
                live ? [timeoutButton("home"), timeoutButton("away")] : undefined
              }
              rule={
                <TargetRule
                  points={targetPts}
                  winBy={stageRule.winBy}
                  cap={stageRule.cap}
                  bestOf={bestOf}
                  periodLabel={periodLabel}
                  periodNo={isFinal ? bestOf : setNo}
                />
              }
            />

            {!isFinal && canScore ? (
              // Serve indicator: who serves the current rally and where the
              // service turn stands (three serves a turn under legacy rules).
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
                <span
                  data-testid="serve-indicator"
                  className="inline-flex min-w-0 items-center gap-1.5 text-sm"
                >
                  <CircleDot aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate font-medium">
                    {t("Serving")}: {server === 0 ? homeName : awayName}
                  </span>
                  {perTurn > 1 ? (
                    <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                      {t("Serve")} {serveN} {t("of")} {perTurn}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  aria-label={t("First server")}
                  onClick={toggleFirstServer}
                  className="inline-flex h-8 min-w-0 items-center rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">
                    {t("First serve")}: {firstServer === 0 ? homeName : awayName}
                  </span>
                </button>
                {gpName ? (
                  <PointFlag
                    kind={gpIsMatch ? "match" : "set"}
                    periodLabel={periodLabel}
                    name={gpName}
                  />
                ) : null}
              </div>
            ) : null}

            {/* Transient reason chips for the point just scored. */}
            {reasonFor ? (
              <div
                role="group"
                aria-label={t("Point reason")}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="text-xs text-muted-foreground">
                  {t("Point")} {reasonFor === "home" ? homeName : awayName}. {t("Reason?")}
                </span>
                {POINT_REASONS.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    data-testid={`reason-${r.key}`}
                    onClick={() => logReason(r.key)}
                    className="inline-flex h-11 items-center rounded-full border border-border px-3.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t(r.label)}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label={t("Skip reason")}
                  onClick={() => setReasonFor(null)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {awaitingNext ? (
              <NextGamePrompt
                summary={`${periodLabel} ${setNo} ${t("done")} ${homePts}-${awayPts}. ${t("Change ends.")}`}
                startLabel={`${t("Start")} ${periodLabel.toLowerCase()} ${setNo + 1}`}
                onStart={startNextSet}
              />
            ) : null}

            {endsOpen ? (
              <div
                data-testid="change-ends"
                role="status"
                className="flex items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground"
              >
                <span>{t("Change ends now.")}</span>
                <Button size="sm" variant="outline" onClick={() => setEndsOpen(false)}>
                  {t("Done")}
                </Button>
              </div>
            ) : null}

            <GameHistory
              progress={prog}
              periodLabel={periodLabel}
              entered={
                isFinal
                  ? (match.set_scores ?? []).map(
                      ([h, a]) => [String(h), String(a)] as SetRow,
                    )
                  : setRows
              }
              homeName={homeName}
              awayName={awayName}
              awaitingNext={awaitingNext}
              targetText={
                targetPts > 0
                  ? `${periodLabel.toLowerCase()} ${t("to")} ${targetPts}`
                  : undefined
              }
              winnerName={winnerName}
              isFinal={isFinal}
              onEdit={inPlay ? () => setEditOpen(true) : undefined}
            />

            {live ? (
              <>
                {/* Scoresheet stats: pick the stat, then the player. */}
                <div className="grid grid-cols-3 gap-1.5">
                  {STAT_BUTTONS.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      data-testid={`stat-${s.key}`}
                      aria-pressed={statOpen === s.key}
                      onClick={() =>
                        setStatOpen((cur) => (cur === s.key ? null : s.key))
                      }
                      className={cn(
                        "inline-flex h-10 items-center justify-center rounded-lg border px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        statOpen === s.key
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      {t(s.label)}
                    </button>
                  ))}
                </div>
                {statOpen ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
                        {t("Log")}{" "}
                        {t(STAT_BUTTONS.find((s) => s.key === statOpen)?.label ?? "")}
                      </span>
                      <button
                        type="button"
                        aria-label={t("Close stat")}
                        onClick={() => setStatOpen(null)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {(["home", "away"] as const).map((side) => (
                        <div key={side} className="flex flex-col gap-1">
                          <span className="truncate text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                            {side === "home" ? homeName : awayName}
                          </span>
                          <Select
                            aria-label={
                              side === "home" ? t("Home player") : t("Away player")
                            }
                            value=""
                            onChange={(v) => logStat(side, v)}
                            options={playerOptions(
                              (side === "home" ? match.home_team : match.away_team)
                                ?.players ?? [],
                            )}
                            placeholder={t("Pick the player")}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {inPlay && editOpen ? (
              <section
                data-testid="corrections"
                className="rounded-xl border border-border bg-muted/20 p-3"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
                    {t("Corrections")}
                  </h3>
                  <button
                    type="button"
                    aria-label={t("Close corrections")}
                    onClick={() => setEditOpen(false)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
                <ScoreEditor
                  rows={setRows}
                  periodLabel={periodLabel}
                  homeName={homeName}
                  awayName={awayName}
                  onBump={bump}
                  onSet={setSide}
                  onRemove={(i) => {
                    const next = setRows.filter((_, j) => j !== i);
                    setSetRows(next);
                    schedulePush(next);
                  }}
                  onAdd={() => setSetRows((rows) => [...rows, ["", ""]])}
                />
              </section>
            ) : null}
        </div>

        {extras}

        <ConsoleActionBar
          back={back}
          sync={
            inPlay ? (
              <span
                data-testid="tap-sync-state"
                className="font-tabular text-xs text-muted-foreground"
                aria-live="polite"
              >
                {match.status === "live"
                  ? progress.isPending
                    ? t("Saving")
                    : syncFailed
                      ? t("Offline. Points are safe on this phone.")
                      : t("All changes saved")
                  : t("Recording the result completes the match.")}
              </span>
            ) : null
          }
          actions={
            <>
              {isFinal ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="amend-result"
                  onClick={() => {
                    setAmendRows(
                      (match.set_scores ?? []).map(
                        (sc) => [String(sc[0]), String(sc[1])] as SetRow,
                      ),
                    );
                    setAmendOpen(true);
                  }}
                >
                  {t("Amend result")}
                </Button>
              ) : null}
              {actions}
              {decided && !isFinal ? (
                // The clinch is the completion gate: the server rejects a
                // result before it, so the button exists only from here.
                <Button
                  data-testid="record-result"
                  className="h-11 min-w-36 flex-1 text-base sm:flex-none"
                  disabled={submitSets.isPending}
                  onClick={() => setConfirmSets(true)}
                >
                  {t("Record result")}
                </Button>
              ) : null}
            </>
          }
        />
      </div>

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
            onClick={() => submitSets.mutate({ event_id: newEventId() })}
            data-testid="confirm-sets"
          >
            {t("Record result")}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* H3: manager amend of a completed set result — audited, reasoned. */}
      <Dialog
        open={amendOpen}
        onOpenChange={setAmendOpen}
        ariaLabel={t("Amend result")}
      >
        <DialogHeader>
          <DialogTitle>{t("Amend the final result?")}</DialogTitle>
          <DialogDescription>
            {t("Corrections are audited and refill the bracket from the corrected winner. Enter the correct set scores and the reason.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-3">
          {amendRows.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-[2.5rem_1fr_1fr_2rem] items-center gap-2"
            >
              <span className="text-xs font-medium text-muted-foreground">
                {periodLabel} {i + 1}
              </span>
              {([0, 1] as const).map((si) => (
                <Input
                  key={si}
                  inputMode="numeric"
                  aria-label={`${t("Amend")} ${periodLabel.toLowerCase()} ${i + 1} ${si === 0 ? homeName : awayName}`}
                  value={row[si]}
                  onChange={(e) =>
                    setAmendRows((rows) =>
                      rows.map((r, j) =>
                        j === i
                          ? ((si === 0
                              ? [e.target.value, r[1]]
                              : [r[0], e.target.value]) as SetRow)
                          : r,
                      ),
                    )
                  }
                  className="h-9 text-center font-tabular"
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t("Remove amended")} ${periodLabel.toLowerCase()} ${i + 1}`}
                disabled={amendRows.length === 1}
                className="h-8 w-8 p-0"
                onClick={() =>
                  setAmendRows((rows) => rows.filter((_, j) => j !== i))
                }
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => setAmendRows((rows) => [...rows, ["", ""]])}
          >
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {t("Add")} {periodLabel.toLowerCase()}
          </Button>
          <div className="flex flex-col gap-1 pt-1">
            <Label htmlFor="amend-reason" className="text-xs">
              {t("Reason")}
            </Label>
            <Input
              id="amend-reason"
              value={amendReason}
              onChange={(e) => setAmendReason(e.target.value)}
              placeholder={t("Why is the result changing?")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setAmendOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            data-testid="confirm-amend"
            disabled={
              amend.isPending ||
              amendReason.trim() === "" ||
              amendRows.every(([h, a]) => h === "" || a === "")
            }
            onClick={() => amend.mutate({ event_id: newEventId() })}
          >
            {t("Amend result")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
