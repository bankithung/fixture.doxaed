import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Layers, ListChecks, Wand2 } from "lucide-react";
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
import { invalidateTournament } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Draw format chosen per competition. "groups_knockout" generates the group
 * stage NOW; the knockout is generated from final standings later via the
 * competition's "Advance to knockout" action (advance-per-group is asked
 * again there, prefilled).
 */
export type DrawFormat = "league" | "groups" | "knockout" | "groups_knockout";

const FORMATS: {
  key: DrawFormat;
  label: string;
  hint: string;
  icon: typeof Wand2;
}[] = [
  {
    key: "league",
    label: "League",
    hint: "Everyone plays everyone once — a single table decides it.",
    icon: ListChecks,
  },
  {
    key: "groups",
    label: "Groups",
    hint: "Round-robin inside groups of N — standings per group.",
    icon: Layers,
  },
  {
    key: "knockout",
    label: "Knockout",
    hint: "Single elimination. Byes are added automatically.",
    icon: GitBranch,
  },
  {
    key: "groups_knockout",
    label: "Groups → Knockout",
    hint: "Group stage now; the top N of each group advance to a bracket.",
    icon: Wand2,
  },
];

interface Props {
  tournamentId: string;
  open: boolean;
  onClose: () => void;
  /** "" = the legacy/uncategorized bucket. */
  leafKey: string;
  leafLabel: string;
  teamCount: number;
  /** Called after a successful generation — chain the schedule wizard here. */
  onGenerated: (opts: { leafKey: string; label: string }) => void;
}

/**
 * Per-competition "Generate draw" wizard — asks the questions the two old
 * one-click buttons skipped: format, group size, how many advance. On
 * success it offers to chain straight into the ScheduleWizard, which asks
 * the WHEN/WHERE questions (dates, venues/places, timings, rest rules).
 */
export function GenerateDrawWizard({
  tournamentId,
  open,
  onClose,
  leafKey,
  leafLabel,
  teamCount,
  onGenerated,
}: Props): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [format, setFormat] = useState<DrawFormat>("league");
  const [groupSize, setGroupSize] = useState(4);
  const [scheduleNext, setScheduleNext] = useState(true);

  const needsGroups = format === "groups" || format === "groups_knockout";
  const groupCount = needsGroups
    ? Math.max(1, Math.ceil(teamCount / Math.max(2, groupSize)))
    : 1;

  const generate = useMutation({
    mutationFn: () => {
      if (format === "knockout") {
        return tournamentsApi.generateFixtures(tournamentId, {
          format: "knockout",
          leafKey: leafKey || undefined,
        });
      }
      if (needsGroups) {
        return tournamentsApi.generateFixtures(tournamentId, {
          format: "round_robin",
          groupSize: Math.max(2, groupSize),
          leafKey: leafKey || undefined,
        });
      }
      // League: one round-robin over the whole competition.
      return leafKey
        ? tournamentsApi.generateFixtures(tournamentId, {
            format: "by_category",
            leafKey,
          })
        : tournamentsApi.generateFixtures(tournamentId, {
            format: "round_robin",
            groupSize: Math.max(2, teamCount),
          });
    },
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t("Draw generated"),
        description:
          format === "groups_knockout"
            ? t("Group stage created. Once groups finish, use \"Advance to knockout\".")
            : undefined,
      });
      onClose();
      if (scheduleNext) onGenerated({ leafKey, label: leafLabel });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not generate the draw"),
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
      ariaLabel={t("Generate draw")}
    >
      <DialogHeader>
        <DialogTitle>
          {leafLabel ? t(`Generate draw — ${leafLabel}`) : t("Generate draw")}
        </DialogTitle>
        <DialogDescription>
          {t(
            `${teamCount} registered teams. Pick a format — every competition can use a different one.`,
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("Draw format")}>
        {FORMATS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="radio"
            aria-checked={format === f.key}
            data-testid={`format-${f.key}`}
            onClick={() => setFormat(f.key)}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
              format === f.key
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-accent/40",
            )}
          >
            <f.icon
              aria-hidden="true"
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                format === f.key ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(f.label)}</span>
              <span className="block text-xs text-muted-foreground">{t(f.hint)}</span>
            </span>
          </button>
        ))}
      </div>

      {needsGroups ? (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-muted/30 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("Teams per group")}</span>
            <Input
              type="number"
              min={2}
              max={Math.max(2, teamCount)}
              value={groupSize}
              data-testid="group-size"
              onChange={(e) => setGroupSize(Number(e.target.value) || 2)}
              className="h-9 w-24"
            />
          </label>
          <p className="pb-1.5 text-xs text-muted-foreground">
            {t(`→ ${groupCount} ${groupCount === 1 ? "group" : "groups"}`)}
            {format === "groups_knockout"
              ? " · " + t("you'll pick how many advance when the groups finish")
              : null}
          </p>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={scheduleNext}
          onChange={(e) => setScheduleNext(e.target.checked)}
          data-testid="schedule-next"
          className="h-4 w-4 rounded border-input accent-[var(--primary,theme(colors.emerald.700))]"
        />
        {t("Next, ask me about dates, venues and timings (open the scheduler)")}
      </label>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
          data-testid="confirm-generate"
        >
          <Wand2 aria-hidden="true" className="h-4 w-4" />
          {generate.isPending ? t("Generating...") : t("Generate draw")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * "Advance to knockout" confirm — asks how many advance per group, then
 * builds the cross-seeded bracket from final group standings.
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
  const [advance, setAdvance] = useState(2);

  const run = useMutation({
    mutationFn: () =>
      tournamentsApi.generateFixtures(tournamentId, {
        format: "knockout_from_groups",
        advancePerGroup: Math.max(1, advance),
        leafKey: leafKey || undefined,
      }),
    onSuccess: (data) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t(`Knockout generated — ${data.generated} matches`),
      });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not advance to knockout"),
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
      ariaLabel={t("Advance to knockout")}
    >
      <DialogHeader>
        <DialogTitle>
          {leafLabel
            ? t(`Advance to knockout — ${leafLabel}`)
            : t("Advance to knockout")}
        </DialogTitle>
        <DialogDescription>
          {t(
            "Top teams from each group enter a cross-seeded bracket (group winners meet other groups' runners-up first).",
          )}
        </DialogDescription>
      </DialogHeader>
      <label className="flex w-fit flex-col gap-1">
        <span className="text-xs font-medium">{t("Advance per group")}</span>
        <Input
          type="number"
          min={1}
          max={8}
          value={advance}
          data-testid="advance-per-group"
          onChange={(e) => setAdvance(Number(e.target.value) || 1)}
          className="h-9 w-24"
        />
      </label>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          type="button"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          data-testid="confirm-advance"
        >
          <GitBranch aria-hidden="true" className="h-4 w-4" />
          {run.isPending ? t("Generating...") : t("Generate knockout")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
