import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, Paperclip, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { Field, Option } from "./types";

export interface FieldRenderProps {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Field-level error code/message to surface inline. */
  error?: string;
  /** Every failure keyed by its full dotted path, so a nested field inside a
   * repeatable row can surface its OWN message. Without it a group carried one
   * detached line and the respondent could not tell which answer was rejected
   * (owner 2026-08-18). */
  errorPaths?: Record<string, string>;
  /** This field's dotted path, the prefix its children extend. */
  path?: string;
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

/** A short, collision-free id for a new repeatable row. It only has to be
 * unique inside one submission, and it must not depend on row position — the
 * whole point is that it survives an edit or a reorder. */
function newRowId(): string {
  return `r${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

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
  // A single image-only field is a LOGO slot (owner 2026-08-18): it gets a
  // real preview card with a Change control, never a bare "Uploaded file"
  // line. The accept type says it is an image, so the preview never depends
  // on recognising a filename a restored draft may not have kept.
  const singleImage = !multiple && (field.accept ?? "").startsWith("image");
  // A multi-file field may cap how many it takes (owner 2026-08-18: three
  // documents per student). Enforced here AND in the server validator — a
  // limit only the picker knows is a suggestion, not a rule.
  const maxFiles =
    multiple && typeof field.max_items === "number" && field.max_items > 0
      ? field.max_items
      : Infinity;
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
    // Take only what still fits, and say so rather than dropping the rest in
    // silence — a school that picked five would otherwise never learn why two
    // never appeared.
    const room = maxFiles - refs.length;
    if (multiple && files.length > room) {
      setUploadErr(
        `${t("Only")} ${maxFiles} ${t("files are allowed here, so")} ${
          room > 0 ? room : t("none")
        } ${t("of those were added.")}`,
      );
      files = room > 0 ? files.slice(0, room) : [];
      if (files.length === 0) return;
    }
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
            const showImg =
              !!url && (singleImage || isImageFile(fileName, meta?.content_type));
            if (singleImage) {
              return (
                <li
                  key={ref}
                  data-testid="logo-card"
                  // A logo is an avatar, not a banner: the card hugs its
                  // content instead of stretching the row (owner 2026-08-18).
                  className="flex w-fit min-w-[16rem] max-w-full items-center gap-3 rounded-lg border border-border bg-muted/40 p-3"
                >
                  {url ? (
                    <img
                      src={url}
                      alt={t(field.label)}
                      className="h-16 w-16 shrink-0 rounded-md border border-border bg-card object-contain"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="grid h-16 w-16 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground"
                    >
                      <Star className="h-5 w-5 opacity-40" />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {names[ref] ?? meta?.name ?? t("Logo uploaded")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("Shown on every team you enter.")}
                    </span>
                  </div>
                  {!disabled ? (
                    <label
                      htmlFor={id}
                      className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      {t("Change")}
                    </label>
                  ) : null}
                  {!disabled ? (
                    <button
                      type="button"
                      aria-label={t("Remove file")}
                      onClick={() => onChange(null)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </button>
                  ) : null}
                </li>
              );
            }
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
      {!disabled &&
      (multiple || refs.length === 0 || singleImage) &&
      (refs.length < maxFiles || singleImage) ? (
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
          className={cn(
            "block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80",
            // With a logo in place the picker hides behind the Change button.
            singleImage && refs.length > 0 && "sr-only",
          )}
        />
      ) : null}
      {!disabled && refs.length >= maxFiles && maxFiles !== Infinity ? (
        <span className="text-xs text-muted-foreground">
          {maxFiles} {t("files added, the most allowed here. Remove one to add another.")}
        </span>
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




const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A date of birth as a DRILL-DOWN calendar (owner 2026-08-18: "first ask the
 * year, then month, then date, like the calendar views"). One compact button
 * opens a popover that walks year -> month -> day, so a birthday decades back
 * is three taps and the closed field takes one input's worth of space — the
 * three side-by-side selects were crowding the sheet cells.
 *
 * The stored value stays an ISO date; Clear empties an optional answer.
 */
function DateParts({
  value,
  onChange,
  disabled,
  id,
  describedBy,
  error,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  id: string;
  describedBy?: string;
  error?: string;
  label: string;
}): React.ReactElement {
  const iso = typeof value === "string" ? value : "";
  const [y, m, d] = iso.split("-");
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"year" | "month" | "day">("year");
  const [draftY, setDraftY] = useState<number | null>(y ? Number(y) : null);
  const [draftM, setDraftM] = useState<number | null>(m ? Number(m) : null);
  // The popover PORTALS to <body> with fixed positioning, exactly as the
  // Select does: inside the sheet the field sits in an overflow-x container,
  // and an absolutely-positioned panel was clipped into the table (owner
  // 2026-08-18). No z-index wins against overflow clipping; escaping the
  // container does.
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const H = 300;
      const below = window.innerHeight - r.bottom;
      setPos({
        top: below < H && r.top > H ? r.top - H + 4 : r.bottom + 4,
        left: Math.max(8, Math.min(r.left, window.innerWidth - 256 - 8)),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 80 }, (_, i) => thisYear - i);

  const openPicker = (): void => {
    setDraftY(y ? Number(y) : null);
    setDraftM(m ? Number(m) : null);
    setStage("year");
    setOpen(true);
  };
  const close = (): void => setOpen(false);

  const shown = iso
    ? `${Number(d)} ${t(MONTHS[Number(m) - 1] ?? "")} ${y}`
    : "";

  const daysInMonth =
    draftY && draftM ? new Date(draftY, draftM, 0).getDate() : 31;
  // Monday-first offset for the calendar-shaped day grid.
  const firstDow =
    draftY && draftM ? (new Date(draftY, draftM - 1, 1).getDay() + 6) % 7 : 0;

  return (
    <div className="relative">
      <button
        type="button"
        ref={btnRef}
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={describedBy}
        aria-invalid={!!error}
        aria-label={label}
        onClick={() => (open ? close() : openPicker())}
        className={cn(
          "flex h-10 w-full min-w-[9.5rem] items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !shown && "text-muted-foreground",
        )}
      >
        <span className="truncate">{shown || t("Set date")}</span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          ▾
        </span>
      </button>
      {open && pos
        ? createPortal(
        <>
          {/* Click-away backdrop; the popover itself sits above it. */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-[59]"
            onClick={close}
          />
          <div
            role="dialog"
            aria-label={label}
            style={{ position: "fixed", top: pos.top, left: pos.left }}
            className="z-[60] w-64 rounded-lg border border-border bg-popover p-2 shadow-md"
          >
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs font-semibold">
                {stage === "year"
                  ? t("Year")
                  : stage === "month"
                    ? `${draftY}`
                    : `${t(MONTHS[(draftM ?? 1) - 1])} ${draftY}`}
              </span>
              <div className="flex items-center gap-2">
                {stage !== "year" ? (
                  <button
                    type="button"
                    onClick={() =>
                      setStage(stage === "day" ? "month" : "year")
                    }
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {t("Back")}
                  </button>
                ) : null}
                {iso && !disabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      onChange("");
                      close();
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    {t("Clear")}
                  </button>
                ) : null}
              </div>
            </div>
            {stage === "year" ? (
              <div className="grid max-h-52 grid-cols-4 gap-1 overflow-y-auto">
                {years.map((yy) => (
                  <button
                    key={yy}
                    type="button"
                    onClick={() => {
                      setDraftY(yy);
                      setStage("month");
                    }}
                    className={cn(
                      "rounded-md px-1 py-1.5 font-tabular text-xs transition-colors hover:bg-accent",
                      draftY === yy && "bg-primary text-primary-foreground",
                    )}
                  >
                    {yy}
                  </button>
                ))}
              </div>
            ) : stage === "month" ? (
              <div className="grid grid-cols-3 gap-1">
                {MONTHS.map((name, idx) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setDraftM(idx + 1);
                      setStage("day");
                    }}
                    className={cn(
                      "rounded-md px-1 py-2 text-xs transition-colors hover:bg-accent",
                      draftM === idx + 1 &&
                        "bg-primary text-primary-foreground",
                    )}
                  >
                    {t(name).slice(0, 3)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-0.5">
                {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((dw) => (
                  <span
                    key={dw}
                    className="py-1 text-center text-[0.625rem] font-medium text-muted-foreground"
                  >
                    {t(dw)}
                  </span>
                ))}
                {Array.from({ length: firstDow }, (_, i) => (
                  <span key={`pad-${i}`} />
                ))}
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(
                  (dd) => (
                    <button
                      key={dd}
                      type="button"
                      onClick={() => {
                        onChange(
                          `${draftY}-${String(draftM).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
                        );
                        close();
                      }}
                      className={cn(
                        "rounded-md py-1 text-center font-tabular text-xs transition-colors hover:bg-accent",
                        iso ===
                          `${draftY}-${String(draftM).padStart(2, "0")}-${String(dd).padStart(2, "0")}` &&
                          "bg-primary text-primary-foreground",
                      )}
                    >
                      {dd}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        </>,
        document.body,
      )
        : null}
      <input type="hidden" value={iso} readOnly />
    </div>
  );
}


