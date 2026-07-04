import { useEffect, useMemo, useState } from "react";
import type { OverviewDay } from "@/api/overview";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Hand-rolled SVG dataviz for the overview dashboard. Series colors come
 * from the validated --chart-* tokens (fill-chart-N utilities); marks are
 * thin, gridlines hairline, tooltips enhance (an sr-only table twin carries
 * every value). Draw-in animation is transform-only (.chart-col/.chart-bar)
 * and collapses under prefers-reduced-motion. */

export type ActivityWindow = "7d" | "30d" | "next14" | "all";

const DAY_MS = 86_400_000;

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function labelOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], {
    day: "numeric",
    month: "short",
  });
}

/** Continuous day series for the selected window, zero-filled. */
export function fillDays(
  days: OverviewDay[],
  window: ActivityWindow,
): OverviewDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const byDate = new Map(days.map((d) => [d.date, d]));
  let from: Date;
  let to: Date;
  if (window === "7d") {
    from = new Date(today.getTime() - 7 * DAY_MS);
    to = today;
  } else if (window === "30d") {
    from = new Date(today.getTime() - 30 * DAY_MS);
    to = today;
  } else if (window === "next14") {
    from = today;
    to = new Date(today.getTime() + 14 * DAY_MS);
  } else {
    from = new Date(today.getTime() - 30 * DAY_MS);
    to = new Date(today.getTime() + 14 * DAY_MS);
  }
  const out: OverviewDay[] = [];
  for (let ts = from.getTime(); ts <= to.getTime(); ts += DAY_MS) {
    const iso = isoOf(new Date(ts));
    const row = byDate.get(iso);
    out.push(
      row ?? { date: iso, completed: 0, live: 0, scheduled: 0 },
    );
  }
  return out;
}

function niceMax(v: number): number {
  if (v <= 4) return Math.max(2, v);
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (v <= step * pow) return step * pow;
  }
  return 10 * pow;
}

function roundedTopRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

const SERIES = [
  { key: "completed" as const, label: "Played", fill: "fill-chart-1", dot: "bg-chart-1" },
  { key: "live" as const, label: "Live", fill: "fill-chart-3", dot: "bg-chart-3" },
  { key: "scheduled" as const, label: "Upcoming", fill: "fill-chart-2", dot: "bg-chart-2" },
];

