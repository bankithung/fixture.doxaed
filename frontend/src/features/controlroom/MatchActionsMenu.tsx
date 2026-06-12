import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Radio } from "lucide-react";
import { liveApi } from "@/api/live";
import type { ControlRoomMatch, MatchRow } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { MatchRepairMenu } from "@/features/fixtures/MatchRepairControls";
import { errorDetail } from "@/features/fixtures/repair";
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
    </div>
  );
}
