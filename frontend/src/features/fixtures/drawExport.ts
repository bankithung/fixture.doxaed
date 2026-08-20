import { t } from "@/lib/t";
import {
  baseCss,
  crestImg,
  csvOf,
  docFooter,
  docHeader,
  downloadCsv,
  esc,
  fileStem,
  openPrintable,
} from "./exportDoc";
import type { DrawBracket, LeafDraw } from "./drawModel";
import { draftNote, type PreviewExportMeta } from "./previewExport";

/**
 * The DRAW as a document (owner 2026-08-20: "add export for the draw and court
 * so that i can print both, not just the sheet").
 *
 * The sheet answers "what happens when"; this answers "who is in what, and who
 * plays whom" — the sheet a draw is read out from, and the one that goes on the
 * noticeboard. It prints exactly what the Draw view is showing, filters and
 * all, from the same `drawModel` the screen reads.
 */

/** A team's entry list and its bracket, as ONE spreadsheet with a Section
 * column — the two are different shapes, and a reader must be able to tell
 * an entry line from a pairing without counting columns. */
export function drawCsv(
  leaves: readonly LeafDraw[],
  brackets: readonly DrawBracket[],
): string {
  const rows: string[][] = [];
  for (const leaf of leaves) {
    for (const line of leaf.lines) {
      rows.push([
        "Entry",
        leaf.label,
        line.group,
        String(line.slot),
        "",
        "",
        line.school,
        "",
        "",
      ]);
    }
  }
  for (const b of brackets) {
    for (const bye of b.byes) {
      rows.push(["Bye", b.label, "", "", "", bye.roundLabel, bye.name, "", ""]);
    }
    for (const r of b.rounds) {
      for (const p of r.pairs) {
        rows.push([
          "Bracket",
          b.label,
          "",
          "",
          String(p.number),
          p.roundLabel,
          p.home,
          p.away,
          p.when,
        ]);
      }
    }
  }
  return csvOf(
    [
      "Section",
      "Competition",
      "Group",
      "Slot",
      "Match",
      "Round",
      "Team 1",
      "Team 2",
      "Time",
    ],
    rows,
  );
}

export function downloadDrawCsv(
  leaves: readonly LeafDraw[],
  brackets: readonly DrawBracket[],
  meta: PreviewExportMeta,
): void {
  downloadCsv(drawCsv(leaves, brackets), `${fileStem("draw", meta.title)}.csv`);
}

