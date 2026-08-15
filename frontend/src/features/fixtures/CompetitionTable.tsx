import { Fragment } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { CompetitionResultCard } from "./CompetitionResultCard";
import { InputsChangedBanner } from "./InputsChangedBanner";
import { LeafLabel } from "./LeafLabel";
import { ReadinessChecklist } from "./ReadinessChecklist";
import {
  competitionSentence,
  statusOf,
  type CardAction,
  type CardActionKind,
  type Competition,
  type CompStatus,
} from "./setupJourney";

/** §7.1 status chips — plain words, token colors. */
const CHIP: Record<CompStatus, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-primary/15 text-primary" },
  needs_setup: { label: "Action needed", cls: "bg-warning-muted text-warning" },
  needs_teams: {
    label: "Waiting for teams",
    cls: "bg-muted text-muted-foreground",
  },
  drawn: { label: "Scheduled", cls: "bg-secondary text-secondary-foreground" },
  live: { label: "Live now", cls: "bg-primary/15 text-primary" },
};

/** Verbs that mutate (or open mutating surfaces) — hidden from viewers. */
const MANAGE_ACTIONS: ReadonlySet<CardActionKind> = new Set([
  "seeds",
  "step1",
  "preview",
  "format",
  "advance",
  "next_round",
  "adjust_schedule",
]);

/** The legacy testid each primary verb kept through the rebuild (§9). */
function primaryTestId(action: CardActionKind, key: string): string {
  if (action === "preview") return `generate-${key}`;
  if (action === "advance") return `advance-${key}`;
  if (action === "next_round") return `next-round-${key}`;
  return `card-action-${key}`;
}

/** Plain format names — the stored key is an internal code. */
const FORMAT_LABELS: Record<string, string> = {
  round_robin: "Round robin",
  knockout: "Knockout",
  knockout_from_groups: "Groups into knockout",
  by_category: "By category",
  swiss: "Swiss",
  double_elim: "Double elimination",
};

export interface CompetitionGroup {
  key: string;
  title: string;
  competitions: Competition[];
}

/**
 * Every competition of the tournament in ONE structured table (owner
 * 2026-08-15: "a proper table format, not a spreadsheet — and one section, not
 * multiple"). A band per status group, then a line per competition:
 * competition, teams, matches, format, status, and the one action that moves
 * it forward. Opening a line drops its detail underneath — the drawn result,
 * or the checklist of what is still missing — instead of every competition
 * carrying its own card.
 */
