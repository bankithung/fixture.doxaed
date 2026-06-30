import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudRain,
  GitBranch,
  MoreHorizontal,
  PartyPopper,
  Printer,
  Radio,
  Share2,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { tournamentsApi, type TeamRow } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ScheduleWizard } from "@/features/tournaments/ScheduleWizard";
import { StageContinue } from "@/features/tournaments/StageContinue";
import {
  EmptyState,
  StandingsTable,
} from "@/features/tournaments/tabs/shared";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { AssistantWidget } from "@/features/assistant/AssistantPanel";
import { AdvanceToKnockoutDialog } from "./AdvanceToKnockoutDialog";
import { CompetitionCard } from "./CompetitionCard";
import { CompetitionFormatWizard } from "./CompetitionFormatWizard";
import { CompetitionFormatBoard } from "./CompetitionFormatBoard";
import { ClashesSection } from "./ClashesSection";
import { ConstraintBuilder } from "./ConstraintBuilder";
import { GlobalSetupCard } from "./GlobalSetupCard";
import { GlobalSetupWizard } from "./GlobalSetupWizard";
import { ScheduleChangesPanel } from "./ScheduleChangesPanel";
import {
  journeyStep,
  statusOf,
  type CardAction,
  type Competition,
} from "./setupJourney";
import { useFixtureStepStore } from "./fixtureStepStore";
import { SETUP_STEP } from "./setupSteps";
import { ShiftDayDialog } from "./ShiftDayDialog";

/** Readiness fix keys the hub has a surface for. */
const FIXABLE = new Set([
  "settings", "venues", "constraints", "teams", "format", "seeds", "diff",
]);

/** Stable next-round refusal codes → plain toast descriptions (§7.9). */
const SWISS_ERRORS: Record<string, string> = {
  round_incomplete:
    "This round still has unfinished matches. Finish or walk over every match first.",
  swiss_not_started: "There is no Swiss round yet. Create the draw first.",
  swiss_complete: "All planned rounds have been played.",
};

/** Funnel sections in journey order (§7.1 titles). "Waiting for teams"
 * starts collapsed — 0-team leaves are not actionable here. */
