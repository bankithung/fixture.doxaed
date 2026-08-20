import { t } from "@/lib/t";
import {
  baseCss,
  csvOf,
  docFooter,
  docHeader,
  downloadCsv,
  esc,
  fileStem,
  openPrintable,
} from "./exportDoc";
import {
  courtTotals,
  fmtDuration,
  type CourtDayLoad,
  type SportLoad,
} from "./courtLoad";
import { fmtClock, fromMinutes } from "./previewGrid";
import { draftNote, type PreviewExportMeta } from "./previewExport";

/**
 * The COURTS view as a document (owner 2026-08-20: "add export for the draw
 * and court so that i can print both, not just the sheet").
 *
 * It carries both halves of the screen: when each court is playing, on a
 * break, or standing free, and how much court time each competition consumes.
 * The timeline is drawn on paper too — it is the answer to "when is court 2
 * free" — but every stretch it shows is ALSO written out in words underneath,
 * because a printer with background graphics turned off would otherwise print
 * an empty box (the same reason the screen carries the free chips).
 */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const clock = (min: number): string => fmtClock(fromMinutes(min));

/** Both tables of the Courts view as ONE spreadsheet, told apart by Section. */
export function courtCsv(
  loads: readonly CourtDayLoad[],
  sports: readonly SportLoad[],
): string {
  const head = [
    "Section",
    "Day",
    "Court",
    "Sport",
    "Competition",
    "From",
    "To",
    "Minutes",
    "Matches",
    "Free minutes",
    "Break minutes",
    "Utilisation",
    "Days",
    "Courts",
    "Share",
    "Detail",
  ];
  const rows: string[][] = [];
  for (const l of loads) {
    rows.push([
      "Court day",
      l.dayLabel,
      l.court,
      "",
      "",
      clock(l.windowStart),
      clock(l.windowEnd),
      String(l.busyMinutes),
      String(l.matches),
      String(l.freeMinutes),
      String(l.breakMinutes),
      pct(l.utilization),
      "",
      "",
      "",
      "",
    ]);
    for (const g of l.gaps) {
      rows.push([
        g.kind === "break" ? "Break" : "Court free",
        l.dayLabel,
        l.court,
        "",
        "",
        clock(g.start),
        clock(g.end),
        String(g.minutes),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        g.label,
      ]);
    }
  }
  for (const s of sports) {
    for (const c of s.competitions) {
      rows.push([
        "Competition",
        "",
        "",
        s.sportLabel,
        c.categoryLabel,
        "",
        "",
        String(c.minutes),
        String(c.matches),
        "",
        "",
        "",
        String(c.days),
        String(c.courts),
        pct(c.share),
        c.scheduled < c.matches ? `${c.matches - c.scheduled} without a time` : "",
      ]);
    }
  }
  return csvOf(head, rows);
}

export function downloadCourtCsv(
  loads: readonly CourtDayLoad[],
  sports: readonly SportLoad[],
  meta: PreviewExportMeta,
): void {
  downloadCsv(courtCsv(loads, sports), `${fileStem("court-time", meta.title)}.csv`);
}

/** Print tints per sport — fixed hex, because a generated tab has no tokens. */
const SPORT_TINTS = ["#ddd6fe", "#bfdbfe", "#bbf7d0", "#fed7aa", "#fecdd3"];

function tintFor(sportKeys: readonly string[], key: string): string {
  const i = sportKeys.indexOf(key);
  return SPORT_TINTS[(i < 0 ? 0 : i) % SPORT_TINTS.length]!;
}

/** One court's day drawn to scale, on the same bounds as every other court. */
function timeline(
  load: CourtDayLoad,
  sportKeys: readonly string[],
  from: number,
  to: number,
): string {
  const span = Math.max(1, to - from);
  const at = (min: number): number => ((min - from) / span) * 100;
  const width = (mins: number): number => (mins / span) * 100;
  const gaps = load.gaps
    .map(
      (g) =>
        `<span class="seg ${g.kind === "break" ? "brk" : "free"}" style="left:${at(
          g.start,
        )}%;width:${width(g.minutes)}%"></span>`,
    )
    .join("");
  const blocks = load.blocks
    .map(
      (b) =>
        `<span class="seg play" style="left:${at(b.start)}%;width:${width(
          b.end - b.start,
        )}%;background:${tintFor(sportKeys, b.sportKey)}"></span>`,
    )
    .join("");
  return `<div class="bar">${gaps}${blocks}</div>`;
}

/** The hour ruler above one day's courts. */
function hourAxis(from: number, to: number): string {
  const span = Math.max(1, to - from);
  const step = span > 480 ? 120 : 60;
  const first = Math.ceil(from / step) * step;
  const ticks: string[] = [];
  for (let m = first; m <= to; m += step) {
    ticks.push(
      `<span class="tick" style="left:${((m - from) / span) * 100}%">${esc(
        clock(m),
      )}</span>`,
    );
  }
  return `<div class="axis">${ticks.join("")}</div>`;
}

