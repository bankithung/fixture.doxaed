import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check } from "lucide-react";
import { tournamentsApi, type StageConsequences } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/** Each stage's work page (so advancing carries you to the next one). */
const STAGE_ROUTE: Record<string, (id: string) => string> = {
  setup: routes.tournamentSports,
  org_registration: routes.tournamentInstitutions,
  team_registration: routes.tournamentTeams,
  members: routes.tournamentMembers,
  fixtures: routes.tournamentFixtures,
};

function blockerText(code: string): string {
  const m: Record<string, string> = {
    no_teams_registered: t("Register at least one team before continuing."),
    no_fixtures_generated: t("Generate fixtures before marking the tournament ready."),
    illegal_transition: t("That move isn't allowed from the current stage."),
  };
  return m[code] ?? code;
}

function warningText(w: StageConsequences["warnings"][number]): string {
  switch (w.code) {
    case "form_will_close":
      return t("The current stage's registration form will close.");
    case "lifecycle_will_change":
      return t("The tournament status will change to") + ` "${String(w.to)}".`;
    case "rules_will_freeze":
      return t("Rules will be locked — later changes will need an amend reason.");
    case "team_form_will_be_created":
      return t("A team-registration form draft will be created for you to review.");
    case "no_sports_selected":
      return t("No sports selected yet — add them on the Sports tab first.");
    default:
      return w.code;
  }
}

/**
 * Persistent "Continue to «next stage»" control rendered under every stage page,
 * so setup reads as a followed flow without detouring to Overview. Same
 * preview → acknowledge → transition path as the stepper; on success it carries
 * you to the next stage's page.
 */
export function StageContinue({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);

  const stageQ = useQuery({
    queryKey: ["tournament-stage", tournamentId],
    queryFn: () => tournamentsApi.stage(tournamentId),
  });
  const data = stageQ.data;
  const nextStage = data ? data.order[data.order.indexOf(data.stage) + 1] : undefined;

  const previewQ = useQuery({
    queryKey: ["tournament-stage-preview", tournamentId, nextStage],
    queryFn: () => tournamentsApi.previewStage(tournamentId, nextStage as string),
    enabled: open && !!nextStage,
  });
  const transition = useMutation({
    mutationFn: () =>
      tournamentsApi.transitionStage(tournamentId, {
        to_stage: nextStage as string,
        ack_warnings: true,
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Moved to the next stage") });
      setOpen(false);
      const dest = nextStage ? STAGE_ROUTE[nextStage]?.(tournamentId) : null;
      if (dest) navigate(dest);
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not continue"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  if (!data) return null;
  const allowed = new Set(data.allowed_to);
  const canAdvance = data.can_manage && !!nextStage && allowed.has(nextStage);
  if (!canAdvance) {
    if (data.stage === "ready") {
      return (
        <div className="mt-6 flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 py-3 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          <Check aria-hidden="true" className="h-4 w-4" />
          {t("Setup complete")}
        </div>
      );
    }
    return null;
  }
  const curIdx = data.order.indexOf(data.stage);
  const nextLabel = data.stages[curIdx + 1]?.label ?? t("next stage");
  const blockers = previewQ.data?.blockers ?? [];
  const warnings = previewQ.data?.warnings ?? [];

  return (
    <div className="mt-6 flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        {t("Done with this step?")}{" "}
        <span className="font-medium text-foreground">
          {t("Next")}: {nextLabel}
        </span>
      </p>
      <Button
        onClick={() => {
          setAck(false);
          setOpen(true);
        }}
        className="shrink-0"
      >
        {t("Continue")}
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(false);
            setAck(false);
          }
        }}
        ariaLabel={t("Confirm continue")}
      >
        <DialogHeader>
          <DialogTitle>{t("Continue to")} {nextLabel}?</DialogTitle>
          <DialogDescription>
            {previewQ.isLoading
              ? t("Checking…")
              : blockers.length
                ? t("This can't be done yet:")
                : warnings.length
                  ? t("Please confirm the following before continuing:")
                  : t("This moves the tournament to the next stage.")}
          </DialogDescription>
        </DialogHeader>

        {blockers.length ? (
          <ul className="flex flex-col gap-1.5">
            {blockers.map((b) => (
              <li
                key={b}
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                {blockerText(b)}
              </li>
            ))}
          </ul>
        ) : warnings.length ? (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-1.5">
              {warnings.map((w, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  {warningText(w)}
                </li>
              ))}
            </ul>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              {t("I understand the above")}
            </label>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              setAck(false);
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              previewQ.isLoading ||
              blockers.length > 0 ||
              (warnings.length > 0 && !ack) ||
              transition.isPending
            }
            onClick={() => transition.mutate()}
          >
            {transition.isPending ? t("Working…") : t("Continue")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
