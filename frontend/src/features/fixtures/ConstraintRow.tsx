import { ArrowDown, ArrowUp, Trash2, X } from "lucide-react";
import type { ConstraintRecord, ConstraintType } from "@/api/tournaments";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { humanizeLeaf } from "@/features/controlroom/format";
import { BlackoutDatesField } from "./BlackoutDatesField";

/** Human labels for known catalog param keys (fallback: humanized key). */
const PARAM_LABELS: Record<string, string> = {
  minutes: "Minutes",
  count: "Count",
  key: "Group by",
  until_round: "Until round",
  dates: "Dates",
  team_id: "Team",
  days: "Days",
  from: "From",
  to: "To",
  date: "Date",
  venues: "Venues (names, comma-separated)",
  round: "Round (final / semi_final / number)",
  final_order: "Which of them plays first",
  min_gap_minutes: "Min gap (minutes)",
  cross_venue_gap_minutes: "Cross-venue gap (minutes)",
  order: "Order, most important first",
  mode: "How strongly the order applies",
  rounds_from_end: "How many closing rounds",
  from_date: "First day they may play",
  exclusive: "Closing days hold nothing else",
};

/** One line of help under a param, where the label alone cannot carry it. */
const PARAM_HINTS: Record<string, string> = {
  order:
    "Anything you leave out is scheduled after everything you list. A sport covers all its categories.",
  rounds_from_end:
    "Counted back from each competition's own last round, so 2 means its final and semi-finals.",
  exclusive:
    "On, the closing days are kept for those rounds only. Off, earlier rounds may still fill the gaps.",
  final_order:
    "Orders the last phase only. One entry can be a whole sport, one category, or a word from the category name such as girls.",
};

/** The phase list's own hint — keyed by KIND, because `phased_finish` stores
 * it under the same `order` key the priority rule uses for competitions. */
const PHASE_ORDER_HINT =
  "Each phase waits for the one before it to finish everywhere. Leave a phase out to let it play whenever there is room.";

/** How each finish phase reads on screen. The values come from the catalog. */
const PHASE_LABELS: Record<string, string> = {
  earlier: "All earlier rounds",
  semi_final: "Semi-finals",
  third_place: "Third places",
  final: "Finals",
};

/** Readable names for enumerated param values, keyed "<param>:<value>". The
 * catalog supplies the values; this only makes them read like English. */
const PARAM_OPTION_LABELS: Record<string, string> = {
  "within:sport": "Same sport only",
  "within:leaf": "Same competition only",
  "within:any": "Any two of its matches",
  "mode:sequential": "Finish one competition, then start the next",
  "mode:within_round": "All progress together, priority goes first",
};

/** The literal the engine reads as "whatever the last scheduled day turns out
 * to be" — so a host can say "the final plays on the last day" before the
 * calendar is settled, and never has to restate it when the dates move. */
const LAST_DAY = "last_day";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function paramLabel(key: string): string {
  return t(
    PARAM_LABELS[key] ??
      key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()),
  );
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * A ranked list the host builds themselves: pick a competition, then move it
 * up or down. The stored value is the ORDER, so the list has to read as one —
 * numbered, one row per entry, with the moves next to the thing they move.
 *
 * Up/down buttons rather than drag: this is a keyboard- and touch-reachable
 * control on a settings form, and a drag surface here would be neither.
 * Anything not picked is stated in words rather than left to be inferred.
 */
