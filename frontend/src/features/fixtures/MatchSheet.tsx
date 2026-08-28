import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type PublicRosterPlayer,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  FINAL_STATUSES,
  LIVE_STATUSES,
  slotLabel,
  winnerOf,
  type RosterIndex,
} from "./publicTournament";
import { LabelChips } from "./publicTournamentViews";
import { StatusPill, fmtDayShort, fmtKickoff } from "./publicMatchCard";

/**
 * The order of play as a SHEET: one aligned row per match, the way a fixture
 * is printed and read at a venue.
 *
 * Cards stacked down a page have no columns, so nothing lines up and nothing
 * can be scanned — you cannot run your eye down "who won" or "what time".
 * A table can: match number, time, competition, both sides, score, winner,
 * status, each in its own column, every row the same shape (owner 2026-08-21).
 *
 * Two things the old rows never said, and a fixture must:
 *  - the MATCH NUMBER the draw gave it, so a bracket pointer can be looked up;
 *  - what an empty side is WAITING ON ("Winner of M12", "Group A top 2"),
 *    never a bare "TBD".
 */

/** The names a team entered, under the team that entered them — the detailed
 * pass of the printed fixture. A team with no published sheet says so rather
 * than leaving the reader wondering whether it has no players or the export
 * dropped them.
 *
 * Exported because the printed group composition names its players the same
 * way: two lists of the same team's players in two shapes would read as two
 * different squads. */
export function TeamSheet({
  players,
}: {
  players: PublicRosterPlayer[] | undefined;
}): React.ReactElement {
  if (!players || players.length === 0) {
    return (
      <span className="mt-0.5 block pl-[1.375rem] text-[0.78em] italic leading-tight text-muted-foreground">
        {t("No team sheet")}
      </span>
    );
  }
  return (
    <ol className="mt-0.5 flex flex-col gap-px pl-[1.375rem] text-[0.78em] leading-tight text-muted-foreground">
      {players.map((p) => (
        <li key={p.id} className="whitespace-normal">
          {p.jersey_no != null ? (
            <span className="font-tabular">{p.jersey_no}. </span>
          ) : null}
          {p.name}
          {p.captain ? ` (${t("C")})` : ""}
        </li>
      ))}
    </ol>
  );
}

/** One side of a match: the team, or the slot it is waiting on. */
function TeamCell({
  side,
  source,
  numbers,
  winner,
  rosters,
}: {
  side: PublicScheduleMatch["home"];
  source: PublicScheduleMatch["home_source"];
  numbers: Map<string, number>;
  winner: boolean;
  /** Present = the detailed pass: name every player under the team. */
  rosters?: RosterIndex;
}): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  if (!side) {
    const waiting = slotLabel(source, numbers);
    return (
      <span
        className={cn(
          "block truncate text-[0.9em]",
          waiting ? "text-muted-foreground" : "italic text-muted-foreground",
        )}
      >
        {waiting ?? t("To be decided")}
      </span>
    );
  }
  const link = (
    <Link
      to={routes.publicTeam(slug, id, side.id)}
      title={side.name}
      className={cn(
        // Above the row's stretched match link, so a name still opens its team.
        "pointer-events-auto relative z-10 flex w-fit max-w-full items-center gap-1.5 rounded-sm hover:text-primary hover:underline",
        winner ? "font-semibold text-foreground" : "",
      )}
    >
      {/* The crest keeps its size; only the name gives way. */}
      <span className="shrink-0">
        <TeamCrest src={side.crest} name={side.name} size="xs" />
      </span>
      {/* `truncate` alone does nothing to a flex item: its default
          min-width:auto refuses to shrink below the text, so a long school
          name spilled out of its column and ran into the score instead of
          ending in an ellipsis (owner 2026-08-27). `min-w-0` is what lets it
          give way; the title carries the full name. */}
      <span className="min-w-0 truncate">{side.name}</span>
    </Link>
  );
  if (!rosters) return link;
  return (
    <span className="block">
      {link}
      <TeamSheet players={rosters.get(side.id)} />
    </span>
  );
}

