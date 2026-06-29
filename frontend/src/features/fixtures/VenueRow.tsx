import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Editable venue draft (maps to the Venue CRUD API, redesign §2.3). */
export interface VenueDraft {
  /** Stored venue id; absent = created on save. */
  id?: string;
  name: string;
  venue_type: string;
  /** Parallel courts/tables/pitches ("MP Hall · T1…T4"). */
  count: number;
  /** Daily availability window; both empty = always open. */
  from: string;
  to: string;
  /** Optional daily break for THIS venue (lunch/prayer); both empty = none.
   * No match is scheduled here during it. */
  break_from: string;
  break_to: string;
  /** Sport keys allowed on this venue; empty = any sport (owner ask
   * 2026-06-25). Binds e.g. "TT Court" to table tennis so a Sepak match
   * never lands there. */
  sports: string[];
}

const TYPE_OPTIONS = [
  { value: "ground", label: t("Ground") },
  { value: "court", label: t("Court") },
  { value: "hall", label: t("Hall") },
];

/**
 * One venue row in the global setup wizard: name, type, hours, court/table
 * count (a daylight-only ground is just a window closing 16:30 — §2.3).
 */
export function VenueRow({
  value,
  index,
  onChange,
  onRemove,
  sportOptions = [],
  showBreak = false,
}: {
  value: VenueDraft;
  index: number;
  onChange: (v: VenueDraft) => void;
  onRemove: () => void;
  /** Tournament sports — when there are 2+, the row offers a "Used by" picker
   * so the organiser bonds courts to a sport (TT tables vs Sepak courts). */
  sportOptions?: { key: string; name: string }[];
  /** Show this venue's own Break from/until inputs (per-venue break mode). */
  showBreak?: boolean;
}): React.ReactElement {
  const set = (patch: Partial<VenueDraft>): void =>
    onChange({ ...value, ...patch });
  const toggleSport = (key: string): void =>
    set({
      sports: value.sports.includes(key)
        ? value.sports.filter((s) => s !== key)
        : [...value.sports, key],
    });
  const options =
    !value.venue_type || TYPE_OPTIONS.some((o) => o.value === value.venue_type)
      ? TYPE_OPTIONS
      : [...TYPE_OPTIONS, { value: value.venue_type, label: value.venue_type }];

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
      <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
        <span className="text-xs font-medium">{t("Venue name")}</span>
        <Input
          value={value.name}
          data-testid={`venue-name-${index}`}
          placeholder={t("Main Ground")}
          onChange={(e) => set({ name: e.target.value })}
          className="h-9"
        />
      </label>
      <label className="flex w-28 flex-col gap-1">
        <span className="text-xs font-medium">{t("Type")}</span>
        <Select
          value={value.venue_type}
          onChange={(v) => set({ venue_type: v })}
          options={options}
          size="sm"
          aria-label={t("Venue type")}
        />
      </label>
      <label className="flex w-36 flex-col gap-1">
        <span className="text-xs font-medium">{t("Open from")}</span>
        <Input
          type="time"
          value={value.from}
          aria-label={t("Venue opens at")}
          onChange={(e) => set({ from: e.target.value })}
          className="h-9"
        />
      </label>
      <label className="flex w-36 flex-col gap-1">
        <span className="text-xs font-medium">{t("Until")}</span>
        <Input
          type="time"
          value={value.to}
          aria-label={t("Venue closes at")}
          onChange={(e) => set({ to: e.target.value })}
          className="h-9"
        />
      </label>
      {showBreak ? (
        <>
          <label className="flex w-36 flex-col gap-1">
            <span className="text-xs font-medium">{t("Break from")}</span>
            <Input
              type="time"
              value={value.break_from}
              aria-label={t("Venue break starts at")}
              onChange={(e) => set({ break_from: e.target.value })}
              className="h-9"
            />
          </label>
          <label className="flex w-36 flex-col gap-1">
            <span className="text-xs font-medium">{t("Break until")}</span>
            <Input
              type="time"
              value={value.break_to}
              aria-label={t("Venue break ends at")}
              onChange={(e) => set({ break_to: e.target.value })}
              className="h-9"
            />
          </label>
        </>
      ) : null}
      <label className="flex w-20 flex-col gap-1">
        <span className="text-xs font-medium">{t("Courts")}</span>
        <Input
          type="number"
          min={1}
          max={64}
          value={value.count}
          data-testid={`venue-count-${index}`}
          aria-label={t("Parallel courts/tables at this venue")}
          onChange={(e) => set({ count: Math.max(1, Number(e.target.value) || 1) })}
          className="h-9 font-tabular"
        />
      </label>
      <button
        type="button"
        aria-label={t(`Remove venue ${value.name || index + 1}`)}
        className="mb-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" className="h-4 w-4" />
      </button>

      {sportOptions.length > 1 ? (
        <div className="flex w-full flex-col gap-1 border-t border-border/60 pt-2">
          <span className="text-xs font-medium">
            {t("Used by")}
            <span className="ml-1 font-normal text-muted-foreground">
              {value.sports.length === 0
                ? t("(any sport, pick to dedicate this venue)")
                : null}
            </span>
          </span>
          <div className="flex flex-wrap gap-1.5">
            {sportOptions.map((s) => {
              const on = value.sports.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={on}
                  data-testid={`venue-${index}-sport-${s.key}`}
                  onClick={() => toggleSport(s.key)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
