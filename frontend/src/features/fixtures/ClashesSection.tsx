import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Save, Trash2 } from "lucide-react";
import { tournamentsApi, type ConstraintRecord } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AskAiButton } from "@/features/assistant/AskAiButton";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const CLASH = "no_concurrent_competitions";
const SESSION = "category_session_window";
const CAP = "official_capacity";

interface Comp {
  leafKey: string;
  label: string;
  sport: string;
}

const asMembers = (r: ConstraintRecord): string[] =>
  Array.isArray(r.params.members) ? (r.params.members as string[]) : [];

/** Title-case a sport key as a last-resort label ("table_tennis" → "Table
 * Tennis") when the sports query hasn't resolved a friendly name. */
const prettySport = (key: string): string =>
  key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/**
 * "Clashes & sessions" — the competition-centric scheduling surface (owner ask
 * 2026-06-18). Friendly editors over the SAME stored `constraints` list the
 * advanced builder writes (other constraint types are preserved verbatim):
 *
 *  • Clash rules (`no_concurrent_competitions`): pick the competitions that may
 *    never run at the same moment — even on separate courts — with an optional
 *    transition gap. Members can be a whole sport ("All Football") or a single
 *    category leaf; the scheduler keeps them apart but auto-orders them.
 *  • Session windows (`category_session_window`, leaf-scoped, hard): give a
 *    single competition its own daily time window.
 *  • Concurrent-match caps (`official_capacity`): how many matches may run at
 *    once, tournament-wide or per sport ("only 2 TT umpires").
 *
 * Saving goes through the settings PATCH with the rules-freeze amend-on-409
 * fallback, exactly like the global wizard and the advanced builder.
 */
