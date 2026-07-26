import { Check, Minus, Plus, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { statusMeta, type SetProgress, type SetRow } from "./shared";

/** Shared visual core of the set-sport consoles, built as an instrument
 * panel: a telemetry strip across the top, the two score cards with the
 * stage's winning rule between them, the full period history (every period
 * the rule allows, including the ones still to be played), a state rail and
 * a sticky action bar. Pure presentation — taps, rules and persistence stay
 * in the owning console module. */

/** Uppercase micro-label used for every panel/cell caption. */
const EYEBROW =
  "text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground";

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const sm = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]",
        sm.badge,
      )}
    >
      {sm.live ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : (
        <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
      )}
      {t(sm.label)}
    </span>
  );
}

export interface StripCell {
  key: string;
  label: string;
  value: React.ReactNode;
  /** Pull the eye to the figure that matters (the running score). */
  emphasis?: boolean;
}

/** The board's masthead + telemetry strip. The title is the console's own
 * heading (what is being played, where) — it belongs INSIDE the panel, set
 * as a heading, not floated above it as muted body text. Below it, one
 * label/value cell per reading; cells are divided from `sm` up and simply
 * space out on a phone, so nothing ever needs sideways scrolling. */
export function ConsoleStrip({
  status,
  cells,
  trailing,
  title,
  titleActions,
}: {
  status: string;
  cells: StripCell[];
  trailing?: React.ReactNode;
  /** Competition context, e.g. "Table tennis · U19 · Boys · 1v1 · Court 2". */
  title?: React.ReactNode;
  /** Right-hand slot on the title row (offline count, print). */
  titleActions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col border-b border-border">
      {title ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <h1
            // The chassis test reads the console's context from here; the
            // football surface carries the same testid in its page header.
            data-testid="match-context"
            // Wraps to a second line on a phone rather than cutting the venue
            // off; capped at two lines so a long venue can't push the board.
            className="line-clamp-2 min-w-0 flex-1 text-base font-semibold leading-tight tracking-tight text-foreground sm:text-lg"
          >
            {title}
          </h1>
          {titleActions ? (
            <div className="flex shrink-0 items-center gap-2">{titleActions}</div>
          ) : null}
        </div>
      ) : null}
      <div
        data-testid="console-strip"
        className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3"
      >
      {/* `sm:contents` lifts these two out of their phone row so the chip and
          the sync badge become ends of the desktop strip. */}
      <div className="flex items-center justify-between gap-2 sm:contents">
        <StatusChip status={status} />
        {trailing ? (
          <div className="min-w-0 sm:order-last sm:ml-auto sm:shrink-0">
            {trailing}
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:min-w-0 sm:flex-1 sm:flex-wrap sm:items-center sm:gap-x-0">
        {cells.map((c) => (
          <div
            key={c.key}
            className="flex min-w-0 flex-col gap-1 border-border sm:border-l sm:pl-4 sm:pr-1 sm:first:border-l-0 sm:first:pl-0"
          >
            <span className={EYEBROW}>{c.label}</span>
            <span
              className={cn(
                "truncate font-tabular text-sm font-semibold leading-none tabular-nums",
                c.emphasis && "text-primary",
              )}
            >
              {c.value}
            </span>
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

export type SyncState = "saved" | "saving" | "offline" | "local";

/** The "is my tap safe?" readout — the one thing a scorer checks mid-match. */
export function SyncBadge({
  state,
  live,
}: {
  state: SyncState;
  live: boolean;
}): React.ReactElement {
  const map: Record<SyncState, { label: string; cls: string }> = {
    saved: { label: t("Auto-saved"), cls: "text-success" },
    saving: { label: t("Saving"), cls: "text-muted-foreground" },
    offline: { label: t("Offline — safe on this phone"), cls: "text-warning" },
    local: { label: t("Not started"), cls: "text-muted-foreground" },
  };
  const m = map[state];
  return (
    <span
      data-testid="sync-badge"
      aria-live="polite"
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium",
        m.cls,
      )}
    >
      {state === "saved" ? (
        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      <span className="truncate">
        {m.label}
        {live ? ` · ${t("Live")}` : ""}
      </span>
    </span>
  );
}

export interface ScorePadProps {
  homeName: string;
  awayName: string;
  /** The big numerals: current-period points in play, periods won once final. */
  homeValue: number;
  awayValue: number;
  /** Side whose name carries the serve dot (null/omitted hides it). */
  server?: 0 | 1 | null;
  /** The Point buttons work. Off while final, decided, or between periods. */
  canScore: boolean;
  /** The per-side Undo button (mis-tap fix). Off once final. */
  canEdit: boolean;
  /** What one press adds (the generic console scores by its step). */
  step?: number;
  onPoint: (side: 0 | 1) => void;
  onMinus: (side: 0 | 1) => void;
  /** The stage's winning rule, rendered between the two cards. */
  rule?: React.ReactNode;
  /** Keyboard keys that score each side, surfaced on pointer devices. */
  shortcuts?: [string, string] | null;
  /** Per-side slot under each card (the timeout button), kept in the card's
   * own grid column so it stays aligned with it at every width. */
  footers?: [React.ReactNode, React.ReactNode];
}

/** Two score cards, one per side, with the stage rule between them: name,
 * big score, an unmissable Point button and an Undo. The button is the
 * interaction — the score is display. On a phone the cards stay side by
 * side (thumb left, thumb right) and the rule drops to a band underneath. */
export function ScorePad({
  homeName,
  awayName,
  homeValue,
  awayValue,
  server = null,
  canScore,
  canEdit,
  step = 1,
  onPoint,
  onMinus,
  rule,
  shortcuts = null,
  footers,
}: ScorePadProps): React.ReactElement {
  return (
    <div className="grid grid-cols-2 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-3 lg:gap-4">
      {([0, 1] as const).map((side) => {
        const name = side === 0 ? homeName : awayName;
        const value = side === 0 ? homeValue : awayValue;
        const home = side === 0;
        return (
          <div
            key={side}
            className={cn(
              "flex min-w-0 flex-col gap-2",
              // The rule band takes the whole row below on a phone.
              side === 1 && "sm:order-3",
            )}
          >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <span
              aria-hidden="true"
              className={cn("h-1 w-full shrink-0", home ? "bg-primary" : "bg-info")}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5 sm:p-4">
              <div className="flex min-w-0 items-center justify-center gap-1.5">
                {server === side ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      home ? "bg-primary" : "bg-info",
                    )}
                  />
                ) : null}
                <span
                  className={cn(
                    "line-clamp-2 text-balance text-center text-sm font-semibold leading-tight sm:text-base",
                    home ? "text-primary" : "text-info",
                  )}
                >
                  {name}
                </span>
              </div>

              <div
                data-testid={home ? "points-home" : "points-away"}
                className="rounded-lg bg-muted/40 py-2 text-center font-tabular text-5xl font-bold leading-none tabular-nums sm:py-3 sm:text-7xl"
              >
                {value}
              </div>

              <Button
                data-testid={home ? "point-home" : "point-away"}
                disabled={!canScore}
                onClick={() => onPoint(side)}
                aria-label={`${t("Point")} ${name}`}
                className={cn(
                  "h-14 w-full select-none text-sm font-bold uppercase tracking-[0.08em] [touch-action:manipulation] sm:h-16 sm:text-base",
                  !home && "bg-info text-info-foreground hover:bg-info/90",
                )}
              >
                <Plus aria-hidden="true" className="h-5 w-5 shrink-0" />
                <span className="truncate">
                  {step === 1 ? t("Point") : `${step} ${t("points")}`}
                </span>
              </Button>

              {canEdit ? (
                <button
                  type="button"
                  data-testid={home ? "minus-home" : "minus-away"}
                  aria-label={`${t("Undo point")} ${name}`}
                  disabled={value <= 0}
                  onClick={() => onMinus(side)}
                  className="inline-flex h-11 w-full select-none items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors [touch-action:manipulation] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  <Undo2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  {t("Undo")}
                </button>
              ) : null}

              {shortcuts ? (
                <p className="hidden text-right font-tabular text-[0.625rem] text-muted-foreground lg:block">
                  {t("Shortcut")}: {shortcuts[side].toUpperCase()}
                </p>
              ) : null}
            </div>
          </div>
          {footers ? footers[side] : null}
          </div>
        );
      })}
      {rule ? (
        <div className="order-last col-span-2 min-w-0 sm:order-2 sm:col-span-1 sm:self-center">
          {rule}
        </div>
      ) : null}
    </div>
  );
}

/** The winning rule for the period in play — how many points take THIS
 * stage, the margin, and how many stages the match runs to. Deciding-period
 * overrides are already resolved by the caller. */
export function TargetRule({
  points,
  winBy,
  cap,
  bestOf,
  periodLabel,
  periodNo,
}: {
  points: number;
  winBy: number;
  cap: number | null;
  bestOf: number;
  periodLabel: string;
  periodNo: number;
}): React.ReactElement {
  const lines: string[] = [];
  if (winBy > 1) lines.push(`${t("win by")} ${winBy}`);
  if (cap != null && cap > 0) lines.push(`${t("cap at")} ${cap}`);
  lines.push(`${t("best of")} ${bestOf}`);
  return (
    <div
      data-testid="target-rule"
      className="flex flex-row items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-center sm:min-w-[8rem] sm:max-w-[10rem] sm:flex-col sm:border-0 sm:bg-transparent sm:px-1"
    >
      <span className={cn(EYEBROW, "shrink-0")}>
        {periodLabel} {periodNo}
      </span>
      <p className="min-w-0 font-tabular text-sm font-semibold leading-tight">
        {points > 0 ? `${t("First to")} ${points}` : t("No target set")}
      </p>
      <p className="min-w-0 text-[0.6875rem] leading-snug text-muted-foreground">
        {lines.join(" · ")}
      </p>
    </div>
  );
}

/** The explicit step between periods: says what just happened and offers ONE
 * clear action. Point buttons stay locked until it is taken. */
export function NextGamePrompt({
  summary,
  startLabel,
  onStart,
}: {
  summary: string;
  startLabel: string;
  onStart: () => void;
}): React.ReactElement {
  return (
    <div
      data-testid="next-game"
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/10 p-3"
    >
      <p className="text-center text-sm font-medium">{summary}</p>
      <Button
        data-testid="start-next"
        className="h-12 w-full text-base"
        onClick={onStart}
      >
        {startLabel}
      </Button>
    </div>
  );
}

/** The mirror of the between-periods step, for the end of the MATCH: a side
 * has clinched, so there is no next period to start and the only thing left
 * is to record it. Without this the board looks like the period in play is
 * still live and the scorer hunts for a "start next" button that correctly
 * does not exist (owner 2026-07-26). */
export function MatchDecidedPrompt({
  winnerName,
  periodsWon,
  periodPlural,
  recordLabel,
  onRecord,
  pending = false,
}: {
  winnerName: string | null;
  /** Periods won, winner first ("2-0"). */
  periodsWon: string;
  periodPlural: string;
  recordLabel: string;
  onRecord: () => void;
  pending?: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="match-decided"
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-success/40 bg-success-muted p-3"
    >
      <p className="text-center text-sm font-semibold">
        {winnerName
          ? `${winnerName} ${t("wins")} ${periodsWon}`
          : t("The match is decided")}
        <span className="font-normal text-muted-foreground">
          {" · "}
          {t("no further")} {periodPlural.toLowerCase()} {t("to play")}
        </span>
      </p>
      <Button
        data-testid="record-result"
        className="h-12 w-full text-base"
        disabled={pending}
        onClick={onRecord}
      >
        {recordLabel}
      </Button>
    </div>
  );
}

/** "Game point / Match point" flag: the next point can end the period or the
 * whole match. */
export function PointFlag({
  kind,
  periodLabel,
  name,
}: {
  kind: "set" | "match";
  periodLabel: string;
  name: string;
}): React.ReactElement {
  return (
    <span
      data-testid="point-flag"
      className={cn(
        "inline-flex min-w-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        kind === "match"
          ? "bg-primary text-primary-foreground"
          : "bg-primary/15 text-primary",
      )}
    >
      <span className="truncate">
        {kind === "match" ? t("Match point") : `${periodLabel} ${t("point")}`} · {name}
      </span>
    </span>
  );
}

type RowState = "complete" | "live" | "pending" | "skipped";

function StateBadge({ state }: { state: RowState }): React.ReactElement {
  if (state === "skipped") {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground/70">
        {t("Not needed")}
      </span>
    );
  }
  if (state === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        {t("Live")}
      </span>
    );
  }
  if (state === "complete") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-muted px-2 py-0.5 text-xs font-semibold text-success">
        <Check aria-hidden="true" className="h-3 w-3" />
        {t("Complete")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {t("Pending")}
    </span>
  );
}

export interface GameHistoryProps {
  progress: SetProgress;
  /** Sport's own word for a period ("Game", "Set"). */
  periodLabel: string;
  /** Every period entered so far, current one last. */
  entered: SetRow[];
  homeName: string;
  awayName: string;
  /** A period just ended and the next has not started: no live row. */
  awaitingNext?: boolean;
  /** The period's own finish rule ("game to 11"), appended to the caption. */
  targetText?: string;
  /** Name of the clinching side (caption), when decided. */
  winnerName: string | null;
  isFinal: boolean;
  /** Opens the corrections editor. */
  onEdit?: () => void;
}

/** Every period the best-of rule allows: the ones played (with their
 * scores), the one in play, and the ones still to come — so the scorer
 * always sees how many stages are left. Table on a desk, stacked cards on a
 * phone. The caption carries the match rule or the clinched result. */
export function GameHistory({
  progress,
  periodLabel,
  entered,
  homeName,
  awayName,
  awaitingNext = false,
  targetText,
  winnerName,
  isFinal,
  onEdit,
}: GameHistoryProps): React.ReactElement {
  const { bestOf, need, homeSets, awaySets, decided } = progress;
  const { isMobile } = useBreakpoint();
  const over = decided || isFinal;
  const total = Math.max(bestOf, entered.length);
  const rows = Array.from({ length: total }, (_, i) => {
    const row = entered[i];
    const filled = row != null && row[0] !== "" && row[1] !== "";
    const isCurrent = i === entered.length - 1;
    // Once a side has clinched, the games the rule allowed but the match no
    // longer needs read "Not needed", never "Pending".
    const state: RowState =
      isCurrent && !over && !awaitingNext
        ? "live"
        : filled
          ? "complete"
          : over
            ? "skipped"
            : "pending";
    return {
      no: i + 1,
      home: row?.[0] === "" || row?.[0] == null ? null : row[0],
      away: row?.[1] === "" || row?.[1] == null ? null : row[1],
      state,
    };
  });
  // The winner belongs here only once the result is RECORDED; between the
  // clinch and recording, MatchDecidedPrompt states it (and states it once).
  const caption =
    isFinal && winnerName
      ? `${winnerName} ${t("wins")} ${Math.max(homeSets, awaySets)}-${Math.min(homeSets, awaySets)}`
      : `${t("First to")} ${need} · ${t("best of")} ${bestOf}${targetText ? ` · ${targetText}` : ""}`;

  return (
    <section
      data-testid="game-history"
      aria-label={`${periodLabel}s ${homeSets}-${awaySets}, ${t("best of")} ${bestOf}`}
      className="rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className={EYEBROW}>
          {periodLabel} {t("history")}
        </h3>
        {onEdit ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="edit-scores"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onEdit}
          >
            {t("Edit scores")}
          </Button>
        ) : null}
      </div>

      {isMobile ? (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((r) => (
            <li
              key={r.no}
              className={cn(
                "flex items-center gap-3 px-3 py-2",
                r.state === "live" && "bg-primary/5",
              )}
            >
              <span className="w-16 shrink-0 text-xs font-semibold">
                {periodLabel} {r.no}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2 font-tabular text-base font-semibold tabular-nums">
                {r.home == null && r.away == null ? (
                  <span className="text-muted-foreground">–</span>
                ) : (
                  <>
                    <span className="text-primary">{r.home ?? "–"}</span>
                    <span className="text-muted-foreground">-</span>
                    <span className="text-info">{r.away ?? "–"}</span>
                  </>
                )}
              </span>
              <StateBadge state={r.state} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={cn(EYEBROW, "px-3 py-2 text-left font-semibold")}>
                  {periodLabel}
                </th>
                <th className="px-3 py-2 text-center text-xs font-semibold text-primary">
                  <span className="line-clamp-1">{homeName}</span>
                </th>
                <th className="px-3 py-2 text-center text-xs font-semibold text-info">
                  <span className="line-clamp-1">{awayName}</span>
                </th>
                <th className={cn(EYEBROW, "px-3 py-2 text-right font-semibold")}>
                  {t("Status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.no}
                  className={cn(
                    "border-b border-border last:border-b-0",
                    r.state === "live" && "bg-primary/5",
                  )}
                >
                  <td
                    className={cn(
                      "px-3 py-2 text-left text-sm",
                      r.state === "live" ? "font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {periodLabel} {r.no}
                  </td>
                  <td className="px-3 py-2 text-center font-tabular text-base font-semibold tabular-nums text-primary">
                    {r.home ?? <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className="px-3 py-2 text-center font-tabular text-base font-semibold tabular-nums text-info">
                    {r.away ?? <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <StateBadge state={r.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p
        data-testid="game-rule-caption"
        className="border-t border-border px-3 py-2 text-center font-tabular text-xs text-muted-foreground"
      >
        {caption}
      </p>
    </section>
  );
}

/** Sticky action bar: leave, sync state, and the one big forward action. */
export function ConsoleActionBar({
  back,
  sync,
  actions,
}: {
  back?: React.ReactNode;
  sync?: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      data-testid="console-action-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border bg-card/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/80"
    >
      <div className="min-w-0 shrink-0">{back}</div>
      {sync ? (
        <div className="order-last w-full min-w-0 text-center sm:order-none sm:w-auto sm:flex-1">
          {sync}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 justify-end gap-2 sm:flex-none">
        {actions}
      </div>
    </div>
  );
}

/** Corrections: one editable row per period. On a desk it is a compact grid
 * (period · home stepper · away stepper · remove); on a phone each period
 * becomes its own card with a labelled `-  value  +` row per side, so the
 * team a number belongs to is never in doubt. */
export function ScoreEditor({
  rows,
  periodLabel,
  homeName,
  awayName,
  step = 1,
  onBump,
  onSet,
  onRemove,
  onAdd,
}: {
  rows: SetRow[];
  periodLabel: string;
  homeName: string;
  awayName: string;
  /** How much one press moves — labels only; `onBump` gets ±1 either way. */
  step?: number;
  onBump: (i: number, side: 0 | 1, delta: number) => void;
  onSet: (i: number, side: 0 | 1, value: string) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();

  /** The `- value +` control for one side of one period. */
  const stepper = (i: number, side: 0 | 1): React.ReactElement => {
    const teamLabel = side === 0 ? homeName : awayName;
    const sideKey = side === 0 ? "home" : "away";
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          aria-label={`${periodLabel} ${i + 1} ${teamLabel} ${t("minus")} ${step}`}
          data-testid={`set-${i}-${sideKey}-minus`}
          className="h-11 w-11 shrink-0 p-0"
          onClick={() => onBump(i, side, -1)}
        >
          <Minus aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Input
          inputMode="numeric"
          aria-label={`${periodLabel} ${i + 1} ${teamLabel}`}
          value={rows[i]?.[side] ?? ""}
          onChange={(e) => onSet(i, side, e.target.value)}
          className="h-11 w-16 shrink-0 text-center font-tabular text-lg font-semibold tabular-nums sm:w-full sm:min-w-0 sm:flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          aria-label={`${periodLabel} ${i + 1} ${teamLabel} ${t("plus")} ${step}`}
          data-testid={`set-${i}-${sideKey}-plus`}
          className="h-11 w-11 shrink-0 p-0"
          onClick={() => onBump(i, side, 1)}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  const removeButton = (i: number): React.ReactElement => (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`${t("Remove")} ${periodLabel.toLowerCase()} ${i + 1}`}
      disabled={rows.length === 1}
      className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
      onClick={() => onRemove(i)}
    >
      <X aria-hidden="true" className="h-4 w-4" />
    </Button>
  );

  const addButton = (
    <Button size="sm" variant="outline" className="w-full sm:w-fit" onClick={onAdd}>
      <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
      {t("Add")} {periodLabel.toLowerCase()}
    </Button>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col gap-2">
        {rows.map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                {periodLabel} {i + 1}
              </span>
              {removeButton(i)}
            </div>
            {([0, 1] as const).map((side) => (
              <div key={side} className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs font-medium",
                    side === 0 ? "text-primary" : "text-info",
                  )}
                >
                  {side === 0 ? homeName : awayName}
                </span>
                {stepper(i, side)}
              </div>
            ))}
          </div>
        ))}
        {addButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[3.5rem_1fr_1fr_2rem] items-center gap-3">
        <span />
        <span className={cn(EYEBROW, "truncate text-center text-primary")}>
          {homeName}
        </span>
        <span className={cn(EYEBROW, "truncate text-center text-info")}>
          {awayName}
        </span>
        <span />
      </div>
      {rows.map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[3.5rem_1fr_1fr_2rem] items-center gap-3"
        >
          <span className="text-xs font-medium text-muted-foreground">
            {periodLabel} {i + 1}
          </span>
          {stepper(i, 0)}
          {stepper(i, 1)}
          {removeButton(i)}
        </div>
      ))}
      {addButton}
    </div>
  );
}
