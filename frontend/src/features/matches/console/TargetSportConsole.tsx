import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { liveApi, type LiveSnapshot } from "@/api/live";
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
import { isRetryable } from "@/api/client";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  buzz,
  gamePointSide,
  setProgress,
  setTargets,
  setsWon,
  type SetRow,
  winningScore,
} from "./shared";
import { usePointKeys } from "./hooks";
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

export interface TargetSportConsoleProps {
  matchId: string;
  match: LiveSnapshot["match"];
  homeName: string;
  awayName: string;
  /** Each side's badge URL ("" / undefined = the team's initials). Resolved by
   * the chassis alongside the names so every console shows the same badge. */
  homeCrest?: string;
  awayCrest?: string;
  live: boolean;
  isFinal: boolean;
  refresh: () => void;
  onError: (e: unknown) => void;
  /** The chassis's state-transition buttons, rendered inside the board
   * exactly where the football surface puts its own. */
  actions: React.ReactNode;
  /** Chassis-owned collapsed rows (discipline recorder, event log) fused
   * into the board so the whole console is ONE section. */
  extras?: React.ReactNode;
  /** Formatted elapsed stopwatch ("8:37"), shown in the board's top strip
   * so the board carries every reading the scorer needs. */
  clock?: string | null;
  /** Chassis-owned "back to matches" link, rendered in the action bar where
   * a thumb can reach it. */
  back?: React.ReactNode;
  /** Competition context ("Table tennis · U19 · Boys · 1v1 · Court 2") — the
   * board's own heading, set inside the panel, not above it. */
  title?: React.ReactNode;
  /** Right-hand slot on the title row (offline queue count, print report). */
  titleActions?: React.ReactNode;
}

/** The scoring surface for target-family (set) sports without a native
 * console. ONE board: score pad with explicit Point buttons (each press
 * adds the chosen step), the between-sets step ("Set 1 done. Start set 2"),
 * the result gate that opens exactly at the clinch (the server's own rule),
 * the set track, and collapsed rows for corrections, discipline and the
 * event log. The audited amend flow (H3) is kept. */