function OrderedPicker({
  value,
  options,
  labelOptions,
  onChange,
  testId,
  label,
  addLabel,
  emptyText,
}: {
  value: string[];
  /** Everything pickable — competitions and whole sports. */
  options: SelectOption[];
  /** Every competition in the tournament, for NAMING a ranked entry. A rule
   * scoped to one sport narrows what can be added, but an entry ranked before
   * that scope was set still has to read as itself. */
  labelOptions?: SelectOption[];
  onChange: (next: string[]) => void;
  testId: string;
  label: string;
  /** What the add control offers, in the words of the thing being ranked —
   * a phase list must not invite the host to "add a competition". */
  addLabel?: string;
  /** What an empty list means, in that same vocabulary. */
  emptyText?: string;
}): React.ReactElement {
  // Never render a raw leaf key: it is an internal code, and one leaking into
  // the list is what made a scoped rule look broken (owner 2026-08-18).
  const labelOf = (v: string): string =>
    (labelOptions ?? options).find((o) => o.value === v)?.label ??
    humanizeLeaf(v);
  // An entry outside this rule's scope is inert — the engine will never match
  // it. Saying so beats leaving the host to wonder why it changes nothing.
  const inScope = (v: string): boolean =>
    !options.length || options.some((o) => o.value === v);
  const remaining = options.filter((o) => !value.includes(o.value));
  const move = (i: number, to: number): void => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [row] = next.splice(i, 1);
    next.splice(to, 0, row!);
    onChange(next);
  };

  return (
    <div className="flex w-full min-w-64 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {value.length ? (
        <ol data-testid={testId} className="flex flex-col gap-1">
          {value.map((v, i) => (
            <li
              key={v}
              data-testid={`${testId}-item-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1"
            >
              <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {labelOf(v)}
                {inScope(v) ? null : (
                  <span
                    data-testid={`${testId}-inert-${i}`}
                    className="ml-1.5 rounded bg-warning-muted px-1 py-0.5 text-[0.625rem] font-medium text-warning"
                  >
                    {t("not in this sport")}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`${t("Move up")}: ${labelOf(v)}`}
                data-testid={`${testId}-up-${i}`}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`${t("Move down")}: ${labelOf(v)}`}
                data-testid={`${testId}-down-${i}`}
                disabled={i === value.length - 1}
                onClick={() => move(i, i + 1)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`${t("Remove")}: ${labelOf(v)}`}
                data-testid={`${testId}-remove-${i}`}
                onClick={() => onChange(value.filter((x) => x !== v))}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(emptyText ?? "Nothing ranked yet, so the schedule keeps its usual order.")}
        </p>
      )}
      {remaining.length ? (
        <Select
          id={`${testId}-add`}
          aria-label={t("Add to the order")}
          placeholder={t(addLabel ?? "Add a competition…")}
          value=""
          onChange={(v) => onChange([...value, v])}
          options={remaining}
          size="sm"
          className="w-full"
        />
      ) : null}
    </div>
  );
}

/** The one-line explanation under a param, when the label cannot carry it. */
function Hint({ text }: { text?: string }): React.ReactElement | null {
  return text ? (
    <span className="text-xs text-muted-foreground">{t(text)}</span>
  ) : null;
}

/** A yes/no rule param. Reads as the two answers it has, matching the row's
 * own Must/Prefer control rather than introducing a second idiom. */
function BoolField({
  on,
  onChange,
  testId,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  testId: string;
  label: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex rounded-lg border border-border p-0.5"
      >
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            type="button"
            aria-pressed={on === v}
            data-testid={`${testId}-${v ? "on" : "off"}`}
            onClick={() => onChange(v)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              on === v
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {v ? t("Yes") : t("No")}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One typed scheduling rule (clarity rebuild §4.5): the param fields are
 * rendered from the catalog's `params_schema` (int→number, time→time,
 * dates→date chips, team_id→team Select, days→weekday chips), plus the scope
 * Select, the Must/Prefer segmented toggle (persisted as `hard`) and — for
 * preferences only — the 1-10 strength (persisted as `weight`).
 */
export function ConstraintRow({
  record,
  spec,
  scopeOptions,
  teams,
  orderOptions = [],
  onChange,
  onRemove,
  badge,
  index,
}: {
  record: ConstraintRecord;
  /** The catalog entry for `record.type` (label + params_schema + scopes). */
  spec: ConstraintType;
  /** Scope choices the builder resolved for this type. */
  scopeOptions: SelectOption[];
  /** Registered teams, for `team_id` params. */
  teams: { id: string; name: string }[];
  /** Rankable competitions and sports, for an `order` param. */
  orderOptions?: SelectOption[];
  onChange: (next: ConstraintRecord) => void;
  onRemove: () => void;
  /** Provenance badge ("From global setup" for wizard-owned records). */
  badge?: string;
  index: number;
}): React.ReactElement {
  const tid = (suffix: string): string => `constraint-${index}-${suffix}`;
  const setParam = (key: string, value: unknown): void =>
    onChange({ ...record, params: { ...record.params, [key]: value } });

  const renderParam = (key: string, kind: string): React.ReactElement => {
    // The phases themselves, in the order they must finish (owner 2026-08-19).
    // Same ranked-list control as a competition order — the thing being
    // ordered is the only difference.
    if (kind === "phase_order") {
      const options = (spec.param_options?.[key] ?? []).map((v) => ({
        value: v,
        label: t(PHASE_LABELS[v] ?? v),
      }));
      return (
        <div key={key} className="flex w-full flex-col gap-1">
          <OrderedPicker
            label={t("Phases, in the order they finish")}
            value={asList(record.params[key])}
            options={options}
            labelOptions={options}
            addLabel="Add a phase…"
            emptyText="No phases set, so nothing waits for anything else."
            onChange={(v) => setParam(key, v)}
            testId={tid(key)}
          />
          <Hint text={PHASE_ORDER_HINT} />
        </div>
      );
    }
    if (kind === "order") {
      // Ranked WITHIN the rule's scope (owner 2026-08-17): sports on separate
      // courts run at the same time, so ordering table tennis against sepak
      // says nothing. A rule scoped to one sport offers only that sport's
      // competitions — one order per sport, which is how a day is actually run.
      const scoped = record.scope?.startsWith("sport:")
        ? record.scope.slice("sport:".length)
        : "";
      const options = scoped
        ? orderOptions.filter(
            (o) => o.value === scoped || o.value.startsWith(`${scoped}.`),
          )
        : orderOptions;
      return (
        <div key={key} className="flex w-full flex-col gap-1">
          <OrderedPicker
            label={paramLabel(key)}
            value={asList(record.params[key])}
            options={options}
            labelOptions={orderOptions}
            onChange={(v) => setParam(key, v)}
            testId={tid(key)}
          />
          <Hint
            text={
              scoped
                ? "Ranked within this sport only. Other sports play in parallel on their own courts, so add a separate rule per sport."
                : PARAM_HINTS[key]
            }
          />
        </div>
      );
    }
    if (kind === "bool") {
      return (
        <div key={key} className="flex flex-col gap-1">
          <BoolField
            label={paramLabel(key)}
            on={Boolean(record.params[key])}
            onChange={(v) => setParam(key, v)}
            testId={tid(key)}
          />
          <Hint text={PARAM_HINTS[key]} />
        </div>
      );
    }
    // A date that may instead be "whatever the last day turns out to be": the
    // date box AND the standing answer, because a host setting this up before
    // the calendar is final should not have to come back and restate it.
    if (kind === "date_or_last_day") {
      const isLast = record.params[key] === LAST_DAY;
      return (
        <div key={key} className="flex flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              aria-label={paramLabel(key)}
              disabled={isLast}
              value={isLast ? "" : String(record.params[key] ?? "")}
              data-testid={tid(key)}
              onChange={(e) => setParam(key, e.target.value)}
              className="h-9 w-fit min-w-36 disabled:opacity-50"
            />
            <button
              type="button"
              aria-pressed={isLast}
              data-testid={tid(`${key}-last-day`)}
              onClick={() => setParam(key, isLast ? "" : LAST_DAY)}
              className={cn(
                "h-9 shrink-0 rounded-md border px-2.5 text-xs font-medium transition-colors",
                isLast
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {t("Last day")}
            </button>
          </div>
        </div>
      );
    }
    if (key === "team_id") {
      return (
        <label key={key} className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <Select
            aria-label={t(`Team, rule ${index + 1}`)}
            value={String(record.params.team_id ?? "")}
            onChange={(v) => setParam("team_id", v)}
            options={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
            size="sm"
          />
        </label>
      );
    }
    if (kind === "list" && key === "dates") {
      return (
        <div key={key} className="w-full">
          <BlackoutDatesField
            label={paramLabel(key)}
            value={asList(record.params.dates)}
            onChange={(v) => setParam("dates", v)}
            testId={tid("dates")}
          />
        </div>
      );
    }
    if (kind === "list" && key === "days") {
      const days = asList(record.params.days);
      return (
        <div key={key} className="flex flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label={paramLabel(key)}>
            {WEEKDAYS.map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  data-testid={tid(`day-${d}`)}
                  onClick={() =>
                    setParam(
                      "days",
                      on ? days.filter((x) => x !== d) : [...days, d],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs capitalize transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {t(d)}
                </button>
              );
            })}
          </div>
          {days.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("Applies every day.")}
            </span>
          ) : null}
        </div>
      );
    }
    if (kind === "list") {
      return (
        <label key={key} className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <Input
            value={asList(record.params[key]).join(", ")}
            data-testid={tid(key)}
            onChange={(e) =>
              setParam(
                key,
                e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              )
            }
            className="h-9"
          />
        </label>
      );
    }
    // A param the catalog gives a fixed set of values for becomes a picker
    // rather than a free-text box — no per-param code here, so any future
    // enumerated param gets one for free.
    const choices = spec.param_options?.[key];
    if (choices?.length) {
      return (
        <label key={key} className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <Select
            aria-label={`${paramLabel(key)}, ${t("rule")} ${index + 1}`}
            value={String(record.params[key] ?? choices[0])}
            onChange={(v) => setParam(key, v)}
            options={choices.map((c) => ({
              value: c,
              label: t(PARAM_OPTION_LABELS[`${key}:${c}`] ?? c),
            }))}
            size="sm"
          />
        </label>
      );
    }
    const type = kind === "int" ? "number" : kind === "time" ? "time" : kind === "date" ? "date" : "text";
    return (
      <div key={key} className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <Input
            type={type}
            min={kind === "int" ? 1 : undefined}
            value={String(record.params[key] ?? "")}
            data-testid={tid(key)}
            onChange={(e) =>
              setParam(
                key,
                kind === "int" ? Number(e.target.value) || 0 : e.target.value,
              )
            }
            className={cn("h-9", kind === "int" ? "w-24" : "w-fit min-w-28")}
          />
        </label>
        <Hint text={PARAM_HINTS[key]} />
      </div>
    );
  };

  return (
    <div
      data-testid={tid("row")}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(spec.label)}</span>
        {badge ? (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
            {badge}
          </span>
        ) : null}
        <div
          role="group"
          aria-label={t("How strictly this rule applies")}
          className="ml-auto inline-flex rounded-lg border border-border p-0.5"
        >
          <button
            type="button"
            aria-pressed={record.hard}
            data-testid={tid("hard")}
            onClick={() => onChange({ ...record, hard: true })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              record.hard
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {t("Must")}
          </button>
          <button
            type="button"
            aria-pressed={!record.hard}
            data-testid={tid("soft")}
            onClick={() => onChange({ ...record, hard: false })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              !record.hard
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {t("Prefer")}
          </button>
        </div>
        <button
          type="button"
          aria-label={t(`Remove rule ${index + 1}`)}
          data-testid={tid("remove")}
          onClick={onRemove}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{t("Applies to")}</span>
          <Select
            aria-label={t(`Scope, rule ${index + 1}`)}
            value={record.scope || "all"}
            onChange={(v) => onChange({ ...record, scope: v })}
            options={scopeOptions}
            size="sm"
          />
        </label>
        {!record.hard ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("How strongly (1-10)")}</span>
            <Input
              type="number"
              min={1}
              max={10}
              value={record.weight}
              data-testid={tid("weight")}
              onChange={(e) =>
                onChange({
                  ...record,
                  weight: Math.max(1, Math.min(10, Number(e.target.value) || 5)),
                })
              }
              className="h-9 w-20"
            />
          </label>
        ) : null}
        {Object.entries(spec.params_schema).map(([key, kind]) =>
          renderParam(key, kind),
        )}
      </div>
    </div>
  );
}
