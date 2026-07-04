import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Minus, Plus, Radio, X } from "lucide-react";
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
import { isNetworkError } from "@/api/client";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { setsWon, statusMeta, type SetRow } from "./shared";

export interface TargetSportConsoleProps {
  matchId: string;
  match: LiveSnapshot["match"];
  homeName: string;
  awayName: string;
  live: boolean;
  isFinal: boolean;
  refresh: () => void;
  onError: (e: unknown) => void;
  /** The chassis's state-transition buttons, rendered inside the scoreboard
   * card exactly where the football surface puts its own. */
  actions: React.ReactNode;
}

/** The whole scoring surface for target-family (set) sports: the scoreboard
 * card, the tap-scored set editor with live auto-save, result recording and
 * the audited amend flow (H3). The chassis mounts it via the console
 * registry; per-sport native consoles can replace it there. */
export function TargetSportConsole({
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
  // Tap scoring: how many points one +/- tap moves (owner 2026-07-03), and
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
  // The steppers hold the truth locally, so a push lost to a dead connection
  // is never lost data: syncFailed flips on and the retry loop below re-sends
  // the LATEST rows until the network returns.
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

  const sm = statusMeta(match.status);
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
            {/* Football periods and the running minute mean nothing to a set
                sport; its pill relies on the Set N line under the score. */}
          </span>

          <div className="grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-medium sm:text-base">{homeName}</div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Home")}
              </div>
            </div>
            {!isFinal ? (
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

          {(() => {
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
          })()}

          {match.home_pens != null && match.away_pens != null ? (
            <p className="font-tabular text-xs text-muted-foreground">
              {t("Pens")} {match.home_pens}-{match.away_pens}
            </p>
          ) : null}

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

      {/* Set-sport result entry — the server rejects goal events for set
          sports, so the console never offers them (P7b). */}
      {live || match.status === "scheduled" ? (
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
            </div>
            <p className="text-xs text-muted-foreground">
              {match.status === "live"
                ? t("Points update live for viewers. Record result finishes the match.")
                : t("Recording the result completes the match.")}
            </p>
          </div>
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
                {t("Set")} {i + 1}
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
