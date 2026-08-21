import { Link, useParams } from "react-router-dom";
import { type PublicScheduleMatch } from "@/api/tournaments";
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
} from "./publicTournament";
import { LabelChips } from "./publicTournamentViews";
import { StatusPill, fmtKickoff } from "./publicMatchCard";

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

/** One side of a match: the team, or the slot it is waiting on. */
function TeamCell({
  side,
  source,
  numbers,
  winner,
}: {
  side: PublicScheduleMatch["home"];
  source: PublicScheduleMatch["home_source"];
  numbers: Map<string, number>;
  winner: boolean;
}): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  if (!side) {
    const waiting = slotLabel(source, numbers);
    return (
      <span
        className={cn(
          "block truncate text-xs",
          waiting ? "text-muted-foreground" : "italic text-muted-foreground",
        )}
      >
        {waiting ?? t("To be decided")}
      </span>
    );
  }
  return (
    <Link
      to={routes.publicTeam(slug, id, side.id)}
      className={cn(
        // Above the row's stretched match link, so a name still opens its team.
        "pointer-events-auto relative z-10 flex w-fit max-w-full items-center gap-1.5 rounded-sm hover:text-primary hover:underline",
        winner ? "font-semibold text-foreground" : "",
      )}
    >
      <TeamCrest src={side.crest} name={side.name} size="xs" />
      <span className="truncate">{side.name}</span>
    </Link>
  );
}

