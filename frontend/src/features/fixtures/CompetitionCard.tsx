import { ChevronDown, GitBranch } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { CompetitionResultCard } from "./CompetitionResultCard";
import { InputsChangedBanner } from "./InputsChangedBanner";
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
  needs_setup: {
    label: "Action needed",
    cls: "bg-warning-muted text-warning-foreground",
  },
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

/**
 * One competition as a card (clarity rebuild §4.1): name + status chip, ONE
 * human sentence (§7.2), ONE action button — and the readiness checklist only
 * behind "See what's missing" when something blocks. Drawn cards expand
 * (accordion, one at a time) into the read-only result card.
 */
export function CompetitionCard({
  competition: c,
  drawFormat,
  tournamentId,
  canManage,
  canRepair,
  kept,
  detailOpen,
  busy = false,
  fixable,
  onToggleDetail,
  onAction,
  onFix,
}: {
  competition: Competition;
  /** Effective stored format for this leaf (drives the Swiss D4 state). */
  drawFormat: string;
  tournamentId: string;
  canManage: boolean;
  canRepair: boolean;
  /** "Keep this draw" was pressed for this leaf (inputs-drift dismissed). */
  kept: boolean;
  /** This card's detail (result card / what's-missing) is the open accordion slot. */
  detailOpen: boolean;
  /** A card mutation (pair next round) is in flight. */
  busy?: boolean;
  /** Fix keys the hub can act on (forwarded to the checklist). */
  fixable: ReadonlySet<string>;
  onToggleDetail: () => void;
  onAction: (action: CardAction) => void;
  onFix?: (fix: string, leafKey: string) => void;
}): React.ReactElement {
  const key = c.leafKey || "general";
  const st = statusOf(c);
  const drawn = c.matches.length > 0;
  // Viewers never see the stale banner (its verbs are manage-only) — fall
  // through to the plain drawn sentence instead.
  const pres = competitionSentence(c, drawFormat, kept || !canManage);
  const actions = pres.actions.filter(
    (a) => canManage || !MANAGE_ACTIONS.has(a.action),
  );
  const primary = actions.find((a) => a.kind === "primary");
  const links = actions.filter((a) => a.kind === "link");
  const hasKnockout = c.matches.some((m) => m.stage === "knockout");

  return (
    <div
      data-testid={`competition-card-${key}`}
      className="flex flex-col gap-2 border-t border-border px-4 py-3 first:border-t-0"
    >
      <div className="flex items-center gap-2">
        {drawn ? (
          <button
            type="button"
            data-testid={`competition-row-${key}`}
            aria-expanded={detailOpen}
            onClick={onToggleDetail}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="truncate text-sm font-semibold">
              {c.label || t("General")}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                detailOpen && "rotate-180",
              )}
            />
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {c.label || t("General")}
          </span>
        )}
        <span className="shrink-0 font-tabular text-xs text-muted-foreground">
          {c.teams.length} {t("teams")}
          {drawn ? <> · {c.matches.length} {t("matches")}</> : null}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
            CHIP[st].cls,
          )}
        >
          {t(CHIP[st].label)}
        </span>
      </div>

      {pres.staleBanner ? (
        /* D2 — the draw's inputs drifted: the banner replaces the sentence. */
        <InputsChangedBanner
          context="draw"
          onRePreview={() =>
            onAction({ label: t("Preview again"), kind: "link", action: "preview" })
          }
          onKeep={() =>
            onAction({ label: t("Keep this draw"), kind: "link", action: "keep" })
          }
        />
      ) : (
        <>
          {pres.sentence ? (
            <p className="text-sm text-muted-foreground">{pres.sentence}</p>
          ) : null}
          {pres.note ? (
            <p className="text-xs text-muted-foreground">
              {pres.note.text}{" "}
              {canManage ? (
                <button
                  type="button"
                  data-testid={`choose-format-${key}`}
                  className="font-medium text-primary hover:underline"
                  onClick={() =>
                    onAction({
                      label: pres.note!.actionLabel,
                      kind: "link",
                      action: "format",
                    })
                  }
                >
                  {pres.note.actionLabel}
                </button>
              ) : null}
            </p>
          ) : null}
          {primary || links.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {primary ? (
                <Button
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={busy}
                  data-testid={primaryTestId(primary.action, key)}
                  onClick={() => onAction(primary)}
                >
                  {primary.label}
                </Button>
              ) : null}
              {links.map((a) => (
                <button
                  key={a.action}
                  type="button"
                  data-testid={`card-link-${a.action}-${key}`}
                  aria-expanded={
                    a.action === "view_matches" ? detailOpen : undefined
                  }
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={() =>
                    a.action === "view_matches" ? onToggleDetail() : onAction(a)
                  }
                >
                  {a.label}
                </button>
              ))}
              {/* Quiet secondary: a ready card with a chosen format can still
                  revisit Step 2 (capability map — the wizard stays reachable). */}
              {primary?.action === "preview" && !pres.note && canManage ? (
                <button
                  type="button"
                  data-testid={`change-format-${key}`}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() =>
                    onAction({
                      label: t("Change format"),
                      kind: "link",
                      action: "format",
                    })
                  }
                >
                  {t("Change format")}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {pres.blocked && c.readiness ? (
        <div className="flex flex-col gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid={`whats-missing-${key}`}
            aria-expanded={detailOpen}
            className="w-fit px-2 text-xs text-muted-foreground"
            onClick={onToggleDetail}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                detailOpen && "rotate-180",
              )}
            />
            {t("See what's missing")}
          </Button>
          {detailOpen ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
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
        </div>
      ) : null}

      {drawn && detailOpen ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
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
  );
}
