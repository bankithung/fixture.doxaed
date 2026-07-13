import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Shield } from "lucide-react";
import type { MatchRow, MatchSource } from "@/api/tournaments";
import { groupPositionLabel } from "@/features/fixtures/groupSlotLabel";
import { t } from "@/lib/t";

/* ---------------------------------------------------------------------------
 * World Cup knockout bracket — a horizontally-scrolling single-direction
 * flow-chart (owner ask 2026-07-01, modelled on the FIFA World Cup "Knockout"
 * widget): round columns laid left -> right (Round of 32 ... Final), the whole
 * row scrolls horizontally with Prev/Next arrows, elbow connectors join each
 * pair of feeders into their child. Deliberately THEMED purple/gold/orange
 * (an approved exception to tokens-only, see memory world-cup-bracket-theme).
 *
 * Every match is a real card (both sides + scores + winner check + a status
 * strip); unresolved slots read "Group A top 1" / "TBD". The 3rd-place playoff
 * (loser_of-fed) is pulled out of the winner tree and shown below the Final.
 * Same `columns` prop everywhere it's used (preview / public / admin / ops).
 * ------------------------------------------------------------------------- */
const C = {
  box: "#3a1d63",
  gold: "#c9a558",
  goldHi: "#e7ce8c",
  line: "#f15a26",
  text: "#ffffff",
  dim: "rgba(255,255,255,0.62)",
  divider: "rgba(255,255,255,0.12)",
  avatar: "rgba(201,165,88,0.16)",
} as const;

const STAGE_BG =
  "radial-gradient(130% 100% at 14% 96%, #5d2e93 0%, rgba(93,46,147,0) 52%)," +
  "linear-gradient(135deg, #3a1c67 0%, #46226e 48%, #3a1c67 100%)";

// Geometry (px). Roomy on purpose — the cards carry two team rows, a meta
// strip and (on byes) a second line of text (owner 2026-07-13: "too compact").
const CARD_W = 244;
const CARD_H = 82;
const META_H = 20;
const ROW = 106; // vertical pitch between round-1 card centres
const COL_GAP = 60; // horizontal gap between round columns
const HEADER_H = 32;
const LABEL_H = 18; // "3rd place" caption above a consolation card

/** Human label for an unresolved bracket slot from its typed pointer:
 * group_position -> "Group A top 1" / "Best 3rd #1"; winner/loser pointers are
 * not entrants (they resolve from an earlier match) so they return null. */
export function sourceLabel(src: MatchSource | null | undefined): string | null {
  if (!src) return null;
  if (src.type === "group_position") return groupPositionLabel(src);
  return null;
}

/** The match id a winner_of/loser_of pointer references (DB rows carry
 * `match_id`, preview rows carry `ref`); "" otherwise. */
function refId(src: MatchSource | null | undefined): string {
  if (!src) return "";
  const raw =
    (src as Record<string, unknown>).match_id ?? (src as Record<string, unknown>).ref;
  return raw != null ? String(raw) : "";
}

/** A side's display label. A real team name; else its group_position slot
 * ("Group A top 1"); else — so we NEVER guess a winner — the match a slot flows
 * FROM ("Winner of M3" / "Loser of M3", where M3 is that feeder's card number);
 * else "TBD" (null). `no` maps match id -> the number shown on each card. */
