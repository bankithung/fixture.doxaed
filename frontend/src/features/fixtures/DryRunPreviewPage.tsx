import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Dices,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
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
import { t } from "@/lib/t";
import { FairnessPanel } from "./FairnessPanel";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { MatchesByDayGrid } from "./MatchesByDayGrid";
import { sideName } from "./sideName";
import { ViolationsPanel } from "./ViolationsPanel";

/** Pairing-layer warning labels per stable code (§9 A5). */
const WARNING_LABELS: Record<string, string> = {
  keep_apart_relaxed:
    "A keep-apart rule could not be fully honoured and was relaxed for this draw.",
  keep_apart_missing_district:
    "Some teams have no district on record — they were excluded from the keep-apart rule.",
  keep_apart_missing_seed:
    "Some teams have no seed — they were excluded from the seed-pot keep-apart rule.",
  keep_apart_unknown_key: "A keep-apart rule uses an unknown key and was skipped.",
};

/** Build the slot-layer payload from the asked-once global calendar
 * (draw_config["*"].calendar). Preview AND Accept send the SAME payload so
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
 * Full-page dry-run preview (redesign §6 screen 5, §5.2): a PURE simulate of
 * generate + schedule for one competition — nothing persists until Accept.
 * Accept replays the previewed `seed` through the real generate + schedule
 * endpoints with `expected_inputs_hash`; a 409 `inputs_changed` renders the
 * InputsChangedBanner and the only way forward is a fresh preview (§9 A1).
 * Regenerate re-rolls; Discard walks away (nothing was saved).
 */
export function DryRunPreviewPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const leaf = params.get("leaf") ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  // Bumping the roll re-simulates (fresh seed for random draws — §5.2).
  const [roll, setRoll] = useState(0);
  const [stale, setStale] = useState(false);

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

  /** Accept = the real generate + schedule endpoints replaying the previewed
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
        title: t(`Draw accepted — ${r.scheduled} matches scheduled`),
        description: r.unscheduled.length
          ? `${r.unscheduled.length} ${t("unscheduled — see the fixtures hub")}`
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
        title: t("Could not accept the draw"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      });
    },
  });

  /** Relaxation routing: demoting a constraint to soft is a one-click PATCH
   * + re-preview; capacity fixes (days/venues/caps) live in the hub's
   * global-setup + constraint surfaces. */
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
      toast.push({ kind: "success", title: t("Constraint demoted to soft") });
      rePreview();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the constraint"),
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

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentFixtures(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to fixture setup")}
      </Link>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Dry-run preview")}
        </h1>
        <span className="text-sm text-muted-foreground">{label}</span>
        {p ? (
          <span className="ml-auto flex flex-wrap items-center gap-2 font-tabular text-xs text-muted-foreground">
            <span data-testid="preview-counts">
              {p.matches.length} {t("matches")}
              {p.fairness.days_used ? ` · ${p.fairness.days_used} ${t("days")}` : ""}
            </span>
            {p.seed != null ? (
              <span
                data-testid="preview-seed"
                title={t("Draw seed — stored on accept so the draw is replayable")}
                className="rounded-full bg-muted px-2 py-0.5"
              >
                {t("seed")} {p.seed}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">
        {t("Nothing is saved until you accept — regenerate or adjust constraints freely.")}
      </p>

      {stale ? (
        <InputsChangedBanner context="accept" onRePreview={rePreview} />
      ) : null}

      {calendarMissing ? (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <p className="text-sm font-medium">{t("Calendar not set")}</p>
          <p className="pt-1 text-sm text-muted-foreground">
            {t("Run the global setup first — the preview needs the tournament dates to build a schedule.")}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => navigate(routes.tournamentFixtures(id))}
          >
            {t("Open fixture setup")}
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
          <ViolationsPanel
            violations={p.violations}
            softScore={p.soft_score}
            onRelax={busy ? undefined : onRelax}
          />

          {/* Per-team fairness analytics (increment R) — rest/early/venue
              metrics with the server's outlier flags. */}
          <FairnessPanel
            teams={p.fairness.teams ?? []}
            flags={p.fairness.flags ?? []}
          />

          {(p.warnings as { code?: string }[]).filter((w) => w?.code).length ? (
            <ul className="flex flex-col gap-1">
              {(p.warnings as { code?: string }[]).map((w, i) =>
                w?.code ? (
                  <li key={i} className="text-xs text-warning-foreground">
                    {t(WARNING_LABELS[w.code] ?? w.code)}
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}

          <MatchesByDayGrid matches={p.matches} teamNames={teamNames} />

          {p.unscheduled.length ? (
            <section className="rounded-xl border border-warning/40 bg-warning-muted px-4 py-3">
              <h3 className="text-sm font-semibold">
                {p.unscheduled.length} {t("match(es) without a slot")}
              </h3>
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

          {/* Sticky decision bar (§6 screen 5). */}
          <div className="sticky bottom-0 -mx-4 mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <Button
              variant="ghost"
              data-testid="discard-preview"
              disabled={busy}
              onClick={() => navigate(routes.tournamentFixtures(id))}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              {t("Discard")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => navigate(routes.tournamentFixtures(id))}
            >
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              {t("Adjust constraints")}
            </Button>
            <Button
              variant="outline"
              data-testid="regenerate-preview"
              disabled={busy}
              onClick={rePreview}
            >
              <Dices aria-hidden="true" className="h-4 w-4" />
              {t("Regenerate")}
            </Button>
            <Button
              data-testid="accept-preview"
              disabled={busy || stale || p.matches.length === 0}
              onClick={() => accept.mutate(p)}
            >
              <Check aria-hidden="true" className="h-4 w-4" />
              {accept.isPending ? t("Saving…") : t("Accept & save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