/** Score column: the number that IS the score, with the detail under it. */
function ScoreCell({ m }: { m: PublicScheduleMatch }): React.ReactElement {
  const sv = liveSetView(m);
  const live = LIVE_STATUSES.has(m.status);
  const final = FINAL_STATUSES.has(m.status);
  if (!live && !final) {
    return (
      <span className="text-[0.85em] text-muted-foreground">{t("Not played")}</span>
    );
  }
  const hasPens = m.home_pens != null && m.away_pens != null;
  const headline = sv
    ? `${sv.points[0]}-${sv.points[1]}`
    : `${m.home_score ?? 0}-${m.away_score ?? 0}`;
  // A sheet row is ONE line. The set-by-set breakdown turned every played row
  // into three and made the day unscannable; it is in the match, which is one
  // tap away (owner 2026-08-25). Only a live match keeps a detail line, and
  // only the set count — that is the thing a row cannot otherwise say.
  const detail = live
    ? [
        sv ? `${t("Sets")} ${sv.sets[0]}-${sv.sets[1]}` : "",
        hasPens ? `(${m.home_pens}-${m.away_pens} ${t("pens")})` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : hasPens
      ? `(${m.home_pens}-${m.away_pens} ${t("pens")})`
      : "";
  return (
    <span className="flex flex-col items-end">
      <span
        data-testid={`sheet-score-${m.id}`}
        className={cn(
          "font-tabular text-[1em] font-semibold",
          live && "text-primary",
        )}
      >
        {headline}
      </span>
      {detail ? (
        <span
          data-testid={`sheet-detail-${m.id}`}
          className="font-tabular text-[0.78em] leading-tight text-muted-foreground"
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}

export interface MatchSheetProps {
  matches: PublicScheduleMatch[];
  timeZone: string;
  /** Fixture match numbers, keyed by match id (see `matchNumbers`). */
  numbers: Map<string, number>;
  /** Name the court in its own column — the by-time sheet needs it; a court's
   * own sheet does not (its heading already says it). */
  showCourt?: boolean;
  /** Name the day. A single competition runs across days, so its own sheet
   * needs it; a match day's does not. */
  showDay?: boolean;
  /** Name the competition. A mixed sheet must (the match number is counted
   * within one); a competition's own sheet already is one. */
  showCompetition?: boolean;
  /** Namespaces the testids when several sheets share a page. */
  idScope?: string;
  /** The match this sheet's queue is waiting on, flagged in its status cell —
   * a court's one live question when nothing on it is on yet. */
  nextId?: string;
  /** Where a row leads. Defaults to the full match hub; the public match
   * centre points it at its own drawer instead, which is still a real link
   * (middle-click opens the sheet with that match already open). */
  linkFor?: (m: PublicScheduleMatch) => string;
  /** Present = the DETAILED sheet: the same fixture, with every player named
   * under the team that entered them. Used by the printed fixture's second
   * pass; the screen reads by team. */
  rosters?: RosterIndex;
}

/** A plain click anywhere on a row opens its match; see the row for why this
 * is a handler and not a stretched link. Modified clicks (new tab), clicks on
 * a control or link of the row's own, and a text selection are left to do
 * what they already do. */
function openRow(
  e: React.MouseEvent<HTMLTableRowElement>,
  href: string,
  navigate: (to: string) => void,
): void {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const target = e.target as Element;
  if (target.closest("a, button, input, select, textarea, [role='button']"))
    return;
  if (window.getSelection()?.toString()) return;
  navigate(href);
}

export function MatchSheet({
  matches,
  timeZone,
  numbers,
  showCourt = false,
  showDay = false,
  showCompetition = true,
  idScope = "sheet",
  nextId,
  linkFor,
  rosters,
}: MatchSheetProps): React.ReactElement {
  const navigate = useNavigate();
  const heads = [
    {
      key: "no",
      label: t("No"),
      cls: "w-10 text-left",
      // The number is counted within its own competition (the way the draw
      // numbers it), so three different M4s can share one court's sheet —
      // which is exactly why the competition sits in the next column and is
      // never hidden.
      title: t("Match number within its competition"),
    },
    ...(showDay ? [{ key: "day", label: t("Day"), cls: "w-20 text-left" }] : []),
    { key: "time", label: t("Time"), cls: "w-14 text-left" },
    ...(showCourt
      ? [{ key: "court", label: t("Court"), cls: "w-24 text-left" }]
      : []),
    ...(showCompetition
      ? [{ key: "event", label: t("Competition"), cls: "w-44 text-left" }]
      : []),
    // The two name columns are the only ones without a width: under
    // table-fixed they split whatever the fixed columns leave, so the sheet
    // spends its width on the names rather than on empty left-hand gutters.
    { key: "home", label: t("Home"), cls: "text-left" },
    { key: "away", label: t("Away"), cls: "text-left" },
    { key: "score", label: t("Score"), cls: "w-20 text-right" },
    { key: "winner", label: t("Winner"), cls: "w-32 text-left" },
    { key: "status", label: t("Status"), cls: "w-24 text-left" },
  ];

  return (
    // The sheet keeps its columns at every width: below the point where they
    // stop fitting it scrolls sideways rather than collapsing into cards, so
    // it is still a sheet on a phone.
    <div className="min-w-0 overflow-x-auto">
      <table
        data-testid={`${idScope}-table`}
        className={cn(
          // FIXED layout (owner 2026-08-27). Under auto layout a long school
          // name ("St. Thomas Higher Secondary School, Nagagaon ST-1") grew
          // its own column and squeezed Score and Winner until they collided,
          // while the narrow left-hand columns kept space nobody needed. With
          // table-fixed the widths below are the widths, so a long name
          // truncates inside its cell instead of shoving the row about.
          "w-full table-fixed border-collapse text-[clamp(0.75rem,0.66rem+0.28vw,1rem)]",
          showCompetition ? "min-w-[62rem]" : "min-w-[46rem]",
        )}
      >
        <thead>
          <tr className="border-b border-border bg-muted text-[0.72em] uppercase tracking-wide text-muted-foreground">
            {heads.map((h) => (
              <th
                key={h.key}
                scope="col"
                // Names the column for the print stylesheet: on paper the
                // screen's fixed widths are wrong (they are cut for a 62rem
                // board) and each column needs its own share of the page.
                data-col={h.key}
                title={"title" in h ? (h.title as string) : undefined}
                className={cn("px-3 py-1.5 font-semibold", h.cls)}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {matches.map((m) => {
            const live = LIVE_STATUSES.has(m.status);
            const sv = liveSetView(m);
            const win = winnerOf(m);
            const no = numbers.get(m.id);
            const href = linkFor ? linkFor(m) : routes.liveViewer(m.id);
            return (
              <tr
                key={m.id}
                data-testid={`${idScope}-row-${m.id}`}
                // The whole row opens the match: a CLICK HANDLER, not a
                // stretched link. The first cut put `relative` on the <tr>
                // and an `absolute inset-0` link inside it — and Safari does
                // not honour `position: relative` on a table row, so on
                // every iPhone the overlay grew to the nearest positioned
                // ancestor and sat, invisible, over the tabs and the
                // toolbar: a tap on "Standings" opened the last match of the
                // page as a drawer instead (owner 2026-08-28: "no iphone
                // users can tap and check the other pages"). The real link
                // now stays inside its own cell (which CAN be `relative`),
                // for keyboards, screen readers and middle-click; the rest
                // of the row hands a plain click to the same place, and
                // leaves alone anything that is already a control, a
                // modified click, or a text selection in progress.
                onClick={(e) => openRow(e, href, navigate)}
                className={cn(
                  "cursor-pointer transition-colors hover:bg-accent focus-within:bg-accent",
                  live && "bg-primary/[0.04]",
                )}
              >
                <td
                  data-col="no"
                  className={cn(
                    "relative px-3 py-2 align-middle",
                    // border-collapse drops a border set on the <tr>, so the
                    // live rule lives on the row's first cell.
                    live && "border-l-2 border-primary",
                  )}
                >
                  <Link
                    to={href}
                    aria-label={`${t("Match")} ${no ?? ""} ${m.home?.name ?? t("To be decided")} ${t("vs")} ${m.away?.name ?? t("To be decided")}`}
                    className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                  <span
                    data-testid={`${idScope}-no-${m.id}`}
                    className={cn(
                      "font-tabular text-[0.85em] font-semibold",
                      live ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {no != null ? `M${no}` : ""}
                  </span>
                </td>
                {showDay ? (
                  <td data-col="day" className="whitespace-nowrap px-3 py-2 align-middle text-[0.85em] text-muted-foreground">
                    {m.day ? fmtDayShort(m.day) : t("TBD")}
                  </td>
                ) : null}
                <td data-col="time" className="whitespace-nowrap px-3 py-2 align-middle font-tabular text-[0.9em]">
                  {fmtKickoff(m.scheduled_at, timeZone)}
                </td>
                {showCourt ? (
                  <td data-col="court" className="truncate px-3 py-2 align-middle text-[0.85em] text-muted-foreground">
                    {m.venue || t("No court yet")}
                  </td>
                ) : null}
                {showCompetition ? (
                  <td
                    data-col="event"
                    className="max-w-0 px-3 py-2 align-middle"
                  >
                    {/* Chips, on ONE line. They wrapped four rows deep for
                        "Table Tennis / Open Category / Boys / Doubles" and
                        stacked the whole sheet (owner 2026-08-25) — but a
                        dashed blob is the thing chips exist to avoid, so the
                        row clips instead of unwrapping. */}
                    <LabelChips
                      label={m.leaf_label}
                      className="flex w-full flex-nowrap overflow-hidden"
                    />
                  </td>
                ) : null}
                <td
                  data-col="home"
                  className={cn(
                    "px-3 py-2",
                    // A team sheet is a block, so its cell tops out with the
                    // name; a bare team name still centres on its row.
                    rosters ? "align-top" : "align-middle",
                  )}
                >
                  <TeamCell
                    side={m.home}
                    source={m.home_source}
                    numbers={numbers}
                    winner={Boolean(win && m.home && win.id === m.home.id)}
                    rosters={rosters}
                  />
                </td>
                <td
                  data-col="away"
                  className={cn(
                    "px-3 py-2",
                    rosters ? "align-top" : "align-middle",
                  )}
                >
                  <TeamCell
                    side={m.away}
                    source={m.away_source}
                    numbers={numbers}
                    winner={Boolean(win && m.away && win.id === m.away.id)}
                    rosters={rosters}
                  />
                </td>
                <td data-col="score" className="px-3 py-2 text-right align-middle">
                  <ScoreCell m={m} />
                </td>
                <td data-col="winner" className="px-3 py-2 align-middle">
                  {win ? (
                    <span
                      data-testid={`${idScope}-winner-${m.id}`}
                      title={win.name}
                      className="flex items-center gap-1.5 text-[0.85em] font-semibold"
                    >
                      <span className="shrink-0">
                        <TeamCrest src={win.crest} name={win.name} size="xs" />
                      </span>
                      {/* The full name, truncated: a parent scanning "who
                          won" recognises "Holy Cross Higher..." and does not
                          recognise "HCHSS". The title carries the rest.
                          `min-w-0` is what actually lets it shrink — see the
                          note in TeamCell. */}
                      <span className="min-w-0 truncate">{win.name}</span>
                    </span>
                  ) : (
                    <span className="text-[0.85em] text-muted-foreground">
                      {LIVE_STATUSES.has(m.status) ? t("In play") : ""}
                    </span>
                  )}
                </td>
                <td data-col="status" className="px-3 py-2 align-middle">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={m.status} />
                    {m.id === nextId ? (
                      <span
                        data-testid={`flag-${m.id}`}
                        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.78em] font-medium text-primary"
                      >
                        {t("Next up")}
                      </span>
                    ) : null}
                    {/* Which part of the match is running — "Set 2", "first
                        half". A live pill alone does not say. */}
                    {live && (sv || m.current_period) ? (
                      <span
                        data-testid={`period-${m.id}`}
                        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.78em] font-medium capitalize text-primary"
                      >
                        {sv
                          ? `${t("Set")} ${sv.setNo}`
                          : t(m.current_period.replace(/_/g, " "))}
                      </span>
                    ) : null}
                    {/* A finished match has nothing to watch live. */}
                    <WatchLiveLink
                      url={live ? m.watch_url : null}
                      className="pointer-events-auto relative z-10 h-6 px-1.5 text-[0.78em] text-primary hover:bg-primary/10"
                      testid={`watch-live-${m.id}`}
                      label={t("Watch this match live on YouTube")}
                    />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