/** The free stretches of one court's day, in words. */
function freeText(load: CourtDayLoad): string {
  const free = load.gaps.filter((g) => g.kind === "free" && g.minutes > 0);
  if (!free.length) return `<p class="gaps">${esc(t("Fully used"))}</p>`;
  return `<p class="gaps">${esc(t("Free"))}: ${free
    .map(
      (g) =>
        `${esc(clock(g.start))} ${esc(t("to"))} ${esc(clock(g.end))} <b>${esc(
          fmtDuration(g.minutes),
        )}</b>`,
    )
    .join(" · ")}</p>`;
}

/** Build the court-time document (exported for tests). */
export function courtPdfHtml({
  loads,
  sports,
  meta,
}: {
  loads: readonly CourtDayLoad[];
  sports: readonly SportLoad[];
  meta: PreviewExportMeta;
}): string {
  const totals = courtTotals(loads);
  const sportKeys = sports.map((s) => s.sportKey);
  const grandMinutes = sports.reduce((sum, s) => sum + s.minutes, 0);

  // One set of bounds per day, so two courts can be compared by eye and the
  // ruler above them is true for both.
  const byDay = new Map<string, CourtDayLoad[]>();
  for (const l of loads) {
    const list = byDay.get(l.day);
    if (list) list.push(l);
    else byDay.set(l.day, [l]);
  }

  const days = [...byDay.entries()]
    .map(([, list]) => {
      const from = Math.min(...list.map((l) => l.windowStart));
      const to = Math.max(...list.map((l) => l.windowEnd));
      const courts = list
        .map(
          (l) => `<div class="court">
            <div class="chead">
              <b>${esc(l.court)}</b>
              <span class="open">${esc(clock(l.windowStart))} ${esc(t("to"))} ${esc(
                clock(l.windowEnd),
              )}</span>
              <span class="stats">${l.matches} ${esc(
                l.matches === 1 ? t("match") : t("matches"),
              )} · ${esc(
                t("used"),
              )} <b>${esc(fmtDuration(l.busyMinutes))}</b> · ${esc(t("free"))} <b>${esc(
                fmtDuration(l.freeMinutes),
              )}</b> · <b>${esc(pct(l.utilization))}</b></span>
            </div>
            ${timeline(l, sportKeys, from, to)}
            ${freeText(l)}
          </div>`,
        )
        .join("");
      return `<section class="day">
        <h2>${esc(list[0]!.dayLabel)}</h2>
        ${hourAxis(from, to)}
        ${courts}
      </section>`;
    })
    .join("");

  const legend = [
    ...sports.map(
      (s) =>
        `<span class="key"><span class="sw" style="background:${tintFor(
          sportKeys,
          s.sportKey,
        )}"></span>${esc(s.sportLabel)}</span>`,
    ),
    `<span class="key"><span class="sw brk"></span>${esc(t("Break you set"))}</span>`,
    `<span class="key"><span class="sw free"></span>${esc(t("Court free"))}</span>`,
  ].join("");

  const compBody = sports
    .map((s) => {
      const band = `<tr class="band"><td colspan="7">${esc(
        s.sportLabel,
      )}<span class="band-n">${s.matches} ${esc(
        s.matches === 1 ? t("match") : t("matches"),
      )} · ${esc(
        fmtDuration(s.minutes),
      )} · ${esc(pct(s.share))}</span></td></tr>`;
      const rows = s.competitions
        .map(
          (c) =>
            `<tr><td>${esc(c.categoryLabel)}</td>` +
            `<td class="num">${c.matches}${
              c.scheduled < c.matches
                ? ` <span class="warn">(${c.matches - c.scheduled} ${esc(
                    t("no time"),
                  )})</span>`
                : ""
            }</td>` +
            `<td class="num strong">${esc(fmtDuration(c.minutes))}</td>` +
            `<td class="num">${c.avgMinutes} ${esc(t("min"))}</td>` +
            `<td class="num">${c.days}</td><td class="num">${c.courts}</td>` +
            `<td class="num">${esc(pct(c.share))}</td></tr>`,
        )
        .join("");
      return band + rows;
    })
    .join("");

  const scope = `${totals.courts} ${
    totals.courts === 1 ? t("court") : t("courts")
  } · ${totals.courtDays} ${t("court days")}`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(meta.title)} ${esc(t("court time"))}</title>
