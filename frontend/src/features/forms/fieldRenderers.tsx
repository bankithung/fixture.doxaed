import { useEffect, useId, useState } from "react";
import type { SyntheticEvent } from "react";
import { Check, ExternalLink, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
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
      {!disabled && (multiple || refs.length === 0) && refs.length < maxFiles ? (
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
 * A date of birth as three pickers rather than a calendar (owner 2026-08-18:
 * "allow separate, first month then date then year, that way it will be
 * easier").
 *
 * A birth date is decades away from today, so a calendar widget makes the
 * respondent page back through hundreds of months. Three lists reach any year
 * in three taps, and on a phone they are native pickers rather than a grid of
 * tap targets a thumb keeps missing.
 *
 * The stored value stays an ISO date, so nothing downstream knows or cares.
 * A partial answer stores nothing: two thirds of a birthday is not a date.
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
  const year = y ?? "";
  const month = m ?? "";
  const day = d ?? "";

  // Old enough for the oldest competitor, recent enough for the youngest.
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 80 }, (_, i) => String(thisYear - i));
  const daysInMonth =
    year && month
      ? new Date(Number(year), Number(month), 0).getDate()
      : 31;
  const days = Array.from({ length: daysInMonth }, (_, i) =>
    String(i + 1).padStart(2, "0"),
  );

  const emit = (nextY: string, nextM: string, nextD: string): void => {
    if (!nextY || !nextM || !nextD) {
      onChange("");
      return;
    }
    // A day that does not exist in the newly chosen month is clamped rather
    // than silently emitting an invalid date (31 February).
    const max = new Date(Number(nextY), Number(nextM), 0).getDate();
    const safe = String(Math.min(Number(nextD), max)).padStart(2, "0");
    onChange(`${nextY}-${nextM}-${safe}`);
  };

  return (
    <div
      className="grid grid-cols-3 gap-2"
      role="group"
      aria-labelledby={describedBy}
      aria-label={label}
    >
      <Select
        aria-label={`${label}: ${t("month")}`}
        value={month}
        onChange={(v) => emit(year, v, day)}
        options={MONTHS.map((name, i) => ({
          value: String(i + 1).padStart(2, "0"),
          label: t(name),
        }))}
        placeholder={t("Month")}
        disabled={disabled}
        size="sm"
      />
      <Select
        aria-label={`${label}: ${t("day")}`}
        value={day}
        onChange={(v) => emit(year, month, v)}
        options={days.map((n) => ({ value: n, label: String(Number(n)) }))}
        placeholder={t("Day")}
        disabled={disabled}
        size="sm"
      />
      <Select
        aria-label={`${label}: ${t("year")}`}
        value={year}
        onChange={(v) => emit(v, month, day)}
        options={years.map((n) => ({ value: n, label: n }))}
        placeholder={t("Year")}
        disabled={disabled}
        searchable
        size="sm"
      />
      <input type="hidden" id={id} value={iso} aria-invalid={!!error} />
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
  return WIDE_TYPES.has(f.type) || (f.options?.length ?? 0) > 4;
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
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {rowLabel} {i + 1}
              </span>
              {canRemove ? remove : null}
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
            {!disabled && collapsible ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={!title}
                data-testid={`row-save-${field.key}-${i}`}
                onClick={() => setOpen(id, false)}
              >
                <Check aria-hidden="true" className="h-4 w-4" />
                {t("Save")}
              </Button>
            ) : null}
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
