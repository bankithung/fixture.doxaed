import { Fragment, useMemo } from "react";
import { Lock, Radio } from "lucide-react";
import type { ControlRoomMatch, MatchRow as MatchRowT } from "@/api/tournaments";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL, IN_PLAY, fmtKickoff, isOverdue, matchWinner } from "./format";
import { RowActions, type ControlRoomPerms } from "./MatchActionsMenu";
import { StatusPill, groupSuffix } from "./MatchTile";

/** One band of the sheet: a group header row and the matches under it. */
export interface MatchSheetGroup {
  key: string;
  label: string;
  matches: ControlRoomMatch[];
  /** Extra note on the band ("Court 1", "12 matches" is automatic). */
  sub?: string;
}

/** Sport + the rest of the competition label, as separate columns. */
function splitLeaf(label: string): { sport: string; category: string } {
  const segs = label
    .split(/\s+[·—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { sport: segs[0] ?? "", category: segs.slice(1).join(" · ") };
}

/**
 * Every match list in operations as ONE spreadsheet (owner 2026-08-15 — the
 * same instrument as the fixture preview's sheet): a line per match with
 * frozen header and line numbers, grid rules, zebra rows, group bands, and a
 * WINNER column so a settled match reads without doing arithmetic on two
 * score numbers.
 *
 * It keeps every control the old dense row had — the status pill, the crew,
 * the row actions menu — and the same testids (`tile-<id>`), so the domain
 * tests and the operator's muscle memory both survive the change.
 */
export function MatchSheet({
  groups,
  timeZone,
  tournamentId,
  siblingsOf,
  perms,
  delayFor,
  badgesFor,
  showCourt = true,
  ariaLabel,
  emptyText,
}: {
  groups: MatchSheetGroup[];
  timeZone: string;
  tournamentId: string;
  siblingsOf: (m: ControlRoomMatch) => MatchRowT[];
  perms: ControlRoomPerms;
  delayFor?: (m: ControlRoomMatch) => number | null;
  /** Caller-owned chips (My tasks puts the viewer's own seat here). */
  badgesFor?: (m: ControlRoomMatch) => React.ReactNode;
  /** False when a band already names the court. */
  showCourt?: boolean;
  ariaLabel?: string;
  emptyText?: string;
}): React.ReactElement {
  const total = groups.reduce((n, g) => n + g.matches.length, 0);
  const columns = [
    { key: "time", label: t("Time"), cls: "w-16" },
    ...(showCourt ? [{ key: "court", label: t("Court"), cls: "w-24" }] : []),
    { key: "sport", label: t("Sport"), cls: "hidden w-28 lg:table-cell" },
    { key: "category", label: t("Category"), cls: "hidden w-40 md:table-cell" },
    { key: "stage", label: t("Stage"), cls: "hidden w-24 lg:table-cell" },
    { key: "home", label: t("Home"), cls: "w-48" },
    { key: "score", label: t("Score"), cls: "w-20 text-center" },
    { key: "away", label: t("Away"), cls: "w-48" },
    { key: "winner", label: t("Winner"), cls: "w-40" },
    { key: "status", label: t("Status"), cls: "w-28" },
    ...(badgesFor ? [{ key: "seat", label: t("Your seat"), cls: "w-24" }] : []),
    { key: "crew", label: t("Crew"), cls: "hidden w-28 xl:table-cell" },
    { key: "actions", label: "", cls: "w-10" },
  ];
  const span = columns.length + 1;
  // Line numbers run continuously down the sheet and are assigned here, so
  // render never mutates a counter.
  const lineNos = useMemo(() => {
    const out = new Map<string, number>();
    let n = 0;
    for (const g of groups) {
      for (const m of g.matches) {
        n += 1;
        out.set(m.id, n);
      }
    }
    return out;
  }, [groups]);

  return (
    <div className="w-full overflow-x-auto">
      <table
        data-testid="match-sheet"
        aria-label={ariaLabel}
        className="w-full border-separate border-spacing-0 text-xs"
      >
        <thead>
          <tr data-testid="match-sheet-header">
            <th
              scope="col"
              className="sticky left-0 top-0 z-30 w-10 border-b border-r border-border bg-muted px-2 py-1.5 text-right text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground"
            >
              #
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "sticky top-0 z-20 border-b border-r border-border bg-muted px-2 py-1.5 text-left text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0",
                  c.cls,
                )}
              >
                {c.label || <span className="sr-only">{t("Actions")}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {total === 0 ? (
            <tr>
              <td
                colSpan={span}
                className="border-b border-border px-3 py-10 text-center text-sm text-muted-foreground"
              >
                {emptyText ?? t("No matches fit these filters.")}
              </td>
            </tr>
          ) : null}

          {groups.map((g) => (
            <Fragment key={g.key}>
              {g.label ? (
                <tr data-testid={`sheet-band-${g.key}`}>
                  <td
                    colSpan={span}
                    className="border-b border-border bg-secondary/60 px-2 py-1"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {/* The band is a heading — it names the run of matches
                          under it, for screen readers as much as for the eye. */}
                      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide">
                        {g.label}
                      </h3>
                      {g.sub ? (
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {g.sub}
                        </span>
                      ) : null}
                      <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                        {g.matches.length}{" "}
                        {g.matches.length === 1 ? t("match") : t("matches")}
                      </span>
                    </span>
                  </td>
                </tr>
              ) : null}

              {g.matches.map((m) => {
                const lineNo = lineNos.get(m.id) ?? 0;
                const zebra = lineNo % 2 === 0 ? "bg-muted/20" : "bg-card";
                const live = IN_PLAY.has(m.status);
                const done = FINAL.has(m.status);
                const overdue = isOverdue(m);
                const showScore = live || done;
                const sv = showScore ? liveSetView(m) : null;
                const winner = matchWinner(m);
                const grp = groupSuffix(m.leaf_label, m.group_label);
                const { sport, category } = splitLeaf(m.leaf_label);
                const delay = delayFor?.(m) ?? null;
                // A settled line reads green the whole way across, so a long
                // day shows at a glance what is finished (owner 2026-07-26).
                const tone = done ? "bg-success-muted/50" : zebra;
                const td =
                  "border-b border-r border-border/60 px-2 py-1.5 last:border-r-0 group-hover:bg-accent/40";
                return (
                  <tr
                    key={m.id}
                    data-testid={`tile-${m.id}`}
                    data-done={done ? "true" : undefined}
                    className={cn("group", tone)}
                  >
                    <td
                      className={cn(
                        "sticky left-0 z-10 border-b border-r border-border px-2 py-1.5 text-right font-tabular text-[0.625rem] text-muted-foreground",
                        tone,
                        live && "border-l-2 border-l-primary",
                      )}
                    >
                      {lineNo}
                    </td>

                    <td className={cn(td, "w-16 font-tabular whitespace-nowrap")}>
                      {fmtKickoff(m.scheduled_at, timeZone)}
                      {overdue ? (
                        <span
                          data-testid={`overdue-${m.id}`}
                          className="ml-1 rounded bg-destructive/15 px-1 py-0.5 text-[0.625rem] font-medium text-destructive"
                        >
                          {t("late")}
                        </span>
                      ) : null}
                    </td>

                    {showCourt ? (
                      <td className={cn(td, "w-24 truncate")}>
                        {m.venue ? (
                          m.venue
                        ) : (
                          <span className="rounded bg-warning-muted px-1.5 py-0.5 font-medium text-warning">
                            {t("No court")}
                          </span>
                        )}
                      </td>
                    ) : null}

                    <td className={cn(td, "hidden w-28 truncate lg:table-cell")}>
                      {sport}
                    </td>
                    <td
                      className={cn(
                        td,
                        "hidden w-40 truncate text-muted-foreground md:table-cell",
                      )}
                    >
                      {category}
                    </td>
                    <td className={cn(td, "hidden w-24 truncate lg:table-cell")}>
                      {grp ?? <span className="text-muted-foreground/50">·</span>}
                    </td>

                    <td className={cn(td, "w-48 max-w-0 truncate font-medium")}>
                      {m.home_team?.name ?? t("TBD")}
                    </td>
                    <td
                      className={cn(td, "w-20 whitespace-nowrap text-center font-tabular")}
                    >
                      {showScore ? (
                        <span
                          className="font-semibold"
                          title={
                            sv ? `${t("Sets")} ${sv.sets[0]}-${sv.sets[1]}` : undefined
                          }
                        >
                          {sv
                            ? `${sv.points[0]} - ${sv.points[1]}`
                            : `${m.home_score ?? 0} - ${m.away_score ?? 0}`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </td>
                    <td className={cn(td, "w-48 max-w-0 truncate font-medium")}>
                      {m.away_team?.name ?? t("TBD")}
                    </td>

                    <td
                      data-testid={`winner-${m.id}`}
                      className={cn(td, "w-40 max-w-0 truncate")}
                    >
                      {winner ? (
                        <span
                          title={winner.label}
                          className={cn(
                            "inline-block max-w-full truncate rounded px-1.5 py-0.5 font-medium",
                            winner.side === "draw"
                              ? "bg-muted text-muted-foreground"
                              : "bg-success-muted text-success",
                          )}
                        >
                          {winner.label}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">·</span>
                      )}
                    </td>

                    <td className={cn(td, "w-28")}>
                      <StatusPill match={m} />
                    </td>

                    {badgesFor ? (
                      <td className={cn(td, "w-24")}>{badgesFor(m)}</td>
                    ) : null}

                    <td
                      className={cn(
                        td,
                        "hidden w-28 truncate text-[0.6875rem] text-muted-foreground xl:table-cell",
                      )}
                    >
                      <span className="flex items-center gap-1">
                        {delay ? (
                          <span
                            data-testid={`delay-${m.id}`}
                            className="rounded bg-warning-muted px-1 py-0.5 font-tabular font-medium text-warning"
                          >
                            +{delay}
                          </span>
                        ) : null}
                        {m.locked_at ? (
                          <Lock
                            aria-label={t("Slot locked")}
                            data-testid={`lock-${m.id}`}
                            className="h-3 w-3 shrink-0"
                          />
                        ) : null}
                        {m.scorer ? (
                          <span
                            data-testid={`crew-${m.id}`}
                            className="inline-flex min-w-0 items-center gap-1"
                          >
                            <Radio aria-hidden="true" className="h-3 w-3 shrink-0" />
                            <span className="truncate">{m.scorer.name}</span>
                          </span>
                        ) : null}
                      </span>
                    </td>

                    <td className={cn(td, "w-10")}>
                      <RowActions
                        tournamentId={tournamentId}
                        match={m}
                        siblings={siblingsOf(m)}
                        perms={perms}
                      />
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
