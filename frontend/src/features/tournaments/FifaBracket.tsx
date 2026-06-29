import type { MatchRow, MatchSource } from "@/api/tournaments";
import { groupPositionLabel } from "@/features/fixtures/groupSlotLabel";
import { t } from "@/lib/t";

/* ---------------------------------------------------------------------------
 * World Cup knockout bracket — a deliberately THEMED rough sketch (owner ask,
 * 2026-06-29). Fixed purple stage / gold boxes / orange connectors / gold
 * trophy, an explicit exception to the tokens-only rule (see memory
 * world-cup-bracket-theme).
 *
 * This is a SKETCH, not a forecast. It draws the SHAPE of the knockout:
 * qualifiers on the outer edges flow through one EMPTY box per round into a
 * central champion + trophy, FIFA-style. It never predicts matchups or winners
 * (the boxes stay empty), but it DOES label each round as a column header
 * (Round of 32 / 16 / Quarter-finals / Semi-finals / Final), scaling with the
 * entrant count.
 * ------------------------------------------------------------------------- */
const C = {
  box: "#3a1d63",
  gold: "#c9a558",
  goldHi: "#e7ce8c",
  line: "#f15a26",
  text: "#ffffff",
} as const;

const STAGE_BG =
  "radial-gradient(130% 100% at 14% 96%, #5d2e93 0%, rgba(93,46,147,0) 52%)," +
  "linear-gradient(135deg, #3a1c67 0%, #46226e 48%, #3a1c67 100%)";

// Geometry (px). A balanced tree: every leaf gets ROW of vertical pitch, every
// node centres on its two children, so the columns line up by construction.
const ROW = 56;
const ITEM_H = 42;
const CARD_W = 152;
const BOX_W = 72;
const STUB = 16;
const CENTER_W = 210;
const CHAMP_W = 150;
const CHAMP_H = 56;
const TROPHY_H = 104;

/** Human label for an unresolved bracket slot from its typed pointer:
 * group_position -> "Group A top 1" / "Best 3rd #1"; winner/loser pointers are
 * not entrants (they resolve from an earlier match) so they return null. */
