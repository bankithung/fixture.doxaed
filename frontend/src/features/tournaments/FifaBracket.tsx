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

// Geometry (px).
const CARD_W = 210;
const CARD_H = 66;
const META_H = 16;
const ROW = 84; // vertical pitch between round-1 card centres
const COL_GAP = 46; // horizontal gap between round columns
const HEADER_H = 28;
const LABEL_H = 15; // "3rd place" caption above a consolation card

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

/** Two-letter monogram from a team name (schools have no country flag). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
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
}: {
  label: string | null;
  score: number | null;
  pens: number | null;
  win: boolean;
}): React.ReactElement {
  const tbd = !label;
  return (
    <div
      className="flex flex-1 items-center gap-2 px-2.5"
      style={{ borderLeft: `2px solid ${win ? C.gold : "transparent"}` }}
    >
      {tbd ? (
        <Shield aria-hidden className="h-[18px] w-[18px] shrink-0" style={{ color: C.dim }} strokeWidth={1.5} />
      ) : (
        <span
          aria-hidden
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[0.5rem] font-semibold"
          style={{ background: C.avatar, color: C.goldHi }}
        >
          {initials(label)}
        </span>
      )}
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
      {win ? <Check aria-hidden className="h-3 w-3 shrink-0" style={{ color: C.gold }} strokeWidth={3} /> : null}
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
function MatchCard({ match, tz }: { match: MatchRow; tz?: string }): React.ReactElement {
  const home = entrantLabel(match.home_team, match.home_source);
  const away = entrantLabel(match.away_team, match.away_source);
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
      <div className="flex items-center justify-between gap-1 px-2.5" style={{ height: META_H, background: "rgba(0,0,0,.2)" }}>
        <span className="truncate text-[0.5625rem] font-medium" style={{ color: C.dim }}>
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
      <TeamRow label={home} score={match.home_score} pens={hasPens ? match.home_pens ?? null : null} win={win === "home"} />
      <div style={{ height: 1, background: C.divider }} />
      <TeamRow label={away} score={match.away_score} pens={hasPens ? match.away_pens ?? null : null} win={win === "away"} />
    </div>
  );
}

/** Even, centred y-positions per round: round 1 spread across `height`, then
 * every later match centred on its two positional children (2i, 2i+1). */
function yCenters(rounds: MatchRow[][], height: number): number[][] {
  const ys: number[][] = [];
  const first = rounds[0] ?? [];
  ys[0] = first.map((_, i) => ((i + 0.5) * height) / Math.max(first.length, 1));
  for (let c = 1; c < rounds.length; c++) {
    const prev = ys[c - 1]!;
    ys[c] = (rounds[c] ?? []).map((_, i) => {
      const a = prev[2 * i] ?? prev[prev.length - 1] ?? height / 2;
      const b = prev[2 * i + 1] ?? a;
      return (a + b) / 2;
    });
  }
  return ys;
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
  // winner tree — pull it out (else the single-final check collapses) and draw
  // it below the Final.
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

  const n0 = rounds[0]!.length;
  const H = Math.max(n0, 1) * ROW;
  const y = yCenters(rounds, H);
  const xOf = (c: number): number => c * (CARD_W + COL_GAP);

  // Consolation cards stack in the Final column, below the Final.
  const finalX = xOf(R - 1);
  const consTop = H / 2 + CARD_H / 2 + 24;
  const consBlock = LABEL_H + 4 + CARD_H + 18;
  const canvasH = Math.max(
    H,
    consolation.length ? consTop + consolation.length * consBlock : H,
  );
  const canvasW = R * CARD_W + (R - 1) * COL_GAP;

  // Connectors: each parent (round c>=1) joins its two children (2i, 2i+1).
  const seg: React.ReactElement[] = [];
  let segKey = 0;
  const hline = (x1: number, x2: number, yy: number): void => {
    seg.push(<span key={`s${segKey++}`} className="absolute" style={{ left: Math.min(x1, x2), top: yy - 1, width: Math.abs(x2 - x1), height: 2, background: C.line }} />);
  };
  const vline = (x: number, y1: number, y2: number): void => {
    seg.push(<span key={`s${segKey++}`} className="absolute" style={{ left: x - 1, top: Math.min(y1, y2), width: 2, height: Math.abs(y2 - y1), background: C.line }} />);
  };
  for (let c = 1; c < R; c++) {
    rounds[c]!.forEach((_, i) => {
      const c0 = y[c - 1]?.[2 * i];
      const c1 = y[c - 1]?.[2 * i + 1];
      if (c0 == null || c1 == null) return;
      const childR = xOf(c - 1) + CARD_W;
      const parentL = xOf(c);
      const bus = (childR + parentL) / 2;
      hline(childR, bus, c0);
      hline(childR, bus, c1);
      vline(bus, c0, c1);
      hline(bus, parentL, y[c]![i]!);
    });
  }

  const cards: React.ReactElement[] = [];
  rounds.forEach((col, c) =>
    col.forEach((m, i) =>
      cards.push(
        <div key={`m-${c}-${i}`} className="absolute" style={{ left: xOf(c), top: (y[c]?.[i] ?? H / 2) - CARD_H / 2, width: CARD_W }}>
          <MatchCard match={m} tz={timeZone} />
        </div>,
      ),
    ),
  );

  const anyPlaceholder = rounds.some((r) => r.some((m) => !m.home_team || !m.away_team));
  const fromGroups = rounds.some((r) =>
    r.some((m) => m.home_source?.type === "group_position" || m.away_source?.type === "group_position"),
  );
  const hasDates = rounds.some((r) => r.some((m) => m.scheduled_at)) || consolation.some((m) => m.scheduled_at);
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
      className="w-full rounded-2xl p-4 shadow-xl sm:p-5"
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
          {/* round headers, one per column */}
          <div className="relative" style={{ width: canvasW, height: HEADER_H }}>
            {rounds.map((r, c) => (
              <span
                key={`h-${c}`}
                className="absolute -translate-x-1/2 whitespace-nowrap text-[0.625rem] font-semibold uppercase tracking-wider"
                style={{ left: xOf(c) + CARD_W / 2, top: 4, color: C.goldHi }}
              >
                {roundName(r.length * 2)}
              </span>
            ))}
          </div>
          {/* the bracket */}
          <div className="relative" style={{ width: canvasW, height: canvasH }}>
            {seg}
            {cards}
            {consolation.map((m, i) => {
              const top = consTop + i * consBlock;
              return (
                <div key={`c-${m.id}`} className="absolute" style={{ left: finalX, top, width: CARD_W }}>
                  <span className="mb-1 block text-[0.5625rem] font-semibold uppercase tracking-wider" style={{ color: C.goldHi }}>
                    {consolationLabel(m)}
                  </span>
                  <MatchCard match={m} tz={timeZone} />
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
