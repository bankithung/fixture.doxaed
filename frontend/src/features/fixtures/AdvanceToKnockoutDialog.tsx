import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";

/**
 * "Build the knockout bracket" confirm (clarity rebuild §4.7): builds the
 * cross-seeded bracket from final group standings. Teams-advancing-per-group
 * was already asked and stored by the Step 2 wizard — this dialog PREFILLS
 * the stored value (defaults < "*" < leaf) and never re-asks it as a blank
 * question; editing here is an explicit override.
 */
export function AdvanceToKnockoutDialog({
  tournamentId,
  open,
  onClose,
  leafKey,
  leafLabel,
}: {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
  leafKey: string;
  leafLabel: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  /** null = untouched — show the stored value once it loads. */
  const [advance, setAdvance] = useState<number | null>(null);

  const drawConfig = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
    enabled: open,
  });
  const stored = drawConfig.data
    ? Number(
        (leafKey ? drawConfig.data.draw_config[leafKey]?.advance_per_group : undefined) ??
          drawConfig.data.draw_config["*"]?.advance_per_group ??
          drawConfig.data.defaults.advance_per_group ??
          2,
      )
    : null;
  const value = advance ?? stored ?? 2;

  const run = useMutation({
    mutationFn: () =>
      tournamentsApi.generateFixtures(tournamentId, {
        format: "knockout_from_groups",
        advancePerGroup: Math.max(1, value),
        leafKey: leafKey || undefined,
      }),
    onSuccess: (data) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t(`Bracket built - ${data.generated} matches`),
      });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not build the bracket"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      ariaLabel={t("Build the knockout bracket")}
    >
      <DialogHeader>
        <DialogTitle>
          {leafLabel
            ? t(`Build the knockout bracket · ${leafLabel}`)
            : t("Build the knockout bracket")}
        </DialogTitle>
        <DialogDescription>
          {t(
            "Top teams from each group enter the bracket, cross-seeded against other groups' runners-up.",
          )}
        </DialogDescription>
      </DialogHeader>
      <label className="flex w-fit flex-col gap-1">
        <span className="text-xs font-medium">{t("Teams advancing per group")}</span>
        <Input
          type="number"
          min={1}
          max={8}
          value={value}
          data-testid="advance-per-group"
          onChange={(e) => setAdvance(Number(e.target.value) || 1)}
          className="h-9 w-24"
        />
        <span className="text-xs text-muted-foreground">
          {t("Set in Step 2. Change only if you mean to.")}
        </span>
      </label>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          disabled={run.isPending || drawConfig.isLoading}
          onClick={() => run.mutate()}
          data-testid="confirm-advance"
        >
          <GitBranch aria-hidden="true" className="h-4 w-4" />
          {run.isPending ? t("Building…") : t("Build bracket")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
