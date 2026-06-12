import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Save } from "lucide-react";
import {
  tournamentsApi,
  type ConstraintDraft,
  type ConstraintRecord,
  type ConstraintType,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { ConstraintRow } from "./ConstraintRow";

/** Records the GlobalSetupWizard owns at scope:"all" — they appear here with
 * a provenance badge (the seeded Nagaland defaults among them). */
const GLOBAL_SETUP_TYPES = new Set([
  "blackout_dates",
  "reserve_days",
  "recurring_blackout_window",
  "ceremony_block",
  "min_rest_minutes",
  "max_matches_per_team_per_day",
]);

/** Sensible starting values for int params when a record is added. */
const INT_DEFAULTS: Record<string, number> = {
  minutes: 30,
  count: 1,
  until_round: 2,
  min_gap_minutes: 30,
  cross_venue_gap_minutes: 60,
};

function defaultRecord(spec: ConstraintType): ConstraintRecord {
  const params: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(spec.params_schema)) {
    if (kind === "int") params[key] = INT_DEFAULTS[key] ?? 1;
    else if (kind === "time") params[key] = key === "to" ? "17:00" : "09:00";
    else if (kind === "list") params[key] = [];
    else params[key] = "";
  }
  return { type: spec.type, scope: "all", hard: spec.hard, weight: 5, params };
}

/** `days: []` means "no days" to nobody — the catalog defines null = every
 * day (D4), so an empty picker normalizes to null at save time. */
function normalized(r: ConstraintRecord): ConstraintDraft {
  return Array.isArray(r.params.days) && r.params.days.length === 0
    ? { ...r, params: { ...r.params, days: null } }
    : r;
}

/**
 * Inline constraint builder (redesign §6 screen 4 — a hub section, not a
 * dialog). Typed rows are driven by the constraint-types catalog
 * (`params_schema` renders the fields); each record carries scope
 * (all/sport/competition/team), Hard/Soft and a 1-10 weight when soft.
 * Saving goes through the settings PATCH (amend-on-409, like the global
 * wizard); "Mark reviewed" stamps `draw_config["*"].constraints_reviewed_at`
 * for the readiness check (§9 A10 — the server clears staleness itself).
 */
