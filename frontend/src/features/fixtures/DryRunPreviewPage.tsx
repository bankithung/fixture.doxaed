import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, Dices } from "lucide-react";
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
import "@/components/ui/star-border.css";
import { BentoGrid } from "@/features/dashboard/BentoCard";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { CompetitionPreviewPanel } from "./CompetitionPreviewPanel";
import { FairnessPanel } from "./FairnessPanel";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { LeafLabel } from "./LeafLabel";
import { MatchesByDayGrid } from "./MatchesByDayGrid";
import { GroupCompositionView } from "./GroupCompositionView";
import { MatchesByGroupGrid } from "./MatchesByGroupGrid";
import { PreviewFilterBar } from "./PreviewFilterBar";
import { competitionLabel, sportKey } from "./previewFilters";
import { shortGroupName } from "./groupSlotLabel";
import { sideName } from "./sideName";
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

/**
 * Step 3 of the journey (clarity rebuild §4.4): a PURE simulate of
 * generate + schedule for one competition — nothing persists until Publish.
 * The verdict leads; fairness, pairing warnings, the draw number and the
 * quality figure sit behind an Advanced-details disclosure that forces open
 * whenever there is a problem. Publish replays the previewed `seed` through
 * the real generate + schedule endpoints with `expected_inputs_hash`; a 409
 * `inputs_changed` renders the InputsChangedBanner and the only way forward
 * is a fresh preview (§9 A1). "Try another draw" re-rolls; "Back without
 * saving" walks away (nothing was saved).
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
  // Schedule filter (owner ask) — narrow to one sport, then one category.
  const [sportFilter, setSportFilter] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<string | null>(null);
  // Preview view: schedule "By day" / "By group", or the "Draw" (groups +
  // bracket) structure view.
  const [viewMode, setViewMode] = useState<"day" | "group" | "draw">("day");

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

  // The schedule both views render: every match honouring the sport/category
  // filter (shared by the day grid and the group grid).
  const filteredMatches = useMemo(
    () =>
      (preview.data?.matches ?? []).filter(
        (m) =>
          (!sportFilter || sportKey(m) === sportFilter) &&
          (!catFilter || m.leaf_key === catFilter),
      ),
    [preview.data, sportFilter, catFilter],
  );

  // The combined (all competitions) schedule shows EVERY timed match,
  // knockout included — a knockout-only sport must not read as empty
  // (owner 2026-07-13); each competition's bracket still lives on its
  // panel's Knockout tab.
  const scheduleMatches = filteredMatches;

  // ONE competition selected (a category filter, or a single-competition
  // preview) -> the Google-style stage-tabbed panel instead of the global
  // views (owner ask 2026-07-13: each game and category separate, group
  // stage and knockout apart, byes shown).
  const selectedLeaf = useMemo(() => {
    if (catFilter) return catFilter;
    const all = preview.data?.matches ?? [];
    const leaves = new Set(all.map((m) => m.leaf_key));
    return leaves.size === 1 ? [...leaves][0]! : null;
  }, [catFilter, preview.data]);
  const selectedLabel = useMemo(() => {
    if (!selectedLeaf) return "";
    const withGroup = (preview.data?.matches ?? []).find(
      (m) => m.leaf_key === selectedLeaf && m.group_label,
    );
    return (
      (withGroup ? competitionLabel(withGroup) : "") ||
      readiness.data?.competitions.find((c) => c.leaf_key === selectedLeaf)
        ?.label ||
      selectedLeaf
    );
  }, [selectedLeaf, preview.data, readiness.data]);

  // The unplaced list grouped per competition — a count you can open, not a
  // wall of rows.
  const unscheduledByLeaf = useMemo(() => {
    const set = new Set(preview.data?.unscheduled ?? []);
    const byLabel = new Map<string, PreviewMatch[]>();
    for (const m of preview.data?.matches ?? []) {
      if (!set.has(m.ref)) continue;
      const key = competitionLabel(m);
      const list = byLabel.get(key);
      if (list) list.push(m);
      else byLabel.set(key, [m]);
    }
    return [...byLabel.entries()];
  }, [preview.data]);

  const rePreview = (): void => {
    setStale(false);
    setRoll((r) => r + 1);
  };

  /** Publish = the real generate + schedule endpoints replaying the previewed
   * seed, both guarded by `expected_inputs_hash` (D6/D10). */
  const accept = useMutation({
    mutationFn: async (p: FixturePreview) => {
      if (isAll) {
        // Publish the WHOLE tournament: every competition's draw + one
        // coordinated schedule, committed atomically server-side — replaying
        // the previewed per-leaf seeds + drift hashes so what was previewed
        // is exactly what commits (C11), 409 on drift like the single path.
        const all = p as FixturePreview & {
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
        ...(p.seed != null ? { seed: p.seed } : {}),
        expectedInputsHash: p.inputs_hash,
      });
      return tournamentsApi.scheduleFixtures(id, {
        ...schedule!,
        ...(leaf ? { leaf_key: leaf } : {}),
        expected_inputs_hash: p.inputs_hash,
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

  const p = preview.data;
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
    ? (
        (p?.warnings ?? []) as { code?: string; leaf_key?: string }[]
      ).filter((w) => w?.code === "skipped_leaf" && w.leaf_key)
    : [];
  // Closed by default and always closable (owner 2026-07-13) — hard
  // problems surface loudly in the verdict panel above regardless.
  const advancedShown = advancedOpen;

  return (
    <BentoGrid className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentFixtures(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to fixture setup")}
      </Link>

      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("Preview")}
          </h1>
          {label ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {label}
            </span>
          ) : null}
          {p ? (
            <span
              data-testid="preview-counts"
              className="ml-auto font-tabular text-xs text-muted-foreground"
            >
              {p.matches.length} {t("matches")}
              {p.fairness.days_used ? ` · ${p.fairness.days_used} ${t("days")}` : ""}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("This is a trial run. Nothing is saved until you publish.")}
        </p>
      </div>

      {stale ? (
        <InputsChangedBanner context="accept" onRePreview={rePreview} />
      ) : null}

      {skippedLeaves.length ? (
        <div
          data-testid="skipped-leaves-notice"
          className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3"
        >
          <p className="text-sm font-medium text-warning">
            {t(
              `${skippedLeaves.length} ${skippedLeaves.length === 1 ? "competition is" : "competitions are"} not drawn yet (fewer than 2 teams). Publishing skips them.`,
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {skippedLeaves.map((w) => (
              <LeafLabel key={w.leaf_key} label={w.leaf_key ?? ""} />
            ))}
          </div>
        </div>
      ) : null}

      {calendarMissing ? (
        <div className="bento-card star-rim rounded-xl border border-border bg-card p-6 shadow-sm">
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
        <div role="alert" className="rounded-xl border border-destructive/50 bg-destructive-muted p-6">
          <p className="text-sm font-medium">{t("The preview could not run.")}</p>
          {previewDetail ? (
            <p className="pt-1 text-sm text-muted-foreground">{previewDetail}</p>
          ) : null}
          <Button variant="outline" className="mt-3" onClick={rePreview}>
            {t("Try again")}
          </Button>
        </div>
      ) : !p ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-muted/40" />
          ))}
        </div>
      ) : (
        <>
          {/* Verdict first (§4.4). */}
          <ViolationsPanel
            violations={p.violations}
            onRelax={busy ? undefined : onRelax}
            onFixRules={() => navigate(routes.tournamentFixtures(id))}
          />

          {/* Advanced details — fairness, pairing warnings, draw number,
              quality. Forced open whenever something needs attention. */}
          <section
            data-testid="advanced-details"
            className="overflow-hidden bento-card star-rim rounded-xl border border-border bg-card shadow-sm"
          >
            <button
              type="button"
              data-testid="advanced-details-toggle"
              aria-expanded={advancedShown}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              <span className="text-sm font-semibold">{t("Advanced details")}</span>
              <span className="hidden text-xs text-muted-foreground sm:block">
                {t("Fairness, draw number and schedule quality")}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  advancedShown && "rotate-180",
                )}
              />
            </button>
            {advancedShown ? (
              <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
                {/* Per-team fairness analytics (increment R) — rest/early/
                    venue metrics with the server's outlier flags. */}
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
                      className="rounded-full bg-muted px-2 py-0.5"
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
          </section>

          {/* One toolbar: the sport/category switcher on the left; the global
              day/group/draw view switch only while EVERY competition shows. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <PreviewFilterBar
                matches={p.matches}
                sport={sportFilter}
                category={catFilter}
                onSport={setSportFilter}
                onCategory={setCatFilter}
              />
            </div>
            {!selectedLeaf ? (
              <div
                role="radiogroup"
                aria-label={t("Preview view")}
                className="inline-flex shrink-0 rounded-lg border border-border bg-muted/20 p-0.5"
              >
                {(
                  [
                    ["day", t("By day")],
                    ["group", t("By group")],
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
                      "h-8 rounded-md px-3 text-xs font-medium transition-colors",
                      viewMode === mode
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {selectedLeaf ? (
            /* ONE competition: its own Google-style panel — Group stage /
               Knockout (byes shown) / Schedule tabs. */
            <CompetitionPreviewPanel
              label={selectedLabel}
              matches={filteredMatches}
              teamNames={teamNames}
              unscheduled={p.unscheduled}
              occupancy={p.matches}
            />
          ) : (
            <>
              {/* All competitions: the combined schedule. Pick a category
                  above for its groups and bracket. */}
              {viewMode === "draw" ? (
                <GroupCompositionView
                  matches={filteredMatches}
                  teamNames={teamNames}
                />
              ) : scheduleMatches.length > 0 ? (
                viewMode === "day" ? (
                  <MatchesByDayGrid
                    matches={scheduleMatches}
                    teamNames={teamNames}
                    occupancy={preview.data?.matches}
                  />
                ) : (
                  <MatchesByGroupGrid
                    matches={scheduleMatches}
                    teamNames={teamNames}
                  />
                )
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t(
                  "Pick a sport and category above to see that competition's groups, knockout bracket and byes.",
                )}
              </p>
            </>
          )}

          {p.unscheduled.length ? (
            <section
              data-testid="unscheduled-summary"
              className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3"
            >
              <h3 className="text-sm font-semibold">
                {p.unscheduled.length} {t("match(es) have no time yet")}
              </h3>
              <p className="pt-0.5 text-xs text-muted-foreground">
                {t("Add another day or venue in Step 1, then preview again.")}
              </p>
              <div className="flex flex-col pt-2">
                {unscheduledByLeaf.map(([lbl, ms]) => (
                  <details key={lbl} className="group border-t border-warning/20 py-1.5">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
                      <ChevronDown
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                      />
                      <span className="min-w-0 flex-1 truncate">{lbl}</span>
                      <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                        {ms.length} {t("matches")}
                      </span>
                    </summary>
                    <ul className="pb-1 pl-6 pt-1">
                      {ms.map((m) => (
                        <li key={m.ref} className="text-sm text-muted-foreground">
                          {sideName(m.home, teamNames)} {t("vs")}{" "}
                          {sideName(m.away, teamNames)}
                          {m.group_label
                            ? ` · ${t("Group")} ${shortGroupName(m.group_label)}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          {/* Sticky decision bar — ONE primary (§4.4). */}
          <div className="sticky bottom-0 -mx-4 mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <Button
              variant="ghost"
              data-testid="discard-preview"
              disabled={busy}
              onClick={() => navigate(routes.tournamentFixtures(id))}
            >
              {t("Back without saving")}
            </Button>
            {isMobile ? (
              <Button
                variant="ghost"
                size="icon"
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
                data-testid="regenerate-preview"
                disabled={busy}
                onClick={rePreview}
              >
                <Dices aria-hidden="true" className="h-4 w-4" />
                {t("Try another draw")}
              </Button>
            )}
            <Button
              data-testid="accept-preview"
              disabled={busy || stale || p.matches.length === 0 || hardCount > 0}
              title={hardCount > 0 ? t("Fix the problems above first.") : undefined}
              onClick={() => accept.mutate(p)}
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              {accept.isPending
                ? t("Saving…")
                : isAll
                  ? t("Publish all competitions")
                  : t("Publish schedule")}
            </Button>
          </div>
        </>
      )}
    </BentoGrid>
  );
}
