import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CloudRain, GitBranch, Users, Wand2 } from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type ReadinessCompetition,
  type TeamRow,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { ScheduleWizard } from "@/features/tournaments/ScheduleWizard";
import {
  EmptyState,
  StandingsTable,
} from "@/features/tournaments/tabs/shared";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { AdvanceToKnockoutDialog } from "./AdvanceToKnockoutDialog";
import { CompetitionFormatWizard } from "./CompetitionFormatWizard";
import { CompetitionResultCard } from "./CompetitionResultCard";
import { ConstraintBuilder } from "./ConstraintBuilder";
import { GlobalSetupCard } from "./GlobalSetupCard";
import { GlobalSetupWizard } from "./GlobalSetupWizard";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { ReadinessChecklist } from "./ReadinessChecklist";
import { ScheduleChangesPanel } from "./ScheduleChangesPanel";
import { SETUP_STEP } from "./setupSteps";
import { ShiftDayDialog } from "./ShiftDayDialog";

/** One competition (category leaf): teams + matches + server readiness. */
interface Competition {
  leafKey: string; // "" = uncategorized/legacy bucket
  label: string;
  sport: string;
  teams: TeamRow[];
  matches: MatchRow[];
  readiness?: ReadinessCompetition;
}

const FINAL = new Set(["completed", "walkover"]);

/** Readiness fix keys the hub has a surface for. */
const FIXABLE = new Set([
  "settings", "venues", "constraints", "teams", "format", "seeds", "diff",
]);

/** True when the competition has a finished group stage and no bracket yet —
 * the moment "Advance to knockout" becomes possible. */
function groupsDone(c: Competition): boolean {
  const groups = c.matches.filter((m) => m.stage === "group");
  return (
    groups.length > 0 &&
    groups.every((m) => FINAL.has(m.status)) &&
    !c.matches.some((m) => m.stage === "knockout")
  );
}

/**
 * Fixture Setup hub (redesign §6 screen 1): the always-visible GlobalSetupCard
 * (asked-once globals, per-row edit), then one section per competition with
 * its server-computed ReadinessChecklist (§5.1 — progress, deep-link fixes)
 * gating the generate CTA. Wires the GlobalSetupWizard, the per-competition
 * draw wizard and the scheduler; standings render below.
 */
