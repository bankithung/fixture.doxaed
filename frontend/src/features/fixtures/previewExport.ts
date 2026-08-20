import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import {
  baseCss,
  crestImg,
  docFooter,
  docHeader,
  downloadCsv,
  esc,
  fileStem,
  openPrintable,
} from "./exportDoc";
import {
  buildCourtGrid,
  fmtClock,
  groupRows,
  linesWithBreaks,
  occupancyByCourt,
  sortRows,
  toCsv,
  type BlackoutWindow,
  type GridSort,
  type GroupBy,
  type PreviewRow,
} from "./previewGrid";

/** What an export says about itself, beyond the rows. */
export interface PreviewExportMeta {
  /** Document heading — the competition (or "All competitions"). */
  title: string;
  /** Plain restatement of the applied filters ("" when none). */
  filterSummary: string;
  shown: number;
  total: number;
  /** How the sheet is banded ("Day and court"). */
  groupLabel: string;
  /** Matches still without a time, called out on the cover line. */
  unplaced: number;
}

/** The trial-run warning every preview document carries, with the count of
 * matches that still have no time when there are any. */
export function draftNote(meta: PreviewExportMeta): string {
  const base = t("Trial run. This schedule is not published yet.");
  return meta.unplaced
    ? `${base} ${meta.unplaced} ${t("match(es) still have no time.")}`
    : base;
}

/** Download the rows the filters are showing, in the order they are shown. */
export function downloadPreviewCsv(
  rows: readonly PreviewRow[],
  meta: PreviewExportMeta,
): void {
  downloadCsv(toCsv(rows), `${fileStem("preview", meta.title)}.csv`);
}

interface PdfColumn {
  label: string;
  /** The cell's text. Always escaped. */
  pick: (r: PreviewRow) => string;
  cls: string;
  /**
   * Raw HTML placed before the text — the team's crest. Kept separate from
   * `pick` so that every column's TEXT still goes through `esc`: a school
   * name must never reach the page unescaped just because its row has a
   * badge.
   */
  lead?: (r: PreviewRow) => string;
}

/** The printed sheet's columns — the same reading order as the on-screen grid. */
const PDF_COLUMNS: PdfColumn[] = [
  { label: t("Day"), pick: (r) => r.dayLabel, cls: "" },
  { label: t("Start"), pick: (r) => fmtClock(r.start) || "·", cls: "num" },
  { label: t("End"), pick: (r) => fmtClock(r.end) || "·", cls: "num" },
  {
    label: t("Min"),
    pick: (r) => (r.minutes == null ? "·" : String(r.minutes)),
    cls: "num",
  },
  { label: t("Court"), pick: (r) => (r.day ? r.venue : "·"), cls: "" },
  { label: t("Sport"), pick: (r) => r.sportLabel, cls: "" },
  { label: t("Category"), pick: (r) => r.categoryLabel, cls: "muted" },
  { label: t("Stage"), pick: (r) => r.group || r.stageLabel, cls: "" },
  { label: t("Round"), pick: (r) => r.roundLabel || "·", cls: "muted" },
  {
    label: t("Team 1"),
    pick: (r) => r.home,
    cls: "team",
    lead: (r) => crestImg(r.homeCrest),
  },
  {
    label: t("Team 2"),
    pick: (r) => r.away,
    cls: "team",
    lead: (r) => crestImg(r.awayCrest),
  },
  {
    label: t("Status"),
    pick: (r) => (r.placed ? t("Scheduled") : t("No time")),
    cls: "",
  },
];

