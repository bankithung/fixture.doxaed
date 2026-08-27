import type { MatchRow, PreviewMatch, PreviewSide } from "@/api/tournaments";
import { buildRows, type PreviewRow } from "./previewGrid";
import { matchNumbers } from "./publicTournament";

/**
 * A committed `scheduled_at` (UTC, aware) as the TOURNAMENT's naive wall clock.
 *
 * The preview's rows read their day and clock by SLICING the ISO string —
 * deliberately, so no browser timezone can drift a preview whose times are
 * already tournament-local (`preview.py` emits a naive ISO). A `Match` row is
 * not that: it is a real UTC instant, so slicing printed 03:30 for a 09:00 IST
 * quarter-final while the board beside it said 09:00 (owner 2026-08-27). The
 * instant is converted here, once, at the seam where the two shapes meet.
 */
function localWallClock(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    const part: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at)) {
      part[p.type] = p.value;
    }
    // Some engines still hand back "24" for midnight under h23.
    const hour = part.hour === "24" ? "00" : part.hour;
    return `${part.year}-${part.month}-${part.day}T${hour}:${part.minute}:${part.second}`;
  } catch {
    return iso;
  }
}

/**
 * The PUBLISHED fixture, shaped for the preview's export documents.
 *
 * The preview's court grid and run sheet are the layouts an organiser prints
 * and pins to a wall, and they were reachable only from the dry run — which
 * holds an UNPUBLISHED draw. An organiser who printed from there could hand
 * out pairings the tournament was never going to play (owner 2026-08-27).
 *
 * Rather than a second set of printable documents that could drift from the
 * first, the committed `Match` rows are adapted to `PreviewMatch` and fed
 * through the very same `buildRows` -> `previewCourtGridHtml` path. One
 * layout, two sources.
 *
 * The adaptation is only about identifiers:
 *   - a match's own id becomes its `ref`, so match numbering, round names and
 *     pointer labels are computed exactly as the preview computes them;
 *   - a `winner_of` / `loser_of` pointer carries `match_id`, which is that
 *     feeder's id, so it is re-expressed as `ref` — that is what `sideName`
 *     looks up to print "Winner of Match 12" instead of a raw uuid.
 */
export function publishedRows(
  matches: readonly MatchRow[],
  /** The tournament's IANA zone (invariant 14). */
  timeZone: string,
): PreviewRow[] {
  const names = new Map<string, string>();
  const crests = new Map<string, string>();
  for (const m of matches) {
    for (const team of [m.home_team, m.away_team]) {
      if (!team) continue;
      names.set(team.id, team.name);
      if (team.crest) crests.set(team.id, team.crest);
    }
  }

  const side = (
    team: MatchRow["home_team"],
    source: MatchRow["home_source"],
  ): PreviewSide => {
    if (team) return { team_id: team.id };
    if (!source) return {};
    // `ref` IS the feeder's id here, because that is what we used as `ref`.
    const ref = source.match_id;
    return { source: ref ? { ...source, ref } : { ...source } };
  };

  const asPreview: PreviewMatch[] = matches.map((m) => ({
    ref: m.id,
    leaf_key: m.leaf_key,
    stage: m.stage,
    group_label: m.group_label,
    round_no: m.round_no,
    home: side(m.home_team, m.home_source),
    away: side(m.away_team, m.away_source),
    scheduled_at: localWallClock(m.scheduled_at, timeZone),
    venue: m.venue,
    duration_minutes: m.duration_minutes ?? null,
  }));

  // THE NUMBERS ARE THE FIXTURE'S OWN, never re-derived here.
  //
  // `previewGrid.matchNumbers` breaks ties inside a round on the digits of the
  // `ref`, because a previewed draw carries its emission order there ("p12").
  // A committed match's ref is its uuid, whose digits mean nothing — so the
  // printed grid numbered the sepak quarter-finals 16..19 in a different order
  // than the public sheet did, and its own "Winner of Match 18" then pointed
  // at a game the board called M16 (owner 2026-08-27). One rule, called from
  // both places: `publicTournament.matchNumbers`, which orders by the draw's
  // `match_no`. It feeds the printed `No` column AND every pointer label,
  // since `buildRows` builds "Winner of Match N" from this same map.
  const numbering = matchNumbers(matches);
  asPreview.sort(
    (a, b) =>
      a.leaf_key.localeCompare(b.leaf_key) ||
      (numbering.get(a.ref) ?? 0) - (numbering.get(b.ref) ?? 0),
  );

  const unscheduled = asPreview
    .filter((m) => !m.scheduled_at)
    .map((m) => m.ref);
  return buildRows(asPreview, names, unscheduled, crests, numbering);
}
