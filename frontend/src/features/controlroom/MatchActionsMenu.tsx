import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  CalendarClock,
  CalendarOff,
  CircleStop,
  Flag,
  Lock,
  LockOpen,
  Megaphone,
  Minus,
  MoreVertical,
  OctagonX,
  Plus,
  Radio,
  RotateCcw,
  SquarePen,
  TimerReset,
  TriangleAlert,
  UserCog,
} from "lucide-react";
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
import {
  DelayMatchDialog,
  MatchRepairMenu,
  MoveMatchDialog,
  SwapMatchDialog,
} from "@/features/fixtures/MatchRepairControls";
import { MOVABLE_STATUSES, errorDetail } from "@/features/fixtures/repair";
import { AssignDrawer } from "./AssignDrawer";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { IN_PLAY, isOverdue } from "./format";

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
export function WalkoverDialog({
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
          {t("The chosen team wins without play. The winner advances and the change is logged.")}
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

/** Match state verbs beyond start/complete (PRD 5.5): every one carries a
 * required reason (mid-play interruptions must be defensible in a dispute). */
type StateVerbKey = "postpone" | "cancel" | "abandon" | "replay";

const STATE_VERBS: Record<
  StateVerbKey,
  { label: string; to: string; title: string; hint: string; danger: boolean }
> = {
  postpone: {
    label: "Postpone",
    to: "postponed",
    title: "Postpone this match?",
    hint: "The match pauses until it is reslotted or resumed. The score so far is kept.",
    danger: false,
  },
  cancel: {
    label: "Cancel match",
    to: "cancelled",
    title: "Cancel this match?",
    hint: "The match will not be played. This cannot be undone.",
    danger: true,
  },
  abandon: {
    label: "Abandon",
    to: "abandoned",
    title: "Abandon this match?",
    hint: "Play stops (weather, injury, crowd). A manager can order a replay later.",
    danger: true,
  },
  replay: {
    label: "Order replay",
    to: "scheduled",
    title: "Replay this match?",
    hint: "The abandoned result is voided and the match returns to the schedule.",
    danger: false,
  },
};

/** Which state verbs this viewer can fire for this match right now. */
export function stateVerbsFor(
  match: ControlRoomMatch,
  perms: ControlRoomPerms,
): StateVerbKey[] {
  const inPlay = match.status === "live" || match.status === "half_time";
  const out: StateVerbKey[] = [];
  if (perms.canManage) {
    if (match.status === "scheduled" || inPlay) out.push("postpone", "cancel");
    if (match.status === "postponed") out.push("cancel");
    if (match.status === "abandoned") out.push("replay");
  }
  // Abandoning is a pitch-side call — referees/scorers hold it too.
  if (inPlay && (perms.canManage || perms.canScore)) out.push("abandon");
  return out;
}

/** Reason-required confirm dialog for postpone/cancel/abandon/replay. */
export function MatchStateDialog({
  tournamentId,
  match,
  verb,
  onClose,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  verb: StateVerbKey;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const cfg = STATE_VERBS[verb];

  const fire = useMutation({
    mutationFn: () => liveApi.transition(match.id, cfg.to, { reason }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      qc.invalidateQueries({ queryKey: qk.controlRoom(tournamentId) });
      qc.invalidateQueries({ queryKey: qk.matches(tournamentId) });
      toast.push({ kind: "success", title: t(cfg.label) });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the match"),
        description: errorDetail(e),
      }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t(cfg.title)}>
      <DialogHeader>
        <DialogTitle>{t(cfg.title)}</DialogTitle>
        <DialogDescription>{t(cfg.hint)}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5 py-2">
        <Label htmlFor={`state-reason-${match.id}`}>{t("Reason")}</Label>
        <textarea
          id={`state-reason-${match.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={t("E.g. waterlogged pitch, floodlight failure")}
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={fire.isPending} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          variant={cfg.danger ? "destructive" : "default"}
          data-testid={`state-${verb}-confirm-${match.id}`}
          disabled={fire.isPending || reason.trim().length < 3}
          onClick={() => fire.mutate()}
        >
          {fire.isPending ? t("Saving…") : t(cfg.label)}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const INCIDENT_KINDS = [
  { value: "foul_play", label: "Foul play" },
  { value: "misconduct", label: "Misconduct" },
  { value: "injury", label: "Injury" },
  { value: "abandonment", label: "Abandonment" },
  { value: "other", label: "Other" },
];

/** Referee incident quick-file — the backend was complete with zero UI. */
export function IncidentDialog({
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
  const [kind, setKind] = useState("");
  const [description, setDescription] = useState("");
  const [minute, setMinute] = useState("");

  const file = useMutation({
    mutationFn: () =>
      liveApi.fileIncident(match.id, {
        kind,
        description,
        minute: minute ? Number(minute) : null,
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Incident filed") });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not file the incident"),
        description: errorDetail(e),
      }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("File incident")}>
      <DialogHeader>
        <DialogTitle>{t("File incident")}</DialogTitle>
        <DialogDescription>
          {t("A permanent report on this match (foul play, injury, protest grounds). Organizers are notified.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`incident-kind-${match.id}`}>{t("Type")}</Label>
          <Select
            id={`incident-kind-${match.id}`}
            aria-label={t("Incident type")}
            value={kind}
            onChange={setKind}
            options={INCIDENT_KINDS.map((k) => ({ value: k.value, label: t(k.label) }))}
            placeholder={t("Pick a type…")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`incident-desc-${match.id}`}>{t("What happened")}</Label>
          <textarea
            id={`incident-desc-${match.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`incident-minute-${match.id}`}>{t("Minute (optional)")}</Label>
          <Input
            id={`incident-minute-${match.id}`}
            inputMode="numeric"
            value={minute}
            onChange={(e) => setMinute(e.target.value)}
            className="h-9 w-24 font-tabular"
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={file.isPending} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          data-testid={`incident-confirm-${match.id}`}
          disabled={file.isPending || !kind || description.trim().length < 5}
          onClick={() => file.mutate()}
        >
          {file.isPending ? t("Saving…") : t("File incident")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}


const DISPUTE_KINDS = [
  { value: "score", label: "Score" },
  { value: "eligibility", label: "Eligibility" },
  { value: "conduct", label: "Conduct" },
  { value: "other", label: "Other" },
];

/** Raise a dispute ABOUT THIS MATCH (protests could not cite a match before —
 * the backend always accepted match_id; the UI never sent it). */
export function DisputeDialog({
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
  const [kind, setKind] = useState("score");
  const [description, setDescription] = useState("");

  const raise = useMutation({
    mutationFn: async () => {
      const { disputesApi } = await import("@/api/disputes");
      return disputesApi.raise(tournamentId, {
        kind,
        description,
        match_id: match.id,
        event_id: newEventId(),
      });
    },
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Dispute raised") });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not raise the dispute"),
        description: errorDetail(e),
      }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Raise dispute")}>
      <DialogHeader>
        <DialogTitle>{t("Raise a dispute")}</DialogTitle>
        <DialogDescription>
          {t("A formal protest about this match. Organizers review and resolve it with a written note.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`dispute-kind-${match.id}`}>{t("Type")}</Label>
          <Select
            id={`dispute-kind-${match.id}`}
            aria-label={t("Dispute type")}
            value={kind}
            onChange={setKind}
            options={DISPUTE_KINDS.map((k) => ({ value: k.value, label: t(k.label) }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`dispute-desc-${match.id}`}>{t("Grounds")}</Label>
          <textarea
            id={`dispute-desc-${match.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={raise.isPending} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          data-testid={`dispute-confirm-${match.id}`}
          disabled={raise.isPending || description.trim().length < 5}
          onClick={() => raise.mutate()}
        >
          {raise.isPending ? t("Saving…") : t("Raise dispute")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function QuickResultDialog({
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
  // Level knockout: the engine refuses completion until a shootout decides
  // it — reveal pens inputs instead of dead-ending on the error.
  const [needsShootout, setNeedsShootout] = useState(false);
  const [pens, setPens] = useState<{ home: string; away: string }>({
    home: "",
    away: "",
  });
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
    mutationFn: async () => {
      const event_id = newEventId();
      if (isSets) {
        return tournamentsApi.scoreSets(match.id, {
          set_scores: filled.map(([h, a]) => [Number(h), Number(a)]),
          event_id,
        });
      }
      if (needsShootout) {
        await liveApi.scoreShootout(match.id, {
          home_pens: Number(pens.home),
          away_pens: Number(pens.away),
          event_id: newEventId(),
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
    onError: (e) => {
      if (errorDetail(e) === "knockout_draw_needs_shootout") {
        setNeedsShootout(true);
        toast.push({
          kind: "info",
          title: t("Level knockout. Enter the shootout result to decide it."),
        });
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not save the result"),
        description: errorDetail(e),
      });
    },
  });

  const homeName = match.home_team?.name ?? t("Home");
  const awayName = match.away_team?.name ?? t("Away");
  const pensOk =
    !needsShootout ||
    (pens.home !== "" && pens.away !== "" && Number(pens.home) !== Number(pens.away));
  const canSave = !save.isPending && pensOk && (isSets ? filled.length > 0 : true);

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
                "Points for each set played. Winner and standings update automatically.",
              )
            : t("Enter the final score. The winner advances.")}
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

      {needsShootout ? (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
          <p className="text-xs font-medium">
            {t("Penalty shootout (decides the level knockout)")}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(["home", "away"] as const).map((side) => (
              <div key={side} className="flex flex-col gap-1">
                <Label htmlFor={`qr-pens-${side}-${match.id}`} className="truncate text-xs">
                  {side === "home" ? homeName : awayName}
                </Label>
                <Input
                  id={`qr-pens-${side}-${match.id}`}
                  inputMode="numeric"
                  data-testid={`qr-pens-${side}-${match.id}`}
                  value={pens[side]}
                  onChange={(e) =>
                    setPens((prev) => ({
                      ...prev,
                      [side]: e.target.value.replace(/[^0-9]/g, "").slice(0, 2),
                    }))
                  }
                  className="h-9 text-center font-tabular"
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
  const [assign, setAssign] = useState(false);
  const [stateVerb, setStateVerb] = useState<StateVerbKey | null>(null);
  const [incident, setIncident] = useState(false);
  const [dispute, setDispute] = useState(false);

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
    ["scheduled", "live", "half_time"].includes(match.status) &&
    match.home_team !== null &&
    match.away_team !== null;
  // Assigning officials / scorer / court is a schedule-editor (or manager) verb.
  const showAssign = perms.canSchedule;
  const verbs = stateVerbsFor(match, perms);
  const showIncident =
    (showConsole || perms.canManage) &&
    ["live", "half_time", "completed", "abandoned"].includes(match.status);

  if (
    !showCall && !showConsole && !showWalkover && !perms.canSchedule &&
    verbs.length === 0 && !showIncident
  ) {
    return null; // read-only member — the tile stays a pure status card
  }

  const VERB_ICONS: Record<StateVerbKey, typeof CalendarOff> = {
    postpone: CalendarOff,
    cancel: OctagonX,
    abandon: CircleStop,
    replay: RotateCcw,
  };

  const iconBtn =
    "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
      {showQuick ? (
        <Button
          size="sm"
          variant="outline"
          data-testid={`quick-result-${match.id}`}
          className="h-8 border-primary/40 text-primary hover:bg-primary/10"
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
          className="h-8"
          data-testid={`call-${match.id}`}
          disabled={call.isPending}
          onClick={() => call.mutate()}
        >
          <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
          {called ? t("Clear call") : t("Call to court")}
        </Button>
      ) : null}
      {/* Secondary verbs collapse to labelled icon buttons — the ops board runs
          20+ tiles a lane, so a five-button row per tile was the clutter. */}
      <span className="ml-auto flex items-center gap-0.5">
        {showConsole ? (
          <Link
            to={routes.matchConsole(tournamentId, match.id)}
            data-testid={`console-${match.id}`}
            aria-label={t("Open console")}
            title={t("Open console")}
            className={`${iconBtn} text-primary`}
          >
            <Radio aria-hidden="true" className="h-4 w-4" />
          </Link>
        ) : null}
        {showAssign ? (
          <button
            type="button"
            data-testid={`assign-${match.id}`}
            aria-label={t("Assign officials")}
            title={t("Assign")}
            onClick={() => setAssign(true)}
            className={`${iconBtn} text-muted-foreground hover:text-foreground`}
          >
            <UserCog aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        {showWalkover ? (
          <button
            type="button"
            data-testid={`walkover-${match.id}`}
            aria-label={t("Award walkover")}
            title={t("Walkover")}
            onClick={() => setWalkover(true)}
            className={`${iconBtn} text-muted-foreground hover:text-foreground`}
          >
            <Flag aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        {verbs.map((v) => {
          const Icon = VERB_ICONS[v];
          return (
            <button
              key={v}
              type="button"
              data-testid={`state-${v}-${match.id}`}
              aria-label={t(STATE_VERBS[v].label)}
              title={t(STATE_VERBS[v].label)}
              onClick={() => setStateVerb(v)}
              className={`${iconBtn} ${STATE_VERBS[v].danger ? "text-destructive/80 hover:text-destructive" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
            </button>
          );
        })}
        {showIncident ? (
          <button
            type="button"
            data-testid={`incident-${match.id}`}
            aria-label={t("File incident")}
            title={t("File incident")}
            onClick={() => setIncident(true)}
            className={`${iconBtn} text-muted-foreground hover:text-foreground`}
          >
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        {["completed", "walkover", "live", "half_time"].includes(match.status) ? (
          <button
            type="button"
            data-testid={`dispute-${match.id}`}
            aria-label={t("Raise dispute")}
            title={t("Raise dispute")}
            onClick={() => setDispute(true)}
            className={`${iconBtn} text-muted-foreground hover:text-foreground`}
          >
            <Flag aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
        {perms.canSchedule ? (
          <MatchRepairMenu
            tournamentId={tournamentId}
            match={match}
            siblings={siblings}
          />
        ) : null}
      </span>
      {stateVerb ? (
        <MatchStateDialog
          tournamentId={tournamentId}
          match={match}
          verb={stateVerb}
          onClose={() => setStateVerb(null)}
        />
      ) : null}
      {incident ? (
        <IncidentDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setIncident(false)}
        />
      ) : null}
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
      {assign ? (
        <AssignDrawer
          tournamentId={tournamentId}
          match={match}
          onClose={() => setAssign(false)}
        />
      ) : null}
      {stateVerb ? (
        <MatchStateDialog
          tournamentId={tournamentId}
          match={match}
          verb={stateVerb}
          onClose={() => setStateVerb(null)}
        />
      ) : null}
      {incident ? (
        <IncidentDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setIncident(false)}
        />
      ) : null}
      {dispute ? (
        <DisputeDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setDispute(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Dense-board / triage-strip action affordance: a MoreVertical overflow menu
 * carrying the SAME role-gated verbs + dialogs as {@link MatchActionsMenu} (kept
 * for the mobile card), plus an optional state-chosen PRIMARY button for the
 * Needs-you strip. `idScope` namespaces the testids so the same match can render
 * in both the strip and the board without id collisions — the board keeps the
 * canonical testids the domain tests resolve against.
 */
export function RowActions({
  tournamentId,
  match,
  siblings,
  perms,
  primary = false,
  idScope = "",
  showRepair = true,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  siblings: MatchRow[];
  perms: ControlRoomPerms;
  /** Needs-you strip: surface the single most-likely verb as a filled button. */
  primary?: boolean;
  /** Testid prefix (default "" = canonical). The strip passes "needs-". */
  idScope?: string;
  /** The board shows the repair overflow; the strip omits it. */
  showRepair?: boolean;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [walkover, setWalkover] = useState(false);
  const [quick, setQuick] = useState(false);
  const [assign, setAssign] = useState(false);
  const [stateVerb, setStateVerb] = useState<StateVerbKey | null>(null);
  const [incident, setIncident] = useState(false);
  const [dispute, setDispute] = useState(false);
  const [repair, setRepair] = useState<"move" | "delay" | "swap" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const locked = Boolean(match.locked_at);
  const lockToggle = useMutation({
    mutationFn: () =>
      locked
        ? tournamentsApi.unlockMatch(match.id)
        : tournamentsApi.lockMatch(match.id),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: locked
          ? t("Slot unlocked")
          : t("Slot locked. Re-runs and delays will not move it."),
      });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not update the lock") }),
  });

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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const showCall = perms.canSchedule && match.status === "scheduled";
  const showConsole =
    perms.canScore ||
    (match.scorer !== null && match.scorer.id === perms.userId);
  const showQuick =
    showConsole && (match.status === "scheduled" || match.status === "live");
  const showWalkover =
    perms.canManage &&
    ["scheduled", "live", "half_time"].includes(match.status) &&
    match.home_team !== null &&
    match.away_team !== null;
  const showAssign = perms.canSchedule;
  const verbs = stateVerbsFor(match, perms);
  const showIncident =
    (showConsole || perms.canManage) &&
    ["live", "half_time", "completed", "abandoned"].includes(match.status);
  const showRepairItems =
    showRepair && perms.canSchedule && MOVABLE_STATUSES.has(match.status);
  const anyItem =
    showQuick || showCall || showConsole || showAssign || showWalkover ||
    verbs.length > 0 || showIncident || showRepairItems;

  if (!anyItem && !perms.canSchedule) return null; // read-only member

  // The single verb the Needs-you strip promotes to a filled button.
  const verb: "result" | "call" | "assign" | null = !primary
    ? null
    : showQuick && (IN_PLAY.has(match.status) || isOverdue(match))
      ? "result"
      : showCall && !called
        ? "call"
        : showAssign && (!match.venue || !match.scorer)
          ? "assign"
          : showQuick
            ? "result"
            : null;

  const tid = (name: string): string => `${idScope}${name}-${match.id}`;
  const item =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50";

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-1">
      {verb === "result" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 border-primary/40 text-primary hover:bg-primary/10"
          data-testid={tid("quick-result")}
          onClick={() => setQuick(true)}
        >
          <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Enter result")}
        </Button>
      ) : null}
      {verb === "call" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          data-testid={tid("call")}
          disabled={call.isPending}
          onClick={() => call.mutate()}
        >
          <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Call to court")}
        </Button>
      ) : null}
      {verb === "assign" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          data-testid={tid("assign")}
          onClick={() => setAssign(true)}
        >
          <UserCog aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Assign")}
        </Button>
      ) : null}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Match actions")}
        data-testid={tid("actions")}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreVertical aria-hidden="true" className="h-4 w-4" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t("Match actions")}
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {showQuick && verb !== "result" ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("quick-result")}
              className={cn(item, "text-primary")}
              onClick={() => {
                setQuick(true);
                setOpen(false);
              }}
            >
              <SquarePen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {t("Enter result")}
            </button>
          ) : null}
          {showCall && verb !== "call" ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("call")}
              className={item}
              disabled={call.isPending}
              onClick={() => {
                call.mutate();
                setOpen(false);
              }}
            >
              <Megaphone aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {called ? t("Clear call") : t("Call to court")}
            </button>
          ) : null}
          {showConsole ? (
            <Link
              to={routes.matchConsole(tournamentId, match.id)}
              role="menuitem"
              data-testid={tid("console")}
              className={item}
              onClick={() => setOpen(false)}
            >
              <Radio aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {t("Open console")}
            </Link>
          ) : null}
          {showAssign && verb !== "assign" ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("assign")}
              className={item}
              onClick={() => {
                setAssign(true);
                setOpen(false);
              }}
            >
              <UserCog aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {t("Assign")}
            </button>
          ) : null}
          {showWalkover ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("walkover")}
              className={cn(item, "text-destructive")}
              onClick={() => {
                setWalkover(true);
                setOpen(false);
              }}
            >
              <Flag aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {t("Award walkover")}
            </button>
          ) : null}
          {showIncident ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("incident")}
              className={item}
              onClick={() => {
                setIncident(true);
                setOpen(false);
              }}
            >
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {t("File incident")}
            </button>
          ) : null}
          {["completed", "walkover", "live", "half_time"].includes(match.status) ? (
            <button
              type="button"
              role="menuitem"
              data-testid={tid("dispute")}
              className={item}
              onClick={() => {
                setDispute(true);
                setOpen(false);
              }}
            >
              <Flag aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {t("Raise dispute")}
            </button>
          ) : null}
          {verbs.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitem"
              data-testid={tid(`state-${v}`)}
              className={cn(item, STATE_VERBS[v].danger && "text-destructive")}
              onClick={() => {
                setStateVerb(v);
                setOpen(false);
              }}
            >
              {v === "postpone" ? (
                <CalendarOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              ) : v === "cancel" ? (
                <OctagonX aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              ) : v === "abandon" ? (
                <CircleStop aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              )}
              {t(STATE_VERBS[v].label)}
            </button>
          ))}
          {showRepairItems ? (
            <>
              <div className="my-1 h-px bg-border" role="separator" />
              <button
                type="button"
                role="menuitem"
                data-testid={`repair-move-${match.id}`}
                className={item}
                onClick={() => {
                  setRepair("move");
                  setOpen(false);
                }}
              >
                <CalendarClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {t("Move…")}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`repair-delay-${match.id}`}
                className={item}
                disabled={match.scheduled_at === null || locked}
                onClick={() => {
                  setRepair("delay");
                  setOpen(false);
                }}
              >
                <TimerReset aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {t("Delay…")}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`repair-swap-${match.id}`}
                className={item}
                disabled={match.scheduled_at === null}
                onClick={() => {
                  setRepair("swap");
                  setOpen(false);
                }}
              >
                <ArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {t("Swap…")}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`repair-lock-${match.id}`}
                className={item}
                disabled={lockToggle.isPending}
                onClick={() => {
                  lockToggle.mutate();
                  setOpen(false);
                }}
              >
                {locked ? (
                  <LockOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                )}
                {locked ? t("Unlock slot") : t("Lock slot")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {repair === "move" ? (
        <MoveMatchDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setRepair(null)}
        />
      ) : null}
      {repair === "delay" ? (
        <DelayMatchDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setRepair(null)}
        />
      ) : null}
      {repair === "swap" ? (
        <SwapMatchDialog
          tournamentId={tournamentId}
          match={match}
          siblings={siblings}
          onClose={() => setRepair(null)}
        />
      ) : null}

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
      {assign ? (
        <AssignDrawer
          tournamentId={tournamentId}
          match={match}
          onClose={() => setAssign(false)}
        />
      ) : null}
      {stateVerb ? (
        <MatchStateDialog
          tournamentId={tournamentId}
          match={match}
          verb={stateVerb}
          onClose={() => setStateVerb(null)}
        />
      ) : null}
      {incident ? (
        <IncidentDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setIncident(false)}
        />
      ) : null}
      {dispute ? (
        <DisputeDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setDispute(false)}
        />
      ) : null}
    </div>
  );
}
