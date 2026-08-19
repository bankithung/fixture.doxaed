import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, CheckCheck, Save } from "lucide-react";
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
import { humanizeLeaf } from "@/features/controlroom/format";
import { ConstraintRow } from "./ConstraintRow";
import { groupRules } from "./ruleGroups";

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
  rounds_from_end: 1,
  min_gap_minutes: 30,
  cross_venue_gap_minutes: 60,
};

function defaultRecord(spec: ConstraintType): ConstraintRecord {
  const params: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(spec.params_schema)) {
    if (kind === "int") params[key] = INT_DEFAULTS[key] ?? 1;
    else if (kind === "time") params[key] = key === "to" ? "17:00" : "09:00";
    else if (kind === "list" || kind === "order") params[key] = [];
    else if (kind === "bool") params[key] = false;
    // A closing-round window with no day set does nothing, and the day a host
    // means is almost always the last one — so start there rather than at a
    // blank box that reads as a broken rule.
    else if (kind === "date_or_last_day") params[key] = "last_day";
    else if (spec.param_options?.[key]?.length) {
      params[key] = spec.param_options[key]![0]!;
    } else params[key] = "";
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
  // The courts, so a show court is picked from what exists rather than typed.
  const venues = useQuery({
    queryKey: qk.venues(tournamentId),
    queryFn: () => tournamentsApi.venues(tournamentId),
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

  // What a priority order can rank: whole sports first (the broad stroke),
  // then every configured competition. Values are the keys the engine matches
  // segment-aligned, so a sport entry covers all its categories.
  // A word that appears in more than one competition's path ("girls", "u_14")
  // ranks all of them at once (owner 2026-08-19: "first girls will play then
  // the boys"). Derived from the tree, so nothing here knows what a gender is
  // — a tournament that files its categories some other way gets ITS words.
  const segmentOptions: SelectOption[] = (() => {
    const seen = new Map<string, number>();
    for (const c of competitions) {
      if (!c.leafKey) continue;
      for (const seg of new Set(c.leafKey.split(".").slice(1))) {
        seen.set(seg, (seen.get(seg) ?? 0) + 1);
      }
    }
    return [...seen.entries()]
      .filter(([, n]) => n > 1)
      .map(([seg]) => ({
        value: seg,
        label: `${t("Every")} ${humanizeLeaf(seg)}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  })();

  // Every playing surface, named exactly as the scheduler names it
  // ("Hall · T2"), so a show court can be PICKED rather than typed.
  const courtOptions: SelectOption[] = (venues.data?.venues ?? []).flatMap((v) =>
    (v.courts ?? []).length
      ? (v.courts ?? []).map((c) => ({ value: c.name, label: c.name }))
      : [{ value: v.name, label: v.name }],
  );

  const orderOptions: SelectOption[] = [
    ...(sports.data?.sports ?? []).map((s) => ({
      value: s.key,
      label: `${t("All of")} ${s.name}`,
    })),
    ...segmentOptions,
    ...competitions
      .filter((c) => c.leafKey)
      .map((c) => ({ value: c.leafKey, label: c.label })),
  ];

  const grouped = groupRules(rows, catalog.data ?? []);

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
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Scheduling rules")}</h3>
          <p className="text-xs text-muted-foreground">
            {t('Rules the schedule follows. "Must" blocks a slot; "Prefer" guides it.')}
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
        ) : (
          /* Grouped by the QUESTION each rule answers (owner 2026-08-17), so a
             rule is found by knowing what you want, not by knowing its name.
             Every group is always shown — an empty one is how you discover the
             rule you did not know existed. */
          grouped.map(({ group, rows: idxs, addable }) => (
            <section
              key={group.key}
              data-testid={`rule-group-${group.key}`}
              className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3"
            >
              <div className="min-w-0">
                <h4 className="text-xs font-semibold uppercase tracking-wide">
                  {t(group.title)}
                </h4>
                <p className="text-xs text-muted-foreground">{t(group.blurb)}</p>
              </div>

              {idxs.map((i) => {
                const record = rows[i]!;
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
                    orderOptions={orderOptions}
                    courtOptions={courtOptions}
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
              })}

              {idxs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(group.emptyHint ?? "Nothing set here yet.")}
                </p>
              ) : null}

              {/* The rule this group exists for gets a NAMED button while it
                  is unset. Hiding it inside "Add a rule…" is what made the
                  ordering control unfindable twice over. */}
              {group.primary &&
              byType.has(group.primary) &&
              !rows.some((r) => r.type === group.primary) ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`add-primary-${group.key}`}
                  className="w-fit"
                  onClick={() => {
                    const spec = byType.get(group.primary!);
                    if (spec) setRows([...rows, defaultRecord(spec)]);
                  }}
                >
                  <ArrowUpDown aria-hidden="true" className="h-3.5 w-3.5" />
                  {t(group.primaryLabel ?? "Set this up")}
                </Button>
              ) : null}

              {addable.length ? (
                <Select
                  aria-label={`${t("Add a rule to")} ${t(group.title)}`}
                  placeholder={t("Add a rule…")}
                  value=""
                  onChange={(type) => {
                    const spec = byType.get(type);
                    if (spec) setRows([...rows, defaultRecord(spec)]);
                  }}
                  options={addable.map((c) => ({
                    value: c.type,
                    label: t(c.label),
                  }))}
                  size="sm"
                  className="w-full max-w-sm"
                />
              ) : null}
            </section>
          ))
        )}

        <div className="flex flex-wrap items-center gap-2">
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
