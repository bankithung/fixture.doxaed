import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
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
              const line = [r.group || r.stageLabel, `${t("Round")} ${r.round}`]
                .filter(Boolean)
                .join(" · ");
              return `<td class="cell">
                <div class="tag">${chip(r)}<span class="line">${esc(line)}</span></div>
                <div class="who"><span class="team">${esc(r.home)}</span><span class="vs">${esc(t("vs"))}</span></div>
                <div class="who"><span class="team">${esc(r.away)}</span></div>
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

  const dateStr = new Date().toLocaleString(undefined, {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("court grid"))}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 9.5px/1.35 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; padding: 20px; background: #fff; }
  .band-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid #6840dd; padding-bottom: 8px; }
  h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: #6b7280; font-size: 10px; margin-top: 2px; }
  .brand { color: #6840dd; font-size: 10px; font-weight: 600; white-space: nowrap; }
  .meta { color: #6b7280; font-size: 9px; margin-top: 6px; }
  .draft { color: #b45309; font-size: 9px; margin-top: 2px; font-weight: 600; }
  h2 { font-size: 11px; font-weight: 600; margin: 14px 0 6px; color: #111827; }
  table.grid { width: 100%; border-collapse: separate; border-spacing: 0;
               border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  thead { display: table-header-group; }
  th { background: #1e293b; color: #fff; text-align: left; font-size: 9px;
       font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
       padding: 8px 10px; }
  th.time-h { width: 92px; }
  tr { break-inside: avoid; }
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
  .foot { margin-top: 12px; color: #9ca3af; font-size: 8px; }
  @page { size: A4 landscape; margin: 10mm; }
  @media print { body { padding: 0; } }
</style></head><body>
  <div class="band-top">
    <div>
      <h1>${esc(meta.title)}</h1>
      <p class="sub">${esc(t("Every court, one view"))}</p>
    </div>
    <div class="brand">fixture.doxaed.com</div>
  </div>
  <p class="meta">${esc(t("Exported"))} ${esc(dateStr)} · ${esc(`${meta.shown} ${t("matches")}`)}</p>
  ${meta.filterSummary ? `<p class="meta">${esc(t("Filters applied"))}: ${esc(meta.filterSummary)}</p>` : ""}
  <p class="draft">${esc(t("Trial run. This schedule is not published yet."))}</p>
  ${body || `<p class="meta">${esc(t("No matches have a time yet."))}</p>`}
  ${
    unplaced.length
      ? `<div class="none"><h3>${esc(t("Still without a time"))}</h3><ul>${unplaced
          .map(
            (r) =>
              `<li>${esc(r.sportLabel)} · ${esc(r.categoryLabel)} · ${esc(r.home)} ${esc(t("vs"))} ${esc(r.away)}</li>`,
          )
          .join("")}</ul></div>`
      : ""
  }
  <p class="foot">${esc(t("Generated by Fixture"))} · fixture.doxaed.com</p>
</body></html>`;
}

/** Open the court grid in a new tab and raise the print dialog. */
export function openPreviewCourtGridPdf(opts: {
  rows: readonly PreviewRow[];
  meta: PreviewExportMeta;
}): void {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(previewCourtGridHtml(opts));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
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
