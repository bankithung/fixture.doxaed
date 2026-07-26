import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleDot, Minus, Plus, X } from "lucide-react";
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
import { buzz, setProgress, setsWon, type SetRow } from "./shared";
import { changeEndsPrompt, serveOfTurn, serveTurn, type ServeRules } from "./serve";
import { useAnnotate, useFirstServer } from "./hooks";
import { GameTrack, StatusChip, TapZones } from "./Scoreboard";

// Point-winning fault vocabulary (sepak blueprint §3): one tap scores the
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

/** Native sepak takraw console (P2). One board: the score zones ARE the
 * point buttons (with fault-reason chips after each rally), the set track
 * shows the best-of rule and the sets still ahead, and the result becomes
 * recordable exactly when a regu clinches — the same gate the server
 * enforces. Courtside extras: serve rotation, ace/kill/block scoresheet
 * stats, one timeout per regu per set, the change-ends prompt. */
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
  const finishedSetChips = setRows
    .slice(0, -1)
    .filter(([h, a]) => h !== "" && a !== "");

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
  const canScore = inPlay && !decided;
  const winnerName = prog.leader == null ? null : prog.leader === 0 ? homeName : awayName;

  // Change-ends banner: latches once per set the moment a side first
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

  // The PRIMARY interaction: a tap on a regu's half scores its rally, then a
  // transient reason chip row explains it (skipping logs nothing extra).
  // Once the running set is legally won, the next tap opens the following
  // set with that point.
  const tapPoint = (sideIdx: 0 | 1) => {
    buzz();
    if (rulesKnown && currentRowWon && !decided) {
      const fresh: SetRow = sideIdx === 0 ? ["1", "0"] : ["0", "1"];
      const next = [...setRows, fresh];
      setSetRows(next);
      schedulePush(next);
    } else {
      bump(setRows.length - 1, sideIdx, 1);
    }
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

  const playerOptions = (players: MiniPlayer[]) => [
    { value: "", label: t("Team (no player)") },
    ...players.map((p) => ({
      value: p.id,
      label: `${p.jersey_no ? `#${p.jersey_no} ` : ""}${p.name}`,
    })),
  ];

  return (
    <>
      {/* The board: status + rule, tap zones, reason chips, set track,
          stats, timeouts, and the result gate — one surface, phone-first. */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm print:hidden">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <StatusChip status={match.status} />
            <span className="font-tabular text-xs text-muted-foreground">
              {isFinal
                ? `${periodPlural} ${match.home_score ?? 0}-${match.away_score ?? 0}`
                : `${periodLabel} ${setNo} ${t("of")} ${bestOf} · ${periodPlural} ${homeSets}-${awaySets}`}
            </span>
          </div>
          {!isFinal ? (
            <button
              type="button"
              aria-label={t("First server")}
              onClick={toggleFirstServer}
              className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("First serve")}: {firstServer === 0 ? homeName : awayName}
            </button>
          ) : null}
        </div>

        <div className="relative flex flex-col gap-3 p-4">
          <TapZones
            homeName={homeName}
            awayName={awayName}
            homeValue={isFinal ? (match.home_score ?? 0) : homePts}
            awayValue={isFinal ? (match.away_score ?? 0) : awayPts}
            server={isFinal ? null : server}
            canScore={canScore}
            canEdit={inPlay}
            onPoint={tapPoint}
            onMinus={(s) => bump(setRows.length - 1, s, -1)}
          />

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

          {!isFinal ? (
            // Serve indicator: who serves the current rally and where the
            // service turn stands (three serves a turn under legacy rules).
            <div className="flex items-center justify-center">
              <span
                data-testid="serve-indicator"
                className="inline-flex items-center gap-1.5 text-sm"
              >
                <CircleDot aria-hidden="true" className="h-4 w-4 text-primary" />
                <span className="font-medium">
                  {t("Serving")}: {server === 0 ? homeName : awayName}
                </span>
                {perTurn > 1 ? (
                  <span className="font-tabular text-xs text-muted-foreground">
                    {t("Serve")} {serveN} {t("of")} {perTurn}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          <GameTrack
            progress={prog}
            periodLabel={periodLabel}
            finished={isFinal ? (match.set_scores ?? []) : finishedSetChips}
            winnerName={winnerName}
            isFinal={isFinal}
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
                    <span className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
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

              {/* Timeouts: one per regu per set. */}
              <div className="grid grid-cols-2 gap-1.5 sm:gap-3">
                {(["home", "away"] as const).map((side) => (
                  <Button
                    key={side}
                    type="button"
                    variant="outline"
                    data-testid={`timeout-${side}`}
                    disabled={timeouts[side] >= 1}
                    onClick={() => spendTimeout(side)}
                    className="h-10 justify-between px-3"
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
            </>
          ) : null}

          {actions}

          {decided && !isFinal ? (
            // The clinch is the completion gate: the server rejects a result
            // before it, so the button exists only from this moment.
            <Button
              data-testid="record-result"
              className="h-12 w-full text-base"
              disabled={submitSets.isPending}
              onClick={() => setConfirmSets(true)}
            >
              {t("Record result")}
            </Button>
          ) : null}

          {isFinal ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="amend-result"
              className="self-center"
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

          {inPlay ? (
            <>
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

              <div className="flex items-center justify-between gap-3">
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
                        : t("Saves as you tap. Viewers see it live.")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("Recording the result completes the match.")}
                  </span>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Change-ends prompt (11 in sets 1 and 2, 8 in the decider). */}
      {endsOpen ? (
        <div
          data-testid="change-ends"
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-medium text-secondary-foreground print:hidden"
        >
          <span>{t("Change ends now.")}</span>
          <Button size="sm" variant="outline" onClick={() => setEndsOpen(false)}>
            {t("Done")}
          </Button>
        </div>
      ) : null}

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
