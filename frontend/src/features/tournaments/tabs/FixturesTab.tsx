import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, GitBranch, Layers, Users, Wand2 } from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type TeamRow,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { ScheduleWizard } from "../ScheduleWizard";
import { EmptyState, ScoreRow, StandingsTable } from "./shared";

type GenFormat = "round_robin" | "by_category" | "knockout";

/** One competition (category leaf) and everything in it. */
interface Competition {
  leafKey: string; // "" = uncategorized/legacy bucket
  label: string;
  sport: string;
  teams: TeamRow[];
  matches: MatchRow[];
}

/**
 * The fixtures workspace, organized PER COMPETITION (category leaf): each
 * leaf — e.g. "Football — U15 — Girls — 5v5" — shows its registered teams,
 * gets its own draw (format chosen per competition) and its own schedule run,
 * fully independent of the other competitions (spec 2026-06-10).
 */
export function FixturesTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [wizard, setWizard] = useState<{ leafKey?: string; label?: string } | null>(
    null,
  );

  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: ["t-matches", id], queryFn: () => tournamentsApi.matches(id) });
  const standings = useQuery({ queryKey: ["t-standings", id], queryFn: () => tournamentsApi.standings(id) });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage =
    (stage.data?.can_manage ?? false) ||
    (stage.data?.modules ?? []).includes("tournament.bracket_editor");

  const competitions = useMemo<Competition[]>(() => {
    const by = new Map<string, Competition>();
    const ensure = (leafKey: string, label: string, sport: string): Competition => {
      let c = by.get(leafKey);
      if (!c) {
        c = { leafKey, label, sport, teams: [], matches: [] };
        by.set(leafKey, c);
      }
      if (label && (c.label === c.leafKey || !c.label)) c.label = label;
      if (sport && !c.sport) c.sport = sport;
      return c;
    };
    for (const tm of teams.data ?? []) {
      if (tm.status !== "registered") continue;
      ensure(tm.leaf_key, tm.leaf_key ? tm.pool || tm.leaf_key : "", tm.sport)
        .teams.push(tm);
    }
    for (const m of matches.data ?? []) {
      ensure(m.leaf_key, m.leaf_key ? m.group_label : "", m.sport).matches.push(m);
    }
    const all = [...by.values()];
    // Leaf competitions first (alphabetical); the legacy/uncategorized bucket last.
    return [
      ...all.filter((c) => c.leafKey).sort((a, b) => a.label.localeCompare(b.label)),
      ...all.filter((c) => !c.leafKey),
    ];
  }, [teams.data, matches.data]);

  const generate = useMutation({
    mutationFn: (args: { format: GenFormat; leafKey?: string }) =>
      tournamentsApi.generateFixtures(id, {
        format: args.format,
        leafKey: args.leafKey,
      }),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Fixtures generated") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not generate fixtures"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const teamCount = (teams.data ?? []).length;
  const matchCount = (matches.data ?? []).length;
  const isLoading = teams.isLoading || matches.isLoading;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Fixtures")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Each competition gets its own draw and schedule — generate and plan them independently.")}
          </p>
        </div>
        {canManage && matchCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setWizard({})}>
              <CalendarClock aria-hidden="true" className="h-4 w-4" />
              {t("Schedule all")}
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

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : competitions.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title={t("No registered teams yet")}
          hint={t("Teams register into competitions during team registration; fixtures are drawn per competition here.")}
        />
      ) : (
        competitions.map((c) => {
          const ready = c.teams.length >= 2;
          const drawn = c.matches.length > 0;
          return (
            <section
              key={c.leafKey || "general"}
              className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold">
                  {c.label || t("General")}
                </h3>
                <span className="font-tabular text-xs text-muted-foreground">
                  {c.teams.length} {t("teams")}
                  {drawn ? <> · {c.matches.length} {t("matches")}</> : null}
                </span>
                {drawn && canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() =>
                      setWizard(
                        c.leafKey
                          ? { leafKey: c.leafKey, label: c.label }
                          : {},
                      )
                    }
                  >
                    <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("Schedule")}
                  </Button>
                ) : null}
              </div>

              {drawn ? (
                <div className="px-4 py-2">
                  {c.matches.map((m) => (
                    <ScoreRow key={m.id} match={m} tournamentId={id} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 px-4 py-4">
                  <p className="text-sm text-muted-foreground">
                    {ready
                      ? t("No draw yet — pick a format for this competition.")
                      : t("Needs at least 2 registered teams before a draw can be made.")}
                  </p>
                  {canManage && ready ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={generate.isPending}
                        onClick={() =>
                          generate.mutate(
                            c.leafKey
                              ? { format: "by_category", leafKey: c.leafKey }
                              : { format: "round_robin" },
                          )
                        }
                      >
                        <Wand2 aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("Round-robin")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={generate.isPending}
                        onClick={() =>
                          generate.mutate({
                            format: "knockout",
                            leafKey: c.leafKey || undefined,
                          })
                        }
                        title={t("Single elimination — byes are added automatically for odd team counts")}
                      >
                        <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("Knockout")}
                      </Button>
                      {!c.leafKey ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={generate.isPending}
                          onClick={() => generate.mutate({ format: "by_category" })}
                          title={t("Round-robin within each category — teams only play their own group")}
                        >
                          <Layers aria-hidden="true" className="h-3.5 w-3.5" />
                          {t("By category")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          );
        })
      )}

      {teamCount >= 2 && matchCount === 0 && competitions.length > 0 && canManage ? (
        <p className="text-xs text-muted-foreground">
          {t("Tip: draws are independent — generating one competition never blocks the others, and repeating a generation is safe.")}
        </p>
      ) : null}

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

      <ScheduleWizard
        tournamentId={id}
        open={wizard !== null}
        onClose={() => setWizard(null)}
        leafKey={wizard?.leafKey}
        leafLabel={wizard?.label}
      />
    </div>
  );
}