/** Stacked daily match columns with per-mark hover tooltip + today rule. */
export function ActivityChart({
  days,
  window,
}: {
  days: OverviewDay[];
  window: ActivityWindow;
}): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const series = useMemo(() => fillDays(days, window), [days, window]);
  const todayIso = isoOf(new Date());

  const W = 640;
  const H = 216;
  const M = { top: 12, right: 8, bottom: 22, left: 30 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const n = series.length;
  const band = plotW / n;
  const colW = Math.min(24, Math.max(3, band - 2));
  const yMax = niceMax(
    Math.max(1, ...series.map((d) => d.completed + d.live + d.scheduled)),
  );
  const yOf = (v: number): number => M.top + plotH - (v / yMax) * plotH;
  const ticks = [0, yMax / 2, yMax].map((v) => Math.round(v));
  const empty = series.every(
    (d) => d.completed + d.live + d.scheduled === 0,
  );
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const todayIdx = series.findIndex((d) => d.date === todayIso);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={cn("block w-full", drawn && "chart-drawn")}
        role="img"
        aria-label={t("Matches per day")}
      >
        {/* hairline grid + clean y ticks */}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={yOf(v)}
              y2={yOf(v)}
              className="stroke-[hsl(var(--chart-grid))]"
              strokeWidth={1}
            />
            <text
              x={M.left - 6}
              y={yOf(v) + 3}
              textAnchor="end"
              className="fill-muted-foreground font-tabular text-[10px]"
            >
              {v}
            </text>
          </g>
        ))}
        {/* today rule */}
        {todayIdx >= 0 && window !== "7d" && window !== "30d" ? (
          <g>
            <line
              x1={M.left + todayIdx * band + band / 2}
              x2={M.left + todayIdx * band + band / 2}
              y1={M.top - 2}
              y2={M.top + plotH}
              className="stroke-muted-foreground/40"
              strokeWidth={1}
            />
            <text
              x={M.left + todayIdx * band + band / 2 + 4}
              y={M.top + 6}
              className="fill-muted-foreground text-[9px]"
            >
              {t("Today")}
            </text>
          </g>
        ) : null}
        {/* stacked columns */}
        {series.map((d, i) => {
          const x = M.left + i * band + (band - colW) / 2;
          let acc = 0;
          const segs = SERIES.map((s) => {
            const v = d[s.key];
            const y0 = acc;
            acc += v;
            return { ...s, v, y0 };
          }).filter((s) => s.v > 0);
          const total = acc;
          return (
            <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.55}>
              {segs.map((s, si) => {
                const yTop = yOf(s.y0 + s.v);
                // 2px surface gap between touching segments (upper segment
                // gives up 2px at its bottom edge).
                const segH = Math.max(1, yOf(s.y0) - yTop - (si > 0 ? 2 : 0));
                const isTop = si === segs.length - 1;
                return isTop ? (
                  <path
                    key={s.key}
                    d={roundedTopRect(x, yTop, colW, segH, 3)}
                    className={cn("chart-col", s.fill)}
                    style={{ transitionDelay: `${i * 12}ms` }}
                  />
                ) : (
                  <rect
                    key={s.key}
                    x={x}
                    y={yTop}
                    width={colW}
                    height={segH}
                    className={cn("chart-col", s.fill)}
                    style={{ transitionDelay: `${i * 12}ms` }}
                  />
                );
              })}
              {/* full-height hit target, bigger than the mark */}
              <rect
                x={M.left + i * band}
                y={M.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={total > 0 ? 0 : -1}
                aria-label={`${labelOf(d.date)}: ${d.completed} ${t("played")}, ${d.live} ${t("live")}, ${d.scheduled} ${t("upcoming")}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
        {/* x labels */}
        {series.map((d, i) =>
          i % labelEvery === 0 ? (
            <text
              key={d.date}
              x={M.left + i * band + band / 2}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {labelOf(d.date)}
            </text>
          ) : null,
        )}
      </svg>

      {empty ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t("No matches in this window.")}
        </p>
      ) : null}

      {hover !== null && series[hover] ? (
        <div
          className="pointer-events-none absolute z-10 min-w-[8rem] -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            left: `${((M.left + hover * band + band / 2) / W) * 100}%`,
            top: 0,
          }}
          role="status"
        >
          <p className="mb-1 font-medium text-foreground">
            {labelOf(series[hover].date)}
          </p>
          {SERIES.map((s) => (
            <p key={s.key} className="flex items-center gap-1.5">
              <span className={cn("h-0.5 w-3 rounded-full", s.dot)} />
              <span className="font-tabular font-semibold text-foreground">
                {series[hover][s.key]}
              </span>
              <span className="text-muted-foreground">{t(s.label)}</span>
            </p>
          ))}
        </div>
      ) : null}

      {/* WCAG table twin */}
      <table className="sr-only">
        <caption>{t("Matches per day")}</caption>
        <thead>
          <tr>
            <th>{t("Date")}</th>
            <th>{t("Played")}</th>
            <th>{t("Live")}</th>
            <th>{t("Upcoming")}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.completed}</td>
              <td>{d.live}</td>
              <td>{d.scheduled}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Legend row for the activity chart (>= 2 series, always present). */
export function ActivityLegend(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-[2px]", s.dot)} />
          {t(s.label)}
        </span>
      ))}
    </div>
  );
}

/** Breakdown table: labeled rows against a Total column plus per-dimension
 * numeric columns (the congregation-report look the owner asked for). The
 * Total column leads in weight; secondary columns stay muted; every number
 * is tabular so the columns align. */
export function BreakdownTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: {
    label: string;
    values: number[];
    isLive?: boolean;
  }[];
}): React.ReactElement {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
          <th scope="col" className="py-2 pl-4 pr-2 text-left font-medium">
            <span className="sr-only">{t("Category")}</span>
          </th>
          {columns.map((col) => (
            <th
              key={col}
              scope="col"
              className="px-2 py-2 text-right font-medium last:pr-4"
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.label}>
            <th
              scope="row"
              className="py-2 pl-4 pr-2 text-left font-medium text-foreground"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {row.isLive ? (
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-3 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-chart-3" />
                  </span>
                ) : null}
                <span className="truncate">{row.label}</span>
              </span>
            </th>
            {row.values.map((v, i) => (
              <td
                key={columns[i]}
                className={cn(
                  "px-2 py-2 text-right font-tabular last:pr-4",
                  i === 0
                    ? "font-semibold text-foreground"
                    : v === 0
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground",
                )}
              >
                {v.toLocaleString()}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Completion meter: fill + same-ramp lighter track (meter spec). */
export function Meter({
  completed,
  total,
  delayMs = 0,
}: {
  completed: number;
  total: number;
  delayMs?: number;
}): React.ReactElement {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div
      className={cn("h-2.5 w-full rounded-sm bg-chart-1/15", drawn && "chart-drawn")}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="chart-bar h-full rounded-sm bg-chart-1"
        style={{ width: `${pct}%`, transitionDelay: `${delayMs}ms` }}
      />
    </div>
  );
}

/** 12-point stat-tile sparkline: de-emphasis stroke, accent end dot. */
export function Sparkline({ points }: { points: number[] }): React.ReactElement | null {
  if (points.length < 2) return null;
  const W = 96;
  const H = 28;
  const max = Math.max(1, ...points);
  const step = W / (points.length - 1);
  const coords = points.map(
    (v, i) => [i * step, H - 3 - (v / max) * (H - 6)] as const,
  );
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = coords[coords.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-24" aria-hidden="true">
      <path
        d={d}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-muted-foreground/40"
      />
      <circle cx={ex} cy={ey} r={4} className="fill-card" />
      <circle cx={ex} cy={ey} r={3} className="fill-primary" />
    </svg>
  );
}
