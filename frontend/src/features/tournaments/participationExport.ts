import {
  baseCss,
  docFooter,
  docHeader,
  esc,
  openPrintable,
} from "@/features/fixtures/exportDoc";
import {
  buildBands,
  buildColumns,
  type CompetitionLike,
  type WithCode,
} from "@/features/fixtures/entriesMatrix";
import { humanizeLeaf } from "@/features/controlroom/format";
import { t } from "@/lib/t";
import { fmtDob, fmtGender } from "./personFormat";
import {
  detailText,
  sportOf,
  type DetailColumn,
  type ParticipationRow,
  type ParticipationTotals,
} from "./participation";

/**
 * The participation workbench on PAPER (owner 2026-08-27).
 *
 * The sheet already exported as a spreadsheet, which is the right file for
 * working ON the data. It is the wrong one for the thing an organizer
 * actually does with this list: carry it into the room where the draw is
 * settled, and hand a school the page that shows their own children. That
 * wants a printed document, so the two views print through the SAME
 * `exportDoc` plumbing every fixture document uses — one header band, one
 * escaping rule, one print handshake.
 *
 * It prints WHAT IS ON SCREEN: the filtered rows in their current order, the
 * detail columns this event's form actually collected, and the view the host
 * is reading (sheet or matrix). A document that quietly printed something
 * else would be a second, disagreeing answer to the same question.
 */

export interface ParticipationDocMeta {
  /** The tournament, or a plain fallback when its name has not loaded. */
  title: string;
  /** Plain restatement of the applied filters ("" when none). */
  filterSummary: string;
  shown: number;
  total: number;
  /** The page's own headline numbers, restated on the paper. */
  totals: ParticipationTotals;
}

/** A person's name as the sheet writes it, teacher tag included. */
function nameOf(r: ParticipationRow): string {
  return r.kind === "teacher" ? `${r.name} (${t("Teacher")})` : r.name;
}

/** One detail cell, worded the way the SCREEN words it — a date of birth reads
 * "23 Jun 2014" on the page, and must not become an ISO string on the print. */
function detailCell(r: ParticipationRow, c: DetailColumn): string {
  const raw = detailText(r, c.key);
  if (!raw) return "·";
  if (c.key === "dob") return fmtDob(raw);
  if (c.key === "gender") return fmtGender(raw);
  if (c.key === "docs") return r.documents.map((d) => d.label || d.name).join(" · ");
  return raw;
}

/** The four readings the page leads with, as a strip under the header band. */
function statStrip(totals: ParticipationTotals): string {
  const stats: [number, string][] = [
    [totals.people, t("declared")],
    [totals.multi, t("in two or more")],
    [totals.multiAcrossSports, t("across two sports")],
    [totals.unentered, t("not entered yet")],
    [totals.busiest, t("most events by one person")],
  ];
  return `<div class="stats">${stats
    .map(
      ([n, label]) =>
        `<span class="stat"><b>${n}</b> ${esc(label)}</span>`,
    )
    .join("")}</div>`;
}

/** The shared look: the workbench is a spreadsheet, so its documents are too. */
function sheetCss(): string {
  return `
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: #374151;
       padding: 4px 5px; border: 1px solid #d1d5db; background: #f3f4f6; }
  td { padding: 3px 5px; border: 1px solid #e5e7eb; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  tr.multi td { background: #fffbeb; }
  .num { font-variant-numeric: tabular-nums; text-align: right; color: #4b5563; white-space: nowrap; }
  .gutter { width: 1.6rem; color: #9ca3af; }
  .who { font-weight: 600; }
  .muted { color: #6b7280; }
  .tiny { font-size: 7.5px; color: #6b7280; word-break: break-word; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .stat { font-size: 9px; color: #6b7280; }
  .stat b { font-size: 11px; color: #111827; font-variant-numeric: tabular-nums; }
  .none { margin-top: 10px; color: #b45309; font-size: 9px; }`;
}

/** The person-by-person document (exported for tests). */
export function participationSheetHtml({
  rows,
  columns,
  meta,
}: {
  rows: readonly ParticipationRow[];
  columns: readonly DetailColumn[];
  meta: ParticipationDocMeta;
}): string {
  const head = [
    t("Name"),
    ...columns.map((c) => t(c.label)),
    t("School"),
    t("Events"),
    t("Entered in"),
  ];
  const body = rows
    .map((r, i) => {
      const entered = r.entries.length
        ? r.entries
            .map(
              (e) =>
                `<div class="tiny"><b>${esc(e.sportLabel)}</b> · ${esc(e.categoryLabel)}</div>`,
            )
            .join("")
        : `<span class="muted">${esc(t("Not entered yet"))}</span>`;
      return `<tr${r.events > 1 ? ' class="multi"' : ""}>
        <td class="num gutter">${i + 1}</td>
        <td class="who">${esc(nameOf(r))}</td>
        ${columns
          .map(
            (c) =>
              `<td class="${c.key === "docs" ? "tiny" : "muted"}${
                c.align === "right" ? " num" : ""
              }">${esc(detailCell(r, c))}</td>`,
          )
          .join("")}
        <td class="muted">${esc(r.group || r.school || "·")}</td>
        <td class="num">${r.events}</td>
        <td>${entered}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("participation"))}</title>
