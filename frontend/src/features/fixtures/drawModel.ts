import type { PreviewMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { shortGroupName } from "./groupSlotLabel";
import { competitionLabel } from "./previewFilters";
import { clockOf, fmtClock, fmtDayLabel, matchNumbers, roundLabels } from "./previewGrid";
import { sideCrest, sideName } from "./sideName";

/**
 * The Draw view's model, as pure functions.
 *
 * It was born inside `GroupCompositionView`, which was fine while the draw was
 * only ever looked at. It is now also printed and downloaded (owner
 * 2026-08-20: "add export for the draw and court so that i can print both"),
 * and a printed draw that derives its own groups would be a second, quietly
 * different truth. So the model lives here and the screen, the CSV and the PDF
 * all read it — exactly as `courtLoad.ts` serves the Courts view.
 */

/** One line of the entry list: a team, its group and its slot in that group. */
export interface DrawLine {
  group: string;
  /** Position within the group (1-based) — the slot number on a wall chart. */
  slot: number;
  school: string;
  /** The team's badge URL, "" when it has none (then initials stand in). */
  crest: string;
  /** Continuous line number down the whole sheet. */
  lineNo: number;
}

export interface LeafDraw {
  leafKey: string;
  label: string;
  lines: DrawLine[];
  groupCount: number;
}

/**
 * Every competition's entry list: one line per team, group and slot as
 * columns. School names come from the group-stage matches' real teams
 * (knockout sides are still placeholders), which is why a knockout-only
 * competition falls back to its own entrants under one "Entry list" heading.
 */
export function buildDrawSheet(
  matches: readonly PreviewMatch[],
  teamNames: ReadonlyMap<string, string>,
  teamCrests?: ReadonlyMap<string, string>,
): LeafDraw[] {
  // leaf -> group name -> that group's teams, keyed by team id. Collecting
  // by ID rather than by name is what lets a crest ride along: the badge
  // cannot be recovered from the name once the id is thrown away.
  type Entrant = { name: string; crest: string };
  const byLeaf = new Map<
    string,
    {
      label: string;
      groups: Map<string, Map<string, Entrant>>;
      entrants: Map<string, Entrant>;
    }
  >();
  for (const m of matches) {
    let entry = byLeaf.get(m.leaf_key);
    if (!entry) {
      entry = { label: "", groups: new Map(), entrants: new Map() };
      byLeaf.set(m.leaf_key, entry);
    }
    if (!entry.label && m.group_label) entry.label = competitionLabel(m);
    const sides = [m.home, m.away].flatMap((s) => {
      const name = s.team_id ? teamNames.get(s.team_id) : undefined;
      if (!s.team_id || !name) return [];
      return [
        [s.team_id, { name, crest: teamCrests?.get(s.team_id) ?? "" }] as const,
      ];
    });
    if (m.stage === "group" && m.group_label) {
      const g = `${t("Group")} ${shortGroupName(m.group_label)}`;
      let bucket = entry.groups.get(g);
      if (!bucket) {
        bucket = new Map();
        entry.groups.set(g, bucket);
      }
      for (const [id, e] of sides) bucket.set(id, e);
    } else {
      // Knockout-only competition: its entrants are real teams.
      for (const [id, e] of sides) entry.entrants.set(id, e);
    }
  }

  const out: LeafDraw[] = [];
  // Line numbers are assigned here, in render order, so the table body never
  // mutates a counter while rendering.
  let lineNo = 0;
  for (const [leafKey, e] of byLeaf) {
    const sorted = (m: Map<string, Entrant>): Entrant[] =>
      [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    const groups =
      e.groups.size > 0
        ? [...e.groups.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([name, bucket]) => ({ name, schools: sorted(bucket) }))
        : e.entrants.size > 0
          ? [{ name: t("Entry list"), schools: sorted(e.entrants) }]
          : [];
    if (!groups.length) continue;
    const lines: DrawLine[] = [];
    for (const g of groups) {
      g.schools.forEach((ent, i) => {
        lineNo += 1;
        lines.push({
          group: g.name,
          slot: i + 1,
          school: ent.name,
          crest: ent.crest,
          lineNo,
        });
      });
    }
    out.push({
      leafKey,
      label: e.label || leafKey,
      lines,
      groupCount: groups.length,
    });
  }
  return out;
}

/** One knockout pairing, with both sides already resolved to what they read. */
export interface BracketPair {
  ref: string;
  /** Its number within its own competition ("Match 7"). */
  number: number;
  roundLabel: string;
  home: string;
  away: string;
  homeCrest: string;
  awayCrest: string;
  /** "Mon, Aug 17 · 9:50 AM", "" when the match has no time yet. */
  when: string;
}

export interface BracketRound {
  round: number;
  label: string;
  pairs: BracketPair[];
}

/** A team that sits a round out because the bracket is not a power of two. */
export interface BracketBye {
  name: string;
  crest: string;
  /** The round it enters at, and what that round is called. */
  round: number;
  roundLabel: string;
}

export interface DrawBracket {
  leafKey: string;
  label: string;
  rounds: BracketRound[];
  byes: BracketBye[];
}

/**
 * Each competition's knockout bracket, round by round.
 *
 * The screen draws this as a flow chart (`FifaBracket`); paper cannot carry
 * the connectors, so it is printed as rounds in order — which is how a draw is
 * read out anyway. A side that is still a pointer prints as the words the
 * bracket shows ("Winner of Match 3", "Group A top 2"), never a raw ref.
 */
export function buildDrawBrackets(
  matches: readonly PreviewMatch[],
  teamNames: ReadonlyMap<string, string>,
  teamCrests: ReadonlyMap<string, string> = new Map(),
  /** Competition names for leaves whose matches carry no rich group label. */
  leafLabels: ReadonlyMap<string, string> = new Map(),
): DrawBracket[] {
  // Numbers and round names are derived from ALL the matches passed in, so a
  // bracket printed on its own still says "Match 7" the way the sheet does.
  const numbers = matchNumbers(matches);
  const refLabels = new Map(
    [...numbers].map(([ref, n]) => [ref, `${t("Match")} ${n}`]),
  );
  const roundNames = roundLabels(matches);

  const byLeaf = new Map<string, PreviewMatch[]>();
  for (const m of matches) {
    if (m.stage !== "knockout") continue;
    const list = byLeaf.get(m.leaf_key);
    if (list) list.push(m);
    else byLeaf.set(m.leaf_key, [m]);
  }

  const out: DrawBracket[] = [];
  for (const [leafKey, ms] of byLeaf) {
    const byRound = new Map<number, BracketPair[]>();
    for (const m of ms) {
      const day = m.scheduled_at ? m.scheduled_at.slice(0, 10) : "";
      const clock = fmtClock(clockOf(m.scheduled_at));
      const pair: BracketPair = {
        ref: m.ref,
        number: numbers.get(m.ref) ?? 0,
        roundLabel: roundNames.get(m.ref) ?? "",
        home: sideName(m.home, teamNames, refLabels),
        away: sideName(m.away, teamNames, refLabels),
        homeCrest: sideCrest(m.home, teamCrests),
        awayCrest: sideCrest(m.away, teamCrests),
        when: day ? `${fmtDayLabel(day)}${clock ? ` · ${clock}` : ""}` : "",
      };
      const list = byRound.get(m.round_no);
      if (list) list.push(pair);
      else byRound.set(m.round_no, [pair]);
    }

    // A third-place playoff SHARES the final's round number — only its
    // loser-fed sides tell the two apart — so a band per round number would
    // print the playoff under the heading "Final". Bands are per round AND
    // per name, and the playoff sorts after the round it shares.
    const rounds: BracketRound[] = [...byRound.entries()]
      .flatMap(([round, pairs]) => {
        const byName = new Map<string, BracketPair[]>();
        for (const pair of pairs) {
          const name = pair.roundLabel || `R${round}`;
          const list = byName.get(name);
          if (list) list.push(pair);
          else byName.set(name, [pair]);
        }
        return [...byName.entries()].map(([label, group]) => {
          group.sort((a, b) => a.number - b.number || a.ref.localeCompare(b.ref));
          return { round, label, pairs: group };
        });
      })
      .sort(
        (a, b) =>
          a.round - b.round ||
          Number(a.label === t("3rd place")) - Number(b.label === t("3rd place")),
      );

    // An entry bye: a real team whose first appearance is after the bracket's
    // opening round, because the draw is not a power of two. It is shown on
    // screen as a ghost "Bye" card, and it belongs on paper for the same
    // reason — the team needs to know it is not playing that round.
    const first = rounds[0]?.round ?? 0;
    const seen = new Set<string>();
    const byes: BracketBye[] = [];
    for (const r of rounds) {
      for (const m of ms) {
        if (m.round_no !== r.round) continue;
        for (const side of [m.home, m.away]) {
          if (!side.team_id || seen.has(side.team_id)) continue;
          seen.add(side.team_id);
          if (r.round === first) continue;
          byes.push({
            name: teamNames.get(side.team_id) ?? t("TBD"),
            crest: teamCrests.get(side.team_id) ?? "",
            round: r.round,
            roundLabel: r.label,
          });
        }
      }
    }

    const named = ms.find((m) => m.group_label);
    out.push({
      leafKey,
      label:
        (named ? competitionLabel(named) : "") || leafLabels.get(leafKey) || leafKey,
      rounds,
      byes,
    });
  }
  return out;
}