export function CompetitionTable({
  groups,
  openGroups,
  onToggleGroup,
  formatFor,
  tournamentId,
  canManage,
  canRepair,
  keptDraws,
  expanded,
  busy = false,
  fixable,
  globalsUnset = false,
  onToggleDetail,
  onAction,
  onFix,
}: {
  groups: CompetitionGroup[];
  openGroups: Record<string, boolean>;
  onToggleGroup: (key: string) => void;
  /** Effective stored format for a leaf (drives the Swiss D4 state). */
  formatFor: (leafKey: string) => string;
  tournamentId: string;
  canManage: boolean;
  canRepair: boolean;
  /** Leaves whose inputs-drift banner was dismissed with "Keep this draw". */
  keptDraws: ReadonlySet<string>;
  /** The one open detail line, by competition key. */
  expanded: string | null;
  busy?: boolean;
  fixable: ReadonlySet<string>;
  globalsUnset?: boolean;
  onToggleDetail: (key: string) => void;
  onAction: (competition: Competition, action: CardAction) => void;
  onFix?: (fix: string, leafKey: string) => void;
}): React.ReactElement {
  const secondaryBtn =
    "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="w-full overflow-x-auto" id="competition-list">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">
          {t("Every competition, one row each")}
        </caption>
        <thead>
          <tr>
            {[
              [t("Competition"), ""],
              [t("Teams"), "w-20 text-right"],
              [t("Matches"), "w-20 text-right"],
              [t("Format"), "w-40"],
              [t("Status"), "w-32"],
              [t("Next step"), "w-56"],
            ].map(([label, cls]) => (
              <th
                key={label}
                scope="col"
                className={cn(
                  "border-b border-border bg-muted px-3 py-1.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground",
                  cls,
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const open = openGroups[g.key] !== false;
            return (
              <Fragment key={g.key}>
                <tr>
                  <td colSpan={6} className="border-b border-border bg-secondary/60 p-0">
                    <button
                      type="button"
                      data-testid={`section-${g.key}`}
                      aria-expanded={open}
                      onClick={() => onToggleGroup(g.key)}
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
                    >
                      {open ? (
                        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-[0.6875rem] font-semibold uppercase tracking-wide">
                        {t(g.title)}
                      </span>
                      <span className="ml-auto font-tabular text-[0.6875rem] text-muted-foreground">
                        {g.competitions.length}
                      </span>
                    </button>
                  </td>
                </tr>

                {open
                  ? g.competitions.map((c) => {
                      const key = c.leafKey || "general";
                      const st = statusOf(c, globalsUnset);
                      const drawn = c.matches.length > 0;
                      const detailOpen = expanded === key;
                      const fmt = formatFor(c.leafKey);
                      // Viewers never see the stale banner (its verbs are
                      // manage-only) — the plain drawn sentence stands instead.
                      const pres = competitionSentence(
                        c,
                        fmt,
                        keptDraws.has(c.leafKey) || !canManage,
                        globalsUnset,
                      );
                      const actions = pres.actions.filter(
                        (a) => canManage || !MANAGE_ACTIONS.has(a.action),
                      );
                      const primary = actions.find((a) => a.kind === "primary");
                      const links = actions.filter((a) => a.kind === "link");
                      const hasKnockout = c.matches.some(
                        (m) => m.stage === "knockout",
                      );
                      const canOpen = drawn || (pres.blocked && !!c.readiness);
                      return (
                        <Fragment key={key}>
                          <tr
                            data-testid={`competition-card-${key}`}
                            className="hover:bg-muted/20"
                          >
                            <td className="border-b border-border px-3 py-1.5">
                              {canOpen ? (
                                <button
                                  type="button"
                                  data-testid={`competition-row-${key}`}
                                  aria-expanded={detailOpen}
                                  onClick={() => onToggleDetail(key)}
                                  className="flex min-w-0 items-center gap-1.5 text-left"
                                >
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={cn(
                                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                      detailOpen && "rotate-180",
                                    )}
                                  />
                                  <LeafLabel label={c.label || ""} size="sm" />
                                </button>
                              ) : (
                                <span className="flex min-w-0 items-center gap-1.5 pl-5">
                                  <LeafLabel label={c.label || ""} size="sm" />
                                </span>
                              )}
                              {/* Where this competition stands, under its own
                                  name — one line, never a second card. */}
                              {pres.staleBanner ? (
                                <div className="pl-5 pt-1">
                                  <InputsChangedBanner
                                    context="draw"
                                    onRePreview={() =>
                                      onAction(c, {
                                        label: t("Preview again"),
                                        kind: "link",
                                        action: "preview",
                                      })
                                    }
                                    onKeep={() =>
                                      onAction(c, {
                                        label: t("Keep this draw"),
                                        kind: "link",
                                        action: "keep",
                                      })
                                    }
                                  />
                                </div>
                              ) : pres.sentence ? (
                                <p className="pl-5 pt-0.5 text-xs text-muted-foreground">
                                  {pres.sentence}
                                </p>
                              ) : null}
                            </td>
                            <td className="border-b border-border px-3 py-1.5 text-right font-tabular text-xs">
                              {c.teams.length}
                            </td>
                            <td className="border-b border-border px-3 py-1.5 text-right font-tabular text-xs text-muted-foreground">
                              {drawn ? c.matches.length : "·"}
                            </td>
                            <td className="border-b border-border px-3 py-1.5 text-xs">
                              {fmt ? (
                                canManage ? (
                                  <button
                                    type="button"
                                    data-testid={`change-format-${key}`}
                                    className="text-left hover:text-primary hover:underline"
                                    onClick={() =>
                                      onAction(c, {
                                        label: t("Change format"),
                                        kind: "link",
                                        action: "format",
                                      })
                                    }
                                  >
                                    {t(FORMAT_LABELS[fmt] ?? fmt)}
                                  </button>
                                ) : (
                                  <span>{t(FORMAT_LABELS[fmt] ?? fmt)}</span>
                                )
                              ) : canManage && pres.note ? (
                                <button
                                  type="button"
                                  data-testid={`choose-format-${key}`}
                                  className="font-medium text-primary hover:underline"
                                  onClick={() =>
                                    onAction(c, {
                                      label: pres.note!.actionLabel,
                                      kind: "link",
                                      action: "format",
                                    })
                                  }
                                >
                                  {pres.note.actionLabel}
                                </button>
                              ) : (
                                <span className="text-muted-foreground">·</span>
                              )}
                            </td>
                            <td className="border-b border-border px-3 py-1.5">
                              <span
                                className={cn(
                                  "inline-block rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                                  CHIP[st].cls,
                                )}
                              >
                                {t(CHIP[st].label)}
                              </span>
                            </td>
                            <td className="border-b border-border px-3 py-1.5">
                              <span className="flex flex-wrap items-center justify-end gap-1.5">
                                {links.map((a) => (
                                  <button
                                    key={a.action}
                                    type="button"
                                    data-testid={`card-link-${a.action}-${key}`}
                                    aria-expanded={
                                      a.action === "view_matches"
                                        ? detailOpen
                                        : undefined
                                    }
                                    className={secondaryBtn}
                                    onClick={() =>
                                      a.action === "view_matches"
                                        ? onToggleDetail(key)
                                        : onAction(c, a)
                                    }
                                  >
                                    {a.label}
                                  </button>
                                ))}
                                {pres.blocked && c.readiness ? (
                                  <button
                                    type="button"
                                    data-testid={`whats-missing-${key}`}
                                    aria-expanded={detailOpen}
                                    className={secondaryBtn}
                                    onClick={() => onToggleDetail(key)}
                                  >
                                    {t("See what's missing")}
                                  </button>
                                ) : null}
                                {!pres.staleBanner && primary ? (
                                  <Button
                                    size="sm"
                                    disabled={busy}
                                    data-testid={primaryTestId(primary.action, key)}
                                    onClick={() => onAction(c, primary)}
                                  >
                                    {primary.label}
                                  </Button>
                                ) : null}
                              </span>
                            </td>
                          </tr>

                          {/* Expanded: the drawn result, or what is still
                              missing — under the line it belongs to. */}
                          {detailOpen && (drawn || (pres.blocked && c.readiness)) ? (
                            <tr data-testid={`competition-detail-${key}`}>
                              <td
                                colSpan={6}
                                className="border-b border-border bg-muted/10 px-3 py-2"
                              >
                                <div className="flex flex-col gap-2 pl-5">
                                  {pres.blocked && c.readiness ? (
                                    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-2.5">
                                      <ReadinessChecklist
                                        competition={c.readiness}
                                        onFix={canManage ? onFix : undefined}
                                        fixable={fixable}
                                      />
                                      <p className="text-xs text-muted-foreground">
                                        {t("Fix the items marked above, then you can preview the draw.")}
                                      </p>
                                    </div>
                                  ) : null}
                                  {drawn ? (
                                    <div className="flex flex-col gap-3">
                                      <CompetitionResultCard
                                        matches={c.matches}
                                        tournamentId={tournamentId}
                                        canRepair={canRepair}
                                      />
                                      {hasKnockout ? (
                                        <Link
                                          to={routes.tournamentBracket(tournamentId)}
                                          data-testid={`view-bracket-${key}`}
                                          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                                        >
                                          <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                                          {t("View bracket")}
                                        </Link>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
