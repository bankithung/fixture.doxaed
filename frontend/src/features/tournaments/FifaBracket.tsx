import type { MatchRow, MatchSource } from "@/api/tournaments";
import { groupPositionLabel } from "@/features/fixtures/groupSlotLabel";
import { t } from "@/lib/t";

/* ---------------------------------------------------------------------------
 * World Cup knockout bracket — a deliberately THEMED flow-chart (owner ask,
 * 2026-06-29 / 30). Fixed purple stage / gold match cards / orange connectors /
 * gold trophy, an explicit exception to the tokens-only rule (see memory
 * world-cup-bracket-theme).
 *
 * Unlike the earlier "sketch", this draws the REAL draw: every match is a card
 * with its two sides + scores, a winner highlight, and a status strip, wired
 * left -> centre -> right into a central Final + champion + trophy, FIFA-style.
 * Unresolved slots still read cleanly ("Group A top 1" / "TBD") so it works for
 * the dry-run preview (placeholder Stage 2) AND the live/public bracket (real
 * results streaming in) from the same `columns` prop.
 *
 * Layout model: the FIRST half of each round's matches flows down the LEFT side
 * (rounds increasing rightward), the SECOND half mirrors on the RIGHT, and the
 * single last-round match sits in the centre. Generated brackets are bracket-
 * ordered (match_no) and halve cleanly each round, so a parent centres on its
 * two positional children (2i, 2i+1) by construction.
 * ------------------------------------------------------------------------- */
const C = {
  box: "#3a1d63",
  gold: "#c9a558",
  goldHi: "#e7ce8c",
  line: "#f15a26",
  text: "#ffffff",
  dim: "rgba(255,255,255,0.62)",
  divider: "rgba(255,255,255,0.12)",
} as const;

const STAGE_BG =
  "radial-gradient(130% 100% at 14% 96%, #5d2e93 0%, rgba(93,46,147,0) 52%)," +
  "linear-gradient(135deg, #3a1c67 0%, #46226e 48%, #3a1c67 100%)";

// Geometry (px).
const CARD_W = 178;
const CARD_H = 58;
const STRIP_H = 16;
const ROW = 78; // vertical pitch between round-1 card centres
const COL_GAP = 38; // horizontal gap between a side's columns
const CENTER_GAP = 52; // gap flanking the central Final
const CHAMP_W = 178;
const CHAMP_H = 42;
const TROPHY_H = 92;
const HEADER_H = 24;

/** Human label for an unresolved bracket slot from its typed pointer:
 * group_position -> "Group A top 1" / "Best 3rd #1"; winner/loser pointers are
 * not entrants (they resolve from an earlier match) so they return null. */
export function sourceLabel(src: MatchSource | null | undefined): string | null {
  if (!src) return null;
  if (src.type === "group_position") return groupPositionLabel(src);
  return null;
}

/** A side's display label: a real team name, else its group_position
 * placeholder ("Group A top 1"), else null (winner_of/tbd -> "TBD"). */
function entrantLabel(
  team: MatchRow["home_team"],
  src: MatchSource | null | undefined,
): string | null {
  if (team?.name) return team.name;
  return sourceLabel(src);
}

/** FIFA round name from the number of teams contesting that round. */
function roundName(teams: number): string {
  if (teams <= 2) return t("Final");
  if (teams === 4) return t("Semi-finals");
  if (teams === 8) return t("Quarter-finals");
  return `${t("Round of")} ${teams}`;
}

/** A consolation match (3rd-place playoff / plate) is fed by loser_of, not part
 * of the winner tree. */
function isConsolation(m: MatchRow): boolean {
  return (
    m.home_source?.type === "loser_of" || m.away_source?.type === "loser_of"
  );
}

/** Clean, ASCII label for a consolation match, from the trailing group_label
 * segment ("… — 3rd Place" -> "3rd Place"); defaults to "Playoff". */
