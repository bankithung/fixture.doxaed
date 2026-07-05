import { useEffect, useId, useState } from "react";
import type { SyntheticEvent } from "react";
import { ExternalLink, Plus, Search, Star, Trash2 } from "lucide-react";
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
  /** Display metadata for already-stored uploads (filename + signed view URL +
   * MIME + the respondent's document name), keyed by upload_ref — lets
   * prefilled files show as names, thumbnails and view links. */
  fileMeta?: Record<
    string,
    { name: string; label?: string; url: string; content_type: string }
  >;
  /** Report the document name a respondent typed for an uploaded file, so the
   * admin knows what each document is. Keyed by upload_ref. */
  onFileLabel?: (ref: string, label: string) => void;
  /** Disable inputs (e.g. live preview that is read-only). */
  disabled?: boolean;
  /** Choice fields only: content to render DIRECTLY under a selected
   * option's row (progressive disclosure — the follow-up question appears
   * beneath the option that revealed it). Called per selected option value. */
  optionExtra?: (value: string) => React.ReactNode;
  /** Keep the label for screen readers but hide it visually (nested chain
   * questions sit right under the option carrying the same words). */
  hideLabel?: boolean;
}

/** True for an upload we should preview inline as an image (by MIME, else by
 * file extension as a fallback when MIME is unknown). */
