import { useMemo } from "react";
import { Check, X } from "lucide-react";
import type { DirectoryCompetition, DirectoryEntry } from "@/api/forms";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Token accents per sport band, in first-seen order. */
const SPORT_TONES = [
  "bg-primary text-primary-foreground",
  "bg-info text-info-foreground",
  "bg-success text-success-foreground",
  "bg-warning text-warning-foreground",
] as const;

/** A competition's short code, built from the segments AFTER the sport:
 * "Table Tennis · U-14 · Boys · Singles" -> "UBS",
 * "Sepak Takraw · U-14 · Girls" -> "UG". The legend spells every code out. */
function shortCode(label: string, sport: string): string {
  const segs = label
    .split(/\s+[·—]\s+/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
  const code = segs
    .map((s) => {
      const nvn = s.match(/(\d+)\s*v\s*(\d+)/i);
      if (nvn) return `${nvn[1]}v${nvn[2]}`;
      if (/^u[\s-]?\d/i.test(s)) return "U";
      if (/^open/i.test(s)) return "O";
      if (/^boys/i.test(s)) return "B";
      if (/^girls/i.test(s)) return "G";
      if (/^mixed/i.test(s)) return "M";
      if (/^singles/i.test(s)) return "S";
      if (/^doubles/i.test(s)) return "D";
      return s[0]?.toUpperCase() ?? "";
    })
    .join("");
  return code || sport.slice(0, 2).toUpperCase();
}

/** Institution names that arrived as slugs ("st_thomas_hr_sec_school") read
 * as slugs. The matrix shows them the way the reference sheet does — the
 * stored name is untouched, this is display only. */
function displayName(name: string): string {
  if (/\s/.test(name) || /[A-Z]/.test(name)) return name;
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

interface Column {
  leafKey: string;
  code: string;
  /** The part of the label after the sport, spelled out for the legend. */
  detail: string;
  count: number;
}
interface SportBand {
  sport: string;
  tone: string;
  columns: Column[];
}

function buildBands(competitions: DirectoryCompetition[]): SportBand[] {
  const bands = new Map<string, SportBand>();
  for (const c of competitions) {
    const sport = c.label.split(/\s+[·—]\s+/)[0]?.trim() || c.label;
    let band = bands.get(sport);
    if (!band) {
      band = { sport, tone: SPORT_TONES[bands.size % SPORT_TONES.length], columns: [] };
      bands.set(sport, band);
    }
    const detail =
      c.label
        .split(/\s+[·—]\s+/)
        .slice(1)
        .join(" · ") || t("Open competition");
    let code = shortCode(c.label, sport);
    // Two competitions of one sport must never share a column code.
    if (band.columns.some((x) => x.code === code)) {
      code = `${code}${band.columns.filter((x) => x.code.startsWith(code)).length + 1}`;
    }
    band.columns.push({ leafKey: c.leaf_key, code, detail, count: c.count });
  }
  return [...bands.values()];
}

/**
 * The registration matrix (owner 2026-08-15, from their reference sheet):
 * schools down the side, every configured competition across the top as a
 * short code banded by sport, and a tick or a cross in each cell. It answers
 * "who is in what" at a glance — the list of competition chips per row could
 * only answer it one school at a time.
 *
 * The codes are spelled out in the legend above the table, and every cell
 * carries the full competition name for screen readers and hover.
 */
export function RegistrationMatrix({
  entries,
  competitions,
  nameLabel,
}: {
  entries: DirectoryEntry[];
  /** EVERY configured competition — zeros included, so the matrix is the full
   * structure and not just what happens to be registered. */
  competitions: DirectoryCompetition[];
  nameLabel: string;
}): React.ReactElement {
  const bands = useMemo(() => buildBands(competitions), [competitions]);
  const columns = useMemo(() => bands.flatMap((b) => b.columns), [bands]);
  const rows = useMemo(
    () =>
      entries.map((e) => ({
        entry: e,
        entered: new Set((e.competitions ?? []).map((c) => c.leaf_key)),
      })),
    [entries],
  );

  if (columns.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("No competitions are configured yet.")}
      </p>
    );
  }

  return (
    <div data-testid="registration-matrix" className="flex flex-col gap-3">
      {/* Legend — what each column code means, plus the two cell states. */}
      <div
        data-testid="matrix-legend"
        className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
      >
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Competition legend")}
        </p>
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {bands.map((b) =>
            b.columns.map((c) => (
              <span key={c.leafKey} className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-tabular text-[0.6875rem] font-semibold",
                    b.tone,
                  )}
                >
                  {c.code}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {b.sport} · {c.detail}
                </span>
              </span>
            )),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-2 text-xs">
          <span className="flex items-center gap-1.5">
            <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
            {t("Registered")}
          </span>
          <span className="flex items-center gap-1.5">
            <X aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
            {t("Not registered")}
          </span>
        </div>
      </div>

      {/* The matrix itself — scrolls sideways on a narrow screen, with the
          school column pinned so a row never loses its name. */}
      <div className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">
            {t("Which competitions each institution registered for")}
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                rowSpan={2}
                className="sticky left-0 top-0 z-40 w-10 border-b border-r border-border bg-muted px-2 py-2 text-right text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {t("No.")}
              </th>
              <th
                scope="col"
                rowSpan={2}
                className="sticky left-10 top-0 z-40 w-52 border-b border-r border-border bg-muted px-3 py-2 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {t(nameLabel)}
              </th>
              {bands.map((b) => (
                <th
                  key={b.sport}
                  scope="colgroup"
                  colSpan={b.columns.length}
                  className={cn(
                    "sticky top-0 z-30 border-b border-r border-border px-3 py-1.5 text-center text-[0.6875rem] font-semibold uppercase tracking-wide last:border-r-0",
                    b.tone,
                  )}
                >
                  {b.sport}
                </th>
              ))}
            </tr>
            <tr>
              {bands.map((b) =>
                b.columns.map((c, i) => (
                  <th
                    key={c.leafKey}
                    scope="col"
                    title={`${b.sport} · ${c.detail}`}
                    className={cn(
                      "sticky top-[1.9rem] z-30 w-12 border-b border-border bg-muted px-2 py-1.5 text-center font-tabular text-[0.6875rem] font-semibold",
                      i === b.columns.length - 1 && "border-r border-border",
                    )}
                  >
                    {c.code}
                    <span className="sr-only">
                      {" "}
                      {b.sport} {c.detail}
                    </span>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, entered }, i) => {
              const zebra = i % 2 === 1 ? "bg-muted/20" : "bg-card";
              return (
                <tr key={`${entry.name}-${i}`} className={cn("group", zebra)}>
                  <td
                    className={cn(
                      "sticky left-0 z-10 border-b border-r border-border px-2 py-2 text-right font-tabular text-[0.6875rem] text-muted-foreground",
                      zebra,
                    )}
                  >
                    {i + 1}
                  </td>
                  <th
                    scope="row"
                    title={entry.name}
                    className={cn(
                      "sticky left-10 z-10 w-52 max-w-[13rem] border-b border-r border-border px-3 py-2 text-left font-medium",
                      zebra,
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {entry.logo ? (
                        <img
                          src={entry.logo}
                          alt=""
                          className="h-5 w-5 shrink-0 rounded object-cover"
                        />
                      ) : null}
                      {/* One line, ellipsed — the name column was eating the
                          width the competitions need (owner 2026-08-15); the
                          full name stays on hover and for screen readers. */}
                      <span className="block truncate text-[0.8125rem] leading-snug">
                        {displayName(entry.name)}
                      </span>
                    </span>
                  </th>
                  {columns.map((c) => {
                    const yes = entered.has(c.leafKey);
                    return (
                      <td
                        key={c.leafKey}
                        data-testid={`cell-${i}-${c.code}`}
                        className="border-b border-border px-2 py-2 text-center group-hover:bg-accent/40"
                      >
                        <span
                          className={cn(
                            "inline-grid h-5 w-5 place-items-center rounded-full",
                            yes
                              ? "bg-success-muted text-success"
                              : "bg-destructive-muted text-destructive/70",
                          )}
                        >
                          {yes ? (
                            <Check aria-hidden="true" className="h-3.5 w-3.5" />
                          ) : (
                            <X aria-hidden="true" className="h-3.5 w-3.5" />
                          )}
                          <span className="sr-only">
                            {yes ? t("Registered") : t("Not registered")}
                          </span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 2}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  {t("No institutions match these filters.")}
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr>
              <td
                colSpan={2}
                className="sticky left-0 z-10 border-t border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {t("Entries per competition")}
              </td>
              {columns.map((c) => (
                <td
                  key={c.leafKey}
                  className="border-t border-border bg-muted/40 px-2 py-1.5 text-center font-tabular text-[0.6875rem] text-muted-foreground"
                >
                  {c.count}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
