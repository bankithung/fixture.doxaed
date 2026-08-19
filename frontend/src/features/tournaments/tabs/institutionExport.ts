import type { Institution } from "@/api/institutions";
import { t } from "@/lib/t";

/** What the export describes, beyond the rows themselves. */
export interface ExportMeta {
  /** Document heading: the tournament's name. */
  title: string;
  /** Sub-heading under it (the form title, e.g. "Institution registration"). */
  subtitle?: string;
  /** Human summary of the active filters ("" when none). */
  filterSummary: string;
  shownCount: number;
  totalCount: number;
}

function csvCell(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function compLabels(inst: Institution): string[] {
  return (inst.competitions ?? []).map((c) => c.label.replace(/\s+—\s+/g, " · "));
}

/** Download the (already filtered) rows as a spreadsheet-ready CSV. */
export function downloadInstitutionsCsv(
  rows: Institution[],
  meta: ExportMeta,
): void {
  const header = [
    t("Institution"),
    t("Type"),
    t("Region"),
    t("Contact name"),
    t("Phone"),
    t("Email"),
    t("Competitions"),
    t("Teams"),
    t("Status"),
  ];
  const lines = [
    header.map(csvCell).join(","),
    ...rows.map((i) =>
      [
        i.name,
        i.kind,
        i.region,
        i.contact_name,
        i.contact_phone,
        i.contact_email,
        compLabels(i).join("; "),
        i.team_count,
        i.status,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  // BOM so Excel reads UTF-8 names correctly.
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
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

/**
 * A school's badge for the printed sheet, or NOTHING when it has none.
 *
 * The document is generated HTML, so `components/ui/TeamCrest` and its
 * fall-back-to-initials cannot run here — and a printed page has no way to
 * recover from a missing image, it just carries the broken-image icon onto
 * the paper. No crest, no tag.
 */
function crestImg(url: string | undefined): string {
  if (!url) return "";
  return (
    `<img src="${esc(url)}" alt="" width="16" height="16" ` +
    `style="border-radius:50%;object-fit:cover;vertical-align:middle;` +
    `margin-right:6px;border:1px solid #e5e7eb;background:#fff">`
  );
}

const STATUS_COLOR: Record<string, string> = {
  registered: "#166534",
  invited: "#92400e",
  withdrawn: "#6b7280",
  rejected: "#b91c1c",
};

/**
 * Open a print-ready, branded document of the (already filtered) rows in a
 * new tab and bring up the print dialog — saving as PDF from there gives the
 * shareable file. All data inlined; no network needed.
 */
export function openInstitutionsPdf(
  rows: Institution[],
  meta: ExportMeta,
): void {
  const dateStr = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const scope =
    meta.shownCount === meta.totalCount
      ? `${meta.totalCount} ${meta.totalCount === 1 ? t("school") : t("schools")}`
      : `${meta.shownCount} ${t("of")} ${meta.totalCount} ${t("schools")}`;

  const bodyRows = rows
    .map((i, idx) => {
      const contact = [
        i.contact_name ? `<div class="c-name">${esc(i.contact_name)}</div>` : "",
        i.contact_phone || i.contact_email
          ? `<div class="c-sub">${esc([i.contact_phone, i.contact_email].filter(Boolean).join(" · "))}</div>`
          : "",
      ].join("");
      const comps = compLabels(i)
        .map((l) => `<span class="chip">${esc(l)}</span>`)
        .join(" ");
      return `<tr>
        <td class="num">${idx + 1}</td>
        <td class="name">${crestImg(i.crest)}${esc(i.name)}</td>
        <td class="cap">${esc(i.kind)}</td>
        <td>${esc(i.region || "")}</td>
        <td>${contact}</td>
        <td>${comps || '<span class="c-sub">·</span>'}</td>
        <td class="num">${i.team_count}</td>
        <td><span class="status cap" style="color:${STATUS_COLOR[i.status] ?? "#374151"}">${esc(i.status)}</span></td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 12px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; padding: 32px; }
  .band { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid #6840dd; padding-bottom: 12px; margin-bottom: 6px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: #6b7280; font-size: 13px; margin-top: 2px; }
  .brand { display: flex; align-items: center; gap: 8px; }
  .brand img { height: 28px; width: 28px; border-radius: 6px; object-fit: cover; }
  .brand span { color: #6840dd; font-size: 12px; font-weight: 600; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 4px; }
  .filters { color: #6840dd; font-size: 11px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; padding: 8px 8px; border-bottom: 1.5px solid #d1d5db; }
  td { padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tr:nth-child(even) td { background: #f9fafb; }
  .num { font-variant-numeric: tabular-nums; text-align: right; color: #6b7280; }
  td.name { font-weight: 600; }
  .cap { text-transform: capitalize; }
  .c-name { font-weight: 500; }
  .c-sub { color: #6b7280; font-size: 11px; }
  .chip { display: inline-block; border: 1px solid #ddd6fe; background: #f5f3ff; color: #4c1d95; border-radius: 4px; padding: 1px 6px; font-size: 10px; margin: 1px 2px 1px 0; }
  .status { font-weight: 600; }
  .foot { margin-top: 20px; color: #9ca3af; font-size: 10px; }
  @page { margin: 14mm; }
  @media print { body { padding: 0; } }
</style></head><body>
  <div class="band">
    <div><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<p class="sub">${esc(meta.subtitle)}</p>` : ""}</div>
    <div class="brand"><img src="${esc(window.location.origin)}/brand-logo.jpg" alt=""><span>fixture.doxaed.com</span></div>
  </div>
  <p class="meta">${esc(t("Exported"))} ${esc(dateStr)} · ${esc(scope)}</p>
  ${meta.filterSummary ? `<p class="filters">${esc(t("Filters applied"))}: ${esc(meta.filterSummary)}</p>` : ""}
  <table>
    <thead><tr>
      <th style="width:2rem">#</th><th>${esc(t("Institution"))}</th><th>${esc(t("Type"))}</th>
      <th>${esc(t("Region"))}</th><th>${esc(t("Contact"))}</th><th>${esc(t("Competitions"))}</th>
      <th style="text-align:right">${esc(t("Teams"))}</th><th>${esc(t("Status"))}</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <p class="foot">${esc(t("Generated by Fixture"))} · fixture.doxaed.com</p>
</body></html>`;

  // NO "noopener" here: with it window.open returns null, leaving a blank
  // tab we can never write into. The document is our own, same-origin.
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  // Print once the art is in (or after a beat if it never arrives), so the
  // header logo AND every school crest make it into the print preview. A bare
  // timeout is a guess, not a handshake: each crest is a signed URL this new
  // tab fetches for itself, and printing mid-fetch puts blank squares on the
  // paper. The ceiling is the other half of the deal — one dead crest URL
  // must never hold the dialog hostage.
  // (Same handshake as `features/fixtures/previewExport.ts` — keep in step.)
  let printed = false;
  const doPrint = (): void => {
    if (printed) return;
    printed = true;
    w.print();
  };
  // Guarded: a document stub with no query API is still a printable window.
  const all = w.document.querySelectorAll
    ? Array.from(w.document.querySelectorAll("img"))
    : [];
  const pending = all.filter((img) => !img.complete);
  if (!pending.length) {
    setTimeout(doPrint, 250);
    return;
  }
  let left = pending.length;
  const settle = (): void => {
    left -= 1;
    // A beat after the last one so the layout it changed has painted.
    if (left <= 0) setTimeout(doPrint, 50);
  };
  for (const img of pending) {
    img.addEventListener("load", settle);
    img.addEventListener("error", settle);
  }
  setTimeout(doPrint, 1500);
}
