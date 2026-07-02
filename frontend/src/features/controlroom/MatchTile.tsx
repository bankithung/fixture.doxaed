import { Lock, Radio, UserCog } from "lucide-react";
import type { ControlRoomMatch, MatchRow } from "@/api/tournaments";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL, IN_PLAY, fmtKickoff, isCalled } from "./format";
import { MatchActionsMenu, type ControlRoomPerms } from "./MatchActionsMenu";

/**
 * The group / round sub-label WITHOUT repeating the competition: the last
 * dash-segment of `group_label` when it adds something over the leaf. The
 * server sends the whole chain twice ("Sepak — u-14 — girls — 3v3" then
 * "… — 3v3 — Group A"); we show the leaf as pills once and just "Group A" here.
 */
export function groupSuffix(
  leafLabel: string,
  groupLabel: string | null | undefined,
): string | null {
  if (!groupLabel || groupLabel === leafLabel) return null;
  const last = groupLabel.split(" — ").pop()?.trim();
  if (!last || leafLabel.endsWith(last)) return null;
  return last;
}

/** Status → pill presentation, tokens only (mirrors MatchConsolePage). */
function statusMeta(m: ControlRoomMatch): {
  label: string;
  cls: string;
  live: boolean;
} {
  if (IN_PLAY.has(m.status)) {
    return {
      label: m.status === "half_time" ? "Half time" : "Live",
      cls: "bg-primary/15 text-primary",
      live: true,
    };
  }
  if (FINAL.has(m.status)) {
    return {
      label: m.status === "walkover" ? "Walkover" : "Full time",
      cls: "bg-accent text-accent-foreground",
      live: false,
    };
  }
  if (isCalled(m)) {
    return {
      label: "Called",
      cls: "bg-warning-muted text-warning-foreground",
      live: false,
    };
  }
  if (m.status === "scheduled") {
    return {
      label: "Scheduled",
      cls: "bg-secondary text-secondary-foreground",
      live: false,
    };
  }
  return {
    label: m.status.replace(/_/g, " "),
    cls: "bg-muted text-muted-foreground",
    live: false,
  };
}

export function StatusPill({
  match,
  idScope = "",
}: {
  match: ControlRoomMatch;
  /** Testid prefix so the same match's pill can render in both the board and
   * the triage strip without colliding (strip passes "needs-"). */
  idScope?: string;
}): React.ReactElement {
  const sm = statusMeta(match);
  return (
    <span
      data-testid={`${idScope}pill-${match.id}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
        sm.cls,
      )}
    >
      {sm.live ? (
        <span className="relative flex h-2 w-2" data-testid={`${idScope}live-pulse-${match.id}`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : null}
      {t(sm.label)}
      {sm.live && match.current_period ? (
        <span className="font-normal">
          · {t(match.current_period.replace(/_/g, " "))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One match card of a venue lane: kick-off time, teams, competition chip,
 * state pill (scheduled → called → LIVE w/ pulse + score → done), lock/delay
 * badges, set/pens detail and the role-gated action row.
 */
export function MatchTile({
  match,
  timeZone,
  tournamentId,
  siblings,
  perms,
  highlight = false,
  delayMinutes = null,
}: {
  match: ControlRoomMatch;
  timeZone: string;
  tournamentId: string;
  /** Same-competition matches (swap candidates). */
  siblings: MatchRow[];
  perms: ControlRoomPerms;
  /** The lane's NOW slot gets a primary ring. */
  highlight?: boolean;
  /** Positive minutes the slot moved by today (queue-rail delay chip). */
  delayMinutes?: number | null;
}): React.ReactElement {
  const showScore = IN_PLAY.has(match.status) || FINAL.has(match.status);
  const sets = match.set_scores ?? [];
  const hasPens = match.home_pens != null && match.away_pens != null;
  const grp = groupSuffix(match.leaf_label, match.group_label);

  return (
    <article
      data-testid={`tile-${match.id}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 shadow-sm",
        highlight && "ring-1 ring-primary",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-tabular text-sm font-semibold text-foreground">
          {fmtKickoff(match.scheduled_at, timeZone)}
        </span>
        {delayMinutes ? (
          <span
            data-testid={`delay-${match.id}`}
            className="rounded bg-warning-muted px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium text-warning-foreground"
          >
            +{delayMinutes} {t("min")}
          </span>
        ) : null}
        {match.locked_at ? (
          <Lock
            aria-label={t("Slot locked")}
            data-testid={`lock-${match.id}`}
            className="h-3 w-3 shrink-0"
          />
        ) : null}
        <span className="ml-auto">
          <StatusPill match={match} />
        </span>
      </div>

      {match.leaf_label ? (
        <div className="flex flex-wrap items-center gap-1">
          <LeafLabel label={match.leaf_label} />
          {grp ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
              {grp}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
        <span className="truncate text-right font-medium">
          {match.home_team?.name ?? t("TBD")}
        </span>
        <span
          className={cn(
            "px-1 text-center font-tabular",
            showScore ? "text-base font-semibold" : "text-xs text-muted-foreground",
          )}
        >
          {showScore
            ? `${match.home_score ?? 0} - ${match.away_score ?? 0}`
            : t("vs")}
        </span>
        <span className="truncate font-medium">
          {match.away_team?.name ?? t("TBD")}
        </span>
      </div>

      {showScore && (sets.length > 0 || hasPens) ? (
        <p
          data-testid={`points-${match.id}`}
          className="text-center font-tabular text-xs text-muted-foreground"
        >
          {sets.map(([h, a]) => `${h}-${a}`).join(" · ")}
          {sets.length > 0 && hasPens ? " · " : ""}
          {hasPens
            ? `(${match.home_pens}-${match.away_pens} ${t("pens")})`
            : ""}
        </p>
      ) : null}

      {match.scorer || (match.officials ?? []).length > 0 ? (
        <div
          data-testid={`crew-${match.id}`}
          className="flex flex-wrap items-center gap-1"
        >
          {match.scorer ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
              <Radio aria-hidden="true" className="h-3 w-3" />
              {match.scorer.name}
            </span>
          ) : null}
          {(match.officials ?? []).map((o) => (
            <span
              key={o.id}
              title={o.role}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground"
            >
              <UserCog aria-hidden="true" className="h-3 w-3" />
              {o.name}
            </span>
          ))}
        </div>
      ) : null}

      <MatchActionsMenu
        tournamentId={tournamentId}
        match={match}
        siblings={siblings}
        perms={perms}
      />
    </article>
  );
}
