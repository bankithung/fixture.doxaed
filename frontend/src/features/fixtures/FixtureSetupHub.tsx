import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CloudRain,
  GitBranch,
  Printer,
  Repeat,
  Settings2,
  Share2,
  Users,
  Wand2,
} from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type ReadinessCompetition,
  type TeamRow,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ScheduleWizard } from "@/features/tournaments/ScheduleWizard";
import {
  EmptyState,
  StandingsTable,
} from "@/features/tournaments/tabs/shared";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
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
const LIVE = new Set(["live", "half_time", "extra_time", "penalties"]);

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

/** Statuses that no longer block the next Swiss round (mirrors the backend's
 * `_SWISS_FINAL` — a cancelled match will never finish). */
const SWISS_FINAL = new Set(["completed", "walkover", "cancelled"]);

/** True when a Swiss draw exists and every round so far is decided — the
 * moment "Generate next round" becomes possible (increment P). */
function swissRoundDone(c: Competition): boolean {
  const swiss = c.matches.filter((m) => m.stage === "swiss");
  return swiss.length > 0 && swiss.every((m) => SWISS_FINAL.has(m.status));
}

/** Stable next-round refusal codes → friendly toast descriptions (§9 A5). */
const SWISS_ERRORS: Record<string, string> = {
  round_incomplete:
    "The current round still has unfinished matches — finish or walk over every match first.",
  swiss_not_started: "No Swiss round exists yet — generate the draw first.",
  swiss_complete: "Every configured Swiss round has already been played.",
};

/** Funnel position of one competition (drives grouping + the row chip). */
type CompStatus = "needs_teams" | "needs_setup" | "ready" | "drawn" | "live";

function statusOf(c: Competition): CompStatus {
  if (c.matches.length > 0) {
    return c.matches.some((m) => LIVE.has(m.status)) ? "live" : "drawn";
  }
  const enoughTeams = c.readiness
    ? c.readiness.checks.find((k) => k.id === "enough_teams")?.status !== "fail"
    : c.teams.length >= 2;
  if (!enoughTeams) return "needs_teams";
  const ready = c.readiness ? c.readiness.ready : c.teams.length >= 2;
  return ready ? "ready" : "needs_setup";
}

const CHIP: Record<CompStatus, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-primary/15 text-primary" },
  needs_setup: {
    label: "Needs setup",
    cls: "bg-warning-muted text-warning-foreground",
  },
  needs_teams: { label: "Needs teams", cls: "bg-muted text-muted-foreground" },
  drawn: { label: "Drawn", cls: "bg-secondary text-secondary-foreground" },
  live: { label: "Live", cls: "bg-primary/15 text-primary" },
};

/** Funnel sections in the order the organizer works through them. The
 * "Needs teams" tail starts collapsed — 0-team leaves are not actionable
 * here (teams register elsewhere), so they only show as a count. */
