import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, Dices } from "lucide-react";
import {
  tournamentsApi,
  type ConstraintDraft,
  type DrawCalendar,
  type FixturePreview,
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
import { FairnessPanel } from "./FairnessPanel";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { MatchesByDayGrid } from "./MatchesByDayGrid";
import { SetupJourneyHeader } from "./SetupJourneyHeader";
import { sideName } from "./sideName";
import { ViolationsPanel } from "./ViolationsPanel";

/** Pairing-layer warning labels per stable code (§7.7). */
const WARNING_LABELS: Record<string, string> = {
  keep_apart_relaxed:
    "We could not fully keep those teams apart, so the rule was relaxed for this draw.",
  keep_apart_missing_district:
    "Some teams have no district saved, so the keep-apart rule skipped them.",
  keep_apart_missing_seed:
    "Some teams have no seed number, so the keep-apart rule skipped them.",
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { isMobile } = useBreakpoint();
  // Bumping the roll re-simulates (fresh seed for random draws — §5.2).
  const [roll, setRoll] = useState(0);
  const [stale, setStale] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const schedule = useMemo(
    () => schedulePayloadFrom(drawConfig.data?.draw_config["*"]?.calendar),
    [drawConfig.data],
  );

  // The simulate itself: a read-only POST (D6) — modelled as a query so the
  // result is stable while the page is open; gcTime 0 so a revisit re-runs.
  const preview = useQuery({
    queryKey: ["t-fixture-preview", id, leaf, roll],
    enabled: drawConfig.data !== undefined && schedule !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: () =>
      tournamentsApi.previewFixtures(id, {
        ...(leaf ? { leaf_key: leaf } : {}),
        schedule: schedule!,
        include_schedule: true,
      }),
  });

  const teamNames = useMemo(
    () => new Map((teams.data ?? []).map((tm) => [tm.id, tm.name])),
    [teams.data],
  );
  const label =
    readiness.data?.competitions.find((c) => c.leaf_key === leaf)?.label ??
    (leaf || t("All competitions"));

  const rePreview = (): void => {
    setStale(false);
    setRoll((r) => r + 1);
  };

  /** Publish = the real generate + schedule endpoints replaying the previewed
   * seed, both guarded by `expected_inputs_hash` (D6/D10). */
  const accept = useMutation({
    mutationFn: async (p: FixturePreview) => {
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
  const flagCount = p?.fairness.flags?.length ?? 0;
  const warnings = ((p?.warnings ?? []) as { code?: string }[]).filter(
    (w) => w?.code,
  );
  // Problems are never hidden — flags or hard violations force the details open.
  const forceAdvanced = hardCount > 0 || flagCount > 0;
  const advancedShown = advancedOpen || forceAdvanced;

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentFixtures(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to fixture setup")}
      </Link>

      <SetupJourneyHeader
        step={3}
        compact
        onStepClick={() => navigate(routes.tournamentFixtures(id))}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Step 3 · Preview & publish")}
        </h1>
        <span className="text-sm text-muted-foreground">{label}</span>
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
      <p className="-mt-2 text-sm text-muted-foreground">
        {t("This is a trial run. Nothing is saved until you publish.")}
      </p>

      {stale ? (
        <InputsChangedBanner context="accept" onRePreview={rePreview} />
      ) : null}

      {calendarMissing ? (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
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
            className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
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
                      <li key={i} className="text-xs text-warning-foreground">
                        {t(WARNING_LABELS[w.code!] ?? w.code!)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 font-tabular text-xs text-muted-foreground">
                  {p.seed != null ? (
                    <span
                      data-testid="preview-seed"
                      title={t("Saved when you publish, so this exact draw can be reproduced.")}
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

          <MatchesByDayGrid matches={p.matches} teamNames={teamNames} />

          {p.unscheduled.length ? (
            <section className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3">
              <h3 className="text-sm font-semibold">
                {p.unscheduled.length} {t("match(es) have no time yet")}
              </h3>
              <p className="pt-0.5 text-xs text-muted-foreground">
                {t("Add another day or venue in Step 1, then preview again.")}
              </p>
              <ul className="pt-1">
                {p.matches
                  .filter((m) => p.unscheduled.includes(m.ref))
                  .map((m) => (
                    <li key={m.ref} className="text-sm text-muted-foreground">
                      <span className="font-tabular text-xs">{m.ref}</span>{" "}
                      {sideName(m.home, teamNames)} {t("vs")}{" "}
                      {sideName(m.away, teamNames)}
                      {m.group_label ? ` · ${m.group_label}` : ""}
                    </li>
                  ))}
              </ul>
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
              {accept.isPending ? t("Saving…") : t("Publish schedule")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
