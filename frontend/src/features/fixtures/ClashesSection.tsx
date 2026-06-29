import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Check,
  Clock,
  Gauge,
  Info,
  Pencil,
  Plus,
  Save,
  Split,
  Trash2,
} from "lucide-react";
import { tournamentsApi, type ConstraintRecord } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AskAiButton } from "@/features/assistant/AskAiButton";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
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

/** The competition label with its leading sport segment removed, so leaf rows
 * shown UNDER a sport group don't repeat the sport ("Table Tennis — u-14 —
 * boys — 1v1" → "u-14 — boys — 1v1"). Falls back to the full label when there's
 * nothing after the sport. */
const subLabel = (label: string): string => {
  const segs = label.split(" — ");
  return segs.length > 1 ? segs.slice(1).join(" — ") : label;
};

/** A slim Supabase-style settings card: header (icon + title + description +
 * optional count) over a divided body. Keeps each concern visually distinct. */
function RuleCard({
  icon,
  title,
  description,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-start gap-2.5 border-b border-border px-4 py-3">
        <span className="mt-0.5 shrink-0 text-primary">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {count != null && count > 0 ? (
              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold text-primary">
                {count}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A muted inline hint row (empty states / tips). */
function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span>{children}</span>
    </div>
  );
}

/**
 * "Clashes & sessions" — the competition-centric scheduling surface (owner ask
 * 2026-06-18, restructured 2026-06-29 for clarity). Friendly editors over the
 * SAME stored `constraints` list the advanced builder writes (other constraint
 * types are preserved verbatim):
 *
 *  • Clash rules (`no_concurrent_competitions`): pick the competitions that may
 *    never run at the same moment — even on separate courts — with an optional
 *    transition gap. Members can be a whole sport ("All Football") or a single
 *    category leaf; the picker groups competitions BY SPORT so selection reads
 *    logically instead of a flat wall of chips.
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
  // "Real changes" only: compare the EFFECTIVE payload (half-built clash rules
  // with < 2 members are dropped on save) against the saved baseline by value.
  // So adding an empty rule, or toggling something and back, leaves Save
  // disabled. Unchanged rows keep their identity + order, so a JSON compare of
  // the arrays is exact here (no key-order drift).
  const effectiveRows =
    state === null
      ? []
      : rows.filter((r) => r.type !== CLASH || asMembers(r).length >= 2);
  const dirty =
    state !== null &&
    JSON.stringify(effectiveRows) !== JSON.stringify(state.base);
  const setRows = (next: ConstraintRecord[]): void =>
    setState((s) => (s ? { ...s, rows: next } : s));

  const sportName = (key: string): string =>
    sportsQ.data?.sports.find((s) => s.key === key)?.name ?? prettySport(key);

  // Competitions grouped by sport (stable first-seen order) — drives the clash
  // picker groups, the session list, and the per-sport capacity rows.
  const sportsInOrder: string[] = [];
  const leavesBySport = new Map<string, Comp[]>();
  for (const c of competitions) {
    if (!leavesBySport.has(c.sport)) {
      leavesBySport.set(c.sport, []);
      sportsInOrder.push(c.sport);
    }
    leavesBySport.get(c.sport)!.push(c);
  }

  // Label for a saved member value (sport key → "All {Sport}", else the leaf).
  const labelOf = (value: string): string => {
    for (const sp of sportsInOrder) {
      if (value === sp) return `${t("All")} ${sportName(sp)}`;
      const leaf = leavesBySport.get(sp)!.find((c) => c.leafKey === value);
      if (leaf) return leaf.label;
    }
    return value;
  };

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
  const sessionCount = rows.filter((r) => r.type === SESSION).length;

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
  const capCount = rows.filter((r) => r.type === CAP).length;

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
      <section className="w-full rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      </section>
    );
  }

  const tooFew = competitions.length < 2;

  return (
    <section
      id="clash-builder"
      className="w-full rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6"
    >
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 text-primary">
            <CalendarClock aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">
              {t("Clashes & sessions")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(
                "Stop competitions overlapping, or pin one to a time of day. The schedule follows these.",
              )}
            </p>
          </div>
        </div>
        <AskAiButton
          className="shrink-0"
          focus={{
            label: t("Clashes & sessions"),
            hint: "the 'Clashes & sessions' section: clash rules that stop competitions running at the same time, per-competition session windows (pin to a time of day), and concurrency caps (how many matches run at once)",
          }}
        />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        {tooFew ? (
          <Hint>
            {t("Add a second competition to set up clashes.")}
          </Hint>
        ) : (
          <>
            {/* ------------------------------------------------ clash rules */}
            <RuleCard
              icon={<Split aria-hidden="true" className="h-4 w-4" />}
              title={t("Can't run at the same time")}
              description={t(
                "Competitions sharing players, courts, or officials never run together.",
              )}
              count={clashes.length}
            >
              <div className="flex flex-col gap-3">
                {clashes.length === 0 ? (
                  <Hint>
                    {t("No clash rules yet. Add one below.")}
                  </Hint>
                ) : (
                  clashes.map(({ r, idx }, n) => {
                    const members = asMembers(r);
                    const gap = Number(r.params.gap_minutes) || 0;
                    const removeBtn = (
                      <button
                        type="button"
                        data-testid={`clash-${n}-remove`}
                        aria-label={t("Remove this clash rule")}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
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
                          className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
                        >
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                            <span className="shrink-0 text-xs font-medium text-muted-foreground">
                              {t("Never together:")}
                            </span>
                            {members.map((m) => (
                              <LeafLabel key={m} label={labelOf(m)} />
                            ))}
                            {gap > 0 ? (
                              <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                                · {gap} {t("min gap")}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              data-testid={`clash-${n}-edit`}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent"
                              onClick={() => setEditingClash(idx)}
                            >
                              <Pencil aria-hidden="true" className="h-3 w-3" />
                              {t("Edit")}
                            </button>
                            {removeBtn}
                          </div>
                        </div>
                      );
                    }

                    // Expanded editor — competitions grouped by sport + gap.
                    return (
                      <div
                        key={idx}
                        data-testid={`clash-${n}`}
                        className="rounded-lg border border-primary/40 bg-primary/5 p-3"
                      >
                        <div className="mb-2.5 flex items-start justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t("Pick the competitions that can't run at the same time")}
                          </span>
                          {removeBtn}
                        </div>

                        <div className="flex flex-col gap-2.5">
                          {sportsInOrder.map((sp) => {
                            const leaves = leavesBySport.get(sp)!;
                            const multi = leaves.length > 1;
                            const allOn = members.includes(sp);
                            return (
                              <div
                                key={sp}
                                className="overflow-hidden rounded-md border border-border bg-card"
                              >
                                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    {sportName(sp)}
                                  </span>
                                  {multi ? (
                                    <button
                                      type="button"
                                      aria-pressed={allOn}
                                      data-testid={`clash-${n}-member-${sp}`}
                                      onClick={() => toggleMember(idx, sp)}
                                      className={cn(
                                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
                                        allOn
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-border bg-card text-foreground hover:bg-muted",
                                      )}
                                    >
                                      {allOn ? (
                                        <Check aria-hidden="true" className="h-3 w-3" />
                                      ) : null}
                                      {t("All")} {sportName(sp)}
                                    </button>
                                  ) : null}
                                </div>
                                <div
                                  className={cn(
                                    "flex flex-col divide-y divide-border",
                                    allOn && "opacity-50",
                                  )}
                                >
                                  {leaves.map((c) => {
                                    const on = members.includes(c.leafKey);
                                    return (
                                      <button
                                        key={c.leafKey}
                                        type="button"
                                        aria-pressed={on}
                                        data-testid={`clash-${n}-member-${c.leafKey}`}
                                        onClick={() => toggleMember(idx, c.leafKey)}
                                        className="flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                                      >
                                        <span
                                          aria-hidden="true"
                                          className={cn(
                                            "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                                            on
                                              ? "border-primary bg-primary text-primary-foreground"
                                              : "border-input",
                                          )}
                                        >
                                          {on ? <Check className="h-3 w-3" /> : null}
                                        </span>
                                        <LeafLabel label={subLabel(c.label)} />
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {members.length >= 2 ? (
                          <div className="mt-3 rounded-md border border-border bg-card p-2.5">
                            <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                              {t("Never at the same time")}
                            </span>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {members.map((m) => (
                                <span
                                  key={m}
                                  className="inline-flex rounded-md border border-border bg-muted/40 px-1.5 py-1"
                                >
                                  <LeafLabel label={labelOf(m)} />
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-3 text-xs text-destructive">
                            {t("Pick at least two competitions.")}
                          </p>
                        )}

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            {t("Gap between them")}
                            <Input
                              type="number"
                              min={0}
                              step={5}
                              data-testid={`clash-${n}-gap`}
                              className="h-9 w-20 font-tabular"
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
                              <Check aria-hidden="true" className="h-4 w-4" />
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
                    className="border-primary text-primary hover:bg-accent hover:text-primary"
                    data-testid="add-clash-rule"
                    onClick={addClash}
                  >
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("Add a clash rule")}
                  </Button>
                </div>
              </div>
            </RuleCard>

            {/* --------------------------------------------- session windows */}
            <RuleCard
              icon={<Clock aria-hidden="true" className="h-4 w-4" />}
              title={t("Each competition's own time of day")}
              description={t(
                "Optional. Pin a competition to a daily window, e.g. U-14 mornings.",
              )}
              count={sessionCount}
            >
              <div className="flex flex-col gap-3">
                {sportsInOrder.map((sp) => (
                  <div key={sp} className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {sportName(sp)}
                    </span>
                    <div className="flex flex-col gap-1.5">
                      {leavesBySport.get(sp)!.map((c) => {
                        const idx = sessionIdx(c.leafKey);
                        const on = idx >= 0;
                        const rec = on ? rows[idx] : null;
                        return (
                          <div
                            key={c.leafKey}
                            className={cn(
                              "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-3 py-2 transition-colors",
                              on
                                ? "border-primary/40 bg-primary/5"
                                : "border-border bg-muted/20",
                            )}
                          >
                            <label className="flex items-center gap-2.5 text-sm">
                              <input
                                type="checkbox"
                                checked={on}
                                data-testid={`session-${c.leafKey}-toggle`}
                                onChange={() => toggleSession(c.leafKey)}
                                className="h-4 w-4 shrink-0 rounded border-border accent-[var(--primary)]"
                              />
                              <LeafLabel label={subLabel(c.label)} />
                            </label>
                            {on && rec ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                {t("from")}
                                <Input
                                  type="time"
                                  data-testid={`session-${c.leafKey}-from`}
                                  className="h-9 w-32 font-tabular"
                                  value={String(rec.params.from ?? "09:00")}
                                  onChange={(e) =>
                                    patchParams(idx, { from: e.target.value })
                                  }
                                />
                                {t("to")}
                                <Input
                                  type="time"
                                  data-testid={`session-${c.leafKey}-to`}
                                  className="h-9 w-32 font-tabular"
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
                ))}
              </div>
            </RuleCard>

            {/* ----------------------------------------- concurrent-match caps */}
            <RuleCard
              icon={<Gauge aria-hidden="true" className="h-4 w-4" />}
              title={t("Matches running at once")}
              description={t(
                "Optional. Cap how many matches run at once, tournament-wide or per sport (e.g. 2 umpires).",
              )}
              count={capCount}
            >
              <div className="flex flex-col gap-1.5">
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
                      className={cn(
                        "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                        on
                          ? "border-primary/40 bg-primary/5"
                          : "border-border bg-muted/20",
                      )}
                    >
                      <label className="flex flex-1 items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={on}
                          data-testid={`cap-${scope}-toggle`}
                          onChange={() => toggleCap(scope)}
                          className="h-4 w-4 shrink-0 rounded border-border accent-[var(--primary)]"
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
                            className="h-9 w-20 font-tabular"
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
            </RuleCard>

            <div className="flex items-center justify-end border-t border-border pt-4">
              <Button
                disabled={!dirty || save.isPending}
                data-testid="save-clashes"
                onClick={() => save.mutate()}
              >
                <Save aria-hidden="true" className="h-4 w-4" />
                {save.isPending ? t("Saving…") : t("Save rules")}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
