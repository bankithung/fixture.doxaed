import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import {
  tournamentsApi,
  type SportScoringConfig,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Deep-ish preset match: the sport currently plays this preset when every
 * key the preset sets agrees with the stored scoring. */
function matchesPreset(
  current: SportScoringConfig | undefined,
  preset: SportScoringConfig,
): boolean {
  if (!current) return false;
  return JSON.stringify(current) === JSON.stringify(preset);
}

/**
 * Scoring regime picker (P2, owner decision D1): each sport's named,
 * SOURCED presets (ISTAF legacy vs ISTAF-2024; ITTF best-of-3/5/7; BWF;
 * FIVB) apply in one click and stay fully editable afterwards — presets,
 * never prisons. Applies to the SPORT level (every competition of the sport
 * inherits unless a per-game override in rules.by_leaf says otherwise).
 */
export function ScoringPresetsPanel({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const metaQ = useQuery({
    queryKey: ["sports-meta", tournamentId],
    queryFn: () => tournamentsApi.sportsMeta(tournamentId),
    staleTime: 300_000,
  });
  const sportsQ = useQuery({
    queryKey: ["t-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
  });

  const apply = useMutation({
    mutationFn: ({
      sportKey,
      scoring,
    }: {
      sportKey: string;
      scoring: SportScoringConfig;
      label: string;
    }) => {
      const sports = (sportsQ.data?.sports ?? []).map((s) =>
        s.key === sportKey ? { ...s, scoring } : s,
      );
      return tournamentsApi.setSports(tournamentId, sports, newEventId());
    },
    onSuccess: (_d, vars) => {
      setPendingKey(null);
      toast.push({
        kind: "success",
        title: `${vars.label} ${t("applied. Editable any time in per-game rules.")}`,
      });
      qc.invalidateQueries({ queryKey: ["t-sports", tournamentId] });
      qc.invalidateQueries({ queryKey: ["sports-meta", tournamentId] });
    },
    onError: (e) => {
      setPendingKey(null);
      toast.push({
        kind: "error",
        title:
          e instanceof Error && e.message
            ? e.message
            : t("Could not apply the preset."),
      });
    },
  });

  const sports = sportsQ.data?.sports ?? [];
  const descriptors = metaQ.data?.descriptors ?? {};
  const rows = sports
    .map((s) => ({ sport: s, presets: descriptors[s.key]?.presets ?? [] }))
    .filter((r) => r.presets.length > 0);
  if (rows.length === 0) return null;

  return (
    <section
      data-testid="scoring-presets"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{t("Scoring regimes")}</h3>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {t(
          "Official rulebook presets per sport. Applying one sets the whole sport; per-game overrides in rules stay possible and always win.",
        )}
      </p>
      <div className="flex flex-col gap-4">
        {rows.map(({ sport, presets }) => {
          const activePreset = presets.find((p) =>
            matchesPreset(sport.scoring, p.scoring),
          );
          return (
            <div key={sport.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{sport.name}</span>
                <span className="text-xs text-muted-foreground">
                  {activePreset
                    ? activePreset.label
                    : sport.scoring
                      ? t("Custom scoring")
                      : t("Sport default")}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => {
                  const active = activePreset?.key === p.key;
                  const busy = pendingKey === `${sport.key}:${p.key}`;
                  return (
                    <Button
                      key={p.key}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      data-testid={`preset-${sport.key}-${p.key}`}
                      disabled={apply.isPending || active}
                      title={p.note}
                      className={cn(active && "pointer-events-none")}
                      onClick={() => {
                        setPendingKey(`${sport.key}:${p.key}`);
                        apply.mutate({
                          sportKey: sport.key,
                          scoring: p.scoring,
                          label: p.label,
                        });
                      }}
                    >
                      {busy ? t("Applying") : p.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