export function ConstraintBuilder({
  tournamentId,
  competitions,
  teams,
}: {
  tournamentId: string;
  /** Configured competitions (leaf scopes). */
  competitions: { leafKey: string; label: string }[];
  /** Registered teams (team scopes + `team_id` params). */
  teams: { id: string; name: string }[];
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<{
    base: ConstraintRecord[];
    rows: ConstraintRecord[];
  } | null>(null);

  const settings = useQuery({
    queryKey: qk.settings(tournamentId),
    queryFn: () => tournamentsApi.settings(tournamentId),
  });
  const catalog = useQuery({
    queryKey: ["constraint-types"],
    queryFn: () => tournamentsApi.constraintTypes(),
  });
  const sports = useQuery({
    queryKey: ["tournament-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
  });
  const drawConfig = useQuery({
    queryKey: qk.drawConfig(tournamentId),
    queryFn: () => tournamentsApi.drawConfig(tournamentId),
  });

  // Seed/refresh from the server while the user has no unsaved edits
  // (guarded render-phase adjustment — rows === base means pristine).
  if (
    settings.data &&
    (state === null ||
      (state.base !== settings.data.constraints && state.rows === state.base))
  ) {
    setState({ base: settings.data.constraints, rows: settings.data.constraints });
  }

  const rows = state?.rows ?? [];
  const dirty = state !== null && state.rows !== state.base;
  const setRows = (next: ConstraintRecord[]): void =>
    setState((s) => (s ? { ...s, rows: next } : s));

  const byType = new Map((catalog.data ?? []).map((c) => [c.type, c]));

  const scopeOptionsFor = (spec: ConstraintType): SelectOption[] => {
    const out: SelectOption[] = [];
    if (spec.scopes.includes("all")) {
      out.push({ value: "all", label: t("Whole tournament") });
    }
    if (spec.scopes.includes("sport")) {
      for (const s of sports.data?.sports ?? []) {
        out.push({ value: `sport:${s.key}`, label: `${t("Sport")} · ${s.name}` });
      }
    }
    if (spec.scopes.includes("leaf")) {
      for (const c of competitions) {
        if (c.leafKey) out.push({ value: `leaf:${c.leafKey}`, label: c.label });
      }
    }
    if (spec.scopes.includes("team")) {
      for (const tm of teams) {
        out.push({ value: `team:${tm.id}`, label: `${t("Team")} · ${tm.name}` });
      }
    }
    return out;
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        constraints: rows.map(normalized),
        event_id: newEventId(),
      };
      try {
        await tournamentsApi.updateSettings(tournamentId, body);
      } catch (e) {
        // Constraints share the rules-freeze gate (invariant 7); scheduling
        // constraints are organizer process data, so amend with a reason.
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.payload.detail === "rules_frozen"
        ) {
          await tournamentsApi.updateSettings(tournamentId, {
            ...body,
            amend: true,
            reason: t("Fixture constraint builder: scheduling constraints updated"),
          });
        } else {
          throw e;
        }
      }
    },
    onSuccess: () => {
      // Reset to pristine so the server's normalized records reseed the rows.
      setState((s) => (s ? { base: s.rows, rows: s.rows } : s));
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Rules saved") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not save the rules"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const markReviewed = useMutation({
    mutationFn: () =>
      tournamentsApi.updateDrawConfig(tournamentId, {
        leaf_key: "*",
        config: { constraints_reviewed_at: new Date().toISOString() },
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({ kind: "success", title: t("Rules marked as checked") });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not mark the rules as checked") }),
  });

  const reviewedAt = drawConfig.data?.draw_config["*"]?.constraints_reviewed_at;
  const loading = settings.isLoading || catalog.isLoading;

  return (
    <section
      id="constraint-builder"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Scheduling rules")}</h3>
          <p className="text-xs text-muted-foreground">
            {t('Rules the schedule must follow. "Must" rules block a time slot; "prefer" rules guide it.')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {reviewedAt ? (
            <span className="text-xs text-muted-foreground">
              {t("Checked")}{" "}
              <span className="font-tabular">
                {new Date(reviewedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={markReviewed.isPending || dirty}
            data-testid="mark-reviewed"
            onClick={() => markReviewed.mutate()}
          >
            <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Mark rules as checked")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3" aria-busy={loading}>
        {loading ? (
          <div className="h-16 animate-pulse rounded-lg bg-muted/40" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No extra rules yet. Step 1 already added the common ones (days off, rest time, Sunday mornings). Add anything sharper here.")}
          </p>
        ) : (
          rows.map((record, i) => {
            const spec = byType.get(record.type);
            if (!spec) return null;
            return (
              <ConstraintRow
                key={`${record.type}-${i}`}
                index={i}
                record={record}
                spec={spec}
                scopeOptions={scopeOptionsFor(spec)}
                teams={teams}
                badge={
                  GLOBAL_SETUP_TYPES.has(record.type) &&
                  (!record.scope || record.scope === "all")
                    ? t("From Step 1")
                    : undefined
                }
                onChange={(next) =>
                  setRows(rows.map((r, j) => (j === i ? next : r)))
                }
                onRemove={() => setRows(rows.filter((_, j) => j !== i))}
              />
            );
          })
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("Add a rule")}
            placeholder={t("Add a rule…")}
            value=""
            onChange={(type) => {
              const spec = byType.get(type);
              if (spec) setRows([...rows, defaultRecord(spec)]);
            }}
            options={(catalog.data ?? []).map((c) => ({
              value: c.type,
              label: t(c.label),
            }))}
            size="sm"
            className="w-72"
          />
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            data-testid="save-constraints"
            onClick={() => save.mutate()}
            className="ml-auto"
          >
            <Save aria-hidden="true" className="h-3.5 w-3.5" />
            {save.isPending ? t("Saving…") : t("Save rules")}
          </Button>
        </div>
      </div>
    </section>
  );
}