/** Score column: the number that IS the score, with the detail under it. */
function ScoreCell({ m }: { m: PublicScheduleMatch }): React.ReactElement {
  const sv = liveSetView(m);
  const live = LIVE_STATUSES.has(m.status);
  const final = FINAL_STATUSES.has(m.status);
  if (!live && !final) {
    return <span className="text-xs text-muted-foreground">{t("Not played")}</span>;
  }
  const sets = sv ? sv.finished : (m.set_scores ?? []);
  const hasPens = m.home_pens != null && m.away_pens != null;
  const headline = sv
    ? `${sv.points[0]}-${sv.points[1]}`
    : `${m.home_score ?? 0}-${m.away_score ?? 0}`;
  const detail = [
    sv ? `${t("Sets")} ${sv.sets[0]}-${sv.sets[1]}` : "",
    sets.map(([h, a]) => `${h}-${a}`).join(" · "),
    hasPens ? `(${m.home_pens}-${m.away_pens} ${t("pens")})` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex flex-col items-end">
      <span
        data-testid={`sheet-score-${m.id}`}
        className={cn(
          "font-tabular text-sm font-semibold",
          live && "text-primary",
        )}
      >
        {headline}
      </span>
      {detail ? (
        <span
          data-testid={`sheet-detail-${m.id}`}
          className="font-tabular text-[0.6875rem] leading-tight text-muted-foreground"
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
  /** Namespaces the testids when several sheets share a page. */
  idScope?: string;
  /** The match this sheet's queue is waiting on, flagged in its status cell —
   * a court's one live question when nothing on it is on yet. */
  nextId?: string;
  /** Where a row leads. Defaults to the full match hub; the public match
   * centre points it at its own drawer instead, which is still a real link
   * (middle-click opens the sheet with that match already open). */
  linkFor?: (m: PublicScheduleMatch) => string;
}

export function MatchSheet({
  matches,
  timeZone,
  numbers,
  showCourt = false,
  idScope = "sheet",
  nextId,
  linkFor,
}: MatchSheetProps): React.ReactElement {
  const heads = [
    {
      key: "no",
      label: t("No"),
      cls: "w-12 text-left",
      // The number is counted within its own competition (the way the draw
      // numbers it), so three different M4s can share one court's sheet —
      // which is exactly why the competition sits in the next column and is
      // never hidden.
      title: t("Match number within its competition"),
    },
    { key: "time", label: t("Time"), cls: "w-16 text-left" },
    ...(showCourt
      ? [{ key: "court", label: t("Court"), cls: "w-28 text-left" }]
      : []),
    { key: "event", label: t("Competition"), cls: "w-52 text-left" },
    { key: "home", label: t("Home"), cls: "min-w-[9rem] text-left" },
    { key: "away", label: t("Away"), cls: "min-w-[9rem] text-left" },
    { key: "score", label: t("Score"), cls: "w-24 text-right" },
    { key: "winner", label: t("Winner"), cls: "w-40 text-left" },
    { key: "status", label: t("Status"), cls: "w-28 text-left" },
  ];

  return (
    // The sheet keeps its columns at every width: below the point where they
    // stop fitting it scrolls sideways rather than collapsing into cards, so
    // it is still a sheet on a phone.
    <div className="overflow-x-auto">
      <table
        data-testid={`${idScope}-table`}
        className="w-full min-w-[62rem] border-collapse text-sm"
      >
        <thead>
          <tr className="border-b border-border bg-muted text-[0.625rem] uppercase tracking-wide text-muted-foreground">
            {heads.map((h) => (
              <th
                key={h.key}
                scope="col"
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
            return (
              <tr
                key={m.id}
                data-testid={`${idScope}-row-${m.id}`}
                // `relative` on the row is what lets ONE link cover it; every
                // cell's own links sit above it on z-10.
                className={cn(
                  "relative transition-colors hover:bg-accent focus-within:bg-accent",
                  live && "bg-primary/[0.04]",
                )}
              >
                <td
                  className={cn(
                    "px-3 py-2 align-middle",
                    // border-collapse drops a border set on the <tr>, so the
                    // live rule lives on the row's first cell.
                    live && "border-l-2 border-primary",
                  )}
                >
                  {/* The whole row opens the match centre. */}
                  <Link
                    to={linkFor ? linkFor(m) : routes.liveViewer(m.id)}
                    aria-label={`${t("Match")} ${no ?? ""} ${m.home?.name ?? t("To be decided")} ${t("vs")} ${m.away?.name ?? t("To be decided")}`}
                    className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                  <span
                    data-testid={`${idScope}-no-${m.id}`}
                    className={cn(
                      "font-tabular text-xs font-semibold",
                      live ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {no != null ? `M${no}` : ""}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-middle font-tabular text-xs">
                  {fmtKickoff(m.scheduled_at, timeZone)}
                </td>
                {showCourt ? (
                  <td className="truncate px-3 py-2 align-middle text-xs text-muted-foreground">
                    {m.venue || t("No court yet")}
                  </td>
                ) : null}
                <td className="px-3 py-2 align-middle">
                  <LabelChips label={m.leaf_label} />
                </td>
                <td className="max-w-0 px-3 py-2 align-middle">
                  <TeamCell
                    side={m.home}
                    source={m.home_source}
                    numbers={numbers}
                    winner={Boolean(win && m.home && win.id === m.home.id)}
                  />
                </td>
                <td className="max-w-0 px-3 py-2 align-middle">
                  <TeamCell
                    side={m.away}
                    source={m.away_source}
                    numbers={numbers}
                    winner={Boolean(win && m.away && win.id === m.away.id)}
                  />
                </td>
                <td className="px-3 py-2 text-right align-middle">
                  <ScoreCell m={m} />
                </td>
                <td className="max-w-0 px-3 py-2 align-middle">
                  {win ? (
                    <span
                      data-testid={`${idScope}-winner-${m.id}`}
                      title={win.name}
                      className="flex items-center gap-1.5 truncate text-xs font-semibold"
                    >
                      <TeamCrest src={win.crest} name={win.name} size="xs" />
                      {/* The full name, truncated: a parent scanning "who
                          won" recognises "Holy Cross Higher..." and does not
                          recognise "HCHSS". The title carries the rest. */}
                      <span className="truncate">{win.name}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {LIVE_STATUSES.has(m.status) ? t("In play") : ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-middle">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={m.status} />
                    {m.id === nextId ? (
                      <span
                        data-testid={`flag-${m.id}`}
                        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary"
                      >
                        {t("Next up")}
                      </span>
                    ) : null}
                    {/* Which part of the match is running — "Set 2", "first
                        half". A live pill alone does not say. */}
                    {live && (sv || m.current_period) ? (
                      <span
                        data-testid={`period-${m.id}`}
                        className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium capitalize text-primary"
                      >
                        {sv
                          ? `${t("Set")} ${sv.setNo}`
                          : t(m.current_period.replace(/_/g, " "))}
                      </span>
                    ) : null}
                    <WatchLiveLink
                      url={m.watch_url}
                      variant="ghost"
                      className="pointer-events-auto relative z-10 h-6 px-1.5 text-[0.6875rem] text-primary hover:bg-primary/10"
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
