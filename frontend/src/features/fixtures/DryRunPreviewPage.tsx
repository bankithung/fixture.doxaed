import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Dices,
  SlidersHorizontal,
} from "lucide-react";
import {
  tournamentsApi,
  type ConstraintDraft,
  type DrawCalendar,
  type FixturePreview,
  type PreviewMatch,
  type PreviewRelaxation,
  type PreviewViolation,
  type ScheduleRequest,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { FifaBracket } from "@/features/tournaments/FifaBracket";
import type { MatchRow } from "@/api/tournaments";
import {
  CompetitionPreviewPanel,
  previewToMatchRow,
} from "./CompetitionPreviewPanel";
import { FairnessPanel } from "./FairnessPanel";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { LeafLabel } from "./LeafLabel";
import { GroupCompositionView } from "./GroupCompositionView";
import { MatchesSpreadsheet } from "./MatchesSpreadsheet";
import { PreviewToolbar } from "./PreviewToolbar";
import {
  applyFilters,
  buildRows,
  EMPTY_FILTERS,
  toCsv,
  type ColumnKey,
  type GridFilters,
  type GridSort,
  type GroupBy,
} from "./previewGrid";
import { competitionLabel } from "./previewFilters";
import { ViolationsPanel } from "./ViolationsPanel";

/** Pairing-layer warning labels per stable code (§7.7). */
const WARNING_LABELS: Record<string, string> = {
  keep_apart_relaxed:
    "Could not fully keep those teams apart, so the rule was relaxed for this draw.",
  keep_apart_missing_district:
    "Some teams have no district, so keep-apart skipped them.",
  keep_apart_missing_seed:
    "Some teams have no seed, so keep-apart skipped them.",
  keep_apart_unknown_key:
    "A keep-apart rule uses an unknown setting and was skipped.",
};

/** Build the slot-layer payload from the asked-once global calendar
 * (draw_config["*"].calendar). Preview AND Publish send the SAME payload so
 * preview ≡ commit (§9 A1); venues stay omitted — both paths fall back to
 * the stored venue pool. */
function schedulePayloadFrom(cal: DrawCalendar | null | undefined): ScheduleRequest | null {
  if (!cal?.date_start) return null;
  return {
    date_start: cal.date_start,
    date_end: cal.date_end ?? cal.date_start,
    daily_start: cal.daily_start ?? "09:00",
    daily_end: cal.daily_end ?? "18:00",
    slot_minutes: cal.slot_minutes ?? 90,
  };
}

/** One reading of the run, ERP status-bar style. */
function StatCell({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: string;
  tone?: "warning" | "success";
  testid?: string;
}): React.ReactElement {
  return (
    <span data-testid={testid} className="flex flex-col leading-tight">
      <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-tabular text-xs font-semibold",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * Step 3 of the journey (clarity rebuild §4.4), rebuilt 2026-08-15 as ONE
 * workbench: a single panel that carries the title bar, the run's readings,
 * every notice, the ERP filter toolbar, the schedule spreadsheet and the
 * decision bar — no stack of separate cards (owner ask: "everything combined
 * in one section"). It is still a PURE simulate of generate + schedule;
 * nothing persists until Publish, which replays the previewed `seed` through
 * the real endpoints with `expected_inputs_hash` (a 409 `inputs_changed`
 * renders the InputsChangedBanner and the only way forward is a fresh
 * preview — §9 A1).
 */
export function DryRunPreviewPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const leaf = params.get("leaf") ?? "";
  // "All competitions" master mode: every sport/category drawn + scheduled
  // together in one combined preview, with a single Publish-all.
  const isAll = params.get("all") === "1";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { isMobile } = useBreakpoint();
  // Bumping the roll re-simulates (fresh seed for random draws — §5.2).
  const [roll, setRoll] = useState(0);
  const [stale, setStale] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The spreadsheet's state: ERP filters, column sort, group bands.
  const [filters, setFilters] = useState<GridFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("day_venue");
  // "sheet" = the spreadsheet; "draw" = the structure (groups + brackets).
  const [viewMode, setViewMode] = useState<"sheet" | "draw">("sheet");

  const drawConfig = useQuery({
    queryKey: qk.drawConfig(id),
    queryFn: () => tournamentsApi.drawConfig(id),
  });
  const teams = useQuery({
    queryKey: qk.teams(id),
    queryFn: () => tournamentsApi.teams(id),
  });
  const readiness = useQuery({
    queryKey: qk.fixtureReadiness(id),
    queryFn: () => tournamentsApi.fixtureReadiness(id),
  });
  // Publish → control room handoff (control room spec §3.2): once the
  // tournament is `ready`, a successful publish lands in the cockpit.
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });

  const schedule = useMemo(
    () => schedulePayloadFrom(drawConfig.data?.draw_config["*"]?.calendar),
    [drawConfig.data],
  );

  // The simulate itself: a read-only POST (D6) — modelled as a query so the
  // result is stable while the page is open; gcTime 0 so a revisit re-runs.
  const preview = useQuery({
    queryKey: ["t-fixture-preview", id, isAll ? "all" : leaf, roll],
    enabled: drawConfig.data !== undefined && schedule !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: () =>
      isAll
        ? tournamentsApi.previewAllFixtures(id, {
            schedule: schedule!,
            include_schedule: true,
          })
        : tournamentsApi.previewFixtures(id, {
            ...(leaf ? { leaf_key: leaf } : {}),
            schedule: schedule!,
            include_schedule: true,
          }),
  });

  const teamNames = useMemo(
    () => new Map((teams.data ?? []).map((tm) => [tm.id, tm.name])),
    [teams.data],
  );
  const label = isAll
    ? t("All competitions")
    : (readiness.data?.competitions.find((c) => c.leaf_key === leaf)?.label ??
      // Raw leaf keys are internal codes — never flash one while loading.
      (readiness.data === undefined ? "" : leaf || t("All competitions")));

  const p = preview.data;

  // The spreadsheet model: every previewed match as a row, then the toolbar's
  // filters. Both the sheet AND the draw views read from the same filtered
  // set, so what you filter is what you see everywhere.
  const allRows = useMemo(
    () => buildRows(p?.matches ?? [], teamNames, p?.unscheduled ?? []),
    [p, teamNames],
  );
  const rows = useMemo(() => applyFilters(allRows, filters), [allRows, filters]);
  const filteredMatches = useMemo(() => rows.map((r) => r.match), [rows]);

  // ONE competition selected (a category filter, or a single-competition
  // preview) -> the Draw view opens that competition's own panel (groups,
  // knockout with byes) instead of the tournament-wide structure.
  const selectedLeaf = useMemo(() => {
    if (filters.category) return filters.category;
    const leaves = new Set((p?.matches ?? []).map((m) => m.leaf_key));
    return leaves.size === 1 ? [...leaves][0]! : null;
  }, [filters.category, p]);
  const selectedLabel = useMemo(() => {
    if (!selectedLeaf) return "";
    const withGroup = (p?.matches ?? []).find(
      (m) => m.leaf_key === selectedLeaf && m.group_label,
    );
    return (
      (withGroup ? competitionLabel(withGroup) : "") ||
      readiness.data?.competitions.find((c) => c.leaf_key === selectedLeaf)
        ?.label ||
      selectedLeaf
    );
  }, [selectedLeaf, p, readiness.data]);

  // The Draw view's brackets: one per knockout competition in the current
  // filter — the proper flow fixture, not flat "Winner of pN" chips.
  const drawBrackets = useMemo(() => {
    const byLeaf = new Map<string, PreviewMatch[]>();
    for (const m of filteredMatches) {
      if (m.stage !== "knockout") continue;
      const list = byLeaf.get(m.leaf_key);
      if (list) list.push(m);
      else byLeaf.set(m.leaf_key, [m]);
    }
    return [...byLeaf.entries()].map(([leafKey, ms]) => {
      const byRound = new Map<number, MatchRow[]>();
      for (const m of ms) {
        const row = previewToMatchRow(m, teamNames);
        const list = byRound.get(m.round_no);
        if (list) list.push(row);
        else byRound.set(m.round_no, [row]);
      }
      const withGroup = filteredMatches.find(
        (m) => m.leaf_key === leafKey && m.group_label,
      );
      const bracketLabel =
        (withGroup ? competitionLabel(withGroup) : "") ||
        readiness.data?.competitions.find((c) => c.leaf_key === leafKey)?.label ||
        leafKey;
      return {
        leafKey,
        label: bracketLabel,
        columns: [...byRound.entries()].sort((a, b) => a[0] - b[0]),
      };
    });
  }, [filteredMatches, teamNames, readiness.data]);

  // The unplaced matches per competition — a chip you can click to filter the
  // sheet down to exactly those rows.
  const unscheduledByLeaf = useMemo(() => {
    const set = new Set(p?.unscheduled ?? []);
    const byLeaf = new Map<string, { label: string; count: number }>();
    for (const m of p?.matches ?? []) {
      if (!set.has(m.ref)) continue;
      const hit = byLeaf.get(m.leaf_key);
      if (hit) hit.count += 1;
      else byLeaf.set(m.leaf_key, { label: competitionLabel(m), count: 1 });
    }
    return [...byLeaf.entries()];
  }, [p]);

  const rePreview = (): void => {
    setStale(false);
    setRoll((r) => r + 1);
  };

  const onSort = (key: ColumnKey): void =>
    setSort((s) =>
      s?.key !== key
        ? { key, dir: "asc" }
        : s.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );

  /** Export exactly what the filters are showing, in the order shown. */
  const onExport = (): void => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fixture-preview-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Publish = the real generate + schedule endpoints replaying the previewed
   * seed, both guarded by `expected_inputs_hash` (D6/D10). */
  const accept = useMutation({
    mutationFn: async (pv: FixturePreview) => {
      if (isAll) {
        // Publish the WHOLE tournament: every competition's draw + one
        // coordinated schedule, committed atomically server-side — replaying
        // the previewed per-leaf seeds + drift hashes so what was previewed
        // is exactly what commits (C11), 409 on drift like the single path.
        const all = pv as FixturePreview & {
          per_leaf_seed?: Record<string, number | null>;
          per_leaf_inputs_hash?: Record<string, string>;
        };
        return tournamentsApi.publishAllFixtures(id, {
          schedule: schedule!,
          ...(all.per_leaf_seed ? { per_leaf_seed: all.per_leaf_seed } : {}),
          ...(all.per_leaf_inputs_hash
            ? { per_leaf_inputs_hash: all.per_leaf_inputs_hash }
            : {}),
        });
      }
      await tournamentsApi.generateFixtures(id, {
        leafKey: leaf || undefined,
        ...(pv.seed != null ? { seed: pv.seed } : {}),
        expectedInputsHash: pv.inputs_hash,
      });
      return tournamentsApi.scheduleFixtures(id, {
        ...schedule!,
        ...(leaf ? { leaf_key: leaf } : {}),
        expected_inputs_hash: pv.inputs_hash,
      });
    },
    onSuccess: (r) => {
      invalidateTournament(qc, id);
      // Once the schedule is live (stage `ready`), publishing hands off to
      // the control room — match day runs from there (spec §3.2).
      if (stageQ.data?.stage === "ready" && r.unscheduled.length === 0) {
        toast.push({
          kind: "success",
          title: t("Schedule published · you're in the control room."),
        });
        navigate(routes.tournamentControl(id));
        return;
      }
      toast.push({
        kind: "success",
        title: t(`Published. ${r.scheduled} matches are on the schedule.`),
        description: r.unscheduled.length
          ? t(`${r.unscheduled.length} matches still need a time. See fixture setup.`)
          : undefined,
      });
      navigate(routes.tournamentFixtures(id));
    },
    onError: (e) => {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.payload.detail === "inputs_changed"
      ) {
        setStale(true); // §9 A1: nothing committed; re-preview to continue
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not publish the schedule"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      });
    },
  });

  /** Relaxation routing: making a rule a preference is a one-click PATCH +
   * re-preview; capacity fixes (days/venues/caps) live in the hub's Step 1 +
   * rules surfaces. */
  const demote = useMutation({
    mutationFn: async (v: PreviewViolation) => {
      const settings = await tournamentsApi.settings(id);
      const next: ConstraintDraft[] = settings.constraints.map((c) =>
        c.type === v.constraint?.type && c.scope === v.constraint?.scope
          ? { ...c, hard: false }
          : c,
      );
      const body = { constraints: next, event_id: newEventId() };
      try {
        await tournamentsApi.updateSettings(id, body);
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.payload.detail === "rules_frozen"
        ) {
          await tournamentsApi.updateSettings(id, {
            ...body,
            amend: true,
            reason: t("Dry-run preview: hard constraint demoted to soft"),
          });
        } else {
          throw e;
        }
      }
    },
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({
        kind: "success",
        title: t("Done. That rule is now a preference, and the preview re-ran."),
      });
      rePreview();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the rule"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const onRelax = (r: PreviewRelaxation, v: PreviewViolation): void => {
    if (r.code === "demote_to_soft" && v.constraint) {
      demote.mutate(v);
      return;
    }
    // add_day / add_venue / raise_max_per_day → the hub's setup surfaces.
    navigate(routes.tournamentFixtures(id));
  };

  const busy = accept.isPending || demote.isPending;
  const calendarMissing = drawConfig.data !== undefined && schedule === null;
  const previewDetail =
    preview.error instanceof ApiError
      ? String(preview.error.payload.detail ?? "")
      : "";

  const hardCount = (p?.violations ?? []).filter((v) => v.hard).length;
  const warnings = ((p?.warnings ?? []) as { code?: string }[]).filter(
    (w) => w?.code,
  );
  // Competitions silently absent from the combined preview (too few teams)
  // are called out loudly (C11): absence used to read as "drawn".
  const skippedLeaves = isAll
    ? ((p?.warnings ?? []) as { code?: string; leaf_key?: string }[]).filter(
        (w) => w?.code === "skipped_leaf" && w.leaf_key,
      )
    : [];
  const unplacedCount = p?.unscheduled.length ?? 0;
  const filtersOn = rows.length !== allRows.length;

  return (
    <div className="flex w-full flex-col px-4 py-4 sm:px-6 lg:px-8">
      {/* ONE workbench: header, readings, notices, filters, sheet and the
          decision bar all live inside this panel (owner 2026-08-15). */}
      <section
        data-testid="preview-workbench"
        className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        {/* Title bar: where you are, what this run is, and its readings. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-3 py-2">
          <Link
            to={routes.tournamentFixtures(id)}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Back to fixture setup")}
          </Link>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <h1 className="text-sm font-semibold tracking-tight">{t("Preview")}</h1>
          {label ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium text-secondary-foreground">
              {label}
            </span>
          ) : null}
          <span className="hidden text-[0.6875rem] text-muted-foreground lg:inline">
            {t("This is a trial run. Nothing is saved until you publish.")}
          </span>

          {p ? (
            <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatCell
                testid="preview-counts"
                label={t("Matches")}
                value={`${p.matches.length}${
                  p.fairness.days_used ? ` · ${p.fairness.days_used} ${t("days")}` : ""
                }`}
              />
              <StatCell
                label={t("Scheduled")}
                value={String(p.matches.length - unplacedCount)}
                tone="success"
              />
              <StatCell
                label={t("No time")}
                value={String(unplacedCount)}
                tone={unplacedCount ? "warning" : undefined}
              />
              <div
                role="radiogroup"
                aria-label={t("Preview view")}
                className="inline-flex shrink-0 rounded-md border border-border bg-background p-0.5"
              >
                {(
                  [
                    ["sheet", t("Sheet")],
                    ["draw", t("Draw")],
                  ] as const
                ).map(([mode, lbl]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={viewMode === mode}
                    data-testid={`preview-view-${mode}`}
                    onClick={() => setViewMode(mode)}
                    className={cn(
                      "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                      viewMode === mode
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-testid="advanced-details-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((o) => !o)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium transition-colors hover:bg-secondary",
                  advancedOpen && "bg-secondary",
                )}
                title={t("Fairness, draw number and schedule quality")}
              >
                <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("Advanced details")}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("h-3 w-3 transition-transform", advancedOpen && "rotate-180")}
                />
              </button>
            </div>
          ) : null}
        </div>

        {/* Advanced band — fairness, pairing warnings, draw number, quality. */}
        {p && advancedOpen ? (
          <div
            data-testid="advanced-details"
            className="flex flex-col gap-3 border-b border-border bg-muted/20 px-3 py-3"
          >
            <FairnessPanel
              teams={p.fairness.teams ?? []}
              flags={p.fairness.flags ?? []}
            />
            {warnings.length ? (
              <ul className="flex flex-col gap-1">
                {warnings.map((w, i) => (
                  <li key={i} className="text-xs text-warning">
                    {t(WARNING_LABELS[w.code!] ?? w.code!)}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 font-tabular text-xs text-muted-foreground">
              {p.seed != null ? (
                <span
                  data-testid="preview-seed"
                  title={t("Saved on publish so this draw can be reproduced.")}
                  className="rounded bg-muted px-2 py-0.5"
                >
                  {t("Draw number")} {p.seed}
                </span>
              ) : null}
              {p.soft_score != null ? (
                <span data-testid="schedule-quality">
                  {t("Schedule quality")} {Math.round(p.soft_score * 100)}%
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Notices: drift, skipped competitions, the verdict, unplaced work —
            one strip, not four cards adrift on the page. */}
        {p || stale ? (
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
            {stale ? (
              <InputsChangedBanner context="accept" onRePreview={rePreview} />
            ) : null}

            {skippedLeaves.length ? (
              <div
                data-testid="skipped-leaves-notice"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2"
              >
                <p className="text-xs font-medium text-warning">
                  {t(
                    `${skippedLeaves.length} ${skippedLeaves.length === 1 ? "competition is" : "competitions are"} not drawn yet (fewer than 2 teams). Publishing skips them.`,
                  )}
                </p>
                {skippedLeaves.map((w) => (
                  <LeafLabel key={w.leaf_key} label={w.leaf_key ?? ""} />
                ))}
              </div>
            ) : null}

            {p ? (
              <ViolationsPanel
                violations={p.violations}
                onRelax={busy ? undefined : onRelax}
                onFixRules={() => navigate(routes.tournamentFixtures(id))}
              />
            ) : null}

            {unplacedCount ? (
              <div
                data-testid="unscheduled-summary"
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2"
              >
                <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
                <span className="text-sm font-semibold">
                  {unplacedCount} {t("match(es) have no time yet")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("Add another day or venue in Step 1, then preview again.")}
                </span>
                <button
                  type="button"
                  data-testid="show-unplaced"
                  onClick={() => {
                    setFilters({ ...EMPTY_FILTERS, status: "unplaced" });
                    setViewMode("sheet");
                  }}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t("Show them in the sheet")}
                </button>
                <span className="flex w-full flex-wrap items-center gap-1.5">
                  {unscheduledByLeaf.map(([leafKey, e]) => (
                    <button
                      key={leafKey}
                      type="button"
                      data-testid={`unplaced-leaf-${leafKey}`}
                      onClick={() => {
                        setFilters({
                          ...EMPTY_FILTERS,
                          category: leafKey,
                          status: "unplaced",
                        });
                        setViewMode("sheet");
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-warning/40 bg-card px-1.5 py-0.5 text-[0.6875rem] transition-colors hover:bg-muted"
                    >
                      <span className="max-w-64 truncate">{e.label}</span>
                      <span className="font-tabular text-muted-foreground">
                        {e.count}
                      </span>
                    </button>
                  ))}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* The working surface. */}
        {calendarMissing ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm font-medium">{t("Step 1 is not finished")}</p>
            <p className="pt-1 text-sm text-muted-foreground">
              {t("The preview needs your tournament dates. Set them in Step 1 first.")}
            </p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => navigate(routes.tournamentFixtures(id))}
            >
              {t("Open Step 1")}
            </Button>
          </div>
        ) : preview.isError ? (
          <div role="alert" className="px-3 py-8 text-center">
            <p className="text-sm font-medium">{t("The preview could not run.")}</p>
            {previewDetail ? (
              <p className="pt-1 text-sm text-muted-foreground">{previewDetail}</p>
            ) : null}
            <Button variant="outline" className="mt-3" onClick={rePreview}>
              {t("Try again")}
            </Button>
          </div>
        ) : !p ? (
          <div className="flex flex-col gap-2 p-3" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-muted/50" />
            ))}
          </div>
        ) : viewMode === "sheet" ? (
          <>
            <PreviewToolbar
              rows={allRows}
              filters={filters}
              onFilters={setFilters}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              visible={rows.length}
              onExport={onExport}
            />
            <MatchesSpreadsheet
              rows={rows}
              sort={sort}
              onSort={onSort}
              groupBy={groupBy}
              occupancy={p.matches}
              filtered={filtersOn}
              onClearFilters={() => setFilters(EMPTY_FILTERS)}
            />
          </>
        ) : (
          <>
            <PreviewToolbar
              rows={allRows}
              filters={filters}
              onFilters={setFilters}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              visible={rows.length}
              onExport={onExport}
            />
            <div className="max-h-[65vh] overflow-auto px-3 py-3">
              {selectedLeaf ? (
                /* ONE competition: its own panel — group stage, then the
                   knockout bracket with byes. */
                <CompetitionPreviewPanel
                  label={selectedLabel}
                  matches={filteredMatches}
                  teamNames={teamNames}
                  unscheduled={p.unscheduled}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <GroupCompositionView
                    matches={filteredMatches}
                    teamNames={teamNames}
                  />
                  {drawBrackets.length ? (
                    <section data-testid="draw-brackets" className="flex flex-col gap-4">
                      <h2 className="text-sm font-semibold">
                        {t("Knockout brackets")}
                      </h2>
                      {drawBrackets.map((b) => (
                        <div
                          key={b.leafKey}
                          data-testid={`preview-bracket-${b.leafKey}`}
                          className="flex flex-col gap-2"
                        >
                          <LeafLabel label={b.label} />
                          <FifaBracket columns={b.columns} />
                        </div>
                      ))}
                    </section>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Pick a category in the filters to see that competition's groups, knockout bracket and byes.",
                    )}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {/* The decision bar closes the same panel — ONE primary (§4.4). */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
          <span className="font-tabular text-[0.6875rem] text-muted-foreground">
            {p
              ? t(
                  `${p.matches.length} matches${unplacedCount ? ` · ${unplacedCount} without a time` : ""}${
                    p.soft_score != null
                      ? ` · quality ${Math.round(p.soft_score * 100)}%`
                      : ""
                  }`,
                )
              : t("Simulating…")}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="discard-preview"
              disabled={busy}
              onClick={() => navigate(routes.tournamentFixtures(id))}
            >
              {t("Back without saving")}
            </Button>
            {isMobile ? (
              <Button
                variant="outline"
                size="sm"
                aria-label={t("Try another draw")}
                data-testid="regenerate-preview"
                disabled={busy}
                onClick={rePreview}
              >
                <Dices aria-hidden="true" className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                data-testid="regenerate-preview"
                disabled={busy}
                onClick={rePreview}
              >
                <Dices aria-hidden="true" className="h-4 w-4" />
                {t("Try another draw")}
              </Button>
            )}
            <Button
              size="sm"
              data-testid="accept-preview"
              disabled={busy || stale || !p || p.matches.length === 0 || hardCount > 0}
              title={hardCount > 0 ? t("Fix the problems above first.") : undefined}
              onClick={() => p && accept.mutate(p)}
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              {accept.isPending
                ? t("Saving…")
                : isAll
                  ? t("Publish all competitions")
                  : t("Publish schedule")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
