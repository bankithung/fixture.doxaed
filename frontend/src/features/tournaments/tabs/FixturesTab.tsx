import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, GitBranch, Layers, Wand2 } from "lucide-react";
import { tournamentsApi, type MatchRow } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { ScheduleWizard } from "../ScheduleWizard";
import { EmptyState, ScoreRow, StandingsTable } from "./shared";

export function FixturesTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [wizardOpen, setWizardOpen] = useState(false);

  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: ["t-matches", id], queryFn: () => tournamentsApi.matches(id) });
  const standings = useQuery({ queryKey: ["t-standings", id], queryFn: () => tournamentsApi.standings(id) });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage = stage.data?.can_manage ?? false;

  const grouped = useMemo(() => {
    const g: Record<string, MatchRow[]> = {};
    for (const m of matches.data ?? []) (g[m.group_label || "—"] ||= []).push(m);
    return g;
  }, [matches.data]);

  const generate = useMutation({
    mutationFn: (format: "round_robin" | "by_category" | "knockout") =>
      tournamentsApi.generateFixtures(id, { format }),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Fixtures generated") });
    },
    onError: () => toast.push({ kind: "error", title: t("Could not generate fixtures") }),
  });

  const teamCount = teams.data?.length ?? 0;
  const matchCount = matches.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Fixtures")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Generate the draw, then schedule it to times and venues with your constraints.")}
          </p>
        </div>
        {canManage && matchCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setWizardOpen(true)}>
              <CalendarClock aria-hidden="true" className="h-4 w-4" />
              {t("Schedule fixtures")}
            </Button>
            <Link
              to={routes.tournamentBracket(id)}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <GitBranch aria-hidden="true" className="h-4 w-4" />
              {t("View bracket")}
            </Link>
          </div>
        ) : null}
      </div>

      {matchCount === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-8 w-8" />}
          title={t("No fixtures yet")}
          hint={
            teamCount < 2
              ? t("Add at least 2 teams before generating fixtures.")
              : t("Generate a round-robin or knockout draw, then schedule it.")
          }
        >
          {canManage && teamCount >= 2 ? (
            <>
              <Button onClick={() => generate.mutate("round_robin")} disabled={generate.isPending}>
                <Wand2 aria-hidden="true" className="h-4 w-4" />
                {t("Round-robin")}
              </Button>
              <Button
                variant="outline"
                onClick={() => generate.mutate("by_category")}
                disabled={generate.isPending}
                title={t("Round-robin within each category — teams only play their own group")}
              >
                <Layers aria-hidden="true" className="h-4 w-4" />
                {t("By category")}
              </Button>
              <Button
                variant="outline"
                onClick={() => generate.mutate("knockout")}
                disabled={generate.isPending}
              >
                <GitBranch aria-hidden="true" className="h-4 w-4" />
                {t("Knockout")}
              </Button>
            </>
          ) : null}
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(grouped).map(([label, ms]) => (
            <div key={label} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold">{label}</h3>
              </div>
              <div className="px-4 py-2">
                {ms.map((m) => (
                  <ScoreRow key={m.id} match={m} tournamentId={id} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(standings.data?.groups.length ?? 0) > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("Standings")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {standings.data!.groups.map((g) => (
              <StandingsTable key={g.group_label} group={g} />
            ))}
          </div>
        </section>
      ) : null}

      <ScheduleWizard tournamentId={id} open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}