const GROUPS = [
  { key: "ready", title: "Ready to draw" },
  { key: "needs_setup", title: "Needs setup" },
  { key: "drawn", title: "Drawn" },
  { key: "needs_teams", title: "Needs teams" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

/** Which funnel section a competition files under (live rows sit in Drawn). */
function groupOf(c: Competition): GroupKey {
  const s = statusOf(c);
  return s === "live" ? "drawn" : s;
}

type TabKey = "constraints" | "changes" | "standings";

/**
 * Fixture Setup hub as a staged funnel (increment V). Stage gate first: until
 * the asked-once globals (dates + venues) exist, only a centered "start here"
 * card shows. Then a slim global-summary strip, compact competition rows
 * grouped in funnel order (accordion — one expansion at a time, revealing the
 * existing checklist / draw / repair surfaces), and the constraint builder,
 * schedule-changes feed and standings behind a local tab bar instead of
 * stacking inline.
 */
export function FixtureSetupHub({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const id = tournamentId;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
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
  // Accordion: at most ONE competition row expanded at a time.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<GroupKey, boolean>>({
    ready: true,
    needs_setup: true,
    drawn: true,
    needs_teams: false,
  });
  const [tab, setTab] = useState<TabKey>("constraints");

  const tournament = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
  });
  const teams = useQuery({ queryKey: qk.teams(id), queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: qk.matches(id), queryFn: () => tournamentsApi.matches(id) });
  const standings = useQuery({ queryKey: qk.standings(id), queryFn: () => tournamentsApi.standings(id) });
  const stage = useQuery({ queryKey: qk.stage(id), queryFn: () => tournamentsApi.stage(id) });
  const readiness = useQuery({
    queryKey: qk.fixtureReadiness(id),
    queryFn: () => tournamentsApi.fixtureReadiness(id),
  });
  const drawConfig = useQuery({
    queryKey: qk.drawConfig(id),
    queryFn: () => tournamentsApi.drawConfig(id),
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

  /** Competitions filed under their funnel section (preserving sort order). */
  const grouped = useMemo(() => {
    const by: Record<GroupKey, Competition[]> = {
      ready: [], needs_setup: [], drawn: [], needs_teams: [],
    };
    for (const c of competitions) by[groupOf(c)].push(c);
    return by;
  }, [competitions]);

  /** Effective draw format for one leaf — the §2.1 single-key layering
   * (defaults < "*" < leaf); layers are sparse so a plain ?? chain resolves. */
  const formatFor = (leafKey: string): string =>
    String(
      (leafKey ? drawConfig.data?.draw_config[leafKey]?.format : undefined) ??
        drawConfig.data?.draw_config["*"]?.format ??
        drawConfig.data?.defaults.format ??
        "",
    );

  /** Materialize the next Swiss round (increment P) — refusals carry stable
   * codes the toast description localizes (§9 A5). */
  const nextRound = useMutation({
    mutationFn: (leafKey: string) =>
      tournamentsApi.swissNextRound(id, {
        leaf_key: leafKey,
        event_id: newEventId(),
      }),
    onSuccess: (r) => {
      invalidateTournament(qc, id);
      toast.push({
        kind: "success",
        title: t(
          `Round ${r.round_no ?? "?"} generated — ${r.generated} ${
            r.generated === 1 ? "match" : "matches"
          }`,
        ),
      });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      toast.push({
        kind: "error",
        title: t("Could not generate the next round"),
        description: SWISS_ERRORS[detail]
          ? t(SWISS_ERRORS[detail])
          : detail || undefined,
      });
    },
  });

  /** Readiness deep-links (§5.1 `fix` keys) → the surface that fixes them. */
  const onFix = (fix: string, leafKey: string): void => {
    if (fix === "settings") setSetup({ step: SETUP_STEP.calendar });
    else if (fix === "venues") setSetup({ step: SETUP_STEP.venues });
    else if (fix === "constraints") {
      // The builder lives behind the Constraints tab — open it, then jump.
      setTab("constraints");
      setTimeout(() => {
        document
          .getElementById("constraint-builder")
          ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }, 0);
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

  /** Stage gate: the funnel stays hidden until the asked-once globals exist
   * (server-computed — `calendar_set` + `venues_defined` global checks). */
  const globalsUnset = (readiness.data?.global.checks ?? []).some(
    (c) =>
      (c.id === "calendar_set" || c.id === "venues_defined") &&
      c.status === "fail",
  );

  /** Panels behind the tab bar — only the ones that would render today. */
  const tabs: { key: TabKey; label: string }[] = [
    ...(canManage
      ? [{ key: "constraints" as const, label: "Constraints" }]
      : []),
    ...(matchCount > 0
      ? [{ key: "changes" as const, label: "Schedule changes" }]
      : []),
    ...((standings.data?.groups.length ?? 0) > 0
      ? [{ key: "standings" as const, label: "Standings" }]
      : []),
  ];
  const activeTab = tabs.some((x) => x.key === tab) ? tab : tabs[0]?.key;

  /** Copy the public read-only schedule URL (trust layer — share freely). */
  const shareSchedule = async (): Promise<void> => {
    const slug = tournament.data?.slug;
    if (!slug) return;
    const url = window.location.origin + routes.publicSchedule(slug, id);
    try {
      await navigator.clipboard.writeText(url);
      toast.push({
        kind: "success",
        title: t("Public schedule link copied"),
        description: t("Anyone can open it — no login needed."),
      });
    } catch {
      toast.push({ kind: "info", title: t("Public schedule link"), description: url });
    }
  };

  /** The expansion body — exactly the pre-funnel per-competition surfaces. */
  const renderExpansion = (c: Competition): React.ReactElement => {
    const drawn = c.matches.length > 0;
    const ready = c.readiness ? c.readiness.ready : c.teams.length >= 2;
    if (drawn) {
      return (
        <div className="flex flex-col gap-3 px-4 py-3">
          {canManage ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setWizard(
                    c.leafKey ? { leafKey: c.leafKey, label: c.label } : {},
                  )
                }
              >
                <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Schedule")}
              </Button>
            </div>
          ) : null}
          {canManage &&
          !keptDraws.has(c.leafKey) &&
          c.readiness?.checks.some(
            (k) => k.id === "already_generated" && k.status === "warn",
          ) ? (
            <InputsChangedBanner
              context="draw"
              onRePreview={() =>
                navigate(
                  routes.tournamentFixturesPreview(id, c.leafKey || undefined),
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
          {canManage &&
          formatFor(c.leafKey) === "swiss" &&
          swissRoundDone(c) ? (
            <div className="flex items-center gap-3 border-b border-border pb-2">
              <p className="text-sm text-muted-foreground">
                {t("Round complete — pair the next Swiss round from the standings.")}
              </p>
              <Button
                size="sm"
                disabled={nextRound.isPending}
                data-testid={`next-round-${c.leafKey || "general"}`}
                onClick={() => nextRound.mutate(c.leafKey)}
              >
                <Repeat aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Generate next round")}
              </Button>
            </div>
          ) : null}
          {/* Post-generation: the accepted draw, read-only (§6 screen 6 —
              score entry is the match console's job, not this stage's). */}
          <CompetitionResultCard
            matches={c.matches}
            tournamentId={id}
            canRepair={canRepair}
          />
        </div>
      );
    }
    return (
      <>
        {c.readiness ? (
          <div className="border-b border-border px-4 py-3">
            <ReadinessChecklist
              competition={c.readiness}
              onFix={canManage ? onFix : undefined}
              fixable={FIXABLE}
            />
          </div>
        ) : null}
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
      </>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Fixture setup")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Set the globals once, then every competition runs its own readiness → draw → schedule funnel.")}
          </p>
        </div>
        {canManage && matchCount > 0 && !globalsUnset ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => setWizard({})}>
              <CalendarClock aria-hidden="true" className="h-4 w-4" />
              {t("Schedule all")}
            </Button>
            {canRepair ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="shift-day"
                onClick={() => setShiftOpen(true)}
              >
                <CloudRain aria-hidden="true" className="h-4 w-4" />
                {t("Shift a day")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              data-testid="share-schedule"
              disabled={!tournament.data?.slug}
              onClick={() => void shareSchedule()}
            >
              <Share2 aria-hidden="true" className="h-4 w-4" />
              {t("Share schedule")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="print-order-of-play"
              disabled={!tournament.data?.slug}
              title={t("Order of play — opens the public schedule, print from there")}
              onClick={() => {
                const slug = tournament.data?.slug;
                if (!slug) return;
                window.open(
                  window.location.origin + routes.publicSchedule(slug, id),
                  "_blank",
                  "noopener",
                );
              }}
            >
              <Printer aria-hidden="true" className="h-4 w-4" />
              {t("Print")}
            </Button>
            <Link
              to={routes.tournamentBracket(id)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
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
      ) : globalsUnset ? (
        /* Stage gate — nothing else is actionable before dates + venues. */
        <section
          data-testid="global-setup-gate"
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center shadow-sm"
        >
          <Settings2
            aria-hidden="true"
            className="h-8 w-8 text-muted-foreground"
          />
          <h3 className="text-base font-semibold">
            {t("Start with the global setup")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("Set the tournament dates and venues once — every competition's readiness, draw and schedule build on them.")}
          </p>
          {canManage ? (
            <Button
              data-testid="global-setup-cta"
              onClick={() => setSetup({ step: 0 })}
            >
              <Wand2 aria-hidden="true" className="h-4 w-4" />
              {t("Set up globals")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("An organizer sets dates and venues before fixtures can be drawn.")}
            </p>
          )}
        </section>
      ) : (
        <>
          <GlobalSetupCard
            tournamentId={id}
            canManage={canManage}
            onEdit={(step) => setSetup({ step })}
          />

          {competitions.length === 0 ? (
            <EmptyState
              icon={<Users className="h-8 w-8" />}
              title={t("No competitions yet")}
              hint={t("Add sports and categories, then teams register into competitions; fixtures are drawn per competition here.")}
            />
          ) : (
            GROUPS.map((g) => {
              const list = grouped[g.key];
              if (list.length === 0) return null;
              const open = openSections[g.key];
              return (
                <section key={g.key} className="flex flex-col gap-2">
                  <button
                    type="button"
                    data-testid={`section-${g.key}`}
                    aria-expanded={open}
                    className="flex items-center gap-2 text-left"
                    onClick={() =>
                      setOpenSections((p) => ({ ...p, [g.key]: !p[g.key] }))
                    }
                  >
                    {open ? (
                      <ChevronDown
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <ChevronRight
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <h3 className="text-sm font-semibold">{t(g.title)}</h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
                      {list.length}
                    </span>
                  </button>
                  {open ? (
                    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                      {list.map((c) => {
                        const key = c.leafKey || "general";
                        const isOpen = expanded === key;
                        const st = statusOf(c);
                        const drawn = c.matches.length > 0;
                        return (
                          <div
                            key={key}
                            className="border-t border-border first:border-t-0"
                          >
                            <button
                              type="button"
                              data-testid={`competition-row-${key}`}
                              aria-expanded={isOpen}
                              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-accent/50"
                              onClick={() => setExpanded(isOpen ? null : key)}
                            >
                              {isOpen ? (
                                <ChevronDown
                                  aria-hidden="true"
                                  className="h-4 w-4 shrink-0 text-muted-foreground"
                                />
                              ) : (
                                <ChevronRight
                                  aria-hidden="true"
                                  className="h-4 w-4 shrink-0 text-muted-foreground"
                                />
                              )}
                              <span className="text-sm font-semibold">
                                {c.label || t("General")}
                              </span>
                              <span className="font-tabular text-xs text-muted-foreground">
                                {c.teams.length} {t("teams")}
                                {drawn ? (
                                  <> · {c.matches.length} {t("matches")}</>
                                ) : null}
                              </span>
                              {c.readiness ? (
                                <span
                                  data-testid={`readiness-badge-${key}`}
                                  className="rounded-full bg-muted px-2 py-0.5 font-tabular text-[0.6875rem] text-muted-foreground"
                                >
                                  {c.readiness.summary}
                                </span>
                              ) : null}
                              <span
                                className={cn(
                                  "ml-auto rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                                  CHIP[st].cls,
                                )}
                              >
                                {t(CHIP[st].label)}
                              </span>
                            </button>
                            {isOpen ? (
                              <div className="border-t border-border">
                                {renderExpansion(c)}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })
          )}

          {tabs.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div
                role="tablist"
                aria-label={t("More panels")}
                className="flex items-center gap-1 border-b border-border"
              >
                {tabs.map((x) => (
                  <button
                    key={x.key}
                    role="tab"
                    type="button"
                    aria-selected={activeTab === x.key}
                    data-testid={`hub-tab-${x.key}`}
                    className={cn(
                      "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                      activeTab === x.key
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setTab(x.key)}
                  >
                    {t(x.label)}
                  </button>
                ))}
              </div>
              {activeTab === "constraints" && canManage ? (
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
              {activeTab === "changes" && matchCount > 0 ? (
                <ScheduleChangesPanel
                  tournamentId={id}
                  competitions={competitions
                    .filter((c) => c.leafKey)
                    .map((c) => ({ leafKey: c.leafKey, label: c.label }))}
                />
              ) : null}
              {activeTab === "standings" &&
              (standings.data?.groups.length ?? 0) > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {standings.data!.groups.map((g) => (
                    <StandingsTable key={g.group_label} group={g} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}

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
