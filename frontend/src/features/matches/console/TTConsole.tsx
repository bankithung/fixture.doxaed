import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { liveApi } from "@/api/live";
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
import { useToast } from "@/components/ui/toast";
import { isNetworkError } from "@/api/client";
import { newEventId } from "@/lib/eventId";
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
import { changeEndsPrompt } from "./serve";
import { useAnnotate, usePointKeys } from "./hooks";
import {
  ConsoleActionBar,
  ConsoleStrip,
  GameHistory,
  MatchDecidedPrompt,
  NextGamePrompt,
  PointFlag,
  ScoreEditor,
  ScorePad,
  SyncBadge,
  TargetRule,
  type StripCell,
  type SyncState,
} from "./Scoreboard";

/** Native table tennis console (P2). ONE board, laid out as an instrument
 * panel: a telemetry strip (status, game of best-of, match score, stopwatch,
 * sync), the two score cards with the stage's winning rule between them,
 * timeouts, the full game history (every game the rule allows, played and
 * still to play), a state rail, and a sticky action bar. ITTF-shaped: Game
 * vocabulary, the deciding-game change-ends nudge, the toweling nudge, one
 * timeout per match per side. Service is deliberately not tracked here
 * (owner 2026-07-26) — the umpire calls it. */
export function TTConsole({
  matchId,
  match,
  homeName,
  awayName,
  homeCrest,
  awayCrest,
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

  // Seed the game editor from the server ONCE per mount so a live match
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

  // H3: audited manager correction of a COMPLETED result. The bracket
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

  // Scoresheet annotations: non-scoring events (invariant 4 — the score of
  // record stays set_scores; a logged point never moves it).
  const annotate = useAnnotate(matchId, onError, refresh);
  // Corrections live in a panel the scorer opens on purpose (rail button or
  // "Edit scores" on the history), never a stray tap away from the pads.
  const [editOpen, setEditOpen] = useState(false);

  const periodLabel = t(match.sport_meta?.terms?.period ?? "Game");
  const periodPlural = `${periodLabel}s`;
  const prog = setProgress(setRows, match.scoring ?? null, 5);
  const { homeSets, awaySets, bestOf, setNo, decided } = prog;
  const completeSets = setRows.filter(([h, a]) => h !== "" && a !== "");
  // The game in play = the last editor row; its points are the BIG score
  // while the match runs (taps show up instantly).
  const currentSetRow = setRows[setRows.length - 1] ?? ["", ""];
  const homePts = Number(currentSetRow[0] || 0);
  const awayPts = Number(currentSetRow[1] || 0);

  // ITTF change-ends config: ends switch in the deciding game when a side
  // first reaches 5.
  const changeEndsRegular = match.scoring?.serve?.change_ends_at?.regular;
  const changeEndsDeciding = match.scoring?.serve?.change_ends_at?.deciding ?? 5;
  // Whether the game in play just finished (legally won under the rules).
  const prevWon = setsWon(setRows.slice(0, -1), match.scoring ?? null);
  const currentRowWon = homeSets + awaySets > prevWon[0] + prevWon[1];
  const rulesKnown = (match.scoring?.points ?? 0) > 0;
  // Not started is not in play (owner 2026-08-17): a scheduled match showed a
  // live-looking board whose Point buttons and shortcut keys were both armed.
  const inPlay = live;
  // The explicit between-games step: the finished game locks the Point
  // buttons until "Start game N+1" is pressed (no stray 12-5s, no magic).
  const awaitingNext = inPlay && rulesKnown && currentRowWon && !decided;
  const canScore = inPlay && !decided && !awaitingNext;
  const winnerName = prog.leader == null ? null : prog.leader === 0 ? homeName : awayName;
  // What ends the game in play: the target score for the caption, and the
  // live "Game point / Match point" flag when the next point can finish it.
  const decidingGame = setNo === bestOf;
  const stageRule = setTargets(match.scoring ?? null, decidingGame);
  const targetPts = stageRule.points;
  const gpSide = canScore
    ? gamePointSide(homePts, awayPts, match.scoring ?? null, decidingGame)
    : null;
  const gpName = gpSide == null ? null : gpSide === 0 ? homeName : awayName;
  const gpIsMatch =
    gpSide != null && (gpSide === 0 ? homeSets : awaySets) + 1 >= prog.need;

  // Deciding-game change-ends nudge: fires once when a side first reaches 5
  // in the last possible game (ITTF 2.14.1); dismissable.
  const [nudge, setNudge] = useState<string | null>(null);
  const decidingFired = useRef(false);
  useEffect(() => {
    if (!live || decidingFired.current) return;
    if (
      setNo === bestOf &&
      changeEndsPrompt(setNo, bestOf, homePts, awayPts, {
        change_ends_at: {
          regular: changeEndsRegular,
          deciding: changeEndsDeciding,
        },
      })
    ) {
      decidingFired.current = true;
      setNudge(`${t("Change ends in the deciding")} ${periodLabel.toLowerCase()}.`);
    }
  }, [
    live,
    setNo,
    bestOf,
    homePts,
    awayPts,
    changeEndsRegular,
    changeEndsDeciding,
    periodLabel,
  ]);

  // Toweling nudge: every 6 total points in the game in play (ITTF 3.4.4.1.2),
  // gone again on the next point.
  const totalPts = homePts + awayPts;
  const towelDue = live && !currentRowWon && totalPts > 0 && totalPts % 6 === 0;

  // Timeouts: ONE per match per side (never resets between games).
  const [timeouts, setTimeouts] = useState({ home: 0, away: 0 });

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

  // The PRIMARY interaction: the Point button scores the rally and logs it
  // on the scoresheet.
  const tapPoint = (sideIdx: 0 | 1) => {
    buzz();
    bump(setRows.length - 1, sideIdx, 1);
    if (live) {
      const side = sideIdx === 0 ? "home" : "away";
      annotate.mutate({
        event_type: "point",
        side,
        detail: { scoring_side: side },
        event_id: newEventId(),
      });
    }
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
  const startNextGame = () => {
    buzz();
    setSetRows((rows) => [...rows, ["", ""]]);
  };


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

  // The strip: every reading the umpire glances at, as label/value cells.
  const stripCells: StripCell[] = [
    {
      key: "period",
      label: decided && !isFinal ? `${periodPlural} ${t("played")}` : periodLabel,
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
      {/* ONE board: everything the umpire needs, in one section. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm print:hidden">
        <ConsoleStrip
          status={match.status}
          cells={stripCells}
          trailing={inPlay ? <SyncBadge state={syncState} live={live} /> : null}
          winnerName={decided || isFinal ? winnerName : null}
          title={title}
          titleActions={titleActions}
        />

        <div className="flex flex-col gap-3 p-3">
            <ScorePad
              homeName={homeName}
              awayName={awayName}
              homeCrest={homeCrest}
              awayCrest={awayCrest}
              homeValue={isFinal ? (match.home_score ?? 0) : homePts}
              awayValue={isFinal ? (match.away_score ?? 0) : awayPts}
              canScore={canScore}
              canEdit={inPlay}
              winner={decided || isFinal ? prog.leader : null}
              onPoint={tapPoint}
              onMinus={(s) => bump(setRows.length - 1, s, -1)}
              shortcuts={canScore ? ["q", "p"] : null}
              footers={
                live ? [timeoutButton("home"), timeoutButton("away")] : undefined
              }
              rule={
                // Once a side has clinched there is no stage left for the
                // rule to describe; the history caption keeps the record.
                decided || isFinal ? undefined : (
                <TargetRule
                  points={targetPts}
                  winBy={stageRule.winBy}
                  cap={stageRule.cap}
                  bestOf={bestOf}
                  periodLabel={periodLabel}
                  periodNo={setNo}
                />
                )
              }
            />

            {awaitingNext ? (
              <NextGamePrompt
                summary={`${periodLabel} ${setNo} ${t("done")} ${homePts}-${awayPts}. ${t("Change ends.")}`}
                startLabel={`${t("Start")} ${periodLabel.toLowerCase()} ${setNo + 1}`}
                onStart={startNextGame}
              />
            ) : null}

            {!isFinal && gpName ? (
              <div className="flex justify-center">
                <PointFlag
                  kind={gpIsMatch ? "match" : "set"}
                  periodLabel={periodLabel}
                  name={gpName}
                />
              </div>
            ) : null}

            {nudge ? (
              <div
                data-testid="change-ends"
                role="status"
                className="flex items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground"
              >
                <span>{nudge}</span>
                <button
                  type="button"
                  aria-label={t("Dismiss")}
                  onClick={() => setNudge(null)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {towelDue ? (
              <p
                data-testid="towel-break"
                className="text-center text-xs text-muted-foreground"
              >
                {t("Towel break")}
              </p>
            ) : null}

            {decided && !isFinal ? (
              // The clinch is the completion gate: the server rejects a
              // result before it, so this step exists only from here — and it
              // is the ONE Record result control (no bottom-bar twin).
              <MatchDecidedPrompt
                winnerName={winnerName}
                winnerCrest={prog.leader === 0 ? homeCrest : awayCrest}
                periodsWon={`${Math.max(homeSets, awaySets)}-${Math.min(homeSets, awaySets)}`}
                periodPlural={periodPlural}
                recordLabel={t("Record result")}
                pending={submitSets.isPending}
                onRecord={() => setConfirmSets(true)}
              />
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
            </>
          }
        />
      </div>

      {/* Confirm the result (completes the match). */}
      <Dialog
        open={confirmSets}
        onOpenChange={setConfirmSets}
        ariaLabel={t("Confirm result")}
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

      {/* H3: manager amend of a completed result — audited, reasoned. */}
      <Dialog
        open={amendOpen}
        onOpenChange={setAmendOpen}
        ariaLabel={t("Amend result")}
      >
        <DialogHeader>
          <DialogTitle>{t("Amend the final result?")}</DialogTitle>
          <DialogDescription>
            {t("Corrections are audited and refill the bracket from the corrected winner. Enter the correct game scores and the reason.")}
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
