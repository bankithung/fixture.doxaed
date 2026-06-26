import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Minus, Plus, Radio, SquarePen } from "lucide-react";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type MatchRow,
} from "@/api/tournaments";
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
import { MatchRepairMenu } from "@/features/fixtures/MatchRepairControls";
import { errorDetail } from "@/features/fixtures/repair";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * The caller's control-room capabilities, derived ONCE from the stage payload
 * (`can_manage` + effective `modules`) — the backend stays the enforcement
 * point (spec §4); these flags only decide what to render.
 */
export interface ControlRoomPerms {
  /** `can_manage_tournament` — walkover/replay/assign-scorer class verbs. */
  canManage: boolean;
  /** `tournament.schedule_editor` — call, move, delay, swap, lock. */
  canSchedule: boolean;
  /** `match.scoring_console` — the scorer console. */
  canScore: boolean;
  /** The signed-in user (assigned scorers always reach their console). */
  userId: string | null;
}

/** Manager-only walkover with an explicit winner (spec §1.3 / §2.e). */
function WalkoverDialog({
  tournamentId,
  match,
  onClose,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [winner, setWinner] = useState("");

  const award = useMutation({
    mutationFn: () =>
      liveApi.transition(match.id, "walkover", { winner_team_id: winner }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Walkover awarded") });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not award the walkover"),
        description: errorDetail(e),
      }),
  });

  const options = [match.home_team, match.away_team]
    .filter((tm): tm is NonNullable<typeof tm> => tm !== null)
    .map((tm) => ({ value: tm.id, label: tm.name }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Award walkover")}>
      <DialogHeader>
        <DialogTitle>{t("Award walkover")}</DialogTitle>
        <DialogDescription>
          {t("The chosen team wins without play. This ends the match and the winner advances; the change is recorded in the audit log.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5 py-2">
        <Label htmlFor={`wo-winner-${match.id}`}>{t("Winning team")}</Label>
        <Select
          id={`wo-winner-${match.id}`}
          aria-label={t("Winning team")}
          value={winner}
          onChange={setWinner}
          options={options}
          placeholder={t("Pick the winning team…")}
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={award.isPending} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          variant="destructive"
          data-testid={`walkover-confirm-${match.id}`}
          disabled={award.isPending || winner === ""}
          onClick={() => award.mutate()}
        >
          {award.isPending ? t("Saving…") : t("Award walkover")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Compact, touch-friendly +/- score stepper (goal sports). */
function ScoreStepper({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  testid: string;
}): React.ReactElement {
  const btn =
    "inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="max-w-[8rem] truncate text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t("Decrease")}
          data-testid={`${testid}-dec`}
          className={btn}
          disabled={value <= 0}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          <Minus aria-hidden="true" className="h-4 w-4" />
        </button>
        <span
          data-testid={testid}
          className="w-10 text-center font-tabular text-3xl font-semibold"
        >
          {value}
        </span>
        <button
          type="button"
          aria-label={t("Increase")}
          data-testid={`${testid}-inc`}
          className={btn}
          onClick={() => onChange(value + 1)}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * One-tap result entry for the common "just put the score in" case (members and
 * admins). Writes through the same event-sourced services as the console
 * (record_score / record_set_result): row-locked, idempotent on event_id, and
 * fires advancement + the live tick on commit. Goal sports get +/- steppers;
 * set sports get a per-set points grid driven by the match's resolved rules.
 */
function QuickResultDialog({
  tournamentId,
  match,
  onClose,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const isSets = match.scoring != null;
  const bestOf = match.scoring?.best_of ?? 1;

  const [home, setHome] = useState(match.home_score ?? 0);
  const [away, setAway] = useState(match.away_score ?? 0);
  const [sets, setSets] = useState<[string, string][]>(() =>
    match.set_scores && match.set_scores.length > 0
      ? match.set_scores.map(
          ([h, a]) => [String(h), String(a)] as [string, string],
        )
      : [["", ""]],
  );

  const setCell = (i: number, j: 0 | 1, v: string): void =>
    setSets((prev) => {
      const next = prev.map((row) => [...row] as [string, string]);
      next[i][j] = v.replace(/[^0-9]/g, "").slice(0, 2);
      return next;
    });

  const filled = sets.filter(([h, a]) => h !== "" && a !== "");

  const save = useMutation({
    mutationFn: () => {
      const event_id = newEventId();
      if (isSets) {
        return tournamentsApi.scoreSets(match.id, {
          set_scores: filled.map(([h, a]) => [Number(h), Number(a)]),
          event_id,
        });
      }
      return tournamentsApi.score(match.id, {
        home_score: home,
        away_score: away,
        event_id,
      });
    },
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Result saved") });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the result"),
        description: errorDetail(e),
      }),
  });

  const homeName = match.home_team?.name ?? t("Home");
  const awayName = match.away_team?.name ?? t("Away");
  const canSave = !save.isPending && (isSets ? filled.length > 0 : true);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={t("Enter result")}
    >
      <DialogHeader>
        <DialogTitle>{t("Enter result")}</DialogTitle>
        <DialogDescription>
          {isSets
            ? t(
                "Enter the points for each set played. The winner and standings update automatically.",
              )
            : t(
                "Enter the final score. This completes the match and advances the winner.",
              )}
        </DialogDescription>
      </DialogHeader>

      {isSets ? (
        <div className="flex flex-col gap-2 py-2">
          <div className="flex items-center justify-between gap-2 px-1 text-xs font-medium text-muted-foreground">
            <span className="truncate">{homeName}</span>
            <span className="truncate text-right">{awayName}</span>
          </div>
          {sets.map((s, i) => (
            <div
              key={i}
              className="grid grid-cols-[3rem_1fr_1.25rem_1fr] items-center gap-2"
            >
              <span className="font-tabular text-xs text-muted-foreground">
                {t("Set")} {i + 1}
              </span>
              <Input
                inputMode="numeric"
                aria-label={`${homeName} ${t("set")} ${i + 1}`}
                data-testid={`set-home-${i}`}
                value={s[0]}
                onChange={(e) => setCell(i, 0, e.target.value)}
                className="text-center font-tabular"
              />
              <span aria-hidden="true" className="flex justify-center text-muted-foreground">
                <Minus className="h-3.5 w-3.5" />
              </span>
              <Input
                inputMode="numeric"
                aria-label={`${awayName} ${t("set")} ${i + 1}`}
                data-testid={`set-away-${i}`}
                value={s[1]}
                onChange={(e) => setCell(i, 1, e.target.value)}
                className="text-center font-tabular"
              />
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            {sets.length < bestOf ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSets((p) => [...p, ["", ""]])}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Add set")}
              </Button>
            ) : null}
            {sets.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSets((p) => p.slice(0, -1))}
              >
                {t("Remove set")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-5 py-5">
          <ScoreStepper
            label={homeName}
            value={home}
            onChange={setHome}
            testid={`qr-home-${match.id}`}
          />
          <span className="pt-5 text-muted-foreground">
            <Minus aria-hidden="true" className="h-5 w-5" />
          </span>
          <ScoreStepper
            label={awayName}
            value={away}
            onChange={setAway}
            testid={`qr-away-${match.id}`}
          />
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          data-testid={`quick-result-confirm-${match.id}`}
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t("Saving…") : t("Save result")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Per-tile action row, gated per the spec §4 matrix: schedule editors get
 * Call-to-court + the existing repair menu (move/delay/swap/lock incl. the
 * 409-conflicts force flow), managers add the walkover dialog, scorers (or
 * the assigned scorer) get their console link. Read-only members get nothing.
 */
export function MatchActionsMenu({
  tournamentId,
  match,
  siblings,
  perms,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  /** Same-competition matches (swap candidates for the repair menu). */
  siblings: MatchRow[];
  perms: ControlRoomPerms;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [walkover, setWalkover] = useState(false);
  const [quick, setQuick] = useState(false);

  const called = Boolean(match.called_at);
  const call = useMutation({
    mutationFn: () =>
      called ? liveApi.uncallMatch(match.id) : liveApi.callMatch(match.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.controlRoom(tournamentId) });
      qc.invalidateQueries({ queryKey: qk.matches(tournamentId) });
      toast.push({
        kind: "success",
        title: called ? t("Call cleared") : t("Match called to the venue"),
      });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the call"),
        description: errorDetail(e),
      }),
  });

  const showCall = perms.canSchedule && match.status === "scheduled";
  const showConsole =
    perms.canScore ||
    (match.scorer !== null && match.scorer.id === perms.userId);
  // Quick result writes a terminal score; the engine only accepts it on a
  // scheduled or live match (record_score guard). Same audience as the console.
  const showQuick =
    showConsole && (match.status === "scheduled" || match.status === "live");
  const showWalkover =
    perms.canManage &&
    match.status === "scheduled" &&
    match.home_team !== null &&
    match.away_team !== null;

  if (!showCall && !showConsole && !showWalkover && !perms.canSchedule) {
    return null; // read-only member — the tile stays a pure status card
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
      {showQuick ? (
        <Button
          size="sm"
          variant="outline"
          data-testid={`quick-result-${match.id}`}
          className="border-primary/40 text-primary hover:bg-primary/10"
          onClick={() => setQuick(true)}
        >
          <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Enter result")}
        </Button>
      ) : null}
      {showCall ? (
        <Button
          size="sm"
          variant={called ? "ghost" : "outline"}
          data-testid={`call-${match.id}`}
          disabled={call.isPending}
          onClick={() => call.mutate()}
        >
          <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
          {called ? t("Clear call") : t("Call to court")}
        </Button>
      ) : null}
      {showConsole ? (
        <Link
          to={routes.matchConsole(tournamentId, match.id)}
          data-testid={`console-${match.id}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Radio aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Open console")}
        </Link>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5">
        {showWalkover ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`walkover-${match.id}`}
            onClick={() => setWalkover(true)}
          >
            {t("Walkover…")}
          </Button>
        ) : null}
        {perms.canSchedule ? (
          <MatchRepairMenu
            tournamentId={tournamentId}
            match={match}
            siblings={siblings}
          />
        ) : null}
      </span>
      {walkover ? (
        <WalkoverDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setWalkover(false)}
        />
      ) : null}
      {quick ? (
        <QuickResultDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setQuick(false)}
        />
      ) : null}
    </div>
  );
}