function entryTable(leaf: LeafDraw): string {
  const body = leaf.lines
    .map(
      (line) =>
        `<tr><td class="num">${line.lineNo}</td><td>${esc(line.group)}</td>` +
        `<td class="num">${line.slot}</td>` +
        `<td class="team">${crestImg(line.crest)}${esc(line.school)}</td></tr>`,
    )
    .join("");
  return `<table class="entries">
    <thead><tr><th style="width:1.8rem">#</th><th style="width:22%">${esc(t("Group"))}</th>
      <th style="width:2.6rem;text-align:right">${esc(t("Slot"))}</th><th>${esc(t("Team"))}</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function bracketTable(b: DrawBracket): string {
  const byes = b.byes.length
    ? `<p class="byes">${esc(t("Byes"))}: ${b.byes
        .map(
          (bye) =>
            `${crestImg(bye.crest, 12)}${esc(bye.name)} <span class="muted">${esc(
              t("into the"),
            )} ${esc(bye.roundLabel.toLowerCase())}</span>`,
        )
        .join(" · ")}</p>`
    : "";
  const body = b.rounds
    .map((r) => {
      const head = `<tr class="band"><td colspan="5">${esc(r.label)}<span class="band-n">${
        r.pairs.length
      } ${esc(r.pairs.length === 1 ? t("match") : t("matches"))}</span></td></tr>`;
      const pairs = r.pairs
        .map(
          (p) =>
            `<tr><td class="num">${p.number}</td>` +
            `<td class="team">${crestImg(p.homeCrest)}${esc(p.home)}</td>` +
            `<td class="vs">${esc(t("v"))}</td>` +
            `<td class="team">${crestImg(p.awayCrest)}${esc(p.away)}</td>` +
            `<td class="when">${esc(p.when || "·")}</td></tr>`,
        )
        .join("");
      return head + pairs;
    })
    .join("");
  return `${byes}<table class="bracket">
    <thead><tr><th style="width:1.8rem">${esc(t("Match"))}</th><th>${esc(t("Team 1"))}</th>
      <th style="width:1.4rem"></th><th>${esc(t("Team 2"))}</th>
      <th style="width:26%">${esc(t("Time"))}</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

/** Build the draw document (exported for tests). */
export function drawPdfHtml({
  leaves,
  brackets,
  meta,
}: {
  leaves: readonly LeafDraw[];
  brackets: readonly DrawBracket[];
  meta: PreviewExportMeta;
}): string {
  // A competition is ONE section: its entry list, then its bracket. Reading
  // them apart would mean flipping pages to answer "which group is this team
  // in and who do they meet".
  const keys = [
    ...new Set([...leaves.map((l) => l.leafKey), ...brackets.map((b) => b.leafKey)]),
  ];
  const sections = keys
    .map((key) => {
      const leaf = leaves.find((l) => l.leafKey === key);
      const bracket = brackets.find((b) => b.leafKey === key);
      const label = leaf?.label || bracket?.label || key;
      const count = leaf
        ? `${leaf.lines.length} ${t("teams")} · ${leaf.groupCount} ${
            leaf.groupCount === 1 ? t("group") : t("groups")
          }`
        : `${bracket?.rounds.reduce((n, r) => n + r.pairs.length, 0) ?? 0} ${t("matches")}`;
      return `<section class="comp">
        <h2>${esc(label)}<span class="cnt">${esc(count)}</span></h2>
        ${leaf ? entryTable(leaf) : ""}
        ${bracket ? bracketTable(bracket) : ""}
      </section>`;
    })
    .join("");

  const teams = leaves.reduce((n, l) => n + l.lines.length, 0);
  const scope = `${keys.length} ${
    keys.length === 1 ? t("competition") : t("competitions")
  } · ${teams} ${t("teams")}`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("draw"))}</title>
<style>${baseCss("portrait")}
  .comp { margin-top: 14px; break-inside: auto; }
  h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
       font-size: 11px; font-weight: 600; border-bottom: 1.5px solid #6840dd;
       padding-bottom: 3px; margin-bottom: 6px; }
  .cnt { font-weight: 500; font-size: 8.5px; color: #6b7280; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em;
       color: #374151; padding: 4px 5px; border-bottom: 1.5px solid #9ca3af; background: #f3f4f6; }
  td { padding: 3px 5px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  .num { font-variant-numeric: tabular-nums; text-align: right; color: #4b5563; white-space: nowrap; }
  .muted { color: #6b7280; font-weight: 500; }
  .team { font-weight: 600; }
  .vs { color: #9ca3af; font-size: 7.5px; text-align: center; text-transform: uppercase; }
  .when { font-variant-numeric: tabular-nums; color: #6b7280; white-space: nowrap; }
  tr.band td { background: #ede9fe !important; font-weight: 600; text-transform: uppercase;
               letter-spacing: 0.05em; font-size: 8.5px; color: #4c1d95; padding: 4px 5px; }
  .band-n { float: right; font-weight: 500; color: #6b7280; text-transform: none; letter-spacing: 0; }
  .byes { background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 6px;
          padding: 4px 6px; margin-bottom: 6px; font-size: 8.5px; color: #4c1d95; }
</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: t("The draw: entry lists and knockout pairings"),
    scope,
    filterSummary: meta.filterSummary,
    note: draftNote(meta),
  })}
  ${sections || `<p class="meta">${esc(t("No groups in this preview."))}</p>`}
  ${docFooter()}
</body></html>`;
}

/** Open the draw in a new tab and raise the print dialog. */
export function openDrawPdf(opts: {
  leaves: readonly LeafDraw[];
  brackets: readonly DrawBracket[];
  meta: PreviewExportMeta;
}): void {
  openPrintable(drawPdfHtml(opts));
}
