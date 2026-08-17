import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { fmtClock, fromMinutes, type BlackoutWindow, type PreviewRow } from "./previewGrid";
import {
  competitionLoads,
  courtDayLoads,
  courtTotals,
  fmtDuration,
  type CourtDayLoad,
  type CourtGap,
} from "./courtLoad";

/** Each sport gets one stable tint on the timeline, from the chart series
 * tokens (light + dark are defined for all of them). */
const SPORT_TONES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-success",
  "bg-info",
] as const;

function toneFor(sportKeys: readonly string[], key: string): string {
  const i = sportKeys.indexOf(key);
  return SPORT_TONES[(i < 0 ? 0 : i) % SPORT_TONES.length]!;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** One reading in the band above the tables. */
function Stat({
  label,
  value,
  sub,
  tone,
  testid,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warning" | "success";
  testid?: string;
}): React.ReactElement {
  return (
    <div
      data-testid={testid}
      className="flex min-w-28 flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2"
    >
      <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-tabular text-sm font-semibold",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="truncate text-[0.625rem] text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  );
}

/**
 * One court's day drawn to scale: play blocks tinted per sport, configured
 * breaks hatched, everything else left as the empty court it is. Hovering or
 * focusing a segment names it; the row below spells out every free stretch in
 * words, so the information never lives only in the picture (WCAG 2.1 AA).
 */
function CourtTimeline({
  load,
  sportKeys,
  from,
  to,
}: {
  load: CourtDayLoad;
  sportKeys: readonly string[];
  /** Day-wide bounds, shared by every court so the hour ruler lines up. */
  from: number;
  to: number;
}): React.ReactElement {
  const span = Math.max(1, to - from);
  const at = (min: number): number => ((min - from) / span) * 100;

  return (
    <div
      data-testid={`court-timeline-${load.key}`}
      className="relative h-7 w-full overflow-hidden rounded border border-border bg-muted/40"
    >
      {load.gaps.map((g) => (
        <div
          key={g.key}
          title={`${g.label} · ${fmtClock(fromMinutes(g.start))} ${t("to")} ${fmtClock(
            fromMinutes(g.end),
          )} · ${fmtDuration(g.minutes)}`}
          data-kind={g.kind}
          className={cn(
            "absolute inset-y-0",
            g.kind === "break"
              ? "bg-warning-muted"
              : "bg-[repeating-linear-gradient(135deg,transparent_0_5px,hsl(var(--border))_5px_6px)]",
          )}
          style={{ left: `${at(g.start)}%`, width: `${(g.minutes / span) * 100}%` }}
        />
      ))}
      {load.blocks.map((b) => (
        <div
          key={b.ref}
          title={`${b.competition} · ${fmtClock(fromMinutes(b.start))} ${t(
            "to",
          )} ${fmtClock(fromMinutes(b.end))} · ${b.home} ${t("v")} ${b.away}`}
          className={cn(
            "absolute inset-y-1 rounded-sm opacity-90",
            toneFor(sportKeys, b.sportKey),
          )}
          style={{
            left: `${at(b.start)}%`,
            width: `${Math.max(0.6, ((b.end - b.start) / span) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

/** The hour ruler above a day's courts, so a block can be read against a
 * clock instead of guessed at. Shares the exact bounds of the timelines
 * below it, which are uniform within a day. */
function HourAxis({
  from,
  to,
}: {
  from: number;
  to: number;
}): React.ReactElement {
  const span = Math.max(1, to - from);
  const first = Math.ceil(from / 60) * 60;
  const ticks: number[] = [];
  // One label an hour on a desk; every second hour once the day is long, so
  // the ruler never turns into a smear.
  const step = span > 8 * 60 ? 120 : 60;
  for (let m = first; m <= to; m += step) ticks.push(m);
  return (
    <div aria-hidden="true" className="relative h-3.5 w-full">
      {ticks.map((m) => (
        <span
          key={m}
          className="absolute top-0 -translate-x-1/2 font-tabular text-[0.5625rem] text-muted-foreground"
          style={{ left: `${((m - from) / span) * 100}%` }}
        >
          {fmtClock(fromMinutes(m))}
        </span>
      ))}
    </div>
  );
}

/** The free stretches of one court's day, as clickable-free plain text. */
function FreeChips({ gaps }: { gaps: readonly CourtGap[] }): React.ReactElement {
  const free = gaps.filter((g) => g.kind === "free" && g.minutes > 0);
  if (!free.length) {
    return (
      <span className="text-[0.6875rem] text-muted-foreground">
        {t("Fully used")}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {free.map((g) => (
        <span
          key={g.key}
          className="rounded bg-secondary px-1.5 py-0.5 font-tabular text-[0.6875rem] text-muted-foreground"
        >
          {fmtClock(fromMinutes(g.start))} {t("to")} {fmtClock(fromMinutes(g.end))}
          <span className="pl-1 font-medium text-foreground">
            {fmtDuration(g.minutes)}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The preview's third view (owner 2026-08-17). Two questions the sheet cannot
 * answer because it is ordered by match: *when is each court free*, and *how
 * much time does each competition actually consume*.
 *
 * It reads the same filtered rows as the sheet and the draw, so filtering to
 * one sport re-scopes the whole analysis rather than showing a second, quietly
 * different truth. Unplaced matches hold no court and are excluded from every
 * minute total; they stay visible as a count on the competition table.
 */
export function CourtLoadView({
  rows,
  dayStart,
  dayEnd,
  blackouts,
}: {
  /** Rows AFTER the toolbar's filters. */
  rows: readonly PreviewRow[];
  /** The configured daily window, which is what "free" is measured against. */
  dayStart: string;
  dayEnd: string;
  blackouts?: readonly BlackoutWindow[];
}): React.ReactElement {
  const { isMobile } = useBreakpoint();
  const [tab, setTab] = useState<"courts" | "time">("courts");

  const loads = useMemo(
    () => courtDayLoads(rows, dayStart, dayEnd, blackouts ?? []),
    [rows, dayStart, dayEnd, blackouts],
  );
  const totals = useMemo(() => courtTotals(loads), [loads]);
  const sports = useMemo(() => competitionLoads(rows), [rows]);
  const sportKeys = useMemo(() => sports.map((s) => s.sportKey), [sports]);
  const grandMinutes = useMemo(
    () => sports.reduce((sum, s) => sum + s.minutes, 0),
    [sports],
  );

  // Grouped per day, with ONE set of bounds per day: every court on a day is
  // drawn to the same scale, so two rows can be compared by eye and the hour
  // ruler above them is true for all of them.
  const byDay = useMemo(() => {
    const map = new Map<string, CourtDayLoad[]>();
    for (const l of loads) {
      const list = map.get(l.day);
      if (list) list.push(l);
      else map.set(l.day, [l]);
    }
    return [...map.entries()].map(([day, list]) => ({
      day,
      list,
      from: Math.min(...list.map((l) => l.windowStart)),
      to: Math.max(...list.map((l) => l.windowEnd)),
    }));
  }, [loads]);

  if (!loads.length) {
    return (
      <div data-testid="court-load-empty" className="px-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t("No scheduled matches to measure court time from.")}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="court-load-view" className="flex flex-col gap-3 px-3 py-3">
      {/* The readings, then the two tables behind one switch. */}
      <div className="flex flex-wrap items-center gap-2">
        <Stat
          testid="court-stat-used"
          label={t("Court time used")}
          value={fmtDuration(totals.busyMinutes)}
          sub={`${totals.courts} ${t("courts")} · ${totals.courtDays} ${t("court days")}`}
        />
        <Stat
          testid="court-stat-free"
          label={t("Court time free")}
          value={fmtDuration(totals.freeMinutes)}
          sub={
            totals.biggestFree
              ? `${t("Biggest")} ${fmtDuration(totals.biggestFree.gap.minutes)} · ${
                  totals.biggestFree.court
                }`
              : undefined
          }
          tone={totals.freeMinutes > totals.busyMinutes ? "warning" : undefined}
        />
        <Stat
          testid="court-stat-breaks"
          label={t("Breaks and ceremonies")}
          value={fmtDuration(totals.breakMinutes)}
          sub={t("Time you closed the courts")}
        />
        <Stat
          testid="court-stat-utilisation"
          label={t("Utilisation")}
          value={pct(totals.utilization)}
          sub={t("Of the hours the courts are open")}
          tone={totals.utilization >= 0.75 ? "success" : undefined}
        />
        <div
          role="radiogroup"
          aria-label={t("Court analysis view")}
          className="ml-auto inline-flex shrink-0 rounded-md border border-border bg-background p-0.5"
        >
          {(
            [
              ["courts", t("By court")],
              ["time", t("By competition")],
            ] as const
          ).map(([mode, lbl]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={tab === mode}
              data-testid={`court-tab-${mode}`}
              onClick={() => setTab(mode)}
              className={cn(
                "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                tab === mode
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {tab === "courts" ? (
        <div className="flex flex-col gap-4">
          {/* The key to the picture, in the picture's own colours. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
            {sports.map((s) => (
              <span key={s.sportKey} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn("h-2.5 w-4 rounded-sm", toneFor(sportKeys, s.sportKey))}
                />
                {s.sportLabel}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2.5 w-4 rounded-sm bg-warning-muted ring-1 ring-inset ring-border"
              />
              {t("Break you set")}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2.5 w-4 rounded-sm bg-[repeating-linear-gradient(135deg,transparent_0_5px,hsl(var(--border))_5px_6px)] ring-1 ring-inset ring-border"
              />
              {t("Court free")}
            </span>
          </div>
          {byDay.map(({ day, list, from, to }) => (
            <section key={day} data-testid={`court-day-${day}`} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold">{list[0]!.dayLabel}</h3>
              <HourAxis from={from} to={to} />
              <div className="flex flex-col gap-2">
                {list.map((l) => (
                  <div
                    key={l.key}
                    data-testid={`court-row-${l.key}`}
                    className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="text-xs font-semibold">{l.court}</span>
                      <span className="font-tabular text-[0.6875rem] text-muted-foreground">
                        {fmtClock(fromMinutes(l.windowStart))} {t("to")}{" "}
                        {fmtClock(fromMinutes(l.windowEnd))}
                      </span>
                      <span className="ml-auto flex flex-wrap items-center gap-x-3 font-tabular text-[0.6875rem]">
                        <span>
                          {l.matches} {t("matches")}
                        </span>
                        <span className="text-success">
                          {t("used")} {fmtDuration(l.busyMinutes)}
                        </span>
                        <span className={cn(l.freeMinutes > 0 && "text-warning")}>
                          {t("free")} {fmtDuration(l.freeMinutes)}
                        </span>
                        <span className="font-semibold">{pct(l.utilization)}</span>
                      </span>
                    </div>
                    <CourtTimeline load={l} sportKeys={sportKeys} from={from} to={to} />
                    <FreeChips gaps={l.gaps} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">
            {t("Court time consumed by each competition")}
          </caption>
          <thead>
            <tr>
              {(
                [
                  [t("Competition"), "left"],
                  [t("Matches"), "right"],
                  [t("Total time"), "right"],
                  [t("Per match"), "right"],
                  [t("Days"), "right"],
                  [t("Courts"), "right"],
                  [t("Share"), "right"],
                ] as const
              )
                .filter(([lbl]) => !isMobile || lbl === t("Competition") || lbl === t("Total time") || lbl === t("Matches"))
                .map(([lbl, align]) => (
                  <th
                    key={lbl}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-20 border-b border-r border-border bg-muted px-2 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0",
                      align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {lbl}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {sports.map((s) => (
              <Fragment key={s.sportKey}>
                <tr data-testid={`load-sport-${s.sportKey}`}>
                  <td
                    colSpan={isMobile ? 3 : 7}
                    className="border-b border-border bg-secondary/60 px-2 py-1"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn("h-2 w-2 rounded-sm", toneFor(sportKeys, s.sportKey))}
                      />
                      <span className="text-[0.6875rem] font-semibold uppercase tracking-wide">
                        {s.sportLabel}
                      </span>
                      <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                        {s.matches} {t("matches")} · {fmtDuration(s.minutes)} ·{" "}
                        {pct(s.share)}
                      </span>
                    </span>
                  </td>
                </tr>
                {s.competitions.map((c, i) => (
                  <tr
                    key={c.key}
                    data-testid={`load-row-${c.leafKey}`}
                    className={cn("group", i % 2 ? "bg-muted/20" : "bg-card")}
                  >
                    <td className="max-w-0 border-b border-r border-border/60 px-2 py-1 group-hover:bg-accent/40">
                      <span className="block truncate">{c.categoryLabel}</span>
                    </td>
                    <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular group-hover:bg-accent/40">
                      {c.matches}
                      {c.scheduled < c.matches ? (
                        <span className="pl-1 text-warning">
                          {t("(")}
                          {c.matches - c.scheduled} {t("no time)")}
                        </span>
                      ) : null}
                    </td>
                    <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular font-medium group-hover:bg-accent/40">
                      {fmtDuration(c.minutes)}
                    </td>
                    {isMobile ? null : (
                      <>
                        <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                          {c.avgMinutes} {t("min")}
                        </td>
                        <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                          {c.days}
                        </td>
                        <td className="border-b border-r border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                          {c.courts}
                        </td>
                        <td className="border-b border-border/60 px-2 py-1 text-right font-tabular text-muted-foreground group-hover:bg-accent/40">
                          {pct(c.share)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr data-testid="load-total">
              <td className="border-b border-r border-border bg-muted px-2 py-1 text-[0.6875rem] font-semibold uppercase tracking-wide">
                {t("All competitions")}
              </td>
              <td className="border-b border-r border-border bg-muted px-2 py-1 text-right font-tabular font-semibold">
                {sports.reduce((sum, s) => sum + s.matches, 0)}
              </td>
              <td className="border-b border-r border-border bg-muted px-2 py-1 text-right font-tabular font-semibold">
                {fmtDuration(grandMinutes)}
              </td>
              {isMobile ? null : <td colSpan={4} className="border-b border-border bg-muted" />}
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