export function sourceLabel(src: MatchSource | null | undefined): string | null {
  if (!src) return null;
  if (src.type === "group_position") return groupPositionLabel(src);
  return null;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** A side is a knockout ENTRANT when it's a real team or a group_position slot
 * ("Group A top 1"). winner_of/loser_of/tbd are not entrants. */
function entrantLabel(
  team: MatchRow["home_team"],
  src: MatchSource | null | undefined,
): string | null {
  if (team?.name) return team.name;
  return sourceLabel(src);
}

/** Column item counts for one half, cards-first: [leaf, leaf/2, …, 1]. */
function halfCounts(leaf: number): number[] {
  const out: number[] = [];
  for (let c = leaf; c >= 1; c = Math.floor(c / 2)) out.push(c);
  return out;
}
const colWidth = (count: number, leaf: number): number =>
  (count === leaf ? CARD_W : BOX_W) + (count > 1 ? 2 * STUB : 0);
const halfWidth = (leaf: number): number =>
  halfCounts(leaf).reduce((sum, c) => sum + colWidth(c, leaf), 0);

/** FIFA round name from the number of teams still in that round. */
function roundName(teams: number): string {
  if (teams <= 2) return t("Final");
  if (teams === 4) return t("Semi-finals");
  if (teams === 8) return t("Quarter-finals");
  return `${t("Round of")} ${teams}`;
}

function EntrantCard({ label }: { label: string | null }): React.ReactElement {
  if (!label) {
    return (
      <div
        className="h-full w-full rounded-md"
        style={{ border: `1.5px dashed rgba(201,165,88,0.4)`, background: "rgba(58,29,99,0.4)" }}
      />
    );
  }
  return (
    <div
      className="flex h-full w-full items-center rounded-md px-2.5"
      style={{ background: C.box, border: `2px solid ${C.gold}` }}
    >
      <span className="truncate text-xs font-medium" style={{ color: C.text }}>
        {label}
      </span>
    </div>
  );
}

function EmptyBox(): React.ReactElement {
  return (
    <div
      className="h-full w-full rounded-md"
      style={{
        background: C.box,
        border: `2px solid ${C.gold}`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
      }}
    />
  );
}

/** One half of the bracket, absolutely positioned. `side` decides which way the
 * connectors flow (left half -> right toward centre, right half -> left). */
function BracketHalf({
  slots,
  side,
  height,
}: {
  slots: (string | null)[];
  side: "left" | "right";
  height: number;
}): React.ReactElement {
  const leaf = slots.length;
  const counts = halfCounts(leaf);
  const physical = side === "left" ? counts : [...counts].reverse();
  const widths = physical.map((c) => colWidth(c, leaf));
  const xs: number[] = [];
  let acc = 0;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const line = (s: React.CSSProperties, key: string) => (
    <span key={key} className="absolute" style={{ background: C.line, ...s }} />
  );

  const els: React.ReactElement[] = [];
  physical.forEach((count, pi) => {
    const x = xs[pi]!;
    const colW = widths[pi]!;
    const isCards = count === leaf;
    const itemW = isCards ? CARD_W : BOX_W;
    const itemLeft = side === "left" ? 0 : colW - itemW;
    const innerEdge = side === "left" ? itemW : colW - itemW;
    const elbow = side === "left" ? itemW + STUB : colW - itemW - STUB;
    const handoff = side === "left" ? colW : 0;
    const cy = (i: number) => (height * (i + 0.5)) / count;

    for (let i = 0; i < count; i++) {
      const top = cy(i) - ITEM_H / 2;
      els.push(
        <div
          key={`it-${pi}-${i}`}
          className="absolute"
          style={{ left: x + itemLeft, top, width: itemW, height: ITEM_H }}
        >
          {isCards ? <EntrantCard label={slots[i] ?? null} /> : <EmptyBox />}
        </div>,
      );
      // Merge connectors toward the centre (only for paired columns).
      if (count > 1 && i % 2 === 0 && i + 1 < count) {
        const a = cy(i);
        const b = cy(i + 1);
        const mid = (a + b) / 2;
        const h = (a1: number, b1: number, y: number, k: string) =>
          line({ left: x + Math.min(a1, b1), width: Math.abs(b1 - a1), top: y - 1, height: 2 }, k);
        els.push(h(innerEdge, elbow, a, `ha-${pi}-${i}`));
        els.push(h(innerEdge, elbow, b, `hb-${pi}-${i}`));
        els.push(
          line(
            { left: x + elbow - 1, width: 2, top: Math.min(a, b), height: Math.abs(b - a) },
            `v-${pi}-${i}`,
          ),
        );
        els.push(h(elbow, handoff, mid, `hm-${pi}-${i}`));
      }
    }
  });

  return (
    <div className="absolute" style={{ width: acc, height, top: 0, left: 0 }}>
      {els}
    </div>
  );
}

function GoldTrophy(): React.ReactElement {
  return (
    <svg viewBox="0 0 200 270" className="w-auto" style={{ height: TROPHY_H }} role="img" aria-label={t("Trophy")}>
      <defs>
        <linearGradient id="wcGold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7dd92" />
          <stop offset=".45" stopColor="#dcab47" />
          <stop offset="1" stopColor="#b07f1d" />
        </linearGradient>
      </defs>
      <path d="M54 52 C20 50 20 104 56 108" fill="none" stroke="url(#wcGold)" strokeWidth="10" strokeLinecap="round" />
      <path d="M146 52 C180 50 180 104 144 108" fill="none" stroke="url(#wcGold)" strokeWidth="10" strokeLinecap="round" />
      <path d="M52 38 H148 V70 C148 132 112 156 100 158 C88 156 52 132 52 70 Z" fill="url(#wcGold)" stroke="#9c6f16" strokeWidth="1.5" />
      <path d="M66 48 H94 V70 C94 110 80 128 73 134 C70 120 66 92 66 70 Z" fill="#fbe9b4" opacity=".5" />
      <rect x="91" y="158" width="18" height="26" fill="url(#wcGold)" />
      <path d="M68 184 H132 L142 206 H58 Z" fill="url(#wcGold)" stroke="#9c6f16" strokeWidth="1" />
      <rect x="54" y="206" width="92" height="15" rx="3" fill="#0f7a4f" />
      <rect x="60" y="221" width="80" height="11" rx="3" fill="url(#wcGold)" />
      <rect x="50" y="232" width="100" height="13" rx="4" fill="#0f7a4f" />
    </svg>
  );
}

/**
 * FIFA-style knockout bracket sketch. `columns` are [round_no, matches] (only
 * the entrants are read from them). Renders qualifier cards on the edges,
 * empty boxes per round converging to a centre champion + trophy.
 */
export function FifaBracket({
  columns,
}: {
  columns: [number, MatchRow[]][];
}): React.ReactElement {
  // Distinct entrants, round-1 first (so play-in pairs sit adjacent).
  const seen = new Set<string>();
  const entrants: string[] = [];
  const ordered = [...columns].sort((a, b) => a[0] - b[0]);
  for (const [, matches] of ordered) {
    for (const mt of matches) {
      for (const lbl of [
        entrantLabel(mt.home_team, mt.home_source),
        entrantLabel(mt.away_team, mt.away_source),
      ]) {
        if (lbl && !seen.has(lbl)) {
          seen.add(lbl);
          entrants.push(lbl);
        }
      }
    }
  }

  if (columns.length === 0 || entrants.length === 0) {
    return (
      <div className="w-full rounded-2xl p-6" style={{ background: STAGE_BG }}>
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>
          {t("No bracket yet.")}
        </p>
      </div>
    );
  }

  const fromGroups = ordered.some(([, ms]) =>
    ms.some(
      (mt) =>
        mt.home_source?.type === "group_position" ||
        mt.away_source?.type === "group_position",
    ),
  );

  const size = Math.max(2, nextPow2(entrants.length));
  const half = size / 2;
  // Spread entrants across both halves so neither side is mostly byes.
  const cut = Math.ceil(entrants.length / 2);
  const padHalf = (arr: string[]): (string | null)[] => {
    const a: (string | null)[] = [...arr];
    while (a.length < half) a.push(null);
    return a;
  };
  const leftSlots = padHalf(entrants.slice(0, cut));
  const rightSlots = padHalf(entrants.slice(cut));

  const H = half * ROW;
  const hw = halfWidth(half);
  const canvasW = hw * 2 + CENTER_W;
  // The champion is centred at midY and the trophy hangs below it, so the
  // canvas must reserve 2x that below-centre reach or the trophy gets clipped.
  const canvasH = Math.max(H, 2 * (CHAMP_H / 2 + 12 + TROPHY_H) + 24);
  const offY = (canvasH - H) / 2;
  const midY = canvasH / 2;

  // Finalist inner edges meet the centre column; champion sits in its middle.
  const champLeft = hw + (CENTER_W - CHAMP_W) / 2;
  const champRight = champLeft + CHAMP_W;
  const cline = (s: React.CSSProperties, key: string) => (
    <span key={key} className="absolute" style={{ background: C.line, ...s }} />
  );

  // FIFA round headers, mirrored on both halves, scaling with the field size:
  // "Round of 32 / 16", then Quarter-finals / Semi-finals / Final.
  const HEADER_H = 26;
  const rounds = halfCounts(half);
  const rWidths = rounds.map((c) => colWidth(c, half));
  let rAcc = 0;
  const rXs = rWidths.map((w) => {
    const x = rAcc;
    rAcc += w;
    return x;
  });
  const roundHeaders = rounds
    // Centre each header over the CARD/BOX, not the column (the column carries a
    // STUB connector gutter on its inner side, so column-centre sits off the item).
    .map((c, j) => ({
      c,
      cx: rXs[j]! + (c === half ? CARD_W : BOX_W) / 2,
      name: roundName(size / 2 ** j),
    }))
    .filter((h) => h.c > 1);
  const headerSpan = (cx: number, label: string, key: string) => (
    <span
      key={key}
      className="absolute -translate-x-1/2 whitespace-nowrap text-[0.625rem] font-semibold uppercase tracking-wider"
      style={{ left: cx, top: 4, color: C.goldHi }}
    >
      {label}
    </span>
  );

  return (
    <div
      role="figure"
      aria-label={t("Knockout bracket draw")}
      className="w-full overflow-x-auto rounded-2xl p-5 shadow-xl sm:p-7"
      style={{ background: STAGE_BG }}
    >
      <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
        {fromGroups
          ? t("Rough draw. Pairings set after the group stage.")
          : t("Rough draw. Pairings set as teams qualify.")}
      </p>
      <div className="mx-auto" style={{ width: canvasW }}>
        <div className="relative" style={{ width: canvasW, height: HEADER_H }}>
          {roundHeaders.map((h, i) => headerSpan(h.cx, h.name, `lh-${i}`))}
          {roundHeaders.map((h, i) => headerSpan(canvasW - h.cx, h.name, `rh-${i}`))}
          {headerSpan(canvasW / 2, t("Final"), "fh")}
        </div>
        <div className="relative" style={{ width: canvasW, height: canvasH }}>
          <div className="absolute" style={{ left: 0, top: offY, width: hw, height: H }}>
            <BracketHalf slots={leftSlots} side="left" height={H} />
          </div>
          <div className="absolute" style={{ left: hw + CENTER_W, top: offY, width: hw, height: H }}>
            <BracketHalf slots={rightSlots} side="right" height={H} />
          </div>

          {/* Centre connectors + champion + trophy. */}
          {cline({ left: hw, top: midY - 1, width: champLeft - hw, height: 2 }, "cl")}
          {cline({ left: champRight, top: midY - 1, width: hw + CENTER_W - champRight, height: 2 }, "cr")}
          <div
            className="absolute flex flex-col items-center justify-center gap-1 rounded-xl"
            style={{
              left: champLeft,
              top: midY - CHAMP_H / 2,
              width: CHAMP_W,
              height: CHAMP_H,
              background: C.box,
              border: `3px solid ${C.gold}`,
            }}
          >
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
              {t("Champion")}
            </span>
          </div>
          <div
            className="absolute flex justify-center"
            style={{ left: champLeft, top: midY + CHAMP_H / 2 + 12, width: CHAMP_W }}
          >
            <GoldTrophy />
          </div>
        </div>
      </div>
    </div>
  );
}
