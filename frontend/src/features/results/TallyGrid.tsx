import { Link } from "react-router-dom";
import type { PublicResultSchool } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MedalChip, medalColumn } from "./MedalChip";
import {
  cellPlacings,
  columnMedals,
  rankOf,
  scopedTotals,
  type ResultBand,
  type ResultColumn,
} from "./resultsMatrix";

/**
 * The medal tally, as the sheet it replaces.
 *
 * Schools down, one column per competition banded by sport, and the cell holds
 * the PLACING — the exact shape of the ANPSA Dimapur sheet this was built from,
 * because that is the shape a host already reads. What is added is the points
 * column, which is the argument the paper sheet cannot settle.
 *
 * A matrix stays a matrix on a phone: it scrolls sideways with the school
 * column pinned, since collapsing a grid into cards destroys the one thing a
 * grid is for. Every number in the footer is counted from the ROWS ON SCREEN,
 * so a filtered sheet can never contradict itself.
 */
export function TallyGrid({
  slug,
  id,
  bands,
  columns,
  rows,
  places,
  labelOf,
}: {
  slug: string;
  id: string;
  bands: ResultBand[];
  columns: ResultColumn[];
  rows: PublicResultSchool[];
  places: number[];
  labelOf: (place: number) => string;
}): React.ReactElement {
  const ranks = rankOf(rows, columns, places);
  const stick =
    "w-44 min-w-44 max-w-44 sm:w-64 sm:min-w-64 sm:max-w-64 lg:w-80 lg:min-w-80 lg:max-w-80";

  return (
    <div className="-mx-3 overflow-x-auto sm:mx-0">
      <table
        data-testid="tally-grid"
        className="w-full min-w-[52rem] border-separate border-spacing-0 text-[clamp(0.7rem,0.62rem+0.28vw,0.95rem)]"
      >
        <caption className="sr-only">
          {t(
            "Every school's placings, competition by competition, with medals and points",
          )}
        </caption>
        <thead>
          <tr>
            <th
              rowSpan={2}
              scope="col"
              className={cn(
                "sticky left-0 top-0 z-10 border-b border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                stick,
              )}
            >
              {t("School")}
            </th>
            {bands.map((b) => (
              <th
                key={b.sportKey}
                colSpan={b.columns.length}
                scope="colgroup"
                data-testid={`tally-band-${b.sportKey}`}
                className="border-b border-l border-border bg-primary/10 px-2 py-1.5 text-center text-xs font-semibold text-primary"
              >
                {b.sportName}
              </th>
            ))}
            {places.map((p, i) => (
              <th
                key={p}
                rowSpan={2}
                scope="col"
                data-testid={`tally-medal-head-${p}`}
                className={cn(
                  "border-b border-border px-2 py-2 text-center text-[0.6875rem] font-semibold uppercase tracking-wide",
                  medalColumn(p).head,
                  i === 0 && "border-l",
                )}
              >
                {labelOf(p)}
              </th>
            ))}
            <th
              rowSpan={2}
              scope="col"
              className="border-b border-l border-border bg-card px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t("Points")}
            </th>
          </tr>
          <tr>
            {columns.map((c) => (
              <th
                key={c.leaf_key}
                scope="col"
                title={`${c.sport_name} · ${c.title}`}
                data-testid={`tally-col-${c.leaf_key}`}
                className="border-b border-l border-border bg-muted/50 px-2 py-2 text-center font-tabular text-xs font-semibold"
              >
                {c.code}
                <span className="sr-only">
                  {" "}
                  {c.sport_name} {c.title}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const totals = scopedTotals(row, columns);
            /* The stripe is set on the row AND repeated on the pinned cell:
               the sticky column needs an opaque background of its own, and
               leaving it plain would break the banding down the one column a
               reader uses to keep their place. */
            const stripe = i % 2 ? "bg-muted/20" : "bg-card";
            return (
              <tr
                key={row.id}
                data-testid={`tally-row-${row.id}`}
                className={cn("group", i % 2 && "bg-muted/20")}
              >
                <th
                  scope="row"
                  className={cn(
                    "sticky left-0 z-[5] border-b border-r border-border px-3 py-2 text-left font-normal transition-colors group-hover:bg-accent",
                    stripe,
                    stick,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-right font-tabular text-xs text-muted-foreground">
                      {totals.count ? ranks.get(row.id) : ""}
                    </span>
                    <TeamCrest src={row.crest} name={row.name} size="md" />
                    <Link
                      to={routes.publicSchool(slug, id, row.id)}
                      title={row.name}
                      className="min-w-0 flex-1 truncate text-sm font-medium hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {row.name}
                    </Link>
                  </div>
                </th>
                {columns.map((c) => {
                  const hits = cellPlacings(row, c.leaf_key);
                  return (
                    <td
                      key={c.leaf_key}
                      data-testid={hits.length ? "tally-cell" : undefined}
                      className="border-b border-l border-border px-2 py-2 text-center align-middle transition-colors group-hover:bg-accent/60"
                    >
                      {hits.length ? (
                        <span className="inline-flex flex-wrap items-center justify-center gap-1">
                          {hits
                            .slice()
                            .sort((a, b) => a.place - b.place)
                            .map((p) => (
                              <MedalChip
                                key={`${p.place}-${p.team_name}`}
                                place={p.place}
                                label={p.label}
                                title={`${p.team_name} · ${p.label} · ${p.points} ${t("points")}`}
                              />
                            ))}
                        </span>
                      ) : (
                        <>
                          <span className="sr-only">
                            {t("No placing")}
                          </span>
                          <span
                            aria-hidden="true"
                            className="text-sm text-muted-foreground/35"
                          >
                            &ndash;
                          </span>
                        </>
                      )}
                    </td>
                  );
                })}
                {places.map((p, idx) => {
                  const n = totals.medals[String(p)] ?? 0;
                  return (
                    <td
                      key={p}
                      className={cn(
                        "border-b border-border px-2 py-2 text-center font-tabular text-sm",
                        medalColumn(p).cell,
                        idx === 0 && "border-l",
                        n
                          ? cn("font-semibold", medalColumn(p).ink)
                          : "text-muted-foreground/50",
                      )}
                    >
                      {n}
                    </td>
                  );
                })}
                <td className="border-b border-l border-border px-3 py-2 text-right transition-colors group-hover:bg-accent/60">
                  <span className="font-tabular text-sm font-semibold">
                    {totals.points}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th
              scope="row"
              className={cn(
                "sticky left-0 z-[5] border-r border-border bg-card px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                stick,
              )}
            >
              {t("Medals awarded")}
            </th>
            {columns.map((c) => (
              <td
                key={c.leaf_key}
                data-testid={`tally-total-${c.leaf_key}`}
                className="border-l border-border px-2 py-2 text-center font-tabular text-xs text-muted-foreground"
              >
                {columnMedals(rows, c.leaf_key) || "-"}
              </td>
            ))}
            {places.map((p, idx) => (
              <td
                key={p}
                className={cn(
                  "px-2 py-2 text-center font-tabular text-xs",
                  medalColumn(p).cell,
                  medalColumn(p).ink,
                  idx === 0 && "border-l border-border",
                )}
              >
                {rows.reduce(
                  (n, r) => n + (scopedTotals(r, columns).medals[String(p)] ?? 0),
                  0,
                )}
              </td>
            ))}
            <td className="border-l border-border px-3 py-2 text-right font-tabular text-xs text-muted-foreground">
              {rows.reduce((n, r) => n + scopedTotals(r, columns).points, 0)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