<style>${baseCss()}${sheetCss()}</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: t("Who is playing what"),
    scope: scopeOf(meta),
    filterSummary: meta.filterSummary,
  })}
  ${statStrip(meta.totals)}
  <table>
    <thead><tr><th class="gutter">#</th>${head
      .map((h) => `<th>${esc(h)}</th>`)
      .join("")}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  ${rows.length ? "" : `<p class="none">${esc(t("No one matches these filters."))}</p>`}
  ${docFooter()}
</body></html>`;
}

/** "153 of 175 people" — what this document counts, and out of what. */
function scopeOf(meta: ParticipationDocMeta): string {
  const noun = meta.shown === 1 ? t("person") : t("people");
  return meta.shown === meta.total
    ? `${meta.total} ${noun}`
    : `${meta.shown} ${t("of")} ${meta.total} ${noun}`;
}

/**
 * The competitions the workbench faceted on, as matrix columns.
 *
 * The codes come from `entriesMatrix` rather than a second scheme of their
 * own: the public entries grid and the medal tally already head a column
 * "UBS", and one code meaning two different things across the product would
 * be worse than no code at all.
 */
export function matrixColumns(
  competitions: readonly { value: string; label: string }[],
): WithCode<CompetitionLike>[] {
  return buildColumns(
    competitions.map((c) => {
      const sportKey = sportOf(c.value);
      const sportName = sportKey ? humanizeLeaf(sportKey) : t("Tournament");
      const segs = c.label.split(" · ");
      return {
        leaf_key: c.value,
        sport_key: sportKey,
        sport_name: sportName,
        path: segs.length > 1 ? segs.slice(1) : [],
        label: c.label,
      };
    }),
  );
}

/** The literal grid: one column per competition, a tick where they are in it. */
export function participationMatrixHtml({
  rows,
  competitions,
  meta,
}: {
  rows: readonly ParticipationRow[];
  competitions: readonly { value: string; label: string }[];
  meta: ParticipationDocMeta;
}): string {
  const cols = matrixColumns(competitions);
  const bands = buildBands(cols);
  const body = rows
    .map((r, i) => {
      const mine = new Set(r.entries.map((e) => e.leafKey));
      return `<tr${r.events > 1 ? ' class="multi"' : ""}>
        <td class="num gutter">${i + 1}</td>
        <td class="who">${esc(nameOf(r))}</td>
        <td class="muted">${esc(r.group || r.school || "·")}</td>
        <td class="num">${r.events}</td>
        ${cols
          .map(
            (c) =>
              `<td class="tick">${mine.has(c.leaf_key) ? "&#10003;" : '<span class="dash">·</span>'}</td>`,
          )
          .join("")}
      </tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("participation matrix"))}</title>
<style>${baseCss()}${sheetCss()}
  td.tick { text-align: center; font-size: 11px; color: #4c1d95; }
  td.tick .dash { color: #d1d5db; }
  th.code { text-align: center; width: 22px; }
  th.band { text-align: center; background: #ede9fe; color: #4c1d95; }
  .legend { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .legend span { font-size: 8px; color: #4b5563; }
  .legend b { color: #4c1d95; }</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: t("Who is playing what"),
    scope: scopeOf(meta),
    filterSummary: meta.filterSummary,
  })}
  ${statStrip(meta.totals)}
  <table>
    <thead>
      <tr>
        <th class="gutter" colspan="4"></th>
        ${bands
          .map(
            (b) =>
              `<th class="band" colspan="${b.columns.length}">${esc(b.sportName)}</th>`,
          )
          .join("")}
      </tr>
      <tr>
        <th class="gutter">#</th>
        <th>${esc(t("Name"))}</th>
        <th>${esc(t("School"))}</th>
        <th>${esc(t("Events"))}</th>
        ${cols
          .map((c) => `<th class="code" title="${esc(c.label)}">${esc(c.code)}</th>`)
          .join("")}
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
  <div class="legend">${cols
    .map((c) => `<span><b>${esc(c.code)}</b> ${esc(c.label)}</span>`)
    .join("")}</div>
  ${rows.length ? "" : `<p class="none">${esc(t("No one matches these filters."))}</p>`}
  ${docFooter()}
</body></html>`;
}

/** Open the document for the view on screen and raise the print dialog —
 * "Save as PDF" there gives the shareable file. */
export function openParticipationPdf(opts: {
  view: "sheet" | "matrix";
  rows: readonly ParticipationRow[];
  columns: readonly DetailColumn[];
  competitions: readonly { value: string; label: string }[];
  meta: ParticipationDocMeta;
}): void {
  openPrintable(
    opts.view === "matrix"
      ? participationMatrixHtml({
          rows: opts.rows,
          competitions: opts.competitions,
          meta: opts.meta,
        })
      : participationSheetHtml({
          rows: opts.rows,
          columns: opts.columns,
          meta: opts.meta,
        }),
  );
}
