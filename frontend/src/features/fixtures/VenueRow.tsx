import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
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
}: {
  value: VenueDraft;
  index: number;
  onChange: (v: VenueDraft) => void;
  onRemove: () => void;
}): React.ReactElement {
  const set = (patch: Partial<VenueDraft>): void =>
    onChange({ ...value, ...patch });
  const options =
    !value.venue_type || TYPE_OPTIONS.some((o) => o.value === value.venue_type)
      ? TYPE_OPTIONS
      : [...TYPE_OPTIONS, { value: value.venue_type, label: value.venue_type }];

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
      <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
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
      <label className="flex w-[6.5rem] flex-col gap-1">
        <span className="text-xs font-medium">{t("Open from")}</span>
        <Input
          type="time"
          value={value.from}
          aria-label={t("Venue opens at")}
          onChange={(e) => set({ from: e.target.value })}
          className="h-9"
        />
      </label>
      <label className="flex w-[6.5rem] flex-col gap-1">
        <span className="text-xs font-medium">{t("Until")}</span>
        <Input
          type="time"
          value={value.to}
          aria-label={t("Venue closes at")}
          onChange={(e) => set({ to: e.target.value })}
          className="h-9"
        />
      </label>
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
    </div>
  );
}