/** Build the landscape run-sheet document (exported for tests). */
export function previewPdfHtml({
  rows,
  sort,
  groupBy,
  occupancy,
  blackouts,
  meta,
}: {
  rows: readonly PreviewRow[];
  sort: GridSort | null;
  groupBy: GroupBy;
  occupancy?: readonly PreviewMatch[];
  blackouts?: readonly BlackoutWindow[];
  meta: PreviewExportMeta;
}): string {
  const busy = occupancyByCourt(occupancy ?? rows.map((r) => r.match));
  const sorted = sortRows(rows, sort);
  const span = PDF_COLUMNS.length + 1;

  let lineNo = 0;
  const body = groupRows(sorted, groupBy)
    .map((band) => {
      const lines =
        groupBy === "day_venue"
          ? linesWithBreaks(
              band.rows,
              busy.get(`${band.day}|${band.venue}`) ?? [],
              blackouts ?? [],
            )
          : band.rows.map((row) => ({ kind: "match" as const, row }));
      const head = band.label
        ? `<tr class="band"><td colspan="${span}">${esc(band.label)}${
            band.sub ? ` <span class="band-sub">${esc(band.sub)}</span>` : ""
          }<span class="band-n">${band.rows.length} ${esc(t("matches"))}</span></td></tr>`
        : "";
      const cells = lines
        .map((line) => {
          if (line.kind === "break") {
            return `<tr class="brk"><td></td><td colspan="${span - 1}">${esc(
              line.label,
            )} ${esc(fmtClock(line.from))} ${esc(t("to"))} ${esc(
              fmtClock(line.to),
            )} · ${line.minutes} ${esc(t("min"))}</td></tr>`;
          }
          lineNo += 1;
          const r = line.row;
          return `<tr${r.placed ? "" : ' class="unplaced"'}><td class="num">${r.number || lineNo}</td>${PDF_COLUMNS.map(
            (c) => `<td class="${c.cls}">${c.lead?.(r) ?? ""}${esc(c.pick(r))}</td>`,
          ).join("")}</tr>`;
        })
        .join("");
      return head + cells;
    })
    .join("");

  const scope =
    meta.shown === meta.total
      ? `${meta.total} ${t("matches")}`
      : `${meta.shown} ${t("of")} ${meta.total} ${t("matches")}`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("preview"))}</title>