export function ClashesSection({
  tournamentId,
  competitions,
}: {
  tournamentId: string;
  competitions: Comp[];
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<{
    base: ConstraintRecord[];
    rows: ConstraintRecord[];
  } | null>(null);
  // Which clash rule is expanded for editing (absolute row index); others show
  // a compact one-line summary so many rules don't stack into a wall.
  const [editingClash, setEditingClash] = useState<number | null>(null);

  const settings = useQuery({
    queryKey: qk.settings(tournamentId),
    queryFn: () => tournamentsApi.settings(tournamentId),
  });
  const sportsQ = useQuery({
    queryKey: ["tournament-sports", tournamentId],
    queryFn: () => tournamentsApi.sports(tournamentId),
  });

  // Seed/refresh from the server while the user has no unsaved edits.
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

  const sportName = (key: string): string =>
    sportsQ.data?.sports.find((s) => s.key === key)?.name ?? prettySport(key);

  // Competitions grouped by sport (stable first-seen order) — drives both the
  // clash picker's "All {Sport}" chips and the per-sport capacity rows.
  const sportsInOrder: string[] = [];
  const leavesBySport = new Map<string, Comp[]>();
  for (const c of competitions) {
    if (!leavesBySport.has(c.sport)) {
      leavesBySport.set(c.sport, []);
      sportsInOrder.push(c.sport);
    }
    leavesBySport.get(c.sport)!.push(c);
  }

  // Selectable clash members: a whole-sport chip (value = sport key) when the
  // sport has more than one category, plus a chip per leaf (value = leaf key).
  const memberChips: { value: string; label: string }[] = [];
  for (const sp of sportsInOrder) {
    const leaves = leavesBySport.get(sp)!;
    if (leaves.length > 1) {
      memberChips.push({ value: sp, label: `${t("All")} ${sportName(sp)}` });
    }
    for (const c of leaves) memberChips.push({ value: c.leafKey, label: c.label });
  }
  const labelOf = (value: string): string =>
    memberChips.find((c) => c.value === value)?.label ?? value;

  // ---- row helpers (operate on the full list, preserving other types) ----
  const patchParams = (idx: number, params: Record<string, unknown>): void =>
    setRows(
      rows.map((r, j) =>
        j === idx ? { ...r, params: { ...r.params, ...params } } : r,
      ),
    );
  const removeAt = (idx: number): void =>
    setRows(rows.filter((_, j) => j !== idx));

  // ---- clash rules ----
  const clashes = rows
    .map((r, idx) => ({ r, idx }))
    .filter((x) => x.r.type === CLASH);

  const addClash = (): void => {
    setEditingClash(rows.length); // open the new rule expanded
    setRows([
      ...rows,
      {
        type: CLASH,
        scope: "all",
        hard: true,
        weight: 5,
        // For a two-competition tournament, pre-select both — that's the whole
        // point of the rule and saves a click.
        params: {
          members: competitions.length === 2 ? competitions.map((c) => c.leafKey) : [],
          gap_minutes: 0,
        },
      },
    ]);
  };

  const toggleMember = (idx: number, value: string): void => {
    const cur = asMembers(rows[idx]);
    patchParams(idx, {
      members: cur.includes(value)
        ? cur.filter((m) => m !== value)
        : [...cur, value],
    });
  };

  // ---- session windows (one per competition leaf) ----
  const sessionIdx = (leafKey: string): number =>
    rows.findIndex((r) => r.type === SESSION && r.scope === `leaf:${leafKey}`);

  const toggleSession = (leafKey: string): void => {
    const idx = sessionIdx(leafKey);
    if (idx >= 0) removeAt(idx);
    else
      setRows([
        ...rows,
        {
          type: SESSION,
          scope: `leaf:${leafKey}`,
          hard: true,
          weight: 5,
          params: { days: null, from: "09:00", to: "12:00" },
        },
      ]);
  };

  // ---- concurrent-match caps (official_capacity; scope "all" or sport:key) ----
  const capIdx = (scope: string): number =>
    rows.findIndex((r) => r.type === CAP && r.scope === scope);

  const toggleCap = (scope: string): void => {
    const idx = capIdx(scope);
    if (idx >= 0) removeAt(idx);
    else
      setRows([
        ...rows,
        { type: CAP, scope, hard: true, weight: 5, params: { count: 1 } },
      ]);
  };

  const save = useMutation({
    mutationFn: async () => {
      // Drop half-built clash rules (< 2 competitions can't clash with anything).
      const constraints = rows.filter(
        (r) => r.type !== CLASH || asMembers(r).length >= 2,
      );
      const body = { constraints, event_id: newEventId() };
      try {
        await tournamentsApi.updateSettings(tournamentId, body);
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.payload.detail === "rules_frozen"
        ) {
          await tournamentsApi.updateSettings(tournamentId, {
            ...body,
            amend: true,
            reason: t("Clashes & sessions: scheduling rules updated"),
          });
        } else {
          throw e;
        }
      }
    },
    onSuccess: () => {
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

  if (settings.isLoading) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      </section>
    );
  }

  const tooFew = competitions.length < 2;

  return (
    <section
      id="clash-builder"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Clashes & sessions")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Keep competitions from running at the same time, or give one its own time of day. The schedule is built around these.",
            )}
          </p>
        </div>
        <AskAiButton
          className="mt-0.5"
          focus={{
            label: t("Clashes & sessions"),
            hint: "the 'Clashes & sessions' section: clash rules that stop competitions running at the same time, per-competition session windows (pin to a time of day), and concurrency caps (how many matches run at once)",
          }}
        />
      </div>

      <div className="flex flex-col gap-5 px-4 py-4">
        {tooFew ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Add a second competition to this tournament to set up clashes between them.",
            )}
          </p>
        ) : (
          <>
            {/* ---------------------------------------------- clash rules */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/10 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Can't run at the same time")}
              </h4>
              {clashes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "No clash rules yet. Add one to stop two competitions overlapping (shared players, courts, or officials).",
                  )}
                </p>
              ) : (
                clashes.map(({ r, idx }, n) => {
                  const members = asMembers(r);
                  const gap = Number(r.params.gap_minutes) || 0;
                  const removeBtn = (
                    <button
                      type="button"
                      data-testid={`clash-${n}-remove`}
                      aria-label={t("Remove this clash rule")}
                      className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (editingClash === idx) setEditingClash(null);
                        removeAt(idx);
                      }}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                  );

                  // Collapsed summary — a complete rule the user isn't editing.
                  if (editingClash !== idx && members.length >= 2) {
                    return (
                      <div
                        key={idx}
                        data-testid={`clash-${n}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2"
                      >
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                          <span className="shrink-0 text-xs font-medium text-muted-foreground">
                            {t("Never together:")}
                          </span>
                          {members.map((m) => (
                            <span
                              key={m}
                              className="rounded-full border border-border bg-card px-2 py-0.5 text-xs"
                            >
                              {labelOf(m)}
                            </span>
                          ))}
                          {gap > 0 ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              · {gap} {t("min gap")}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            data-testid={`clash-${n}-edit`}
                            className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
                            onClick={() => setEditingClash(idx)}
                          >
                            {t("Edit")}
                          </button>
                          {removeBtn}
                        </div>
                      </div>
                    );
                  }

                  // Expanded editor — the competition picker + gap.
                  return (
                    <div
                      key={idx}
                      data-testid={`clash-${n}`}
                      className="rounded-lg border border-primary/40 bg-muted/20 p-3"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {t("Tap the competitions that can't run at the same time")}
                        </span>
                        {removeBtn}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {memberChips.map((c) => {
                          const on = members.includes(c.value);
                          return (
                            <button
                              key={c.value}
                              type="button"
                              aria-pressed={on}
                              data-testid={`clash-${n}-member-${c.value}`}
                              onClick={() => toggleMember(idx, c.value)}
                              className={cn(
                                "rounded-full border px-3 py-1 text-sm transition-colors",
                                on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border bg-card text-foreground hover:bg-muted",
                              )}
                            >
                              {c.label}
                            </button>
                          );
                        })}
                      </div>
                      {members.length < 2 ? (
                        <p className="mt-2 text-xs text-destructive">
                          {t("Pick at least two competitions.")}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          {t("Gap between them")}
                          <Input
                            type="number"
                            min={0}
                            step={5}
                            data-testid={`clash-${n}-gap`}
                            className="h-8 w-20 font-tabular"
                            value={gap}
                            onChange={(e) =>
                              patchParams(idx, {
                                gap_minutes: Math.max(0, Number(e.target.value) || 0),
                              })
                            }
                          />
                          {t("minutes")}
                        </label>
                        {members.length >= 2 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`clash-${n}-done`}
                            onClick={() => setEditingClash(null)}
                          >
                            {t("Done")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="add-clash-rule"
                  onClick={addClash}
                >
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Add a clash rule")}
                </Button>
              </div>
            </div>

            {/* ------------------------------------------- session windows */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/10 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Each competition's own time of day")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Optional. Pin a competition to a daily window (e.g. U-14 in the mornings).",
                )}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
              {competitions.map((c) => {
                const idx = sessionIdx(c.leafKey);
                const on = idx >= 0;
                const rec = on ? rows[idx] : null;
                return (
                  <div
                    key={c.leafKey}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <label className="flex flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        data-testid={`session-${c.leafKey}-toggle`}
                        onChange={() => toggleSession(c.leafKey)}
                        className="h-4 w-4 rounded border-border accent-[var(--primary)]"
                      />
                      <span className="flex items-center gap-1.5">
                        <CalendarClock
                          aria-hidden="true"
                          className="h-3.5 w-3.5 text-muted-foreground"
                        />
                        {c.label}
                      </span>
                    </label>
                    {on && rec ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("from")}
                        <Input
                          type="time"
                          data-testid={`session-${c.leafKey}-from`}
                          className="h-8 w-28 font-tabular"
                          value={String(rec.params.from ?? "09:00")}
                          onChange={(e) =>
                            patchParams(idx, { from: e.target.value })
                          }
                        />
                        {t("to")}
                        <Input
                          type="time"
                          data-testid={`session-${c.leafKey}-to`}
                          className="h-8 w-28 font-tabular"
                          value={String(rec.params.to ?? "12:00")}
                          onChange={(e) =>
                            patchParams(idx, { to: e.target.value })
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              </div>
            </div>

            {/* --------------------------------------- concurrent-match caps */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/10 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Matches running at once")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Optional. Cap how many matches play at the same time — tournament-wide, or per sport (e.g. only 2 umpires).",
                )}
              </p>
              {[
                { scope: "all", label: t("Whole tournament") },
                ...sportsInOrder.map((sp) => ({
                  scope: `sport:${sp}`,
                  label: sportName(sp),
                })),
              ].map(({ scope, label }) => {
                const idx = capIdx(scope);
                const on = idx >= 0;
                const count = on ? Number(rows[idx].params.count) || 1 : 1;
                return (
                  <div
                    key={scope}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <label className="flex flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        data-testid={`cap-${scope}-toggle`}
                        onChange={() => toggleCap(scope)}
                        className="h-4 w-4 rounded border-border accent-[var(--primary)]"
                      />
                      {label}
                    </label>
                    {on ? (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("at most")}
                        <Input
                          type="number"
                          min={1}
                          data-testid={`cap-${scope}-count`}
                          className="h-8 w-20 font-tabular"
                          value={count}
                          onChange={(e) =>
                            patchParams(idx, {
                              count: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                        />
                        {t("at a time")}
                      </label>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-end border-t border-border pt-3">
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                data-testid="save-clashes"
                onClick={() => save.mutate()}
              >
                <Save aria-hidden="true" className="h-3.5 w-3.5" />
                {save.isPending ? t("Saving…") : t("Save rules")}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