export function TargetSportConsole({
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
  // Tap scoring: how many points one press moves (owner 2026-07-03), and
  // the debounce plumbing that auto-saves the running points while live.
  const [step, setStep] = useState(1);
  const [stepText, setStepText] = useState("1");
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
  // The pad holds the truth locally, so a push lost to a dead connection
  // is never lost data: syncFailed flips on and the retry loop below
  // re-sends the LATEST rows until the network returns.
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
      if (isRetryable(e)) {
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
          // A game is PLAYED when either side has a figure — a side that did
          // not score is 0, not unknown. Requiring both cells dropped every
          // whitewash game from the payload, so an 11-0, 0-11, 11-0, 0-11,
          // 11-0 match reached the server as ONE game and was refused with
          // "the games do not match the best-of rule" (owner 2026-08-27).
          .filter(([h, a]) => h !== "" || a !== "")
          .map(([h, a]) => [Number(h || 0), Number(a || 0)]),
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
  // Corrections live in a panel the scorer opens on purpose (rail button or
  // "Edit scores" on the history), never a stray tap away from the pads.
  const [editOpen, setEditOpen] = useState(false);
  const amend = useMutation({
    mutationFn: (v: { event_id: string }) =>
      liveApi.amendSetResult(matchId, {
        set_scores: amendRows
          // A game is PLAYED when either side has a figure — a side that did
          // not score is 0, not unknown. Requiring both cells dropped every
          // whitewash game from the payload, so an 11-0, 0-11, 11-0, 0-11,
          // 11-0 match reached the server as ONE game and was refused with
          // "the games do not match the best-of rule" (owner 2026-08-27).
          .filter(([h, a]) => h !== "" || a !== "")
          .map(([h, a]) => [Number(h || 0), Number(a || 0)]),
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

  const periodLabel = t(match.sport_meta?.terms?.period ?? "Set");
  const periodPlural = `${periodLabel}s`;
  const prog = setProgress(setRows, match.scoring ?? null, 3);
  const { homeSets, awaySets, bestOf, setNo, decided } = prog;
  const completeSets = setRows.filter(([h, a]) => h !== "" && a !== "");
  // The set in play = the last editor row; its points are the BIG score for
  // set sports while the match runs (taps show up instantly, owner 2026-07-03).
  const currentSetRow = setRows[setRows.length - 1] ?? ["", ""];
  const homePts = Number(currentSetRow[0] || 0);
  const awayPts = Number(currentSetRow[1] || 0);
  // Whether the set in play just finished (legally won under the rules).
  const prevWon = setsWon(setRows.slice(0, -1), match.scoring ?? null);
  const currentRowWon = homeSets + awaySets > prevWon[0] + prevWon[1];
  const rulesKnown = (match.scoring?.points ?? 0) > 0;
  // A match that has not been started is NOT in play (owner 2026-08-17:
  // "if the match is not started then nothing should be clickable"). Treating
  // `scheduled` as in-play left a live-looking board on a match nobody had
  // begun — points could be tapped before the umpire said go, and the shortcut
  // keys were armed.
  const inPlay = live;
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

  // Tap scoring: every edit while LIVE auto-saves (debounced) — no Save
  // button. When the match has not started, edits stay local until the
  // result is recorded, exactly as before.
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
  const setSide = (
    i: number,
    sideIdx: 0 | 1,
    value: string,
    { zeroOther = false }: { zeroOther?: boolean } = {},
  ) => {
    const next = setRows.map((r, j) => {
      if (j !== i) return r;
      // Scoring one side starts the game for BOTH: the other side is on nought,
      // not unknown. Leaving it blank is what made a whitewash look unplayed —
      // it read "Not needed", never locked the board, and was dropped from the
      // recorded result (owner 2026-08-27: "by default all marks should be
      // zero"). Only a tap zeroes the partner; typing in the editor does not.
      const other = zeroOther && r[sideIdx === 0 ? 1 : 0] === "" ? "0" : null;
      return (
        sideIdx === 0
          ? [value, other ?? r[1]]
          : [other ?? r[0], value]
      ) as SetRow;
    });
    setSetRows(next);
    schedulePush(next);
  };
  const bump = (i: number, sideIdx: 0 | 1, delta: number) => {
    const cur = Number(setRows[i]?.[sideIdx] || 0);
    // A point above the score that WINS the set was never played, so the
    // board refuses it — the same ceiling the server applies. Belt and
    // braces behind the between-sets lock, and it also bounds the editor.
    const other = Number(setRows[i]?.[sideIdx === 0 ? 1 : 0] || 0);
    const rule = setTargets(match.scoring ?? null, i + 1 === bestOf);
    const ceiling = winningScore(other, rule.points, rule.winBy, rule.cap);
    setSide(i, sideIdx, String(Math.min(ceiling, Math.max(0, cur + delta))), {
      zeroOther: true,
    });
  };
  const tapPoint = (sideIdx: 0 | 1) => {
    buzz();
    bump(setRows.length - 1, sideIdx, step);
  };
  // Starting the next set is a PUSH, not a local step (owner 2026-08-27):
  // the blank row used to live only on this phone until the first point of the
  // new set was tapped, so the public board and every other viewer kept the
  // finished set's points as the headline score — "6-11" with nothing
  // moving — long after the players had changed ends. The server accepts a
  // trailing 0-0 as the set in play, and its fan-out is what turns the page.
  const startNextSet = () => {
    buzz();
    const next: SetRow[] = [...setRows, ["", ""]];
    setSetRows(next);
    schedulePush(next);
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


  return (
    <>
      {/* ONE board: everything the scorer needs, in one section. The server
          rejects goal events for set sports, so the console never offers
          them (P7b). */}
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
              step={step}
              onPoint={tapPoint}
              onMinus={(s) => bump(setRows.length - 1, s, -step)}
              shortcuts={canScore ? ["q", "p"] : null}
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

            {canScore ? (
              // Points per press: what one Point press adds (any number works).
              // It governs the pads, so it sits directly beneath them.
              <div
                role="group"
                aria-label={t("Points per tap")}
                className="flex flex-wrap items-center justify-center gap-1.5"
              >
                <span className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
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
                      "inline-flex h-8 min-w-9 items-center justify-center rounded-md border px-1.5 font-tabular text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                  className="h-8 w-12 px-1 text-center font-tabular text-xs"
                />
              </div>
            ) : null}

            {awaitingNext ? (
              <NextGamePrompt
                summary={`${periodLabel} ${setNo} ${t("done")} ${homePts}-${awayPts}.`}
                startLabel={`${t("Start")} ${periodLabel.toLowerCase()} ${setNo + 1}`}
                onStart={startNextSet}
              />
            ) : null}

            {gpName ? (
              <div className="flex items-center justify-center">
                <PointFlag
                  kind={gpIsMatch ? "match" : "set"}
                  periodLabel={periodLabel}
                  name={gpName}
                />
              </div>
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

            {match.home_pens != null && match.away_pens != null ? (
              <p className="text-center font-tabular text-xs text-muted-foreground">
                {t("Pens")} {match.home_pens}-{match.away_pens}
              </p>
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
                  step={step}
                  onBump={(i, side, delta) => bump(i, side, delta * step)}
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
                  aria-label={`${t("Amend set")} ${i + 1} ${si === 0 ? homeName : awayName}`}
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
                aria-label={`${t("Remove amended set")} ${i + 1}`}
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
            {t("Add set")}
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