<style>${baseCss()}
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: #374151;
       padding: 4px 5px; border-bottom: 1.5px solid #9ca3af; background: #f3f4f6; }
  td { padding: 3px 5px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  .num { font-variant-numeric: tabular-nums; text-align: right; color: #4b5563; white-space: nowrap; }
  .muted { color: #6b7280; }
  .team { font-weight: 600; }
  tr.band td { background: #ede9fe !important; font-weight: 600; text-transform: uppercase;
               letter-spacing: 0.05em; font-size: 8.5px; color: #4c1d95; padding: 4px 5px; }
  .band-sub { font-weight: 500; text-transform: none; letter-spacing: 0; color: #6d28d9; margin-left: 6px; }
  .band-n { float: right; font-weight: 500; color: #6b7280; }
  tr.brk td { background: #fffbeb !important; color: #92400e; font-size: 8.5px; }
  tr.unplaced td { background: #fef3c7 !important; }
</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: `${t("Fixture preview")} · ${t("grouped by")} ${meta.groupLabel.toLowerCase()}`,
    scope,
    filterSummary: meta.filterSummary,
    note: draftNote(meta),
  })}
  <table>
    <thead><tr><th style="width:1.6rem">#</th>${PDF_COLUMNS.map(
      (c) =>
        `<th${c.cls === "num" ? ' style="text-align:right"' : ""}>${esc(c.label)}</th>`,
    ).join("")}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  ${docFooter()}
</body></html>`;
}

/**
 * The same schedule as a TIME-BY-COURT grid: one row per start time, one
 * column per court (owner 2026-08-19, from a layout they sent). A list makes
 * an official scan for their court; this puts the court above their head and
 * the time down the side, so "8:20, court 2" is one glance.
 *
 * Prints from the SAME filtered rows as the list, so whatever is on screen is
 * what comes out. Matches with no time hold no cell — they are listed under
 * the grid rather than silently dropped.
 */
export function previewCourtGridHtml({
  rows,
  meta,
}: {
  rows: readonly PreviewRow[];
  meta: PreviewExportMeta;
}): string {
  const days = buildCourtGrid(rows);
  const unplaced = rows.filter((r) => !r.placed);

  /** A stable two-letter chip per group/stage, coloured by its own name so
   * the eye can follow one group down a column. */
  const chip = (r: PreviewRow): string => {
    const name = r.group || r.stageLabel || "";
    const code =
      name
        .split(/\s+/)
        .map((w) => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase() || "—";
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="chip" style="background:hsl(${hash} 70% 94%);color:hsl(${hash} 55% 32%)">${esc(code)}</span>`;
  };

  const body = days
    .map((day) => {
      const head = day.courts
        .map((c) => `<th class="court">${esc(c)}</th>`)
        .join("");
      const slots = day.slots
        .map((slot) => {
          const cells = slot.cells
            .map((r) => {
              if (!r) return `<td class="idle"></td>`;
              // "Knockout · Round 3" told an official nothing; the round's
              // own name does (owner 2026-08-19).
              const line = [
                r.number ? `${t("Match")} ${r.number}` : "",
                r.group || r.stageLabel,
                r.roundLabel,
              ]
                .filter(Boolean)
                .join(" · ");
              return `<td class="cell">
                <div class="tag">${chip(r)}<span class="line">${esc(line)}</span></div>
                <div class="who"><span class="team">${crestImg(r.homeCrest)}${esc(r.home)}</span><span class="vs">${esc(t("vs"))}</span></div>
                <div class="who"><span class="team">${crestImg(r.awayCrest)}${esc(r.away)}</span></div>
                <div class="cat">${esc(r.sportLabel)} · ${esc(r.categoryLabel)}</div>
              </td>`;
            })
            .join("");
          return `<tr>
            <td class="time">
              <div class="start">${esc(fmtClock(slot.start))}</div>
              <div class="fin">${esc(fmtClock(slot.end))}</div>
              ${slot.stage ? `<div class="stage">${esc(slot.stage)}</div>` : ""}
            </td>${cells}</tr>`;
        })
        .join("");
      return `<h2>${esc(day.dayLabel)}</h2>
        <table class="grid">
          <thead><tr><th class="time-h">${esc(t("Time"))}</th>${head}</tr></thead>
          <tbody>${slots}</tbody>
        </table>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("court grid"))}</title>
<style>${baseCss()}
  body { padding: 20px; }
  h2 { font-size: 11px; font-weight: 600; margin: 14px 0 6px; color: #111827; }
  table.grid { width: 100%; border-collapse: separate; border-spacing: 0;
               border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  th { background: #1e293b; color: #fff; text-align: left; font-size: 9px;
       font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
       padding: 8px 10px; }
  th.time-h { width: 92px; }
  td { border-top: 1px solid #eef1f5; padding: 7px 10px; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafbfc; }
  td.time { width: 92px; white-space: nowrap; background: #f7f8fa; }
  .start { font-size: 11px; font-weight: 700; }
  .fin { color: #9ca3af; font-size: 9px; }
  .stage { color: #2563eb; font-size: 7.5px; font-weight: 700;
           text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
  .tag { display: flex; align-items: center; gap: 5px; margin-bottom: 3px; }
  .chip { display: inline-block; border-radius: 4px; padding: 1px 4px;
          font-size: 7.5px; font-weight: 700; letter-spacing: 0.04em; }
  .line { color: #4b5563; font-size: 7.5px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.06em; }
  .who { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .team { font-weight: 600; font-size: 9.5px; }
  .vs { color: #9ca3af; font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.08em; }
  .cat { color: #9ca3af; font-size: 7.5px; margin-top: 2px; }
  td.idle { background: #fcfcfd; }
  .none { margin-top: 12px; }
  .none h3 { font-size: 10px; color: #b45309; }
  .none li { font-size: 9px; color: #4b5563; }
</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: t("Every court, one view"),
    scope: `${meta.shown} ${t("matches")}`,
    filterSummary: meta.filterSummary,
    note: t("Trial run. This schedule is not published yet."),
  })}
  ${body || `<p class="meta">${esc(t("No matches have a time yet."))}</p>`}
  ${
    unplaced.length
      ? `<div class="none"><h3>${esc(t("Still without a time"))}</h3><ul>${unplaced
          .map(
            (r) =>
              `<li>${esc(r.sportLabel)} · ${esc(r.categoryLabel)} · ${crestImg(
                r.homeCrest,
                12,
              )}${esc(r.home)} ${esc(t("vs"))} ${crestImg(r.awayCrest, 12)}${esc(r.away)}</li>`,
          )
          .join("")}</ul></div>`
      : ""
  }
  ${docFooter()}
</body></html>`;
}

/** Open the court grid in a new tab and raise the print dialog. */
export function openPreviewCourtGridPdf(opts: {
  rows: readonly PreviewRow[];
  meta: PreviewExportMeta;
}): void {
  openPrintable(previewCourtGridHtml(opts));
}

/** Open the landscape run sheet in a new tab and raise the print dialog. */
export function openPreviewPdf(opts: {
  rows: readonly PreviewRow[];
  sort: GridSort | null;
  groupBy: GroupBy;
  occupancy?: readonly PreviewMatch[];
  blackouts?: readonly BlackoutWindow[];
  meta: PreviewExportMeta;
}): void {
  openPrintable(previewPdfHtml(opts));
}