function entrantLabel(
  team: MatchRow["home_team"],
  src: MatchSource | null | undefined,
  no: Map<string, number>,
): string | null {
  if (team?.name) return team.name;
  if (!src) return null;
  if (src.type === "group_position") return groupPositionLabel(src);
  if (src.type === "winner_of" || src.type === "loser_of") {
    const n = no.get(refId(src));
    if (n == null) return null;
    return src.type === "loser_of" ? `${t("Loser of M")}${n}` : `${t("Winner of M")}${n}`;
  }
  return null;
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
 * segment ("… — 3rd Place" / "… · 3rd Place" -> "3rd Place"); defaults to
 * "Third place" (the only consolation v1 generates). */
function consolationLabel(m: MatchRow): string {
  const segs = (m.group_label || "").split(/ [—·] /);
  const last = segs[segs.length - 1]?.trim();
  return segs.length > 1 && last ? last : t("Third place");
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

/** Two-letter monogram from a team name (schools have no country flag).
 * Prefers word INITIALS from alphabetic words, so "Practice School 16" reads
 * "PS", never the numeric "P1". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const alpha = parts.filter((p) => /[A-Za-z]/.test(p[0]!));
  const use = alpha.length ? alpha : parts;
  if (use.length === 0) return "?";
  if (use.length === 1) return use[0]!.slice(0, 2).toUpperCase();
  return (use[0]![0]! + use[use.length - 1]![0]!).toUpperCase();
}

/** Long TZ name ("Asia/Kolkata" -> "India Standard Time") for the footnote. */
function tzLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Relative kickoff ("Today, 9:30 pm" / "Tomorrow" / "Yesterday"), else
 * absolute ("Fri, 3 Jul, 12:30 am"). Rendered in `tz` when given, else local. */
function fmtKickoff(iso: string, tz?: string): string {
  const opt = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions =>
    tz ? { ...o, timeZone: tz } : o;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const day = (x: Date): string => x.toLocaleDateString("en-CA", opt({}));
  const time = d.toLocaleTimeString([], opt({ hour: "numeric", minute: "2-digit" }));
  const dd = day(d);
  if (dd === day(now)) return `${t("Today")}, ${time}`;
  if (dd === day(new Date(now.getTime() + 86_400_000))) return `${t("Tomorrow")}, ${time}`;
  if (dd === day(new Date(now.getTime() - 86_400_000))) return `${t("Yesterday")}, ${time}`;
  const date = d.toLocaleDateString([], opt({ weekday: "short", day: "numeric", month: "short" }));
  return `${date}, ${time}`;
}

/** Status pill for the card's top strip: FT / FT (P) / LIVE, or none. */
function statusBadge(m: MatchRow): { text: string; live: boolean } | null {
  if (m.status === "completed" || m.status === "walkover") {
    const pens = m.home_pens != null && m.away_pens != null;
    return { text: pens ? t("FT (P)") : t("FT"), live: false };
  }
  if (m.current_period) return { text: t("LIVE"), live: true };
  return null;
}

/** One side of a match card: crest/monogram, name, winner check, score. */
function TeamRow({
  label,
  score,
  pens,
  win,
  isTeam,
}: {
  label: string | null;
  score: number | null;
  pens: number | null;
  win: boolean;
  isTeam: boolean;
}): React.ReactElement {
  const soft = !isTeam;
  return (
    <div
      className="flex flex-1 items-center gap-2 px-3"
      style={{ borderLeft: `2px solid ${win ? C.gold : "transparent"}` }}
    >
      {isTeam ? (
        <span
          aria-hidden
          className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-[0.5625rem] font-semibold"
          style={{ background: C.avatar, color: C.goldHi }}
        >
          {initials(label ?? "")}
        </span>
      ) : (
        <Shield aria-hidden className="h-[20px] w-[20px] shrink-0" style={{ color: C.dim }} strokeWidth={1.5} />
      )}
      <span
        className="min-w-0 flex-1 truncate text-xs"
        style={{
          color: soft ? C.dim : win ? C.text : "rgba(255,255,255,0.85)",
          fontStyle: soft ? "italic" : "normal",
          fontWeight: win ? 600 : 500,
        }}
      >
        {label ?? t("TBD")}
      </span>
      {win && isTeam ? <Check aria-hidden className="h-3 w-3 shrink-0" style={{ color: C.gold }} strokeWidth={3} /> : null}
      {score != null ? (
        <span
          className="ml-0.5 font-tabular text-[0.6875rem] tabular-nums"
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

/** A single match drawn as a card: kickoff/status strip + both sides. */
function MatchCard({ match, tz, no }: { match: MatchRow; tz?: string; no: Map<string, number> }): React.ReactElement {
  const home = entrantLabel(match.home_team, match.home_source, no);
  const away = entrantLabel(match.away_team, match.away_source, no);
  const num = no.get(match.id);
  const win = decided(match);
  const badge = statusBadge(match);
  const kickoff = match.scheduled_at ? fmtKickoff(match.scheduled_at, tz) : "";
  const hasPens = match.home_pens != null && match.away_pens != null;
  return (
    <div
      role="group"
      aria-label={`${home ?? t("TBD")} ${match.home_score ?? ""} ${t("vs")} ${
        away ?? t("TBD")
      } ${match.away_score ?? ""}${badge ? ` ${badge.text}` : ""}`
        .replace(/\s+/g, " ")
        .trim()}
      className="flex w-full flex-col overflow-hidden rounded-md transition-shadow hover:shadow-lg"
      style={{
        height: CARD_H,
        background: C.box,
        border: `1.5px solid ${C.gold}`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
      }}
    >
      <div className="flex items-center gap-1.5 px-3" style={{ height: META_H, background: "rgba(0,0,0,.2)" }}>
        {num != null ? (
          <span className="shrink-0 font-tabular text-[0.625rem] font-semibold" style={{ color: C.goldHi }}>
            M{num}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[0.625rem] font-medium" style={{ color: C.dim }}>
          {kickoff}
        </span>
        {badge ? (
          <span
            className="shrink-0 text-[0.5625rem] font-semibold uppercase tracking-wider"
            style={{ color: badge.live ? C.line : C.goldHi }}
          >
            {badge.live ? (
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: C.line }} />
            ) : null}
            {badge.text}
          </span>
        ) : null}
      </div>
      <TeamRow label={home} isTeam={!!match.home_team?.name} score={match.home_score} pens={hasPens ? match.home_pens ?? null : null} win={win === "home"} />
      <div style={{ height: 1, background: C.divider }} />
      <TeamRow label={away} isTeam={!!match.away_team?.name} score={match.away_score} pens={hasPens ? match.away_pens ?? null : null} win={win === "away"} />
    </div>
  );
}

/** The match a winner_of pointer feeds from; "" for non-winner_of sides (a real
 * team / group_position / loser_of / tbd side is not a winner-bracket feeder). */
function feederId(src: MatchSource | null | undefined): string {
  return src?.type === "winner_of" ? refId(src) : "";
}

/** Round name by DISTANCE-TO-FINAL (byes/play-ins make match count unreliable):
 * 0 -> Final, 1 -> Semi-finals, 2 -> Quarter-finals, else Round of 2^(d+1). */
function roundNameByDepth(d: number): string {
  if (d <= 0) return t("Final");
  if (d === 1) return t("Semi-finals");
  if (d === 2) return t("Quarter-finals");
  return `${t("Round of")} ${2 ** (d + 1)}`;
}

/** A slot that skips a round: drawn as a ghost "Bye" card in the column it
 * sits out, wired into the same connector bus. Entry byes carry a `label`
 * (team name / group slot); a mid-bracket bye on a winner_of slot carries the
 * `feederId` instead — the component renders "Winner of M<n>" for it. */
interface ByeGhost {
  parentId: string;
  x: number;
  y: number;
  label?: string;
  feederId?: string;
}

interface BracketLayout {
  pos: Map<string, { x: number; y: number }>;
  feedersByParent: Map<string, string[]>;
  ghosts: ByeGhost[];
  colLabels: { x: number; label: string }[];
  H: number;
  canvasW: number;
  finalX: number;
  finalY: number;
}

/**
 * Lay a knockout out as the REAL tree defined by its winner_of feeder pointers:
 * each match sits one column LEFT of the slot it feeds, centred on its two
 * children (a terminal side — real team / group slot — takes one leaf row).
 * This keeps byes/play-ins correct (a play-in round no longer looks bigger than
 * the round it feeds, and columns are named by distance-to-final, not by count).
 * Falls back to round_no columns with even spacing when the pointers don't form
 * one clean rooted tree.
 */
function layoutBracket(matches: MatchRow[]): BracketLayout {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const feedersByParent = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const m of matches) {
    for (const src of [m.home_source, m.away_source]) {
      const fid = feederId(src);
      if (fid && byId.has(fid)) {
        parent.set(fid, m.id);
        const list = feedersByParent.get(m.id);
        if (list) list.push(fid);
        else feedersByParent.set(m.id, [fid]);
      }
    }
  }
  const roots = matches.filter((m) => !parent.has(m.id));
  const colX = (c: number): number => c * (CARD_W + COL_GAP);
  const pos = new Map<string, { x: number; y: number }>();

  // Clean single-elimination tree? one root, every match reachable from it.
  const depth = new Map<string, number>();
  let treeOk = roots.length === 1;
  if (treeOk) {
    depth.set(roots[0]!.id, 0);
    const stack = [roots[0]!.id];
    while (stack.length) {
      const id = stack.pop()!;
      for (const fid of feedersByParent.get(id) ?? []) {
        if (!depth.has(fid)) {
          depth.set(fid, depth.get(id)! + 1);
          stack.push(fid);
        }
      }
    }
    treeOk = depth.size === matches.length;
  }

  if (treeOk) {
    // Columns follow the matches' ACTUAL rounds, not distance-to-final —
    // an uneven bracket (pair_all byes) must not draw a round-1 match in a
    // later column just because its path to the final is shorter.
    const roundsSorted = [...new Set(matches.map((m) => m.round_no))].sort(
      (a, b) => a - b,
    );
    const colOf = new Map(roundsSorted.map((r, i) => [r, i]));
    const cols = roundsSorted.length;
    const lastCol = cols - 1;
    let slot = 0;
    const ghosts: ByeGhost[] = [];
    const placeY = (id: string): number => {
      const m = byId.get(id)!;
      const col = colOf.get(m.round_no) ?? 0;
      const centers: number[] = [];
      const sides: [MatchRow["home_team"], MatchSource | null | undefined][] = [
        [m.home_team, m.home_source],
        [m.away_team, m.away_source],
      ];
      for (const [team, src] of sides) {
        const fid = feederId(src);
        if (fid && byId.has(fid)) {
          const fy = placeY(fid);
          centers.push(fy);
          // A feeder more than one column back = this slot SAT OUT the
          // round(s) between — a genuine mid-bracket bye. One ghost per
          // skipped column, riding the feeder's row.
          const fcol = colOf.get(byId.get(fid)!.round_no) ?? 0;
          for (let c = fcol + 1; c < col; c += 1) {
            ghosts.push({ parentId: id, feederId: fid, x: colX(c), y: fy });
          }
        } else {
          const y = (slot + 0.5) * ROW;
          centers.push(y);
          slot += 1;
          // Entering later than the first round = an entry bye through the
          // previous round: show it instead of a silent gap.
          if (col > 0) {
            const label = team?.name ?? sourceLabel(src ?? null);
            if (label) {
              ghosts.push({ parentId: id, label, x: colX(col - 1), y });
            }
          }
        }
      }
      const yc = centers.reduce((a, b) => a + b, 0) / centers.length;
      pos.set(id, { x: colX(col), y: yc });
      return yc;
    };
    const finalY = placeY(roots[0]!.id);
    // Classic power-of-2 shape keeps the FIFA names: every round after the
    // first halves cleanly into the final (the first round may be partial —
    // that is the normal byes/play-in round of a padded bracket). Anything
    // else (pair_all) is labeled by plain round number, honestly.
    const countByRound = new Map<number, number>();
    for (const m of matches) {
      countByRound.set(m.round_no, (countByRound.get(m.round_no) ?? 0) + 1);
    }
    const classic =
      roundsSorted
        .slice(1)
        .every((r, i) => countByRound.get(r) === 2 ** (lastCol - (i + 1))) &&
      (countByRound.get(roundsSorted[0]!) ?? 0) <= 2 ** lastCol;
    return {
      pos,
      feedersByParent,
      ghosts,
      colLabels: roundsSorted.map((_, c) => ({
        x: colX(c) + CARD_W / 2,
        label: classic
          ? roundNameByDepth(lastCol - c)
          : c === lastCol
            ? t("Final")
            : `${t("Round")} ${c + 1}`,
      })),
      H: Math.max(slot, 1) * ROW,
      canvasW: cols * CARD_W + (cols - 1) * COL_GAP,
      finalX: colX(lastCol),
      finalY,
    };
  }

  // Fallback: columns by round_no, each round spread evenly across the tallest.
  const byRound = new Map<number, MatchRow[]>();
  for (const m of matches) {
    const list = byRound.get(m.round_no);
    if (list) list.push(m);
    else byRound.set(m.round_no, [m]);
  }
  const keys = [...byRound.keys()].sort((a, b) => a - b);
  const maxCount = Math.max(1, ...keys.map((r) => byRound.get(r)!.length));
  const H = maxCount * ROW;
  keys.forEach((r, c) => {
    const col = byRound.get(r)!.slice().sort((a, b) => a.match_no - b.match_no);
    col.forEach((m, i) => pos.set(m.id, { x: colX(c), y: ((i + 0.5) * H) / col.length }));
  });
  const lastCol = byRound.get(keys[keys.length - 1] ?? 0) ?? [];
  return {
    pos,
    feedersByParent,
    ghosts: [],
    colLabels: keys.map((r, c) => ({
      x: colX(c) + CARD_W / 2,
      label: roundName(byRound.get(r)!.length * 2),
    })),
    H,
    canvasW: Math.max(1, keys.length) * CARD_W + (keys.length - 1) * COL_GAP,
    finalX: colX(Math.max(0, keys.length - 1)),
    finalY: (lastCol[0] && pos.get(lastCol[0].id)?.y) || H / 2,
  };
}

/**
 * FIFA-style single-direction knockout bracket. `columns` are [round_no,
 * matches] sorted low -> high; the last round is the Final. `timeZone` (IANA)
 * formats kickoffs + the footnote; omit for the viewer's local time.
 */
export function FifaBracket({
  columns,
  timeZone,
}: {
  columns: [number, MatchRow[]][];
  timeZone?: string;
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [nav, setNav] = useState({ start: true, end: true });

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setNav({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft >= el.scrollWidth - el.clientWidth - 1,
    });
  }, []);
  useEffect(() => {
    sync();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, columns]);

  const scrollByCol = useCallback((dir: 1 | -1) => {
    scrollRef.current?.scrollBy({ left: dir * (CARD_W + COL_GAP), behavior: "smooth" });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollByCol(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollByCol(-1);
    }
  };

  // A loser_of-fed match is a consolation (3rd-place playoff), NOT part of the
  // winner tree — pull it out and draw it below the Final.
  const all = columns.flatMap(([, ms]) => ms);
  const consolation = all
    .filter(isConsolation)
    .sort((a, b) => a.match_no - b.match_no);
  const bracketMatches = all.filter((m) => !isConsolation(m));

  if (bracketMatches.length === 0) {
    return (
      <div className="w-full rounded-2xl p-6" style={{ background: STAGE_BG }}>
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.75)" }}>
          {t("No bracket yet.")}
        </p>
      </div>
    );
  }

  const { pos, feedersByParent, ghosts, colLabels, H, canvasW, finalX, finalY } =
    layoutBracket(bracketMatches);

  // Number every card (M1, M2 …) top-to-bottom within each column, left to
  // right — so an unresolved slot can point at "Winner of M3" instead of a
  // guessed name. Consolation matches number after the bracket.
  const matchNo = new Map<string, number>();
  [...bracketMatches]
    .sort((a, b) => {
      const pa = pos.get(a.id) ?? { x: 1e9, y: 1e9 };
      const pb = pos.get(b.id) ?? { x: 1e9, y: 1e9 };
      return pa.x - pb.x || pa.y - pb.y;
    })
    .forEach((m, i) => matchNo.set(m.id, i + 1));
  consolation.forEach((m, i) => matchNo.set(m.id, bracketMatches.length + i + 1));

  // Consolation cards stack in the Final column, below the Final.
  const consTop = finalY + CARD_H / 2 + 32;
  const consBlock = LABEL_H + 6 + CARD_H + 24;
  const canvasH = Math.max(
    H,
    consolation.length ? consTop + consolation.length * consBlock : H,
  );

  // Connectors: each feeder joins the slot it feeds (elbow via a shared bus).
  const seg: React.ReactElement[] = [];
  let segKey = 0;
  const hline = (x1: number, x2: number, yy: number): void => {
    seg.push(<span key={`s${segKey++}`} className="absolute" style={{ left: Math.min(x1, x2), top: yy - 1, width: Math.abs(x2 - x1), height: 2, background: C.line }} />);
  };
  const vline = (x: number, y1: number, y2: number): void => {
    seg.push(<span key={`s${segKey++}`} className="absolute" style={{ left: x - 1, top: Math.min(y1, y2), width: 2, height: Math.abs(y2 - y1), background: C.line }} />);
  };
  // Bye ghosts join the same bus as real feeders, so a card fed by one match
  // and one bye still draws a single clean elbow. A mid-bracket bye reroutes
  // its feeder's connector THROUGH the ghost (a straight ride across the
  // skipped column), and the ghost joins the parent's bus in its place.
  const ghostsByParent = new Map<string, ByeGhost[]>();
  for (const g of ghosts) {
    const list = ghostsByParent.get(g.parentId);
    if (list) list.push(g);
    else ghostsByParent.set(g.parentId, [g]);
  }
  const parents = new Set([...feedersByParent.keys(), ...ghostsByParent.keys()]);
  for (const pid of parents) {
    const p = pos.get(pid);
    if (!p) continue;
    const kp: { x: number; y: number }[] = [];
    const rerouted = new Map<string, ByeGhost>();
    for (const g of ghostsByParent.get(pid) ?? []) {
      if (!g.feederId) {
        kp.push({ x: g.x, y: g.y });
        continue;
      }
      const cur = rerouted.get(g.feederId);
      if (!cur || g.x > cur.x) rerouted.set(g.feederId, g);
    }
    for (const k of feedersByParent.get(pid) ?? []) {
      const kpos = pos.get(k);
      if (!kpos) continue;
      const via = rerouted.get(k);
      if (via) {
        hline(kpos.x + CARD_W, via.x, kpos.y);
        kp.push({ x: via.x, y: via.y });
      } else {
        kp.push(kpos);
      }
    }
    if (kp.length === 0) continue;
    const bus = (Math.max(...kp.map((k) => k.x + CARD_W)) + p.x) / 2;
    for (const k of kp) hline(k.x + CARD_W, bus, k.y);
    const ys = [...kp.map((k) => k.y), p.y];
    vline(bus, Math.min(...ys), Math.max(...ys));
    hline(bus, p.x, p.y);
  }

  const cards = bracketMatches.map((m) => {
    const p = pos.get(m.id) ?? { x: 0, y: H / 2 };
    return (
      <div key={`m-${m.id}`} className="absolute" style={{ left: p.x, top: p.y - CARD_H / 2, width: CARD_W }}>
        <MatchCard match={m} tz={timeZone} no={matchNo} />
      </div>
    );
  });

  // Ghost "Bye" cards: the slot had no opponent in this round and advances
  // automatically (a real-tournament bye), shown instead of a silent gap.
  // Mid-bracket byes name the slot by its feeder match ("Winner of M18").
  const GHOST_H = 60;
  const ghostLabel = (g: ByeGhost): string =>
    g.label ??
    (g.feederId != null && matchNo.get(g.feederId) != null
      ? `${t("Winner of M")}${matchNo.get(g.feederId)}`
      : t("TBD"));
  const ghostCards = ghosts.map((g, i) => (
    <div
      key={`b-${i}`}
      role="group"
      aria-label={`${ghostLabel(g)} ${t("bye, advances to the next round")}`}
      data-testid="bracket-bye"
      className="absolute flex flex-col justify-center gap-1 rounded-md px-3 py-2"
      style={{
        left: g.x,
        top: g.y - GHOST_H / 2,
        width: CARD_W,
        height: GHOST_H,
        background: "rgba(0,0,0,0.16)",
        border: "1.5px dashed rgba(201,165,88,0.55)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: "rgba(255,255,255,0.85)" }}>
          {ghostLabel(g)}
        </span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider"
          style={{ color: C.goldHi, border: `1px solid ${C.gold}` }}
        >
          {t("Bye")}
        </span>
      </div>
      <span className="truncate text-[0.625rem]" style={{ color: C.dim }}>
        {t("Advances automatically")}
      </span>
    </div>
  ));

  const anyPlaceholder = bracketMatches.some((m) => !m.home_team || !m.away_team);
  const fromGroups = bracketMatches.some(
    (m) => m.home_source?.type === "group_position" || m.away_source?.type === "group_position",
  );
  const hasDates =
    bracketMatches.some((m) => m.scheduled_at) || consolation.some((m) => m.scheduled_at);
  const canScroll = !(nav.start && nav.end);

  const arrowBtn = (dir: 1 | -1, disabled: boolean): React.ReactElement => (
    <button
      type="button"
      aria-label={dir === -1 ? t("Previous round") : t("Next round")}
      onClick={() => scrollByCol(dir)}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-full transition-opacity disabled:cursor-default disabled:opacity-30"
      style={{ background: "rgba(0,0,0,0.25)", border: `1.5px solid ${C.gold}`, color: C.goldHi }}
    >
      {dir === -1 ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
    </button>
  );

  return (
    <div
      role="figure"
      aria-label={t("Knockout bracket")}
      className="w-full rounded-2xl p-5 shadow-xl sm:p-6"
      style={{ background: STAGE_BG }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[0.6875rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
          {anyPlaceholder
            ? fromGroups
              ? t("Pairings fill in as the group stage finishes.")
              : t("Pairings fill in as teams qualify.")
            : ""}
        </p>
        {canScroll ? (
          <div className="flex shrink-0 gap-1.5">
            {arrowBtn(-1, nav.start)}
            {arrowBtn(1, nav.end)}
          </div>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        onScroll={sync}
        onKeyDown={onKeyDown}
        tabIndex={0}
        className="overflow-x-auto focus:outline-none"
        style={{ scrollbarWidth: "thin" }}
      >
        <div style={{ width: canvasW }}>
          {/* round headers, one per column (named by distance-to-final) */}
          <div className="relative" style={{ width: canvasW, height: HEADER_H }}>
            {colLabels.map((h, c) => (
              <span
                key={`h-${c}`}
                className="absolute -translate-x-1/2 whitespace-nowrap text-[0.6875rem] font-semibold uppercase tracking-wider"
                style={{ left: h.x, top: 6, color: C.goldHi }}
              >
                {h.label}
              </span>
            ))}
          </div>
          {/* the bracket */}
          <div className="relative" style={{ width: canvasW, height: canvasH }}>
            {seg}
            {ghostCards}
            {cards}
            {consolation.map((m, i) => {
              const top = consTop + i * consBlock;
              return (
                <div key={`c-${m.id}`} className="absolute" style={{ left: finalX, top, width: CARD_W }}>
                  <span className="mb-1.5 block text-[0.625rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
                    {consolationLabel(m)}
                  </span>
                  <MatchCard match={m} tz={timeZone} no={matchNo} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {hasDates ? (
        <p className="mt-3 text-[0.625rem]" style={{ color: C.dim }}>
          {timeZone
            ? `${t("All times are in")} ${tzLabel(timeZone)}`
            : t("All times shown in your local time")}
        </p>
      ) : null}
    </div>
  );
}
