import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Lock } from "lucide-react";
import {
  tournamentsApi,
  type StageConsequences,
  type StageInfo,
} from "@/api/tournaments";
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
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Human copy for blocker/warning codes (server returns codes; FE localises). */
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
    case "form_will_reopen":
      return t("This stage's registration form will re-open.");
    case "lifecycle_will_change":
      return t("The tournament status will change to") + ` "${String(w.to)}".`;
    case "rules_will_freeze":
      return t("Rules will be locked — later changes will need an amend reason.");
    case "downstream_artifacts_exist":
      return (
        `${String(w.count)} ` +
        t("generated fixtures exist; editing earlier stages may invalidate them.")
      );
    case "rules_frozen":
      return t("Rules are frozen; editing them needs an amend reason.");
    default:
      return w.code;
  }
}

const countLabel = (s: StageInfo): string | null => {
  const entries = Object.entries(s.counts);
  if (!entries.length) return null;
  const [k, v] = entries[0];
  return `${v} ${t(k)}`;
};

export function StageStepper({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  const stageQ = useQuery({
    queryKey: ["tournament-stage", tournamentId],
    queryFn: () => tournamentsApi.stage(tournamentId),
  });

  const previewQ = useQuery({
    queryKey: ["tournament-stage-preview", tournamentId, target],
    queryFn: () => tournamentsApi.previewStage(tournamentId, target as string),
    enabled: target !== null,
  });

  const transition = useMutation({
    mutationFn: () =>
      tournamentsApi.transitionStage(tournamentId, {
        to_stage: target as string,
        ack_warnings: true,
        event_id: newEventId(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tournament-stage", tournamentId] });
      qc.invalidateQueries({ queryKey: ["tournament", tournamentId] });
      qc.invalidateQueries({ queryKey: ["t-teams", tournamentId] });
      qc.invalidateQueries({ queryKey: ["t-matches", tournamentId] });
      toast.push({ kind: "success", title: t("Stage updated") });
      closeDialog();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not change stage"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const closeDialog = (): void => {
    setTarget(null);
    setAck(false);
  };

  if (stageQ.isLoading || !stageQ.data) return null;
  const data = stageQ.data;
  const allowed = new Set(data.allowed_to);
  const curIdx = data.order.indexOf(data.stage);

  const consequences = previewQ.data;
  const blockers = consequences?.blockers ?? [];
  const warnings = consequences?.warnings ?? [];
  const isReopen = target !== null && data.order.indexOf(target) < curIdx;

  return (
    <section
      aria-label={t("Setup progress")}
      className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Setup progress")}
        </p>
        {data.rules_frozen_at ? (
          <span className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
            <Lock aria-hidden="true" className="h-3 w-3" />
            {t("Rules frozen")}
          </span>
        ) : null}
      </div>

      <ol className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-1">
        {data.stages.map((s, i) => {
          const clickable = data.can_manage && allowed.has(s.key);
          const count = countLabel(s);
          return (
            <li key={s.key} className="flex-1">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && (setAck(false), setTarget(s.key))}
                aria-current={s.state === "current" ? "step" : undefined}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                  s.state === "current"
                    ? "border-primary bg-primary/[0.04]"
                    : s.state === "complete"
                      ? "border-border bg-background"
                      : "border-dashed border-border bg-background",
                  clickable
                    ? "hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    : "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full font-tabular text-xs font-semibold",
                    s.state === "complete"
                      ? "bg-primary text-primary-foreground"
                      : s.state === "current"
                        ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {s.state === "complete" ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block truncate text-sm font-medium",
                      s.state === "upcoming" && "text-muted-foreground",
                    )}
                  >
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                    {count ??
                      (s.form
                        ? `${t("Form")} · ${t(s.form.status)}`
                        : t(s.state))}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Transition confirm dialog (preview → ack → execute). */}
      <Dialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) closeDialog();
        }}
        ariaLabel={t("Confirm stage change")}
      >
        <DialogHeader>
          <DialogTitle>
            {isReopen ? t("Go back to this stage?") : t("Advance to this stage?")}
          </DialogTitle>
          <DialogDescription>
            {previewQ.isLoading
              ? t("Checking…")
              : blockers.length
                ? t("This can't be done yet:")
                : warnings.length
                  ? t("Please confirm the following before continuing:")
                  : t("This will move the tournament to the next stage.")}
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
              {warnings.map((w, idx) => (
                <li
                  key={idx}
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
          <Button variant="outline" onClick={closeDialog}>
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
            {transition.isPending
              ? t("Working…")
              : isReopen
                ? t("Go back")
                : t("Continue")}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