function isImageFile(name: string, contentType?: string): boolean {
  if (contentType) return contentType.startsWith("image/");
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
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
 * File input for `file_upload` fields — single or (with `field.multiple`) many.
 * Each picked file uploads via `onUpload`, and the field's value becomes the
 * resulting upload ref(s); picked filenames are kept locally just for display.
 * Works inside repeatable groups because the renderer now threads `onUpload`
 * through. Without an upload handler (builder preview) it falls back to names.
 */
function FileUploadField({
  field,
  value,
  onChange,
  onUpload,
  fileMeta,
  onFileLabel,
  disabled,
  id,
  describedBy,
  error,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  onUpload?: (field: Field, file: File) => Promise<string>;
  fileMeta?: Record<
    string,
    { name: string; label?: string; url: string; content_type: string }
  >;
  onFileLabel?: (ref: string, label: string) => void;
  disabled?: boolean;
  id: string;
  describedBy?: string;
  error?: string;
}): React.ReactElement {
  const multiple = field.multiple === true;
  // Multi-file fields are document fields ("ID / certificate", "Coach docs") —
  // let the respondent name each upload so the admin knows what it is. Local
  // edits layer over any name carried in from a prior submission (fileMeta).
  const [labels, setLabels] = useState<Record<string, string>>({});
  const labelable = multiple && !!onFileLabel;
  const labelFor = (ref: string): string =>
    labels[ref] ?? fileMeta?.[ref]?.label ?? "";
  const setLabel = (ref: string, v: string): void => {
    setLabels((m) => ({ ...m, [ref]: v }));
    onFileLabel?.(ref, v);
  };
  const refs = Array.isArray(value)
    ? (value as unknown[]).map(String)
    : value
      ? [String(value)]
      : [];
  const [names, setNames] = useState<Record<string, string>>({});
  // Object URLs for files just picked this session, so images preview instantly
  // before the server can mint a signed URL (cleared via cleanup on unmount).
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  // Revoke object URLs on unmount so picking many images doesn't leak blobs.
  useEffect(
    () => () => Object.values(previews).forEach((u) => URL.revokeObjectURL(u)),
    [previews],
  );

  const handleFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setUploadErr(null);
    if (!onUpload) {
      onChange(multiple ? files.map((f) => f.name) : files[0].name);
      return;
    }
    setBusy(true);
    try {
      const added: string[] = [];
      const newNames: Record<string, string> = {};
      const newPreviews: Record<string, string> = {};
      for (const file of files) {
        const ref = await onUpload(field, file);
        added.push(ref);
        newNames[ref] = file.name;
        if (file.type.startsWith("image/"))
          newPreviews[ref] = URL.createObjectURL(file);
        if (!multiple) break;
      }
      setNames((n) => ({ ...n, ...newNames }));
      setPreviews((p) => ({ ...p, ...newPreviews }));
      onChange(multiple ? [...refs, ...added] : (added[0] ?? null));
    } catch {
      setUploadErr(
        t("Couldn't upload that file · use a PDF, PNG or JPG under 10 MB."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {refs.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {refs.map((ref) => {
            const meta = fileMeta?.[ref];
            const fileName = names[ref] ?? meta?.name ?? t("Uploaded file");
            const docLabel = labelFor(ref);
            // Show the document name as the headline when given; the filename
            // then drops to a muted second line.
            const primary = docLabel || fileName;
            const url = meta?.url ?? previews[ref];
            const showImg = !!url && isImageFile(fileName, meta?.content_type);
            return (
              <li
                key={ref}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm"
              >
                <div className="flex items-center gap-2.5">
                  {showImg ? (
                    <img
                      src={url}
                      alt={primary}
                      className="h-10 w-10 shrink-0 rounded border border-border object-cover"
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1.5 text-primary hover:underline"
                      >
                        <span className="truncate">{primary}</span>
                        <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      </a>
                    ) : (
                      <span className="min-w-0 truncate">{primary}</span>
                    )}
                    {docLabel ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {fileName}
                      </span>
                    ) : null}
                  </div>
                  {!disabled ? (
                    <button
                      type="button"
                      aria-label={t("Remove file")}
                      onClick={() =>
                        onChange(multiple ? refs.filter((r) => r !== ref) : null)
                      }
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                {labelable && !disabled ? (
                  <Input
                    value={docLabel}
                    onChange={(e) => setLabel(ref, e.target.value)}
                    placeholder={t("Name this document (e.g. Aadhaar card)")}
                    aria-label={t(`Document name for ${fileName}`)}
                    className="h-8 text-xs"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!disabled && (multiple || refs.length === 0) ? (
        <input
          id={id}
          type="file"
          multiple={multiple}
          accept={field.accept}
          disabled={disabled || busy}
          aria-describedby={describedBy}
          aria-invalid={!!error}
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = ""; // allow re-picking the same file
            void handleFiles(files);
          }}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
        />
      ) : null}
      {busy ? (
        <span className="text-xs text-muted-foreground">{t("Uploading…")}</span>
      ) : null}
      {uploadErr ? (
        <span role="alert" className="text-xs text-destructive">
          {uploadErr}
        </span>
      ) : null}
    </div>
  );
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
  fileMeta,
  onFileLabel,
  disabled,
  optionExtra,
  hideLabel,
}: FieldRenderProps): React.ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const describedBy = field.help ? `${id}-help` : undefined;
  const options = field.options ?? [];

  // Long choice lists (>5 options) get an inline search box so respondents
  // can filter instead of scanning — radio/checkbox groups here; the dropdown
  // type gets the same behaviour from the Select component itself.
  const [optQuery, setOptQuery] = useState("");
  const choiceSearch =
    (field.type === "single_choice" || field.type === "multi_choice") &&
    options.length > 5;
  const q = optQuery.trim().toLowerCase();
  const visibleOptions =
    choiceSearch && q
      ? options.filter((o) => t(o.label).toLowerCase().includes(q))
      : options;
  const optionFilter = choiceSearch ? (
    <label className="relative block">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={optQuery}
        onChange={(e) => setOptQuery(e.target.value)}
        placeholder={t("Search options…")}
        aria-label={t(`Search ${field.label}`)}
        className="h-9 pl-9"
      />
    </label>
  ) : null;
  const noMatches =
    choiceSearch && visibleOptions.length === 0 ? (
      <p className="text-sm text-muted-foreground">{t("No matches.")}</p>
    ) : null;

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
        // For native date/time inputs the calendar only opens from the tiny
        // built-in glyph. Open the picker when the user clicks (or focuses)
        // anywhere on the field. showPicker() must run inside a user gesture
        // and isn't available on every browser, so guard + swallow errors.
        const isPicker = field.type === "date" || field.type === "time";
        const openPicker = isPicker
          ? (e: SyntheticEvent<HTMLInputElement>) => {
              const el = e.currentTarget;
              if (typeof el.showPicker === "function") {
                try {
                  el.showPicker();
                } catch {
                  /* not allowed / unsupported — fall back to native UI */
                }
              }
            }
          : undefined;
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
            onClick={openPicker}
            onFocus={openPicker}
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
            : visibleOptions;
        return (
          <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-2">
            {optionFilter}
            {noMatches}
            {opts.map((o) => {
              const oid = `${id}-${o.value}`;
              const selected = asString(value) === String(o.value);
              const extra = selected ? optionExtra?.(String(o.value)) : null;
              return (
                <div key={o.value} className="flex flex-col">
                  <label
                    htmlFor={oid}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={oid}
                      type="radio"
                      name={id}
                      value={o.value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => onChange(o.value)}
                      className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {o.image ? (
                      <img src={o.image} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : null}
                    <span>{t(o.label)}</span>
                  </label>
                  {extra ? <div className="mt-2">{extra}</div> : null}
                </div>
              );
            })}
          </div>
        );
      }
      case "multi_choice": {
        const arr = asArray(value);
        return (
          <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
            {optionFilter}
            {choiceSearch && q && arr.length > 0 ? (
              <p className="font-tabular text-xs text-muted-foreground">
                {arr.length} {t("selected (kept while you search)")}
              </p>
            ) : null}
            {noMatches}
            {visibleOptions.map((o) => {
              const oid = `${id}-${o.value}`;
              const checked = arr.includes(String(o.value));
              const extra = checked ? optionExtra?.(String(o.value)) : null;
              return (
                <div key={o.value} className="flex flex-col">
                  <label
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
                    {o.image ? (
                      <img src={o.image} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : null}
                    <span>{t(o.label)}</span>
                  </label>
                  {extra ? <div className="mt-2">{extra}</div> : null}
                </div>
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
              image: o.image,
            }))}
            placeholder={t("Select…")}
            aria-label={t(field.label)}
            disabled={disabled}
            // Searchable for any non-trivial list — live-bound pickers (the
            // school/institution list) always, and static lists once they have
            // more than a few options (so a school dropdown gets a search box).
            searchable={!!field.data_source || options.length > 3}
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
          <FileUploadField
            field={field}
            value={value}
            onChange={onChange}
            onUpload={onUpload}
            fileMeta={fileMeta}
            onFileLabel={onFileLabel}
            disabled={disabled}
            id={id}
            describedBy={describedBy}
            error={error}
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
                      onUpload={onUpload}
                      fileMeta={fileMeta}
                      onFileLabel={onFileLabel}
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
                    ? ` · ${t("at least")} ${minRows} ${t("required")}`
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
                onUpload={onUpload}
                fileMeta={fileMeta}
                onFileLabel={onFileLabel}
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
      <Label id={labelId} htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
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
          {/* Known codes map to copy; full sentences (inline/server
              validation messages) display verbatim; bare codes fall back. */}
          {t(
            ERROR_MESSAGES[error] ??
              (error.includes(" ") ? error : "This field is required."),
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Server validation codes → human messages (default: required). */
const ERROR_MESSAGES: Record<string, string> = {
  too_few_items: "Add the minimum number of entries (check the squad size).",
  too_many_items: "Too many entries. Remove some (check the squad size).",
  required_in_rows: "Complete the required details in every entry.",
};
