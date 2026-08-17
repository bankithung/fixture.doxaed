import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import {
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

function fileStem(meta: PreviewExportMeta): string {
  const slug = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `fixture-preview-${slug || "schedule"}-${new Date().toISOString().slice(0, 10)}`;
}

/** Download the rows the filters are showing, in the order they are shown. */
export function downloadPreviewCsv(
  rows: readonly PreviewRow[],
  meta: PreviewExportMeta,
): void {
  // BOM so Excel reads school names as UTF-8.
  const blob = new Blob(["﻿" + toCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileStem(meta)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The printed sheet's columns — the same reading order as the on-screen grid. */
const PDF_COLUMNS: [string, (r: PreviewRow) => string, string][] = [
  [t("Day"), (r) => r.dayLabel, ""],
  [t("Start"), (r) => fmtClock(r.start) || "·", "num"],
  [t("End"), (r) => fmtClock(r.end) || "·", "num"],
  [t("Min"), (r) => (r.minutes == null ? "·" : String(r.minutes)), "num"],
  [t("Court"), (r) => (r.day ? r.venue : "·"), ""],
  [t("Sport"), (r) => r.sportLabel, ""],
  [t("Category"), (r) => r.categoryLabel, "muted"],
  [t("Stage"), (r) => r.group || r.stageLabel, ""],
  [t("Rd"), (r) => (r.round ? `R${r.round}` : "·"), "num"],
  [t("Team 1"), (r) => r.home, "team"],
  [t("Team 2"), (r) => r.away, "team"],
  [t("Status"), (r) => (r.placed ? t("Scheduled") : t("No time")), ""],
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
          return `<tr${r.placed ? "" : ' class="unplaced"'}><td class="num">${lineNo}</td>${PDF_COLUMNS.map(
            ([, pick, cls]) => `<td class="${cls}">${esc(pick(r))}</td>`,
          ).join("")}</tr>`;
        })
        .join("");
      return head + cells;
    })
    .join("");

  const dateStr = new Date().toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const scope =
    meta.shown === meta.total
      ? `${meta.total} ${t("matches")}`
      : `${meta.shown} ${t("of")} ${meta.total} ${t("matches")}`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("preview"))}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 9.5px/1.35 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; padding: 24px; }
  .band-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid #6840dd; padding-bottom: 8px; }
  h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: #6b7280; font-size: 10px; margin-top: 2px; }
  .brand { color: #6840dd; font-size: 10px; font-weight: 600; white-space: nowrap; }
  .meta { color: #6b7280; font-size: 9px; margin-top: 6px; }
  .filters { color: #6840dd; font-size: 9px; margin-top: 2px; }
  .draft { color: #b45309; font-size: 9px; margin-top: 2px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: #374151;
       padding: 4px 5px; border-bottom: 1.5px solid #9ca3af; background: #f3f4f6; }
  td { padding: 3px 5px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tr { break-inside: avoid; }
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
  .foot { margin-top: 12px; color: #9ca3af; font-size: 8px; }
  @page { size: A4 landscape; margin: 10mm; }
  @media print { body { padding: 0; } }
</style></head><body>
  <div class="band-top">
    <div>
      <h1>${esc(meta.title)}</h1>
      <p class="sub">${esc(t("Fixture preview"))} · ${esc(t("grouped by"))} ${esc(meta.groupLabel.toLowerCase())}</p>
    </div>
    <div class="brand">fixture.doxaed.com</div>
  </div>
  <p class="meta">${esc(t("Exported"))} ${esc(dateStr)} · ${esc(scope)}</p>
  ${meta.filterSummary ? `<p class="filters">${esc(t("Filters applied"))}: ${esc(meta.filterSummary)}</p>` : ""}
  <p class="draft">${esc(t("Trial run. This schedule is not published yet."))}${
    meta.unplaced
      ? ` ${esc(`${meta.unplaced} ${t("match(es) still have no time.")}`)}`
      : ""
  }</p>
  <table>
    <thead><tr><th style="width:1.6rem">#</th>${PDF_COLUMNS.map(
      ([label, , cls]) =>
        `<th${cls === "num" ? ' style="text-align:right"' : ""}>${esc(label)}</th>`,
    ).join("")}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="foot">${esc(t("Generated by Fixture"))} · fixture.doxaed.com</p>
</body></html>`;
}

/**
 * Open the landscape run sheet in a new tab and raise the print dialog —
 * "Save as PDF" there gives the shareable file. Everything is inlined, so the
 * document needs no network and no PDF dependency.
 */
export function openPreviewPdf(opts: {
  rows: readonly PreviewRow[];
  sort: GridSort | null;
  groupBy: GroupBy;
  occupancy?: readonly PreviewMatch[];
  blackouts?: readonly BlackoutWindow[];
  meta: PreviewExportMeta;
}): void {
  // NO "noopener": with it window.open returns null, leaving a blank tab we
  // can never write into. The document is our own, same-origin.
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(previewPdfHtml(opts));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}