const GROUPS = [
  { key: "ready", title: "Ready to go" },
  { key: "needs_setup", title: "Needs your attention" },
  { key: "drawn", title: "Scheduled" },
  { key: "needs_teams", title: "Waiting for teams" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

/** Which funnel section a competition files under (live rows sit in
 * Scheduled; nothing files under "Ready to go" while Step 1 is incomplete —
 * `statusOf` demotes those to needs-setup). */
function groupOf(c: Competition, globalsUnset: boolean): GroupKey {
  const s = statusOf(c, globalsUnset);
  return s === "live" ? "drawn" : s;
}

type TabKey = "constraints" | "changes" | "standings";

/** §7.8 labels for the Advanced-tools panels. */
const TAB_LABELS: Record<TabKey, string> = {
  constraints: "Scheduling rules",
  changes: "Change history",
  standings: "Group tables",
};

/** The done-state overflow menu (§4.1): every secondary verb in one place,
 * same markup pattern as MatchRepairMenu. */
function HubMoreMenu({
  canRepair,
  shareReady,
  bracketTo,
  onReRun,
  onShiftDay,
  onPrint,
}: {
  canRepair: boolean;
  shareReady: boolean;
  bracketTo: string;
  onReRun: () => void;
  onShiftDay: () => void;
  onPrint: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const itemCls =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div ref={ref} className="relative shrink-0">
      <Button
        size="sm"
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="hub-more"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
        {t("More")}
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={t("More schedule tools")}
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="re-run-schedule"
            className={itemCls}
            onClick={() => {
              setOpen(false);
              onReRun();
            }}
          >
            <CalendarClock
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            {t("Re-run schedule")}
          </button>
          {canRepair ? (
            <button
              type="button"
              role="menuitem"
              data-testid="shift-day"
              className={itemCls}
              onClick={() => {
                setOpen(false);
                onShiftDay();
              }}
            >
              <CloudRain
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              {t("Shift a day")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-testid="print-order-of-play"
            disabled={!shareReady}
            title={t("Opens the public schedule to print.")}
            className={itemCls}
            onClick={() => {
              setOpen(false);
              onPrint();
            }}
          >
            <Printer
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            {t("Print")}
          </button>
          <Link
            to={bracketTo}
            role="menuitem"
            data-testid="view-bracket"
            className={itemCls}
            onClick={() => setOpen(false)}
          >
            <GitBranch
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            {t("View bracket")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A setup sub-page (Clashes & sessions, How each competition plays). The owner
 * asked for these to be their OWN pages, not stacked in one scroll — so the hub
 * body shows ONE at a time and this frames it with a back link + a "next" step.
 */
function SetupSubPage({
  onBack,
  nextLabel,
  onNext,
  children,
}: {
  onBack: () => void;
  nextLabel: string;
  onNext: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      {children}
      {/* "Back to setup" and the step's primary "Next" both live at the bottom,
          so they're reachable right after the user finishes the step's work. */}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <button
          type="button"
          data-testid="subpage-back"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          {t("Back to setup")}
        </button>
        <Button variant="outline" data-testid="subpage-next" onClick={onNext}>
          {nextLabel}
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Fixture Setup hub as a guided three-step journey (clarity rebuild §4.1):
 * a persistent numbered header (When & where → How each competition plays →
 * Preview & publish), the Step 1 gate/receipt, one card per competition with
 * ONE sentence + ONE action (checklist only behind "See what's missing"),
 * a celebrate banner when everything is drawn, and the constraint builder /
 * change history / group tables behind a closed Advanced-tools disclosure.
 *
 * Step 1 is INLINE full-page content, not a modal (owner feedback): in the
 * gate state the wizard IS the page body; editing later (receipt Edit, chips,
 * fix deep-links) swaps the hub content for the same panel, and Cancel
 * returns to the hub view.
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
  // `flow` marks a Step-1 opening that's part of the sequential journey (the
  // gate, the "Start Step 1" CTA, a Step-1 stepper click) — saving then advances
  // to Clashes & sessions. Edits/fixes open without it and just return to the hub.
  const [setup, setSetup] = useState<{ step: number; flow?: boolean } | null>(
    null,
  );
  // Cancelled out of the gate's auto-opened Step 1 — fall back to the gate
  // card until the next explicit open.
  const [gateDismissed, setGateDismissed] = useState(false);
  const [wizard, setWizard] = useState<{ leafKey?: string; label?: string } | null>(
    null,
  );
  const [draw, setDraw] = useState<{
    leafKey: string;
    label: string;
    teams: TeamRow[];
    focusSeeds?: boolean;
  } | null>(null);
  const [advanceDlg, setAdvanceDlg] = useState<{
    leafKey: string;
    label: string;
  } | null>(null);
  const [shiftOpen, setShiftOpen] = useState(false);
  // "Keep this draw" dismissals of the inputs-drift banner (per leaf).
  const [keptDraws, setKeptDraws] = useState<ReadonlySet<string>>(new Set());
  // Accordion: at most ONE card detail (result card / what's-missing) open.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<GroupKey, boolean>>({
    ready: true,
    needs_setup: true,
    drawn: true,
    needs_teams: false,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("constraints");
  // The §6.3 celebrate banner, dismissible per session.
  const [doneDismissed, setDoneDismissed] = useState(false);
  // Owner: never stack the setup sections on one page. "Clashes & sessions"
  // and "How each competition plays" are their OWN pages, reached from the
  // journey stepper; the hub body shows ONE at a time. "overview" is the
  // competition list — the Preview & publish surface (journey step 4).
  const [view, setView] = useState<"overview" | "clashes" | "formats">(
    "overview",
  );
  // Sport to focus when arriving on the formats page from a card's "Change
  // format" deep-link; null = navigated via the step bar (no focus).
  const [formatsFocus, setFormatsFocus] = useState<string | null>(null);

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
  // Constraints power the journey ticks (is "Clashes & sessions" configured?).
  // Same query key the Clashes/Constraint panels use, so it shares the cache.
  const settings = useQuery({
    queryKey: qk.settings(id),
    queryFn: () => tournamentsApi.settings(id),
  });
  const canManage =
    (stage.data?.can_manage ?? false) ||
    (stage.data?.modules ?? []).includes("tournament.bracket_editor");
  /** The repair verbs are gated by the schedule_editor module server-side. */
  const canRepair =
    (stage.data?.can_manage ?? false) ||
    (stage.data?.modules ?? []).includes("tournament.schedule_editor");

  /** Stage gate: the journey stays at Step 1 until the asked-once globals
   * exist (server-computed off the CANONICAL stores the Step-1 wizard writes
   * — `calendar_set` + `venues_defined` checks). */
  const globalsUnset = (readiness.data?.global.checks ?? []).some(
    (c) =>
      (c.id === "calendar_set" || c.id === "venues_defined") &&
      c.status === "fail",
  );

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
    for (const c of competitions) by[groupOf(c, globalsUnset)].push(c);
    return by;
  }, [competitions, globalsUnset]);

  /** Effective draw format for one leaf — the §2.1 layering with the sport
   * layer (defaults < "*" < sport:<k> < leaf); layers are sparse so a plain ??
   * chain resolves. Sport key = the leaf key's first segment. */
  const formatFor = (leafKey: string): string => {
    const sport = leafKey ? leafKey.split(".")[0] : "";
    return String(
      (leafKey ? drawConfig.data?.draw_config[leafKey]?.format : undefined) ??
        (sport ? drawConfig.data?.draw_config[`sport:${sport}`]?.format : undefined) ??
        drawConfig.data?.draw_config["*"]?.format ??
        drawConfig.data?.defaults.format ??
        "",
    );
  };

  /** Materialize the next Swiss round — refusals carry stable codes the
   * toast description localizes (§7.9). */
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
          `Round ${r.round_no ?? "?"} paired - ${r.generated} ${
            r.generated === 1 ? "match" : "matches"
          }`,
        ),
      });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      toast.push({
        kind: "error",
        title: t("Could not pair the next round"),
        description: SWISS_ERRORS[detail]
          ? t(SWISS_ERRORS[detail])
          : detail || undefined,
      });
    },
  });

  /** Readiness deep-links (`fix` keys) → the surface that fixes them. */
  const onFix = (fix: string, leafKey: string): void => {
    if (fix === "settings") setSetup({ step: SETUP_STEP.calendar });
    else if (fix === "venues") setSetup({ step: SETUP_STEP.venues });
    else if (fix === "constraints") {
      // The rules live behind the Advanced disclosure — open it, then jump.
      setAdvancedOpen(true);
      setTab("constraints");
      setTimeout(() => {
        document
          .getElementById("constraint-builder")
          ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }, 0);
    } else if (fix === "teams") navigate(routes.tournamentTeams(id));
    else if (fix === "format") {
      // Same destination as a card's "Change format": the How-each-plays page.
      const c = competitions.find((x) => x.leafKey === leafKey);
      setFormatsFocus(c?.sport || leafKey.split(".")[0] || null);
      setView("formats");
    } else if (fix === "seeds") {
      // The Step 2 wizard owns seeding (SeedListEditor under Advanced).
      const c = competitions.find((x) => x.leafKey === leafKey);
      if (c) {
        setDraw({ leafKey, label: c.label, teams: c.teams, focusSeeds: true });
      }
    } else if (fix === "diff") {
      // Inputs changed since the draw — a fresh preview shows the new draw.
      navigate(routes.tournamentFixturesPreview(id, leafKey || undefined));
    }
  };

  /** Card actions (§7.2) → their surfaces. */
  const onCardAction = (c: Competition, a: CardAction): void => {
    if (a.action === "teams") navigate(routes.tournamentTeams(id));
    else if (a.action === "step1") setSetup({ step: 0, flow: true });
    else if (a.action === "seeds") {
      setDraw({ leafKey: c.leafKey, label: c.label, teams: c.teams, focusSeeds: true });
    } else if (a.action === "format") {
      // "Change format" / "Choose format" send the user to the How-each-plays
      // page (Step 3), focused on this competition's sport.
      setFormatsFocus(c.sport || c.leafKey.split(".")[0] || null);
      setView("formats");
    } else if (a.action === "preview") {
      navigate(routes.tournamentFixturesPreview(id, c.leafKey || undefined));
    } else if (a.action === "advance") {
      setAdvanceDlg({ leafKey: c.leafKey, label: c.label });
    } else if (a.action === "next_round") nextRound.mutate(c.leafKey);
    else if (a.action === "console" && a.matchId) {
      navigate(routes.matchConsole(id, a.matchId));
    } else if (a.action === "adjust_schedule") {
      setWizard(c.leafKey ? { leafKey: c.leafKey, label: c.label } : {});
    } else if (a.action === "keep") {
      setKeptDraws((prev) => new Set(prev).add(c.leafKey));
    }
  };

  const isLoading = teams.isLoading || matches.isLoading || readiness.isLoading;

  const journey = journeyStep(readiness.data, competitions);

  /** The Step 1 wizard renders INLINE as the page body, never as a modal:
   * explicit opens (gate CTA, receipt Edit, chips, fix deep-links) win; in
   * the gate state it IS the page until cancelled back to the gate card. */
  const setupView =
    setup ??
    (globalsUnset && canManage && !gateDismissed
      ? { step: 0, flow: true }
      : null);
  const closeSetup = (): void => {
    setSetup(null);
    setGateDismissed(true);
  };
  /** After the When & Where wizard SAVES: close it, and — when it was opened as
   * part of the sequential journey — advance to the next step, Clashes &
   * sessions, instead of dropping onto the competition list. */
  const savedSetup = (): void => {
    const wasFlow = setupView?.flow;
    setSetup(null);
    setGateDismissed(true);
    if (wasFlow) setView("clashes");
  };

  /** Which page the body is currently showing — so the stepper highlights the
   * page you're on (Step 1 wizard / gate → 1, sub-pages → 2/3, the competition
   * list → 4, the Preview & publish surface). */
  const activeStep: 1 | 2 | 3 | 4 =
    globalsUnset || setupView
      ? 1
      : view === "clashes"
        ? 2
        : view === "formats"
          ? 3
          : 4;

  /** Real completion per step → the stepper ticks (not mere position). Step 2
   * (Clashes & sessions) is optional; it ticks once any clash rule or session
   * window exists. Step 3 ticks when no competition is still on the implicit
   * league default. Step 4 ticks when every eligible competition is drawn. */
  const constraints = settings.data?.constraints ?? [];
  // The three constraint types the "Clashes & sessions" page owns.
  const CLASH_TYPES = new Set([
    "no_concurrent_competitions",
    "category_session_window",
    "official_capacity",
  ]);
  const clashesConfigured = constraints.some((c) => CLASH_TYPES.has(c.type));
  const leafComps = competitions.filter((c) => c.leafKey);
  const formatsChosen =
    leafComps.length > 0 &&
    !leafComps.some((c) =>
      c.readiness?.checks.some(
        (k) => k.id === "format_chosen" && k.status === "warn",
      ),
    );
  const doneSteps: Partial<Record<1 | 2 | 3 | 4, boolean>> = {
    1: !globalsUnset,
    2: clashesConfigured,
    3: formatsChosen,
    4: journey === "done",
  };

  /** Panels behind the Advanced disclosure — only the ones that render today. */
  const matchCount = (matches.data ?? []).length;
  const tabs: TabKey[] = [
    ...(canManage ? (["constraints"] as const) : []),
    ...(matchCount > 0 ? (["changes"] as const) : []),
    ...((standings.data?.groups.length ?? 0) > 0
      ? (["standings"] as const)
      : []),
  ];
  const activeTab = tabs.includes(tab) ? tab : tabs[0];

  /** Copy the public read-only schedule URL (share freely — no login). */
  const shareSchedule = async (): Promise<void> => {
    const slug = tournament.data?.slug;
    if (!slug) return;
    const url = window.location.origin + routes.publicSchedule(slug, id);
    try {
      await navigator.clipboard.writeText(url);
      toast.push({
        kind: "success",
        title: t("Schedule link copied"),
        description: t("Anyone with the link can see the schedule. No login needed."),
      });
    } catch {
      toast.push({ kind: "info", title: t("Schedule link"), description: url });
    }
  };

  const openPublicSchedule = (): void => {
    const slug = tournament.data?.slug;
    if (!slug) return;
    window.open(
      window.location.origin + routes.publicSchedule(slug, id),
      "_blank",
      "noopener",
    );
  };

  /** Journey steps are PAGE navigation — each step is its own page in the hub
   * body, never stacked together (owner: "they should be in different pages").
   * Step 1 opens the inline When & where wizard; 2 and 3 swap the body to the
   * Clashes and Formats pages; 4 returns to the competition list (Preview &
   * publish), where each competition's Preview button lives. */
  const onStepClick = (n: 1 | 2 | 3 | 4): void => {
    // Stepper navigation is not a per-sport deep-link — clear any card focus.
    setFormatsFocus(null);
    if (n === 1) {
      setView("overview");
      setSetup({ step: 0, flow: true });
    } else {
      // Leaving Step 1 for a later page closes the inline wizard if it's open
      // (e.g. a receipt edit), so the page actually swaps.
      setSetup(null);
      setView(n === 2 ? "clashes" : n === 3 ? "formats" : "overview");
    }
  };

  // Publish the journey state UP to the AppShell sticky sub-toolbar, which
  // renders the stepper under the top bar — the same placement as the Sports
  // setup page. The hub keeps all the state + logic; the bar is just a view.
  // The Step 1 "When & Where" wizard keeps the bar visible too (it's journey
  // step 1, so the four stages stay on screen even while the wizard — with its
  // OWN inner sub-step rail — owns the page body).
  const publishStep = useFixtureStepStore((s) => s.publish);
  const clearStep = useFixtureStepStore((s) => s.clear);
  useEffect(() => {
    if (!readiness.data) {
      clearStep();
      return;
    }
    publishStep({
      step: journey,
      activeStep,
      doneSteps,
      onStepClick: canManage && !globalsUnset ? onStepClick : undefined,
    });
  });
  useEffect(() => () => clearStep(), [clearStep]);

  const shareReady = Boolean(tournament.data?.slug);
  const showDoneBanner = journey === "done" && !doneDismissed;
  // ONE primary per view: while the celebrate banner carries Share, the
  // toolbar offers only the overflow menu; while the inline Step 1 panel is
  // open, the wizard's Next/Save is the page's only primary.
  const showToolbar =
    canManage &&
    !globalsUnset &&
    journey === "done" &&
    !setupView &&
    view === "overview";

  return (
    // Reserve bottom clearance when the floating "Ask AI" launcher is shown
    // (canManage) so the FAB never sits on top of a page's bottom-right actions
    // (the wizard's Next/Save, StageContinue's Continue).
    <div className={cn("flex flex-col gap-4", canManage && "pb-20")}>
      {/* The "Fixture setup" page title is hidden while the When & Where wizard
          owns the page — the wizard's own header (eyebrow + title) replaces it,
          matching its reference design. */}
      {!setupView ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("Fixture setup")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("Set up, then preview and publish.")}
            </p>
          </div>
          {showToolbar ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {!showDoneBanner ? (
                <Button
                  size="sm"
                  data-testid="share-schedule"
                  disabled={!shareReady}
                  onClick={() => void shareSchedule()}
                >
                  <Share2 aria-hidden="true" className="h-4 w-4" />
                  {t("Share schedule")}
                </Button>
              ) : null}
              <HubMoreMenu
                canRepair={canRepair}
                shareReady={shareReady}
                bracketTo={routes.tournamentBracket(id)}
                onReRun={() => setWizard({})}
                onShiftDay={() => setShiftOpen(true)}
                onPrint={openPublicSchedule}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The journey stepper lives in a sticky sub-toolbar pinned under the top
          bar (FixtureStepBar, rendered by AppShell) — same placement as the
          Sports setup page. The hub publishes its state to useFixtureStepStore
          (see the publishStep effect above) and stops publishing while the Step
          1 wizard owns the page. */}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : setupView ? (
        /* Step 1 inline (owner feedback): the wizard IS the page body — the
         * gate opens straight into it, edits swap the hub content for it. */
        <GlobalSetupWizard
          tournamentId={id}
          initialStep={setupView.step}
          onClose={closeSetup}
          onSaved={savedSetup}
        />
      ) : globalsUnset ? (
        /* §6.1 empty state — nothing else is actionable before dates + venues. */
        <section
          data-testid="global-setup-gate"
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center shadow-sm"
        >
          <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
            <CalendarRange aria-hidden="true" className="h-6 w-6" />
          </span>
          <h3 className="text-base font-semibold">
            {t("Let's set up your fixtures")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("Start with Step 1: set your dates and venues. Everything builds on those.")}
          </p>
          {canManage ? (
            <Button
              data-testid="global-setup-cta"
              onClick={() => setSetup({ step: 0, flow: true })}
            >
              <CalendarRange aria-hidden="true" className="h-4 w-4" />
              {t("Start Step 1")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("An organizer sets dates and venues first.")}
            </p>
          )}
        </section>
      ) : view === "clashes" ? (
        /* Journey Step 2 — its OWN page (owner: not stacked with formats). */
        <SetupSubPage
          onBack={() => onStepClick(1)}
          nextLabel={t("Next: How each competition plays")}
          onNext={() => setView("formats")}
        >
          {canManage && competitions.length > 0 ? (
            <ClashesSection
              tournamentId={id}
              competitions={competitions
                .filter((c) => c.leafKey)
                .map((c) => ({
                  leafKey: c.leafKey,
                  label: c.label,
                  sport: c.sport,
                }))}
            />
          ) : (
            <EmptyState
              icon={<CalendarClock className="h-8 w-8" />}
              title={t("Nothing to schedule yet")}
              hint={t("Clashes span competitions. Add sports and categories in Settings first.")}
            />
          )}
        </SetupSubPage>
      ) : view === "formats" ? (
        /* Journey Step 3 — its OWN page (owner: not stacked with clashes). */
        <SetupSubPage
          onBack={() => onStepClick(1)}
          nextLabel={t("Done — review competitions")}
          onNext={() => setView("overview")}
        >
          {canManage && competitions.some((c) => c.leafKey) ? (
            <CompetitionFormatBoard
              tournamentId={id}
              focusSport={formatsFocus ?? undefined}
              competitions={competitions
                .filter((c) => c.leafKey)
                .map((c) => ({
                  leafKey: c.leafKey,
                  label: c.label,
                  sport: c.sport,
                }))}
            />
          ) : (
            <EmptyState
              icon={<Users className="h-8 w-8" />}
              title={t("No competitions yet")}
              hint={t("Add sports and categories in Settings. Each gets its own format here.")}
            />
          )}
        </SetupSubPage>
      ) : (
        <>
          <GlobalSetupCard
            tournamentId={id}
            canManage={canManage}
            onEdit={(step) => setSetup({ step })}
          />

          {/* The combined master view: every sport drawn + timed together, then
              publish the whole tournament in one step (vs. one card at a time). */}
          {canManage && competitions.some((c) => c.leafKey) ? (
            <section
              data-testid="preview-all-cta"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5"
            >
              <CalendarClock
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-primary"
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold leading-tight">
                  {t("See & publish the whole tournament at once")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("Draw and time every sport together, then publish.")}
                </p>
              </div>
              <Button
                size="sm"
                data-testid="preview-all"
                onClick={() =>
                  navigate(routes.tournamentFixturesPreviewAll(id))
                }
              >
                <CalendarClock aria-hidden="true" className="h-4 w-4" />
                {t("Preview all competitions")}
              </Button>
            </section>
          ) : null}

          {showDoneBanner ? (
            /* §6.3 celebrate state. */
            <section
              data-testid="done-banner"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-success/40 bg-success-muted px-4 py-2.5"
            >
              <PartyPopper
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-success"
              />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold leading-tight">
                  {t("Your schedule is out")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("Every competition is scheduled. Share or print it.")}
                </p>
              </div>
              <span className="flex shrink-0 flex-wrap items-center gap-3">
                {/* Handoff to the live-ops cockpit (control room spec §3.2). */}
                <Link
                  to={routes.tournamentControl(id)}
                  data-testid="done-open-control"
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  <Radio aria-hidden="true" className="h-4 w-4" />
                  {t("Open control room")}
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="share-schedule"
                  disabled={!shareReady}
                  onClick={() => void shareSchedule()}
                >
                  <Share2 aria-hidden="true" className="h-4 w-4" />
                  {t("Share schedule")}
                </Button>
                <button
                  type="button"
                  data-testid="done-print"
                  disabled={!shareReady}
                  title={t("Opens the public schedule to print.")}
                  className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
                  onClick={openPublicSchedule}
                >
                  {t("Print")}
                </button>
                <Link
                  to={routes.tournamentBracket(id)}
                  data-testid="done-view-bracket"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {t("View bracket")}
                </Link>
                <button
                  type="button"
                  aria-label={t("Dismiss")}
                  data-testid="done-dismiss"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setDoneDismissed(true)}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </span>
            </section>
          ) : null}

          {/* Clashes & sessions (Step 2) and How each competition plays (Step 3)
              are their OWN pages now — reached from the journey stepper above,
              not stacked here. This overview is the Preview & publish surface. */}

          {competitions.length === 0 ? (
            <EmptyState
              icon={<Users className="h-8 w-8" />}
              title={t("No competitions yet")}
              hint={t("Add sports and categories in Settings. Teams register into them, and each gets its own draw here.")}
            >
              {canManage ? (
                <Link
                  to={routes.tournamentSettings(id)}
                  data-testid="empty-open-settings"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {t("Open Settings")}
                </Link>
              ) : null}
            </EmptyState>
          ) : (
            <div id="competition-list" className="flex flex-col gap-3">
              {GROUPS.map((g) => {
                const list = grouped[g.key];
                if (list.length === 0) return null;
                const open = openSections[g.key];
                return (
                  <section key={g.key} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      data-testid={`section-${g.key}`}
                      aria-expanded={open}
                      className="flex items-center gap-1.5 text-left"
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
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t(g.title)}
                      </h3>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 font-tabular text-[0.6875rem] text-muted-foreground">
                        {list.length}
                      </span>
                    </button>
                    {open ? (
                      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                        {list.map((c) => {
                          const key = c.leafKey || "general";
                          return (
                            <CompetitionCard
                              key={key}
                              competition={c}
                              drawFormat={formatFor(c.leafKey)}
                              tournamentId={id}
                              canManage={canManage}
                              canRepair={canRepair}
                              kept={keptDraws.has(c.leafKey)}
                              detailOpen={expanded === key}
                              busy={nextRound.isPending}
                              fixable={FIXABLE}
                              globalsUnset={globalsUnset}
                              onToggleDetail={() =>
                                setExpanded(expanded === key ? null : key)
                              }
                              onAction={(a) => onCardAction(c, a)}
                              onFix={onFix}
                            />
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}

          {tabs.length > 0 ? (
            <section
              data-testid="advanced-tools"
              className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"
            >
              <button
                type="button"
                data-testid="advanced-tools-toggle"
                aria-expanded={advancedOpen}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
                onClick={() => setAdvancedOpen((o) => !o)}
              >
                <SlidersHorizontal
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <h3 className="text-sm font-semibold">{t("Advanced tools")}</h3>
                <span className="hidden text-xs text-muted-foreground sm:block">
                  {t("Rules, history and group tables")}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    advancedOpen && "rotate-180",
                  )}
                />
              </button>
              {advancedOpen ? (
                <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
                  <div
                    role="tablist"
                    aria-label={t("Advanced tools")}
                    className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
                  >
                    {tabs.map((x) => (
                      <button
                        key={x}
                        role="tab"
                        type="button"
                        aria-selected={activeTab === x}
                        data-testid={`hub-tab-${x}`}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          activeTab === x
                            ? "bg-card text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => setTab(x)}
                      >
                        {t(TAB_LABELS[x])}
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
            </section>
          ) : null}

          {/* The tournament-level "Continue to Ready" lives ONLY here, on the
              last journey step (Preview & publish). Earlier steps advance within
              the journey (wizard save -> Clashes -> Formats -> here), so this is
              the single place the whole fixture stage hands off to Ready. */}
          <StageContinue tournamentId={id} />
        </>
      )}

      {wizard ? (
        <ScheduleWizard
          tournamentId={id}
          open
          onClose={() => setWizard(null)}
          leafKey={wizard.leafKey}
          leafLabel={wizard.label}
        />
      ) : null}
      {draw ? (
        <CompetitionFormatWizard
          tournamentId={id}
          open
          onClose={() => setDraw(null)}
          leafKey={draw.leafKey}
          leafLabel={draw.label}
          teams={draw.teams}
          focusSeeds={draw.focusSeeds}
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

      {/* AI co-pilot — answers questions and fills the setup form (manager-only). */}
      <AssistantWidget tournamentId={id} canManage={canManage} />
    </div>
  );
}
