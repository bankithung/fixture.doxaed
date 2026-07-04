import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Minus, Plus, Radio, X } from "lucide-react";
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
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { TargetSportConsoleProps } from "./TargetSportConsole";
import { setsWon, statusMeta, type SetRow } from "./shared";
import { changeEndsPrompt, serveTurn, type ServeRules } from "./serve";
import { useAnnotate, useFirstServer } from "./hooks";

/** Native table tennis console (P2). Same chassis contract as the generic
 * set surface, ITTF-shaped: Game vocabulary, a service indicator that
 * alternates every two points (every point from deuce), big rally tap zones
 * that also log the point on the scoresheet, change-ends and deciding-game
 * prompts, the toweling nudge, and one timeout per match per side. The
 * stepper editor stays below, collapsed, for corrections. */
export function TTConsole({
  matchId,
  match,
  homeName,
  awayName,
  live,
  isFinal,
  refresh,
  onError,
  actions,
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
  // The tap zones hold the truth locally, so a push lost to a dead
  // connection is never lost data: syncFailed flips on and the retry loop
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
  const [firstServer, toggleFirstServer] = useFirstServer(matchId);

  const sm = statusMeta(match.status);
  const periodLabel = t(match.sport_meta?.terms?.period ?? "Game");
  const periodPlural = `${periodLabel}s`;
  const [homeSets, awaySets] = setsWon(setRows, match.scoring ?? null);
  const completeSets = setRows.filter(([h, a]) => h !== "" && a !== "");
  // The game in play = the last editor row; its points are the BIG score
  // while the match runs (taps show up instantly).
  const currentSetRow = setRows[setRows.length - 1] ?? ["", ""];
  const homePts = Number(currentSetRow[0] || 0);
  const awayPts = Number(currentSetRow[1] || 0);
  const finishedSetChips = setRows
    .slice(0, -1)
    .filter(([h, a]) => h !== "" && a !== "");

  // ITTF service config (2 serves a turn, every point from 10 all; ends
  // switch in the deciding game when a side first reaches 5).
  const scoringServe = match.scoring?.serve;
  const scoringPoints = match.scoring?.points;
  const serveRules: ServeRules = useMemo(
    () => ({
      serves_per_turn: scoringServe?.serves_per_turn ?? 2,
      alternate_every_point: scoringServe?.alternate_every_point ?? true,
      points: scoringPoints ?? 11,
      change_ends_at: {
        regular: scoringServe?.change_ends_at?.regular,
        deciding: scoringServe?.change_ends_at?.deciding ?? 5,
      },
    }),
    [scoringServe, scoringPoints],
  );
  const setNo = setRows.length;
  const bestOf = match.scoring?.best_of ?? 5;
  const need = Math.floor(bestOf / 2) + 1;
  const matchDecided = homeSets >= need || awaySets >= need;
  const server = serveTurn(homePts, awayPts, serveRules, firstServer);
  // Whether the game in play just finished (legally won under the rules).
  const prevWon = setsWon(setRows.slice(0, -1), match.scoring ?? null);
  const currentRowWon = homeSets + awaySets > prevWon[0] + prevWon[1];

  // Prompt banner: ends change between games, and the deciding-game switch
  // the moment a side first reaches 5. One slot; each trigger latches once.
  const [banner, setBanner] = useState<{ text: string; startNext: boolean } | null>(null);
  const decidingFired = useRef(false);
  const gameEndFired = useRef(0);
  useEffect(() => {
    if (!live) return;
    if (
      setNo === bestOf &&
      !decidingFired.current &&
      changeEndsPrompt(setNo, bestOf, homePts, awayPts, serveRules)
    ) {
      decidingFired.current = true;
      setBanner({
        text: `${t("Change ends in the deciding")} ${periodLabel.toLowerCase()}.`,
        startNext: false,
      });
      return;
    }
    if (currentRowWon && !matchDecided && gameEndFired.current !== setNo) {
      gameEndFired.current = setNo;
      setBanner({
        text: `${periodLabel} ${setNo} ${t("done. Change ends.")}`,
        startNext: true,
      });
    }
  }, [
    live,
    setNo,
    bestOf,
    homePts,
    awayPts,
    serveRules,
    currentRowWon,
    matchDecided,
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

  // The PRIMARY interaction: a TT point is just a point — one tap bumps the
  // running game AND logs the rally on the scoresheet.
  const tapPoint = (sideIdx: 0 | 1) => {
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
    setSetRows((rows) => [...rows, ["", ""]]);
    setBanner(null);
  };

  return (
    <>
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
          </span>

          <div className="grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
            <div className="min-w-0 text-right">
              <div className="flex items-center justify-end gap-1.5">
                {!isFinal && server === 0 ? (
                  // The service dot sits on the serving side.
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
                <div className="truncate text-sm font-medium sm:text-base">{homeName}</div>
              </div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Home")}
              </div>
            </div>
            {!isFinal ? (
              // In play: the BIG number is the CURRENT GAME's points,
              // straight from the tap zones so a tap shows up instantly.
              <div className="text-center">
                <div
                  data-testid="set-scoreboard"
                  className="font-tabular text-4xl font-semibold tabular-nums sm:text-6xl"
                >
                  {homePts}
                  <span className="px-2 text-muted-foreground">-</span>
                  {awayPts}
                </div>
                <p className="mt-1 font-tabular text-sm text-muted-foreground">
                  {periodLabel} {setNo} · {periodPlural} {homeSets}-{awaySets}
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
              <div className="flex items-center justify-start gap-1.5">
                <div className="truncate text-sm font-medium sm:text-base">{awayName}</div>
                {!isFinal && server === 1 ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
              </div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Away")}
              </div>
            </div>
          </div>

          {!isFinal ? (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
              <span
                data-testid="serve-indicator"
                className="inline-flex items-center gap-1.5 text-sm"
              >
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-primary" />
                <span className="font-medium">
                  {t("Service")}: {server === 0 ? homeName : awayName}
                </span>
              </span>
              <button
                type="button"
                aria-label={t("First server")}
                onClick={toggleFirstServer}
                className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("First serve")}: {firstServer === 0 ? homeName : awayName}
              </button>
            </div>
          ) : null}

          {(() => {
            // In play: finished games from the local editor (instant); once
            // final, the server's recorded games.
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
          })()}

          {actions}
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
        </div>
      </div>

      {/* Ends prompts: between games, and the deciding-game switch at 5. */}
      {banner ? (
        <div
          data-testid="change-ends"
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-medium text-secondary-foreground print:hidden"
        >
          <span>{banner.text}</span>
          <div className="flex items-center gap-2">
            {banner.startNext && !matchDecided ? (
              <Button size="sm" onClick={startNextGame}>
                {t("Start")} {periodLabel.toLowerCase()} {setNo + 1}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setBanner(null)}>
              {t("Done")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Rally scoring: tap zones first, timeouts, and the stepper editor
          collapsed below for corrections. */}
      {live || match.status === "scheduled" ? (
        <div className="rounded-xl border border-border bg-card shadow-sm print:hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("Rally scoring")}</h2>
            </div>
            <span className="font-tabular text-xs text-muted-foreground">
              {periodPlural} {homeSets}-{awaySets}
              {match.scoring?.best_of ? ` · ${t("best of")} ${match.scoring.best_of}` : ""}
            </span>
          </div>
          <div className="flex flex-col gap-3 p-4">
            {/* One tap = one rally point for that side. */}
            <div className="grid grid-cols-2 gap-3">
              {([0, 1] as const).map((sideIdx) => (
                <button
                  key={sideIdx}
                  type="button"
                  data-testid={sideIdx === 0 ? "point-home" : "point-away"}
                  onClick={() => tapPoint(sideIdx)}
                  className="flex h-16 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg bg-primary px-2 text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="text-base font-semibold">{t("Point")}</span>
                  <span className="max-w-full truncate text-xs opacity-90">
                    {sideIdx === 0 ? homeName : awayName}
                  </span>
                </button>
              ))}
            </div>

            {towelDue ? (
              <p
                data-testid="towel-break"
                className="text-center text-xs text-muted-foreground"
              >
                {t("Towel break")}
              </p>
            ) : null}

            {live ? (
              // Timeouts: one per match per side (ITTF 3.4.4.1.1).
              <div className="grid grid-cols-2 gap-3">
                {(["home", "away"] as const).map((side) => (
                  <Button
                    key={side}
                    type="button"
                    variant="outline"
                    data-testid={`timeout-${side}`}
                    disabled={timeouts[side] >= 1}
                    onClick={() => spendTimeout(side)}
                    className="h-11 justify-between px-3"
                  >
                    <span className="truncate">
                      {t("Timeout")} · {side === "home" ? homeName : awayName}
                    </span>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {timeouts[side]}/1
                    </span>
                  </Button>
                ))}
              </div>
            ) : null}

            {/* Corrections: the classic stepper editor, collapsed. */}
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                {t("Adjust")} {periodPlural.toLowerCase()}
              </summary>
              <div className="flex flex-col gap-3 border-t border-border p-3">
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
                      {periodLabel} {i + 1}
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
                            aria-label={`${periodLabel} ${i + 1} ${teamLabel} ${t("minus")} 1`}
                            data-testid={`set-${i}-${sideKey}-minus`}
                            className="h-11 w-10 shrink-0 p-0"
                            onClick={() => bump(i, sideIdx, -1)}
                          >
                            <Minus aria-hidden="true" className="h-4 w-4" />
                          </Button>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-center text-[0.6875rem] text-muted-foreground sm:hidden">
                              {teamLabel}
                            </span>
                            <Input
                              inputMode="numeric"
                              aria-label={`${periodLabel} ${i + 1} ${teamLabel}`}
                              value={row[sideIdx]}
                              onChange={(e) => setSide(i, sideIdx, e.target.value)}
                              className="h-11 w-full text-center font-tabular text-lg font-semibold"
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            aria-label={`${periodLabel} ${i + 1} ${teamLabel} ${t("plus")} 1`}
                            data-testid={`set-${i}-${sideKey}-plus`}
                            className="h-11 w-14 shrink-0 p-0"
                            onClick={() => bump(i, sideIdx, 1)}
                          >
                            <Plus aria-hidden="true" className="h-5 w-5" />
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t("Remove")} ${periodLabel.toLowerCase()} ${i + 1}`}
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
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => setSetRows((rows) => [...rows, ["", ""]])}
                >
                  <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                  {t("Add")} {periodLabel.toLowerCase()}
                </Button>
              </div>
            </details>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-3">
              {match.status === "live" ? (
                <span
                  data-testid="tap-sync-state"
                  className="text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {progress.isPending
                    ? t("Saving")
                    : syncFailed
                      ? t("Offline. Points are safe on this phone.")
                      : t("Saves as you tap")}
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
            <p className="text-xs text-muted-foreground">
              {match.status === "live"
                ? t("Points update live for viewers. Record result finishes the match.")
                : t("Recording the result completes the match.")}
            </p>
          </div>
        </div>
      ) : null}

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