export function FixtureSetupHub({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const id = tournamentId;
  const navigate = useNavigate();
  const [setup, setSetup] = useState<{ step: number } | null>(null);
  const [wizard, setWizard] = useState<{ leafKey?: string; label?: string } | null>(
    null,
  );
  const [draw, setDraw] = useState<{
    leafKey: string;
    label: string;
    teams: TeamRow[];
  } | null>(null);
  const [advanceDlg, setAdvanceDlg] = useState<{
    leafKey: string;
    label: string;
  } | null>(null);
  const [shiftOpen, setShiftOpen] = useState(false);
  // "Keep" dismissals of the invariant-10 inputs-changed banner (per leaf).
  const [keptDraws, setKeptDraws] = useState<ReadonlySet<string>>(new Set());

  const teams = useQuery({ queryKey: qk.teams(id), queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: qk.matches(id), queryFn: () => tournamentsApi.matches(id) });
  const standings = useQuery({ queryKey: qk.standings(id), queryFn: () => tournamentsApi.standings(id) });
  const stage = useQuery({ queryKey: qk.stage(id), queryFn: () => tournamentsApi.stage(id) });
  const readiness = useQuery({
    queryKey: qk.fixtureReadiness(id),
    queryFn: () => tournamentsApi.fixtureReadiness(id),
  });
  const canManage =
    (stage.data?.can_manage ?? false) ||
    (stage.data?.modules ?? []).includes("tournament.bracket_editor");
  /** The repair verbs are gated by the schedule_editor module server-side. */
  const canRepair =
    (stage.data?.can_manage ?? false) ||
    (stage.data?.modules ?? []).includes("tournament.schedule_editor");

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
    // Server readiness is the canonical competition list (every configured
    // leaf appears, even before any team registers).
    for (const r of readiness.data?.competitions ?? []) {
      ensure(r.leaf_key, r.label, "").readiness = r;
    }
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
  }, [teams.data, matches.data, readiness.data]);

  /** Readiness deep-links (§5.1 `fix` keys) → the surface that fixes them. */
  const onFix = (fix: string, leafKey: string): void => {
    if (fix === "settings") setSetup({ step: SETUP_STEP.calendar });
    else if (fix === "venues") setSetup({ step: SETUP_STEP.venues });
    else if (fix === "constraints") {
      // The builder lives inline on this page (§6 screen 4) — jump to it.
      document
        .getElementById("constraint-builder")
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } else if (fix === "teams") navigate(routes.tournamentTeams(id));
    else if (fix === "format" || fix === "seeds") {
      // The format wizard owns seeding too (SeedListEditor).
      const c = competitions.find((x) => x.leafKey === leafKey);
      if (c) setDraw({ leafKey, label: c.label, teams: c.teams });
    } else if (fix === "diff") {
      // Inputs changed since the draw — a fresh dry run shows the new draw.
      navigate(routes.tournamentFixturesPreview(id, leafKey || undefined));
    }
  };

  const matchCount = (matches.data ?? []).length;
  const isLoading = teams.isLoading || matches.isLoading || readiness.isLoading;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Fixture setup")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Set the globals once, then every competition runs its own readiness → draw → schedule funnel.")}
          </p>
        </div>
        {canManage && matchCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setWizard({})}>
              <CalendarClock aria-hidden="true" className="h-4 w-4" />
              {t("Schedule all")}
            </Button>
            {canRepair ? (
              <Button
                variant="outline"
                data-testid="shift-day"
                onClick={() => setShiftOpen(true)}
              >
                <CloudRain aria-hidden="true" className="h-4 w-4" />
                {t("Shift a day")}
              </Button>
            ) : null}
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

      <GlobalSetupCard
        tournamentId={id}
        canManage={canManage}
        onEdit={(step) => setSetup({ step })}
      />

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
          title={t("No competitions yet")}
          hint={t("Add sports and categories, then teams register into competitions; fixtures are drawn per competition here.")}
        />
      ) : (
        competitions.map((c) => {
          const drawn = c.matches.length > 0;
          const ready = c.readiness ? c.readiness.ready : c.teams.length >= 2;
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

              {c.readiness && !drawn ? (
                <div className="border-b border-border px-4 py-3">
                  <ReadinessChecklist
                    competition={c.readiness}
                    onFix={canManage ? onFix : undefined}
                    fixable={FIXABLE}
                  />
                </div>
              ) : null}

              {drawn ? (
                <div className="flex flex-col gap-3 px-4 py-3">
                  {canManage &&
                  !keptDraws.has(c.leafKey) &&
                  c.readiness?.checks.some(
                    (k) => k.id === "already_generated" && k.status === "warn",
                  ) ? (
                    <InputsChangedBanner
                      context="draw"
                      onRePreview={() =>
                        navigate(
                          routes.tournamentFixturesPreview(
                            id,
                            c.leafKey || undefined,
                          ),
                        )
                      }
                      onKeep={() =>
                        setKeptDraws((prev) => new Set(prev).add(c.leafKey))
                      }
                    />
                  ) : null}
                  {canManage && groupsDone(c) ? (
                    <div className="flex items-center gap-3 border-b border-border pb-2">
                      <p className="text-sm text-muted-foreground">
                        {t("Group stage complete — build the bracket from the standings.")}
                      </p>
                      <Button
                        size="sm"
                        data-testid={`advance-${c.leafKey || "general"}`}
                        onClick={() =>
                          setAdvanceDlg({ leafKey: c.leafKey, label: c.label })
                        }
                      >
                        <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("Advance to knockout")}
                      </Button>
                    </div>
                  ) : null}
                  {/* Post-generation: the accepted draw, read-only (§6 screen
                      6 — score entry is the match console's job, not this
                      stage's). */}
                  <CompetitionResultCard
                    matches={c.matches}
                    tournamentId={id}
                    canRepair={canRepair}
                  />
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <p className="text-sm text-muted-foreground">
                    {ready
                      ? t("Ready — preview the draw; nothing is saved until you accept it.")
                      : t("Resolve the failed checks above before generating.")}
                  </p>
                  {canManage ? (
                    <Button
                      size="sm"
                      disabled={!ready}
                      data-testid={`generate-${c.leafKey || "general"}`}
                      onClick={() =>
                        setDraw({
                          leafKey: c.leafKey,
                          label: c.label,
                          teams: c.teams,
                        })
                      }
                    >
                      <Wand2 aria-hidden="true" className="h-3.5 w-3.5" />
                      {t("Preview & generate")}
                    </Button>
                  ) : null}
                </div>
              )}
            </section>
          );
        })
      )}

      {canManage ? (
        <ConstraintBuilder
          tournamentId={id}
          competitions={competitions
            .filter((c) => c.leafKey)
            .map((c) => ({ leafKey: c.leafKey, label: c.label }))}
          teams={(teams.data ?? [])
            .filter((tm) => tm.status === "registered")
            .map((tm) => ({ id: tm.id, name: tm.name }))}
        />
      ) : null}

      {matchCount > 0 ? (
        <ScheduleChangesPanel
          tournamentId={id}
          competitions={competitions
            .filter((c) => c.leafKey)
            .map((c) => ({ leafKey: c.leafKey, label: c.label }))}
        />
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

      {setup ? (
        <GlobalSetupWizard
          tournamentId={id}
          open
          initialStep={setup.step}
          onClose={() => setSetup(null)}
        />
      ) : null}
      <ScheduleWizard
        tournamentId={id}
        open={wizard !== null}
        onClose={() => setWizard(null)}
        leafKey={wizard?.leafKey}
        leafLabel={wizard?.label}
      />
      {draw ? (
        <CompetitionFormatWizard
          tournamentId={id}
          open
          onClose={() => setDraw(null)}
          leafKey={draw.leafKey}
          leafLabel={draw.label}
          teams={draw.teams}
          onGenerated={({ leafKey, label }) =>
            setWizard(leafKey ? { leafKey, label } : {})
          }
          onPreview={({ leafKey }) =>
            navigate(routes.tournamentFixturesPreview(id, leafKey || undefined))
          }
          onEditGlobals={() => {
            setDraw(null);
            setSetup({ step: SETUP_STEP.calendar });
          }}
        />
      ) : null}
      {shiftOpen ? (
        <ShiftDayDialog
          tournamentId={id}
          matches={matches.data ?? []}
          competitions={competitions
            .filter((c) => c.leafKey)
            .map((c) => ({ leafKey: c.leafKey, label: c.label }))}
          onClose={() => setShiftOpen(false)}
        />
      ) : null}
      {advanceDlg ? (
        <AdvanceToKnockoutDialog
          tournamentId={id}
          open
          onClose={() => setAdvanceDlg(null)}
          leafKey={advanceDlg.leafKey}
          leafLabel={advanceDlg.label}
        />
      ) : null}
    </div>
  );
}
