import { Trash2 } from "lucide-react";
import type { ConstraintRecord, ConstraintType } from "@/api/tournaments";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
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
  min_gap_minutes: "Min gap (minutes)",
  cross_venue_gap_minutes: "Cross-venue gap (minutes)",
};

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
 * One typed constraint record (redesign §6 screen 4): the param fields are
 * rendered from the catalog's `params_schema` (int→number, time→time,
 * dates→date chips, team_id→team Select, days→weekday chips), plus the scope
 * Select, the Hard/Soft segmented toggle and — soft only — the 1-10 weight.
 */
export function ConstraintRow({
  record,
  spec,
  scopeOptions,
  teams,
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
    if (key === "team_id") {
      return (
        <label key={key} className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{paramLabel(key)}</span>
          <Select
            aria-label={t(`Team — constraint ${index + 1}`)}
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
              {t("No days selected — applies every day.")}
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
    const type = kind === "int" ? "number" : kind === "time" ? "time" : kind === "date" ? "date" : "text";
    return (
      <label key={key} className="flex flex-col gap-1">
        <span className="text-xs font-medium">{paramLabel(key)}</span>
        <Input
          type={type}
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
    );
  };

  return (
    <div
      data-testid={tid("row")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3"
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
          aria-label={t(`Enforcement — constraint ${index + 1}`)}
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
            {t("Hard")}
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
            {t("Soft")}
          </button>
        </div>
        <button
          type="button"
          aria-label={t(`Remove constraint ${index + 1}`)}
          data-testid={tid("remove")}
          onClick={onRemove}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-44 flex-col gap-1">
          <span className="text-xs font-medium">{t("Applies to")}</span>
          <Select
            aria-label={t(`Scope — constraint ${index + 1}`)}
            value={record.scope || "all"}
            onChange={(v) => onChange({ ...record, scope: v })}
            options={scopeOptions}
            size="sm"
          />
        </label>
        {!record.hard ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("Weight (1–10)")}</span>
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
