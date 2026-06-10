import { useId } from "react";
import { Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { Field } from "./types";

export interface FieldRenderProps {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Field-level error code/message to surface inline. */
  error?: string;
  /** Upload handler for file fields; resolves to an `upload_ref`. */
  onUpload?: (field: Field, file: File) => Promise<string>;
  /** Disable inputs (e.g. live preview that is read-only). */
  disabled?: boolean;
}

/** Address sub-fields (mirrors the backend address coercion shape). */
const ADDRESS_PARTS: { key: string; label: string }[] = [
  { key: "line1", label: "Address line" },
  { key: "city", label: "City / town" },
  { key: "district", label: "District" },
  { key: "state", label: "State" },
  { key: "pincode", label: "PIN code" },
];

function asString(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map(String) : [];
}

/**
 * One renderer per field type, shared by the builder preview and the public
 * renderer. Pure presentation: no data fetching, no branching — the caller
 * filters fields by visibility before rendering. Every control is labelled
 * and keyboard-reachable (WCAG 2.1 AA).
 */
export function FieldRenderer({
  field,
  value,
  onChange,
  error,
  onUpload,
  disabled,
}: FieldRenderProps): React.ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const describedBy = field.help ? `${id}-help` : undefined;
  const options = field.options ?? [];

  // section_text is display-only: render a static block with no control.
  if (field.type === "section_text") {
    return (
      <div className="rounded-lg bg-muted/40 px-4 py-3">
        <p className="text-sm font-medium">{t(field.label)}</p>
        {field.help ? (
          <p className="mt-1 text-sm text-muted-foreground">{t(field.help)}</p>
        ) : null}
      </div>
    );
  }

  const control = (() => {
    switch (field.type) {
      case "short_text":
      case "email":
      case "phone":
      case "number":
      case "date":
      case "time": {
        const inputType =
          field.type === "short_text" ? "text" : field.type;
        return (
          <Input
            id={id}
            type={inputType}
            inputMode={
              field.type === "number" || field.type === "phone"
                ? "numeric"
                : undefined
            }
            value={asString(value)}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      }
      case "long_text":
        return (
          <textarea
            id={id}
            rows={4}
            value={asString(value)}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value)}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        );
      case "single_choice":
      case "yes_no": {
        const opts =
          field.type === "yes_no" && options.length === 0
            ? [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]
            : options;
        return (
          <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-2">
            {opts.map((o) => {
              const oid = `${id}-${o.value}`;
              return (
                <label
                  key={o.value}
                  htmlFor={oid}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id={oid}
                    type="radio"
                    name={id}
                    value={o.value}
                    checked={asString(value) === String(o.value)}
                    disabled={disabled}
                    onChange={() => onChange(o.value)}
                    className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>{t(o.label)}</span>
                </label>
              );
            })}
          </div>
        );
      }
      case "multi_choice": {
        const arr = asArray(value);
        return (
          <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
            {options.map((o) => {
              const oid = `${id}-${o.value}`;
              const checked = arr.includes(String(o.value));
              return (
                <label
                  key={o.value}
                  htmlFor={oid}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id={oid}
                    type="checkbox"
                    value={o.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...arr, String(o.value)]
                          : arr.filter((v) => v !== String(o.value)),
                      )
                    }
                    className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>{t(o.label)}</span>
                </label>
              );
            })}
          </div>
        );
      }
      case "dropdown":
        return (
          <Select
            id={id}
            value={asString(value)}
            onChange={(v) => onChange(v)}
            options={options.map((o) => ({
              value: String(o.value),
              label: t(o.label),
            }))}
            placeholder={t("Select…")}
            aria-label={t(field.label)}
            disabled={disabled}
          />
        );
      case "rating": {
        const max = field.validation?.max ?? 5;
        const cur = Number(value) || 0;
        return (
          <div className="flex items-center gap-1" role="radiogroup" aria-label={t(field.label)}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-label={`${n}`}
                aria-pressed={cur >= n}
                onClick={() => onChange(n)}
                className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Star
                  aria-hidden="true"
                  className={cn(
                    "h-6 w-6",
                    cur >= n ? "fill-primary text-primary" : "text-muted-foreground",
                  )}
                />
              </button>
            ))}
          </div>
        );
      }
      case "linear_scale": {
        const min = field.validation?.min ?? 1;
        const max = field.validation?.max ?? 5;
        const cur = Number(value);
        const nums: number[] = [];
        for (let n = min; n <= max; n += 1) nums.push(n);
        return (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t(field.label)}>
            {nums.map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-pressed={cur === n}
                onClick={() => onChange(n)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-tabular transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  cur === n
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-accent",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        );
      }
      case "address": {
        const obj =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        return (
          <div className="flex flex-col gap-2">
            {ADDRESS_PARTS.map((p) => (
              <Input
                key={p.key}
                aria-label={t(p.label)}
                placeholder={t(p.label)}
                value={asString(obj[p.key])}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...obj, [p.key]: e.target.value })
                }
              />
            ))}
          </div>
        );
      }
      case "file_upload":
        return (
          <input
            id={id}
            type="file"
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={!!error}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (onUpload) {
                void onUpload(field, file).then((ref) => onChange(ref));
              } else {
                onChange(file.name);
              }
            }}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
          />
        );
      case "group": {
        const children = field.fields ?? [];
        // Repeatable group → an ARRAY of row objects with add/remove. Nesting
        // works because each child renders through FieldRenderer, so a nested
        // repeatable group (e.g. players inside a team) renders its own rows.
        if (field.repeatable) {
          const rows: Record<string, unknown>[] = Array.isArray(value)
            ? (value as Record<string, unknown>[])
            : [];
          const rowLabel = t(field.label) || t("Item");
          // Roster bounds (W2-B): a category's format can pin squad size —
          // Add stops at max_items, Remove stops at min_items, and the
          // counter shows where you stand. Server enforces the same bounds.
          const minRows = typeof field.min_items === "number" ? field.min_items : 0;
          const maxRows =
            typeof field.max_items === "number" ? field.max_items : Infinity;
          const atMax = rows.length >= maxRows;
          const canRemove = !disabled && rows.length > minRows;
          return (
            <div className="flex flex-col gap-2">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {rowLabel} {i + 1}
                    </span>
                    {canRemove ? (
                      <button
                        type="button"
                        onClick={() =>
                          onChange(rows.filter((_, k) => k !== i))
                        }
                        aria-label={t(`Remove ${rowLabel} ${i + 1}`)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                  {children.map((child) => (
                    <FieldRenderer
                      key={child.key}
                      field={child}
                      value={(row ?? {})[child.key]}
                      disabled={disabled}
                      onChange={(v) =>
                        onChange(
                          rows.map((r, k) =>
                            k === i ? { ...r, [child.key]: v } : r,
                          ),
                        )
                      }
                    />
                  ))}
                </div>
              ))}
              {!disabled && !atMax ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => onChange([...rows, {}])}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {t(`Add ${rowLabel}`)}
                </Button>
              ) : null}
              {minRows > 0 || maxRows !== Infinity ? (
                <p
                  className={cn(
                    "font-tabular text-xs",
                    rows.length < minRows
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {rows.length}
                  {maxRows !== Infinity
                    ? ` / ${maxRows}`
                    : ""}{" "}
                  {rowLabel.toLowerCase()}
                  {minRows > 0 && rows.length < minRows
                    ? ` — ${t("at least")} ${minRows} ${t("required")}`
                    : ""}
                </p>
              ) : null}
            </div>
          );
        }
        // Non-repeatable group → a single object of child values.
        const obj =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        return (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
            {children.map((child) => (
              <FieldRenderer
                key={child.key}
                field={child}
                value={obj[child.key]}
                disabled={disabled}
                onChange={(v) => onChange({ ...obj, [child.key]: v })}
              />
            ))}
            {children.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("No fields in this group yet.")}
              </p>
            ) : null}
          </div>
        );
      }
      default:
        return (
          <Input
            id={id}
            value={asString(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  })();

  return (
    <div className="flex flex-col gap-1.5">
      <Label id={labelId} htmlFor={id}>
        {t(field.label)}
        {field.required ? (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {field.help ? (
        <p id={describedBy} className="text-xs text-muted-foreground">
          {t(field.help)}
        </p>
      ) : null}
      {control}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(ERROR_MESSAGES[error] ?? "This field is required.")}
        </p>
      ) : null}
    </div>
  );
}

/** Server validation codes → human messages (default: required). */
const ERROR_MESSAGES: Record<string, string> = {
  too_few_items: "Add the minimum number of entries (check the squad size).",
  too_many_items: "Too many entries — remove some (check the squad size).",
};