<style>${baseCss()}
  .stats-band { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .stat { border: 1px solid #e5e7eb; border-radius: 6px; padding: 5px 9px; min-width: 108px; }
  .stat .lbl { display: block; font-size: 7.5px; text-transform: uppercase;
               letter-spacing: 0.06em; color: #6b7280; }
  .stat .val { display: block; font-size: 12px; font-weight: 600;
               font-variant-numeric: tabular-nums; }
  .stat .note { display: block; font-size: 7.5px; color: #9ca3af; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px;
            font-size: 8px; color: #4b5563; }
  .key { display: inline-flex; align-items: center; gap: 4px; }
  .sw { display: inline-block; width: 14px; height: 8px; border-radius: 2px;
        border: 1px solid #cbd5e1; background: #fff; }
  .sw.brk { background: #fef3c7; }
  .sw.free { background: #fff; border-style: dashed; }
  .day { margin-top: 14px; }
  h2 { font-size: 11px; font-weight: 600; border-bottom: 1.5px solid #6840dd;
       padding-bottom: 3px; margin-bottom: 6px; }
  .axis { position: relative; height: 11px; margin: 0 0 2px; }
  .tick { position: absolute; top: 0; transform: translateX(-50%); font-size: 7px;
          color: #9ca3af; font-variant-numeric: tabular-nums; }
  .court { border: 1px solid #e5e7eb; border-radius: 6px; padding: 5px 7px;
           margin-bottom: 5px; break-inside: avoid; }
  .chead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 9px; }
  .chead .open { color: #6b7280; font-variant-numeric: tabular-nums; }
  .chead .stats { margin-left: auto; color: #4b5563; font-variant-numeric: tabular-nums; }
  .bar { position: relative; height: 14px; margin: 4px 0 3px; border: 1px solid #cbd5e1;
         border-radius: 3px; overflow: hidden; background: #fff; }
  .seg { position: absolute; top: 0; bottom: 0; }
  .seg.play { border-right: 1px solid #94a3b8; }
  .seg.brk { background: #fef3c7; }
  .seg.free { background: repeating-linear-gradient(135deg, transparent 0 4px, #e2e8f0 4px 5px); }
  .gaps { font-size: 7.5px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em;
       color: #374151; padding: 4px 5px; border-bottom: 1.5px solid #9ca3af; background: #f3f4f6; }
  td { padding: 3px 5px; border-bottom: 1px solid #e5e7eb; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; color: #4b5563; }
  .strong { color: #111827; font-weight: 600; }
  .warn { color: #b45309; }
  tr.band td { background: #ede9fe !important; font-weight: 600; text-transform: uppercase;
               letter-spacing: 0.05em; font-size: 8.5px; color: #4c1d95; }
  .band-n { float: right; font-weight: 500; color: #6b7280; text-transform: none; letter-spacing: 0; }
  tr.total td { background: #f3f4f6; font-weight: 600; }
</style></head><body>
  ${docHeader({
    title: meta.title,
    subtitle: t("Court time: when each court plays, breaks and stands free"),
    scope,
    filterSummary: meta.filterSummary,
    note: draftNote(meta),
  })}
  <div class="stats-band">
    <span class="stat"><span class="lbl">${esc(t("Court time used"))}</span>
      <span class="val">${esc(fmtDuration(totals.busyMinutes))}</span>
      <span class="note">${totals.courts} ${esc(t("courts"))} · ${totals.courtDays} ${esc(
        t("court days"),
      )}</span></span>
    <span class="stat"><span class="lbl">${esc(t("Court time free"))}</span>
      <span class="val">${esc(fmtDuration(totals.freeMinutes))}</span>
      <span class="note">${
        totals.biggestFree
          ? `${esc(t("Biggest"))} ${esc(fmtDuration(totals.biggestFree.gap.minutes))} · ${esc(
              totals.biggestFree.court,
            )}`
          : ""
      }</span></span>
    <span class="stat"><span class="lbl">${esc(t("Breaks and ceremonies"))}</span>
      <span class="val">${esc(fmtDuration(totals.breakMinutes))}</span>
      <span class="note">${esc(t("Time you closed the courts"))}</span></span>
    <span class="stat"><span class="lbl">${esc(t("Utilisation"))}</span>
      <span class="val">${esc(pct(totals.utilization))}</span>
      <span class="note">${esc(t("Of the hours the courts are open"))}</span></span>
  </div>
  ${loads.length ? `<div class="legend">${legend}</div>` : ""}
  ${
    days ||
    `<p class="meta">${esc(t("No scheduled matches to measure court time from."))}</p>`
  }
  ${
    sports.length
      ? `<section class="day">
    <h2>${esc(t("Court time by competition"))}</h2>
    <table>
      <thead><tr><th>${esc(t("Competition"))}</th><th class="num">${esc(t("Matches"))}</th>
        <th class="num">${esc(t("Total time"))}</th><th class="num">${esc(t("Per match"))}</th>
        <th class="num">${esc(t("Days"))}</th><th class="num">${esc(t("Courts"))}</th>
        <th class="num">${esc(t("Share"))}</th></tr></thead>
      <tbody>${compBody}
        <tr class="total"><td>${esc(t("All competitions"))}</td>
          <td class="num">${sports.reduce((sum, s) => sum + s.matches, 0)}</td>
          <td class="num">${esc(fmtDuration(grandMinutes))}</td>
          <td colspan="4"></td></tr>
      </tbody>
    </table>
  </section>`
      : ""
  }
  ${docFooter()}
</body></html>`;
}

/** Open the court-time report in a new tab and raise the print dialog. */
export function openCourtPdf(opts: {
  loads: readonly CourtDayLoad[];
  sports: readonly SportLoad[];
  meta: PreviewExportMeta;
}): void {
  openPrintable(courtPdfHtml(opts));
}