/**
 * A multi_choice drawn as a TICK-MARK TABLE (owner 2026-08-18: "like the
 * public directory page where we show a list and then tick mark").
 *
 * Rows and columns come from each option's own `row`/`col`, so the engine
 * never parses a key. A combination the tournament does not run simply has no
 * cell, which is how an uneven category tree stays truthful.
 */
function MatrixChoice({
  field,
  options,
  value,
  onChange,
  disabled,
  labelId,
}: {
  field: Field;
  options: Option[];
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  labelId: string;
}): React.ReactElement {
  const picked = new Set(asArray(value));
  const rows: string[] = [];
  const cols: string[] = [];
  const cell = new Map<string, Option>();
  for (const o of options) {
    const r = o.row ?? "";
    const c = o.col ?? t(o.label);
    if (!rows.includes(r)) rows.push(r);
    if (!cols.includes(c)) cols.push(c);
    cell.set(`${r}\u0000${c}`, o);
  }

  const toggle = (v: string, on: boolean): void =>
    onChange(on ? [...picked, v] : [...picked].filter((x) => x !== v));

  const rowValues = (r: string): string[] =>
    cols
      .map((c) => cell.get(`${r}\u0000${c}`)?.value)
      .filter((v): v is string => Boolean(v));

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t(field.label)}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 border-b border-r border-border bg-muted px-3 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t("Category")}
            </th>
            {cols.map((c) => (
              <th
                key={c}
                scope="col"
                className="border-b border-border bg-muted px-2 py-2 text-center text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-labelledby={labelId}>
          {rows.map((r, i) => {
            const inRow = rowValues(r);
            const all = inRow.length > 0 && inRow.every((v) => picked.has(v));
            return (
              <tr key={r} className={i % 2 ? "bg-muted/20" : "bg-card"}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-border bg-inherit px-3 py-2 text-left font-medium"
                >
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={disabled}
                      aria-label={`${t("All of")} ${r || t(field.label)}`}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? [...new Set([...picked, ...inRow])]
                            : [...picked].filter((v) => !inRow.includes(v)),
                        )
                      }
                      className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                    />
                    <span className="text-[0.8125rem]">{r || t(field.label)}</span>
                  </label>
                </th>
                {cols.map((c) => {
                  const o = cell.get(`${r}\u0000${c}`);
                  if (!o) {
                    return (
                      <td
                        key={c}
                        className="border-b border-border bg-muted/30 px-2 py-2 text-center text-xs text-muted-foreground"
                      >
                        <span aria-hidden="true">·</span>
                        <span className="sr-only">{t("Not offered")}</span>
                      </td>
                    );
                  }
                  const on = picked.has(String(o.value));
                  return (
                    <td key={c} className="border-b border-border px-2 py-2 text-center">
                      <label className="inline-flex cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          value={String(o.value)}
                          aria-label={t(o.label)}
                          onChange={(e) => toggle(String(o.value), e.target.checked)}
                          className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </label>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Which fields deserve the full width of a row.
 *
 * A person is a handful of short answers (name, class, roll, date, gender) and
 * they read as ONE record when they sit side by side. Stacked full-width they
 * become a column of unrelated boxes, which is what made a roll of forty
 * students unreadable (owner 2026-08-18). Choice lists, uploads and nested
 * groups keep the full row because they are tall by nature.
 */
const WIDE_TYPES = new Set([
  "multi_choice",
  "single_choice",
  "long_text",
  "file_upload",
  "group",
  "rating",
  "info",
]);

function isWide(f: Field): boolean {
  // Option COUNT is not width: a dropdown is one control whether it holds
  // three names or three hundred, and treating a long list as wide stacked
  // "Teacher" and "Role" that plainly belong side by side (owner 2026-08-18).
  // Only genuinely tall types take the whole row.
  return WIDE_TYPES.has(f.type);
}

/** Lay a group's children out as a two-column record on a desk, one column on
 * a phone. Wide fields span both. */
function GroupFields({
  children,
  render,
  wideKey,
}: {
  children: Field[];
  render: (f: Field) => React.ReactNode;
  /** A row's naming field (its `row_title`) takes the full width: it is the
   * thing the row IS, and half a row of "Full name" beside a gap reads as a
   * layout fault. */
  wideKey?: string;
}): React.ReactElement {
  // A hidden field renders nothing, so giving it a grid cell left a HOLE and
  // pushed the next field into the far column (owner 2026-08-18: "the name
  // input is going to the right leaving gaps"). Every group here starts with a
  // hidden row id, so this hit every student and every teacher.
  const shown = children.filter((c) => c.type !== "hidden");
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      {shown.map((child) => (
        <div
          key={child.key}
          className={cn(
            (isWide(child) || child.key === wideKey) && "sm:col-span-2",
          )}
        >
          {render(child)}
        </div>
      ))}
    </div>
  );
}


/** A multi_choice squeezed into a sheet cell: small inline checkboxes, no
 * search box, no bordered rows. The options here are two or three sports. */
function InlineChecks({
  field,
  value,
  onChange,
  disabled,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}): React.ReactElement {
  const picked = asArray(value);
  return (
    <div
      role="group"
      aria-label={t(field.label)}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1"
    >
      {(field.options ?? []).map((o) => {
        const on = picked.includes(String(o.value));
        return (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-1.5 text-xs"
          >
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              value={String(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...picked, String(o.value)]
                    : picked.filter((v) => v !== String(o.value)),
                )
              }
              className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {t(o.label)}
          </label>
        );
      })}
    </div>
  );
}

/** How much horizontal room a sheet column needs, by what it holds. */
function sheetColWidth(c: Field): string {
  if (c.type === "file_upload") return "min-w-[16rem]";
  if (c.type === "date") return "min-w-[10rem]";
  if (c.type === "multi_choice") return "min-w-[10rem]";
  if (c.type === "dropdown") return "min-w-[9rem]";
  return "min-w-[11rem]";
}

/**
 * A repeatable group as an EXCEL-STYLE SHEET (owner 2026-08-18): one row per
 * person, one labelled column per detail, the documents upload a column of
 * its own. The collapsible-card layout made a roll of forty students a stack
 * of forms to open one by one; a school filling a roll reads and types row
 * by row, which is a spreadsheet.
 *
 * Cells reuse FieldRenderer (with the label sr-only and the help dropped), so
 * every control the form knows — the three-part date, the capped document
 * upload, the pickers — works in a cell without a second implementation. Wide
 * content scrolls inside the table, never the page.
 */
function SheetGroup({
  field,
  rows,
  onChange,
  disabled,
  onUpload,
  fileMeta,
  onFileLabel,
  errorPaths,
  path,
}: {
  field: Field;
  rows: Record<string, unknown>[];
  onChange: (next: unknown) => void;
  disabled?: boolean;
  onUpload?: FieldRenderProps["onUpload"];
  fileMeta?: FieldRenderProps["fileMeta"];
  onFileLabel?: FieldRenderProps["onFileLabel"];
  errorPaths?: Record<string, string>;
  path?: string;
}): React.ReactElement {
  const children = (field.fields ?? []).filter((c) => c.type !== "hidden");
  // A `layout: "columns"` child explodes into ONE COLUMN PER OPTION (owner
  // 2026-08-18): the student's competitions are tick cells on their row, in
  // sport-grouped bands exactly like the public directory's matrix.
  type Col =
    | { kind: "field"; child: Field }
    | { kind: "option"; child: Field; option: Option };
  const cols: Col[] = children.flatMap((c): Col[] =>
    c.layout === "columns" && (c.options?.length ?? 0) > 0
      ? (c.options ?? []).map((option) => ({ kind: "option", child: c, option }))
      : [{ kind: "field", child: c }],
  );
  const exploded = cols.some((c) => c.kind === "option");
  /** Consecutive option columns of one sport, for the grouped header band. */
  const sportBands: { sport: string; span: number }[] = [];
  for (const c of cols) {
    if (c.kind !== "option") continue;
    const sport = c.option.sport ?? "";
    const last = sportBands[sportBands.length - 1];
    if (last && last.sport === sport) last.span += 1;
    else sportBands.push({ sport, span: 1 });
  }
  const BAND_TONES = [
    "bg-primary text-primary-foreground",
    "bg-info text-info-foreground",
  ];
  // Which sibling answers a competition cell locks on (owner 2026-08-18):
  // the row's gender against the column's gender node, and the row's date of
  // birth against the column's age rule. Both siblings are found by SHAPE
  // (the male/female dropdown, the date field), never by key.
  const genderChild = children.find(
    (c) =>
      c.type === "dropdown" &&
      (c.options ?? []).some((o) => String(o.value) === "male"),
  );
  const dobChild = children.find((c) => c.type === "date");
  const GENDER_OF: Record<string, string> = { male: "boys", female: "girls" };
  const ageAt = (isoDob: string): number | null => {
    const [yy, mm, dd] = isoDob.split("-").map(Number);
    if (!yy || !mm || !dd) return null;
    const now = new Date();
    let age = now.getFullYear() - yy;
    if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) {
      age -= 1;
    }
    return age;
  };
  /** Why this cell is locked for this row, or null when it is open. */
  const lockReason = (
    row: Record<string, unknown>,
    option: Option,
    eventsChild?: Field,
  ): string | null => {
    // Age brackets are exclusive within a sport (owner 2026-08-18): a tick
    // in U-14 locks that sport's Open Category cells for this student, and
    // the other way round. The bracket is the option's own `row` fact.
    if (eventsChild && option.row && option.sport) {
      const ticked = asArray(row[eventsChild.key]);
      const clash = (eventsChild.options ?? []).some(
        (o) =>
          ticked.includes(String(o.value)) &&
          o.sport === option.sport &&
          (o.row ?? "") !== option.row,
      );
      if (clash && !ticked.includes(String(option.value))) {
        return t("One age category per sport");
      }
    }
    if (option.gender) {
      const g = genderChild
        ? GENDER_OF[String(row[genderChild.key] ?? "")]
        : undefined;
      if (g && g !== option.gender) {
        return option.gender === "boys"
          ? t("A boys' competition")
          : t("A girls' competition");
      }
    }
    if (option.age && dobChild) {
      const dob = String(row[dobChild.key] ?? "");
      const age = dob ? ageAt(dob) : null;
      if (age != null) {
        const a = option.age;
        if (a.op === "under" && a.age != null && age >= a.age) {
          return `${t("Over the age limit")} (${t("under")} ${a.age})`;
        }
        if (a.op === "over" && a.age != null && age < a.age) {
          return `${t("Under the age limit")} (${t("over")} ${a.age})`;
        }
        if (a.op === "between" && ((a.min != null && age < a.min) || (a.max != null && age > a.max))) {
          return `${t("Outside the age limit")} (${a.min ?? "?"}-${a.max ?? "?"})`;
        }
      }
    }
    return null;
  };
  const rowLabel = t(field.label) || t("Item");
  const minRows = typeof field.min_items === "number" ? field.min_items : 0;
  const maxRows =
    typeof field.max_items === "number" ? field.max_items : Infinity;
  const canRemove = !disabled && rows.length > minRows;
  const setCell = (i: number, key: string, v: unknown): void =>
    onChange(rows.map((r, k) => (k === i ? { ...r, [key]: v } : r)));
  // Documents live behind a side drawer (owner 2026-08-18): the inline upload
  // UI made the Documents column the tallest thing on every row. The cell is
  // a count button; the drawer holds the full upload UX with previews, the
  // name-this-document boxes and per-file delete.
  const [docsAt, setDocsAt] = useState<{ row: number; key: string } | null>(null);
  const rowName = (i: number): string => {
    const titled = field.row_title
      ? String((rows[i] ?? {})[field.row_title] ?? "").trim()
      : "";
    return titled || `${rowLabel} ${i + 1}`;
  };

  const legendToneOf = (sport: string): string => {
    const idx = sportBands.findIndex((b) => b.sport === sport);
    return BAND_TONES[(idx < 0 ? 0 : idx) % BAND_TONES.length];
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Every short code spelled out (owner 2026-08-18: "show all the full
          form too, so the user can read"), exactly like the directory
          matrix's legend. */}
      {exploded ? (
        <div
          data-testid={`sheet-legend-${field.key}`}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-2.5"
        >
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("Competition legend")}
          </p>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {cols
              .filter((c): c is Extract<Col, { kind: "option" }> => c.kind === "option")
              .map((c) => (
                <span key={c.option.value} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold",
                      legendToneOf(c.option.sport ?? ""),
                    )}
                  >
                    {c.option.code}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {c.option.sport} · {t(c.option.label)}
                  </span>
                </span>
              ))}
          </div>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table
          data-testid={`sheet-${field.key}`}
          className="w-full border-separate border-spacing-0 text-sm"
        >
          <caption className="sr-only">{t(field.label)}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                rowSpan={exploded ? 2 : 1}
                className="w-10 border-b border-r border-border bg-muted px-2 py-2 text-right font-tabular text-[0.6875rem] font-medium text-muted-foreground"
              >
                #
              </th>
              {(() => {
                const out: React.ReactNode[] = [];
                let bandAt = 0;
                for (let k = 0; k < cols.length; k++) {
                  const c = cols[k];
                  if (c.kind === "field") {
                    out.push(
                      <th
                        key={c.child.key}
                        scope="col"
                        rowSpan={exploded ? 2 : 1}
                        className={cn(
                          "border-b border-r border-border bg-muted px-3 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground",
                          sheetColWidth(c.child),
                        )}
                      >
                        {t(c.child.label)}
                        {c.child.required ? (
                          <span aria-hidden="true" className="ml-0.5 text-destructive">
                            *
                          </span>
                        ) : null}
                      </th>,
                    );
                  } else if (k === 0 || cols[k - 1].kind === "field" ||
                             (cols[k - 1] as { option: Option }).option.sport !==
                               c.option.sport) {
                    const band = sportBands[bandAt];
                    out.push(
                      <th
                        key={`band-${band.sport}-${k}`}
                        scope="colgroup"
                        colSpan={band.span}
                        className={cn(
                          "border-b border-r border-border px-2 py-1.5 text-center text-[0.6875rem] font-semibold uppercase tracking-wide",
                          BAND_TONES[bandAt % BAND_TONES.length],
                        )}
                      >
                        {band.sport}
                      </th>,
                    );
                    bandAt += 1;
                  }
                }
                return out;
              })()}
              {!disabled ? (
                <th
                  scope="col"
                  rowSpan={exploded ? 2 : 1}
                  className="w-10 border-b border-border bg-muted"
                >
                  <span className="sr-only">{t("Remove")}</span>
                </th>
              ) : null}
            </tr>
            {exploded ? (
              <tr>
                {cols
                  .filter((c) => c.kind === "option")
                  .map((c) => (
                    <th
                      key={(c as { option: Option }).option.value}
                      scope="col"
                      title={t((c as { option: Option }).option.label)}
                      className="w-12 border-b border-border bg-muted px-2 py-1.5 text-center font-tabular text-[0.6875rem] font-semibold"
                    >
                      {(c as { option: Option }).option.code ??
                        t((c as { option: Option }).option.label)}
                      <span className="sr-only">
                        {" "}
                        {t((c as { option: Option }).option.label)}
                      </span>
                    </th>
                  ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={cols.length + 2}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {t("Nothing here yet. Add the first row below.")}
                </td>
              </tr>
            ) : null}
            {rows.map((row, i) => (
              <tr
                key={field.row_key ? String((row ?? {})[field.row_key] ?? i) : i}
                className={i % 2 ? "bg-muted/20" : "bg-card"}
              >
                <td className="border-b border-r border-border px-2 py-2 text-right align-top font-tabular text-[0.6875rem] text-muted-foreground">
                  {i + 1}
                </td>
                {cols.map((col) => {
                  if (col.kind === "option") {
                    const { child, option } = col;
                    const picked = asArray((row ?? {})[child.key]);
                    const on = picked.includes(String(option.value));
                    const lock = lockReason(
                      (row ?? {}) as Record<string, unknown>,
                      option,
                      child,
                    );
                    return (
                      <td
                        key={`${child.key}-${option.value}`}
                        title={lock ?? undefined}
                        className={cn(
                          "w-12 border-b border-r border-border px-2 py-2 text-center align-middle last:border-r-0",
                          lock && !on && "bg-muted/40",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          // A locked cell cannot be ticked; a tick that BECAME
                          // conflicting (the gender or birthday changed after)
                          // stays clickable so it can be unticked, and shows
                          // as the problem it is.
                          disabled={disabled || (Boolean(lock) && !on)}
                          aria-label={`${t(option.label)}, ${rowLabel} ${i + 1}`}
                          onChange={(e) =>
                            setCell(
                              i,
                              child.key,
                              e.target.checked
                                ? [...picked, String(option.value)]
                                : picked.filter((v) => v !== String(option.value)),
                            )
                          }
                          className={cn(
                            "h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            lock && !on && "opacity-35",
                            lock && on && "outline outline-2 outline-destructive",
                          )}
                        />
                      </td>
                    );
                  }
                  const c = col.child;
                  const cellPath = `${path ?? field.key}.${i}.${c.key}`;
                  if (c.type === "file_upload") {
                    const refs = (rows[i] ?? {})[c.key];
                    const n = Array.isArray(refs) ? refs.length : refs ? 1 : 0;
                    const cellErr = errorPaths?.[cellPath];
                    return (
                      <td
                        key={c.key}
                        className="border-b border-r border-border px-2 py-2 align-middle last:border-r-0"
                      >
                        <button
                          type="button"
                          data-testid={`docs-open-${field.key}-${i}`}
                          aria-haspopup="dialog"
                          aria-label={`${t(c.label)}, ${rowName(i)}`}
                          onClick={() => setDocsAt({ row: i, key: c.key })}
                          className={cn(
                            "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            cellErr && "border-destructive text-destructive",
                          )}
                        >
                          <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
                          {n > 0
                            ? `${n} ${n === 1 ? t("file") : t("files")}`
                            : t("Add")}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        "border-b border-r border-border px-2 py-1.5 align-top last:border-r-0",
                        sheetColWidth(c),
                      )}
                    >
                      {c.type === "multi_choice" ? (
                        <InlineChecks
                          field={c}
                          value={(row ?? {})[c.key]}
                          disabled={disabled}
                          onChange={(v) => setCell(i, c.key, v)}
                        />
                      ) : (
                        <FieldRenderer
                          field={{ ...c, help: undefined }}
                          hideLabel
                          value={(row ?? {})[c.key]}
                          disabled={disabled}
                          error={errorPaths?.[cellPath]}
                          errorPaths={errorPaths}
                          path={cellPath}
                          onUpload={onUpload}
                          fileMeta={fileMeta}
                          onFileLabel={onFileLabel}
                          onChange={(v) => setCell(i, c.key, v)}
                        />
                      )}
                    </td>
                  );
                })}
                {!disabled ? (
                  <td className="border-b border-border px-1 py-1.5 text-center align-top">
                    {canRemove ? (
                      <button
                        type="button"
                        onClick={() => onChange(rows.filter((_, k) => k !== i))}
                        aria-label={t(`Remove ${rowLabel} ${i + 1}`)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && rows.length < maxRows ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          data-testid={`row-add-${field.key}`}
          onClick={() =>
            onChange([
              ...rows,
              field.row_key ? { [field.row_key]: newRowId() } : {},
            ])
          }
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {field.add_label ? t(field.add_label) : t(`Add ${rowLabel}`)}
        </Button>
      ) : null}
      {docsAt ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setDocsAt(null);
          }}
          ariaLabel={`${rowName(docsAt.row)} · ${t("Documents")}`}
          variant="side"
        >
          {(() => {
            const child = children.find((c) => c.key === docsAt.key);
            if (!child) return null;
            const cellPath = `${path ?? field.key}.${docsAt.row}.${child.key}`;
            return (
              <div className="flex h-full flex-col gap-4 p-4">
                <DialogHeader>
                  <DialogTitle>{rowName(docsAt.row)}</DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    {t(child.label)}
                    {child.help ? ` · ${t(child.help)}` : ""}
                  </p>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <FieldRenderer
                    field={{ ...child, help: undefined }}
                    hideLabel
                    value={(rows[docsAt.row] ?? {})[child.key]}
                    disabled={disabled}
                    error={errorPaths?.[cellPath]}
                    errorPaths={errorPaths}
                    path={cellPath}
                    onUpload={onUpload}
                    fileMeta={fileMeta}
                    onFileLabel={onFileLabel}
                    onChange={(v) => setCell(docsAt.row, child.key, v)}
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    data-testid="docs-done"
                    onClick={() => setDocsAt(null)}
                  >
                    {t("Done")}
                  </Button>
                </DialogFooter>
              </div>
            );
          })()}
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * A repeatable group whose filled rows COLLAPSE to their name (owner
 * 2026-08-18: "when saved no need to expand, we can only show the name, and
 * on pressing edit allow edit").
 *
 * A school entering forty students was reading forty open forms at once — the
 * page became unnavigable long before the roll was finished. A saved row is
 * therefore one line: its name, an Edit and a Remove. Editing reopens exactly
 * that row.
 *
 * Save is a display action, not a submit: the answers are already in the form
 * state as they are typed, so collapsing loses nothing and there is no second
 * source of truth to keep. It is disabled until the row has a name, because a
 * row that collapsed to a blank strip could not be told from any other.
 */
function RepeatableGroup({
  field,
  rows,
  onChange,
  disabled,
  onUpload,
  fileMeta,
  onFileLabel,
  errorPaths,
  path,
}: {
  field: Field;
  rows: Record<string, unknown>[];
  errorPaths?: Record<string, string>;
  path?: string;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  onUpload?: FieldRenderProps["onUpload"];
  fileMeta?: FieldRenderProps["fileMeta"];
  onFileLabel?: FieldRenderProps["onFileLabel"];
}): React.ReactElement {
  const children = field.fields ?? [];
  const rowLabel = t(field.label) || t("Item");
  // Roster bounds (W2-B): a category's format can pin squad size — Add stops
  // at max_items, Remove stops at min_items. Server enforces the same bounds.
  const minRows = typeof field.min_items === "number" ? field.min_items : 0;
  const maxRows =
    typeof field.max_items === "number" ? field.max_items : Infinity;
  const atMax = rows.length >= maxRows;
  const canRemove = !disabled && rows.length > minRows;

  /** Collapsing is OPT-IN, via an authored `row_title` naming the child that
   * labels a saved row. Inferring one would collapse rows that cannot say what
   * they are — a player row is a dropdown and a number, and "Player 1" tells
   * you less than the row itself. Groups without it behave exactly as before. */
  const titleKey = field.row_title;
  const collapsible = Boolean(titleKey);
  const titleChild = children.find((c) => c.key === titleKey);

  /** What a saved row is called. A picker stores an id, so the row has to be
   * named by the OPTION's label — collapsing a squad to a column of uuids
   * would be worse than leaving it open. */
  const titleOf = (row: Record<string, unknown>): string => {
    const raw = (row ?? {})[titleKey ?? ""];
    if (raw == null || raw === "") return "";
    const opts = titleChild?.options ?? [];
    const hit = opts.find((o) => String(o.value) === String(raw));
    return String(hit ? t(hit.label) : raw).trim();
  };

  /** Rows are identified by their own minted id where they have one, so a
   * removal in the middle does not re-open somebody else's row. */
  const idOf = (row: Record<string, unknown>, i: number): string =>
    field.row_key ? String(row?.[field.row_key] ?? `i${i}`) : `i${i}`;

  /** Any failure reported anywhere inside row `i`. A saved row that hides a
   * rejected answer is exactly how a submit fails with nothing to look at. */
  const rowError = (i: number): string | undefined => {
    const prefix = `${path ?? field.key}.${i}.`;
    for (const [k, v] of Object.entries(errorPaths ?? {})) {
      if (k.startsWith(prefix)) return v;
    }
    return undefined;
  };

  // Rows already present when this mounts are filled work — they open closed.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const setOpen = (id: string, open: boolean): void =>
    setOpenIds((s) => {
      const next = new Set(s);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const id = idOf(row, i);
        const title = titleOf(row);
        const err = rowError(i);
        // A row carrying a rejected answer opens itself: the message belongs
        // beside the field, not at the bottom of the page.
        const open = !collapsible || openIds.has(id) || Boolean(err);
        const remove = (
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, k) => k !== i))}
            aria-label={t(`Remove ${rowLabel} ${i + 1}`)}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        );

        if (!open) {
          return (
            <div
              key={id}
              data-testid={`row-saved-${field.key}-${i}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="w-5 shrink-0 font-tabular text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {title || `${rowLabel} ${i + 1}`}
              </span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => setOpen(id, true)}
                  data-testid={`row-edit-${field.key}-${i}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent"
                >
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Edit")}
                </button>
              ) : null}
              {canRemove ? remove : null}
            </div>
          );
        }

        return (
          <div
            key={id}
            data-testid={`row-open-${field.key}-${i}`}
            className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {rowLabel} {i + 1}
              </span>
              {!disabled && collapsible ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  disabled={!title}
                  data-testid={`row-save-${field.key}-${i}`}
                  onClick={() => setOpen(id, false)}
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Save")}
                </Button>
              ) : null}
              {canRemove ? (
                <span className={cn(!collapsible && "ml-auto")}>{remove}</span>
              ) : null}
            </div>
            {err ? (
              <p
                role="alert"
                data-testid={`row-error-${field.key}-${i}`}
                className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
              >
                {t(ERROR_MESSAGES[err] ?? err)}
              </p>
            ) : null}
            <GroupFields
              children={children}
              wideKey={titleKey}
              render={(child) => (
                <FieldRenderer
                  field={child}
                  value={(row ?? {})[child.key]}
                  disabled={disabled}
                  error={errorPaths?.[`${path ?? field.key}.${i}.${child.key}`]}
                  errorPaths={errorPaths}
                  path={`${path ?? field.key}.${i}.${child.key}`}
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
              )}
            />

          </div>
        );
      })}
      {!disabled && !atMax ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          data-testid={`row-add-${field.key}`}
          onClick={() => {
            // A row a picker can point at needs an identity of its own: minted
            // here, at creation, so it survives editing and reordering (two
            // same-named students stay two).
            const id = newRowId();
            onChange([...rows, field.row_key ? { [field.row_key]: id } : {}]);
            // A row you just asked for opens ready to type in.
            if (collapsible) setOpen(field.row_key ? id : `i${rows.length}`, true);
          }}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {field.add_label ? t(field.add_label) : t(`Add ${rowLabel}`)}
        </Button>
      ) : null}
      {minRows > 0 || maxRows !== Infinity ? (
        <p
          className={cn(
            "font-tabular text-xs",
            rows.length < minRows ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {rows.length}
          {maxRows !== Infinity ? ` / ${maxRows}` : ""}{" "}
          {rowLabel.toLowerCase()}
          {minRows > 0 && rows.length < minRows
            ? ` · ${t("at least")} ${minRows} ${t("required")}`
            : ""}
        </p>
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
  errorPaths,
  path,
}: FieldRenderProps): React.ReactElement | null {
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

  // A generated row id. It is real submitted data — it is what a picker below
  // points at — but it is machinery, so it never appears on screen.
  if (field.type === "hidden") return null;

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
      // NOTE: "date" is deliberately NOT here. It falls through to the
      // three-part picker below (owner 2026-08-18); leaving it in this group
      // rendered the native calendar and made that branch dead code.
      case "short_text":
      case "email":
      case "phone":
      case "number":
      case "time": {
        const inputType =
          field.type === "short_text" ? "text" : field.type;
        // For a native TIME input the picker only opens from the tiny
        // built-in glyph. Open it when the user clicks (or focuses) anywhere
        // on the field. showPicker() must run inside a user gesture and isn't
        // available on every browser, so guard + swallow errors. (Dates use
        // the three-part picker below and never reach this branch.)
        const isPicker = field.type === "time";
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
                  {/* Whole row is the hit target: bordered, hoverable,
                      violet when picked (bare browser radios read as
                      unfinished on the public forms). */}
                  <label
                    htmlFor={oid}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
                      selected
                        ? "border-primary/50 bg-accent/60 font-medium"
                        : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
                    )}
                  >
                    <input
                      id={oid}
                      type="radio"
                      name={id}
                      value={o.value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => onChange(o.value)}
                      className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {o.image ? (
                      <img src={o.image} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : null}
                    <span className="min-w-0">{t(o.label)}</span>
                  </label>
                  {extra ? <div className="mt-2">{extra}</div> : null}
                </div>
              );
            })}
          </div>
        );
      }
      case "multi_choice": {
        if (field.layout === "matrix" && options.length > 0) {
          return (
            <MatrixChoice
              field={field}
              options={options}
              value={value}
              onChange={onChange}
              disabled={disabled}
              labelId={labelId}
            />
          );
        }
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
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
                      checked
                        ? "border-primary/50 bg-accent/60 font-medium"
                        : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
                    )}
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
                      className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {o.image ? (
                      <img src={o.image} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
                    ) : null}
                    <span className="min-w-0">{t(o.label)}</span>
                  </label>
                  {extra ? <div className="mt-2">{extra}</div> : null}
                </div>
              );
            })}
          </div>
        );
      }
      case "date":
        return (
          <DateParts
            value={value}
            onChange={onChange}
            disabled={disabled}
            id={id}
            describedBy={describedBy}
            error={error}
            label={t(field.label)}
          />
        );
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
          if (field.layout === "sheet") {
            return (
              <SheetGroup
                field={field}
                rows={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
                onChange={onChange}
                disabled={disabled}
                errorPaths={errorPaths}
                path={path}
                onUpload={onUpload}
                fileMeta={fileMeta}
                onFileLabel={onFileLabel}
              />
            );
          }
          return (
            <RepeatableGroup
              field={field}
              rows={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
              onChange={onChange}
              disabled={disabled}
              errorPaths={errorPaths}
              path={path}
              onUpload={onUpload}
              fileMeta={fileMeta}
              onFileLabel={onFileLabel}
            />
          );
        }
        // Non-repeatable group → a single object of child values.
        const obj =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        return (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <GroupFields
              children={children}
              render={(child) => (
                <FieldRenderer
                  field={child}
                  value={obj[child.key]}
                  disabled={disabled}
                  error={errorPaths?.[`${path ?? field.key}.${child.key}`]}
                  errorPaths={errorPaths}
                  path={`${path ?? field.key}.${child.key}`}
                  onUpload={onUpload}
                  fileMeta={fileMeta}
                  onFileLabel={onFileLabel}
                  onChange={(v) => onChange({ ...obj, [child.key]: v })}
                />
              )}
            />
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
  too_many_files: "Too many files. Remove one before adding another.",
  required_in_rows: "Complete the required details in every entry.",
};
