import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { tournamentsApi, type CopySetupReport } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Take another tournament's fixture setup (owner 2026-08-19: "I need a copy
 * rule from different tournaments so that I can directly copy the rules we
 * have in Clone 2 into our main when it starts").
 *
 * It shows what would arrive BEFORE anything is written, because the settings
 * are worth a season of tuning and the target may already have its own. The
 * report also names every competition the copied rules mention that this
 * tournament does not have — a rule that would read as set and do nothing.
 *
 * Data is never copied. Schools, teams, players, forms and results stay with
 * the tournament that owns them; only the inputs the generator reads move.
 */

const PART_LABELS: Record<string, string> = {
  constraints: "Scheduling rules",
  draw_config: "Draw settings, calendar and durations",
  scheduling_config: "Saved schedule settings",
  rules: "Scoring rules and tiebreakers",
};

export function CopySetupDialog({
  tournamentId,
  open,
  onClose,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [source, setSource] = useState("");
  const [withScoring, setWithScoring] = useState(false);
  const [report, setReport] = useState<CopySetupReport | null>(null);

  const all = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
    enabled: open,
  });

  const options = useMemo(
    () =>
      (all.data ?? [])
        .filter((x) => x.id !== tournamentId)
        .map((x) => ({ value: x.id, label: x.name })),
    [all.data, tournamentId],
  );

  const parts = withScoring
    ? ["constraints", "draw_config", "scheduling_config", "rules"]
    : undefined;

  const check = useMutation({
    mutationFn: () =>
      tournamentsApi.copySetup(tournamentId, {
        source_tournament_id: source,
        parts,
        dry_run: true,
      }),
    onSuccess: setReport,
    onError: () =>
      toast.push({
        kind: "error",
        title: t("Could not read that tournament's setup."),
      }),
  });

  const take = useMutation({
    mutationFn: () =>
      tournamentsApi.copySetup(tournamentId, {
        source_tournament_id: source,
        parts,
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t("Setup copied"),
        description: t("Preview the fixture to see it applied."),
      });
      onClose();
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not copy that setup.") }),
  });

  if (!open) return null;
  const busy = check.isPending || take.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      ariaLabel={t("Copy fixture setup")}
    >
      <div data-testid="copy-setup-dialog" className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">
            {t("Copy setup from another tournament")}
          </h2>
          <p className="pt-1 text-xs text-muted-foreground">
            {t(
              "Takes the rules, calendar, durations and draw settings. Your schools, teams, players and results are never touched.",
            )}
          </p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("Copy from")}</span>
          <Select
            value={source}
            onChange={(v) => {
              setSource(v);
              setReport(null);
            }}
            options={options}
            placeholder={
              all.isPending ? t("Loading…") : t("Choose a tournament")
            }
            aria-label={t("Copy from")}
          />
        </label>

        <button
          type="button"
          data-testid="copy-setup-scoring"
          aria-pressed={withScoring}
          onClick={() => {
            setWithScoring((v) => !v);
            setReport(null);
          }}
          className="flex w-fit items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <span
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded border",
              withScoring ? "border-primary bg-primary" : "border-border",
            )}
          >
            {withScoring ? (
              <Check aria-hidden="true" className="h-3 w-3 text-primary-foreground" />
            ) : null}
          </span>
          {t("Also copy the scoring rules and tiebreakers")}
        </button>

        {report ? (
          <div
            data-testid="copy-setup-report"
            className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
          >
            <p className="text-xs font-medium">
              {t("What would arrive from")} {report.source_name}
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {report.parts.map((p) => (
                <li key={p} className="flex items-baseline gap-2">
                  <span className="font-tabular font-medium text-foreground">
                    {report.counts[p] ?? 0}
                  </span>
                  {t(PART_LABELS[p] ?? p)}
                </li>
              ))}
            </ul>
            {report.target_had.constraints > 0 ? (
              <p className="text-xs text-warning">
                {t("This replaces the")} {report.target_had.constraints}{" "}
                {t("rules already here.")}
              </p>
            ) : null}
            {report.unknown_competitions.length ? (
              <div className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                />
                <span>
                  {t(
                    "These rules name competitions this tournament does not have, so they would do nothing:",
                  )}{" "}
                  {report.unknown_competitions.join(", ")}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            variant="outline"
            className="ml-auto"
            data-testid="copy-setup-check"
            disabled={!source || busy}
            onClick={() => check.mutate()}
          >
            {t("Check first")}
          </Button>
          <Button
            data-testid="copy-setup-apply"
            disabled={!source || busy || !report}
            onClick={() => take.mutate()}
          >
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Copy it over")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