function consolationLabel(m: MatchRow): string {
  const segs = (m.group_label || "").split(" — ");
  const last = segs[segs.length - 1]?.trim();
  return segs.length > 1 && last ? last : t("Playoff");
}

/** Which side won a decided match (goals, then penalties); null while open or
 * drawn-without-a-shootout. */
function decided(m: MatchRow): "home" | "away" | null {
  if (m.status !== "completed" && m.status !== "walkover") return null;
  const hs = m.home_score;
  const as = m.away_score;
  if (hs == null || as == null) return null;
  if (hs > as) return "home";
  if (as > hs) return "away";
  const hp = m.home_pens;
  const ap = m.away_pens;
  if (hp != null && ap != null) {
    if (hp > ap) return "home";
    if (ap > hp) return "away";
  }
  return null;
}

function fmtDate(iso: string): string {
  // Parse the full instant: a UTC "…Z" live time renders in the viewer's TZ
  // (invariant 14, public), while an offset-less preview wall-clock string keeps
  // its own date (parse and format cancel out in the same local TZ).
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact status for the card's top strip: FT / LIVE / a kickoff date. */
function statusOf(m: MatchRow): { text: string; live: boolean } {
  if (m.status === "completed" || m.status === "walkover")
    return { text: t("FT"), live: false };
  if (m.current_period) return { text: t("LIVE"), live: true };
  if (m.scheduled_at) return { text: fmtDate(m.scheduled_at), live: false };
  return { text: "", live: false };
}

/** One side of a match card: name (left) + score (right), winner emphasised. */
function CardSide({
  label,
  score,
  pens,
  win,
}: {
  label: string | null;
  score: number | null;
  pens: number | null;
  win: boolean;
}): React.ReactElement {
  const tbd = !label;
  return (
    <div
      className="flex flex-1 items-center gap-1.5 px-2"
      style={{ borderLeft: `2px solid ${win ? C.gold : "transparent"}` }}
    >
      <span
        className="min-w-0 flex-1 truncate text-[0.6875rem]"
        style={{
          color: tbd ? C.dim : win ? C.text : "rgba(255,255,255,0.85)",
          fontStyle: tbd ? "italic" : "normal",
          fontWeight: win ? 600 : 500,
        }}
      >
        {label ?? t("TBD")}
      </span>
      {score != null ? (
        <span
          className="font-tabular text-[0.6875rem] tabular-nums"
          style={{ color: win ? C.goldHi : C.dim, fontWeight: win ? 600 : 500 }}
        >
          {score}
          {pens != null ? (
            <span style={{ color: C.dim }} className="ml-0.5 text-[0.5625rem]">
              ({pens})
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** A single match drawn as a two-row FIFA card (status strip + both sides). */
function MatchCard({ match }: { match: MatchRow }): React.ReactElement {
  const home = entrantLabel(match.home_team, match.home_source);
  const away = entrantLabel(match.away_team, match.away_source);
  const win = decided(match);
  const st = statusOf(match);
  const hasPens = match.home_pens != null && match.away_pens != null;
  return (
    <div
      role="group"
      aria-label={`${home ?? t("TBD")} ${match.home_score ?? ""} ${t("vs")} ${
        away ?? t("TBD")
      } ${match.away_score ?? ""}`.replace(/\s+/g, " ").trim()}
      className="flex w-full flex-col overflow-hidden rounded-md"
      style={{
        height: CARD_H,
        background: C.box,
        border: `1.5px solid ${C.gold}`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
      }}
    >
      {st.text ? (
        <div
          className="flex items-center px-2"
          style={{ height: STRIP_H, background: "rgba(0,0,0,.2)" }}
        >
          <span
            className="text-[0.5625rem] font-semibold uppercase tracking-wider"
            style={{ color: st.live ? C.line : C.goldHi }}
          >
            {st.live ? (
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: C.line }}
              />
            ) : null}
            {st.text}
          </span>
        </div>
      ) : (
        <div style={{ height: STRIP_H }} />
      )}
      <CardSide
        label={home}
        score={match.home_score}
        pens={hasPens ? match.home_pens ?? null : null}
        win={win === "home"}
      />
      <div style={{ height: 1, background: C.divider }} />
      <CardSide
        label={away}
        score={match.away_score}
        pens={hasPens ? match.away_pens ?? null : null}
        win={win === "away"}
      />
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

/** Even, centred y-positions for one half: round 1 spread across `height`, then
 * every later match centred on its two positional children. */
function yCenters(cols: MatchRow[][], height: number): number[][] {
  const ys: number[][] = [];
  const first = cols[0] ?? [];
  ys[0] = first.map((_, i) => ((i + 0.5) * height) / Math.max(first.length, 1));
  for (let c = 1; c < cols.length; c++) {
    const prev = ys[c - 1]!;
    ys[c] = (cols[c] ?? []).map((_, i) => {
      const a = prev[2 * i] ?? prev[prev.length - 1] ?? height / 2;
      const b = prev[2 * i + 1] ?? a;
      return (a + b) / 2;
    });
  }
  return ys;
}

/**
 * FIFA-style knockout bracket. `columns` are [round_no, matches] sorted low ->
 * high; the last round's single match is the Final. Renders the real draw with
 * scores + winner highlights, placeholder labels on unresolved slots.
 */
export function FifaBracket({
  columns,
}: {
  columns: [number, MatchRow[]][];
}): React.ReactElement {
  // A loser_of-fed match is a consolation (3rd-place playoff / plate), NOT part
  // of the winner tree — the generator emits it at the SAME round_no as the
  // Final, so it must be pulled out or it would defeat the single-final check
  // and collapse the whole bracket. Render it separately below.
  const consolation = columns
    .flatMap(([, ms]) => ms)
    .filter(isConsolation)
    .sort((a, b) => a.match_no - b.match_no);
  const rounds = [...columns]
    .sort((a, b) => a[0] - b[0])
    .map(([, ms]) =>
      ms.filter((m) => !isConsolation(m)).sort((a, b) => a.match_no - b.match_no),
    )
    .filter((r) => r.length > 0);

  const R = rounds.length;
  if (R === 0) {
    return (
      <div className="w-full rounded-2xl p-6" style={{ background: STAGE_BG }}>
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>
          {t("No bracket yet.")}
        </p>
      </div>
    );
  }

  const finalMatch = rounds[R - 1]!.length === 1 ? rounds[R - 1]![0]! : null;
  // With a clean single-match Final we mirror the draw around a centre; without
  // one (degenerate / partial data) we fall back to a single left->right tree.
  const split = finalMatch != null;
  const sideRounds = finalMatch ? rounds.slice(0, R - 1) : rounds;
  const S = sideRounds.length;

  const leftCols = sideRounds.map((r) => (split ? r.slice(0, Math.ceil(r.length / 2)) : r));
  const rightCols = sideRounds.map((r) => (split ? r.slice(Math.ceil(r.length / 2)) : []));

  const k0 = Math.max(leftCols[0]?.length ?? 0, rightCols[0]?.length ?? 0, 1);
  const H = k0 * ROW;

  const xLeft = leftCols.map((_, c) => c * (CARD_W + COL_GAP));
  const leftEdge = S > 0 ? xLeft[S - 1]! + CARD_W : 0;
  const xFinal = S > 0 ? leftEdge + CENTER_GAP : 0;
  const xRightInner = xFinal + CARD_W + CENTER_GAP;
  const xRight = rightCols.map((_, c) => xRightInner + (S - 1 - c) * (CARD_W + COL_GAP));
  const canvasW = finalMatch
    ? (S > 0 ? xRight[0]! + CARD_W : xFinal + CARD_W)
    : leftEdge;

  // Top-anchor the tree; the champion + trophy hang below the central Final, so
  // the canvas only grows to fit that reach (no dead band above the bracket).
  const belowReach = CARD_H / 2 + 12 + CHAMP_H + 10 + TROPHY_H;
  const offY = 0;
  const midY = H / 2;
  const canvasH = finalMatch ? Math.max(H, midY + belowReach) : H;

  const yLeft = yCenters(leftCols, H);
  const yRight = yCenters(rightCols, H);

  // --- connectors -----------------------------------------------------------
  const seg: React.ReactElement[] = [];
  let segKey = 0;
  const hline = (x1: number, x2: number, y: number): void => {
    seg.push(
      <span
        key={`s${segKey++}`}
        className="absolute"
        style={{ left: Math.min(x1, x2), top: y - 1, width: Math.abs(x2 - x1), height: 2, background: C.line }}
      />,
    );
  };
  const vline = (x: number, y1: number, y2: number): void => {
    seg.push(
      <span
        key={`s${segKey++}`}
        className="absolute"
        style={{ left: x - 1, top: Math.min(y1, y2), width: 2, height: Math.abs(y2 - y1), background: C.line }}
      />,
    );
  };

  // Left side: children sit to the LEFT of their parent.
  for (let c = 1; c < S; c++) {
    leftCols[c]!.forEach((_, i) => {
      const c0 = yLeft[c - 1]?.[2 * i];
      const c1 = yLeft[c - 1]?.[2 * i + 1];
      if (c0 == null || c1 == null) return;
      const childR = xLeft[c - 1]! + CARD_W;
      const parentL = xLeft[c]!;
      const bus = (childR + parentL) / 2;
      hline(childR, bus, offY + c0);
      hline(childR, bus, offY + c1);
      vline(bus, offY + c0, offY + c1);
      hline(bus, parentL, offY + yLeft[c]![i]!);
    });
  }
  // Right side: children sit to the RIGHT of their parent.
  for (let c = 1; c < S; c++) {
    rightCols[c]!.forEach((_, i) => {
      const c0 = yRight[c - 1]?.[2 * i];
      const c1 = yRight[c - 1]?.[2 * i + 1];
      if (c0 == null || c1 == null) return;
      const childL = xRight[c - 1]!;
      const parentR = xRight[c]! + CARD_W;
      const bus = (parentR + childL) / 2;
      hline(childL, bus, offY + c0);
      hline(childL, bus, offY + c1);
      vline(bus, offY + c0, offY + c1);
      hline(bus, parentR, offY + yRight[c]![i]!);
    });
  }
  // Semifinals -> Final. For a clean power-of-2 draw each SF sits at midY, so
  // this is a straight line; route via an elbow to midY otherwise so the line
  // always meets the Final's mid-height edge (never floats above/below it).
  const connectFinal = (childEdge: number, childY: number, finalEdge: number): void => {
    if (childY === midY) {
      hline(childEdge, finalEdge, midY);
      return;
    }
    const bus = (childEdge + finalEdge) / 2;
    hline(childEdge, bus, childY);
    vline(bus, childY, midY);
    hline(bus, finalEdge, midY);
  };
  if (finalMatch && S > 0) {
    if (leftCols[S - 1]!.length) {
      connectFinal(xLeft[S - 1]! + CARD_W, offY + (yLeft[S - 1]?.[0] ?? H / 2), xFinal);
    }
    if (rightCols[S - 1]!.length) {
      connectFinal(xRight[S - 1]!, offY + (yRight[S - 1]?.[0] ?? H / 2), xFinal + CARD_W);
    }
  }

  // --- cards ----------------------------------------------------------------
  const cards: React.ReactElement[] = [];
  const placeCard = (m: MatchRow, x: number, cy: number, key: string): void => {
    cards.push(
      <div key={key} className="absolute" style={{ left: x, top: cy - CARD_H / 2, width: CARD_W }}>
        <MatchCard match={m} />
      </div>,
    );
  };
  leftCols.forEach((col, c) =>
    col.forEach((m, i) => placeCard(m, xLeft[c]!, offY + (yLeft[c]?.[i] ?? H / 2), `l-${c}-${i}`)),
  );
  rightCols.forEach((col, c) =>
    col.forEach((m, i) => placeCard(m, xRight[c]!, offY + (yRight[c]?.[i] ?? H / 2), `r-${c}-${i}`)),
  );

  // --- champion -------------------------------------------------------------
  const champSide = finalMatch ? decided(finalMatch) : null;
  const champName = finalMatch
    ? champSide === "home"
      ? entrantLabel(finalMatch.home_team, finalMatch.home_source)
      : champSide === "away"
        ? entrantLabel(finalMatch.away_team, finalMatch.away_source)
        : null
    : null;

  // --- round headers --------------------------------------------------------
  const headers: { x: number; label: string }[] = [];
  sideRounds.forEach((r, c) => {
    const label = roundName(r.length * 2);
    if (leftCols[c]!.length) headers.push({ x: xLeft[c]! + CARD_W / 2, label });
    if (rightCols[c]!.length) headers.push({ x: xRight[c]! + CARD_W / 2, label });
  });
  if (finalMatch) headers.push({ x: xFinal + CARD_W / 2, label: t("Final") });

  const anyPlaceholder = rounds.some((r) =>
    r.some((m) => !m.home_team || !m.away_team),
  );
  const fromGroups = rounds.some((r) =>
    r.some(
      (m) =>
        m.home_source?.type === "group_position" ||
        m.away_source?.type === "group_position",
    ),
  );

  return (
    <div
      role="figure"
      aria-label={t("Knockout bracket")}
      className="w-full overflow-x-auto rounded-2xl p-5 shadow-xl sm:p-7"
      style={{ background: STAGE_BG }}
    >
      {anyPlaceholder ? (
        <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
          {fromGroups
            ? t("Pairings fill in as the group stage finishes.")
            : t("Pairings fill in as teams qualify.")}
        </p>
      ) : null}
      <div className="mx-auto" style={{ width: canvasW }}>
        <div className="relative" style={{ width: canvasW, height: HEADER_H }}>
          {headers.map((h, i) => (
            <span
              key={`hd-${i}`}
              className="absolute -translate-x-1/2 whitespace-nowrap text-[0.625rem] font-semibold uppercase tracking-wider"
              style={{ left: h.x, top: 4, color: C.goldHi }}
            >
              {h.label}
            </span>
          ))}
        </div>
        <div className="relative" style={{ width: canvasW, height: canvasH }}>
          {seg}
          {cards}
          {finalMatch ? (
            <>
              <div className="absolute" style={{ left: xFinal, top: midY - CARD_H / 2, width: CARD_W }}>
                <MatchCard match={finalMatch} />
              </div>
              <div
                className="absolute flex flex-col items-center justify-center rounded-lg"
                style={{
                  left: xFinal,
                  top: midY + CARD_H / 2 + 12,
                  width: CHAMP_W,
                  height: CHAMP_H,
                  background: C.box,
                  border: `2px solid ${C.gold}`,
                }}
              >
                <span className="text-[0.5625rem] font-semibold uppercase tracking-[0.14em]" style={{ color: C.goldHi }}>
                  {t("Champion")}
                </span>
                {champName ? (
                  <span className="max-w-full truncate px-2 text-xs font-semibold" style={{ color: C.text }}>
                    {champName}
                  </span>
                ) : null}
              </div>
              <div
                className="absolute flex justify-center"
                style={{ left: xFinal, top: midY + CARD_H / 2 + 12 + CHAMP_H + 10, width: CHAMP_W }}
              >
                <GoldTrophy />
              </div>
            </>
          ) : null}
        </div>
        {consolation.length ? (
          <div className="mt-4 flex flex-wrap justify-center gap-4 border-t pt-4" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            {consolation.map((m) => (
              <div key={m.id} className="flex flex-col gap-1" style={{ width: CARD_W }}>
                <span
                  className="text-center text-[0.625rem] font-semibold uppercase tracking-wider"
                  style={{ color: C.goldHi }}
                >
                  {consolationLabel(m)}
                </span>
                <MatchCard match={m} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
