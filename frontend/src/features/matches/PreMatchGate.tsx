import { useState } from "react";
import { CircleAlert, Play, ShieldCheck } from "lucide-react";
import type { LiveSnapshot } from "@/api/live";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { officialRoleLabel } from "@/features/controlroom/crewRoster";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { competitionLabel } from "./console/shared";

/**
 * The team sheet an official carries to the table, on screen (owner
 * 2026-08-19: "when the user open fresh match console we only show a proper
 * start match button and all list of assigned referee and teachers, and once
 * all ready the user can start, so it is a manual verification the user look
 * in real and start").
 *
 * A match that has not started renders THIS AND NOTHING ELSE. Before, the gate
 * sat on top of a full scoreboard, so the console showed "Confirm and start"
 * and a live-looking 0-0 board with Game 1 marked "Live" at the same time —
 * two contradictory readings of the same match. The board does not exist until
 * the match does.
 *
 * The verification is the screen, not a checklist. Nothing here blocks Start:
 * the server allows `scheduled -> live` with no officials and no lineups
 * (`ALLOWED_TRANSITIONS` carries no precondition), and adding one in the UI
 * would strand the two cases that legitimately happen on the day — a bracket
 * slot still filling from an earlier result, and a crew assigned verbally. So
 * the sheet states plainly what is missing and lets the human decide, which is
 * exactly what "look in real and start" means.
 */

type Side = "home" | "away";

type Team = LiveSnapshot["match"]["home_team"];

function Cell({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement | null {
  if (!value) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-sm font-medium">{value}</span>
    </div>
  );
}

function TeamSheet({
  team,
  tone,
  fallback,
}: {
  team: Team;
  tone: "primary" | "info";
  fallback: string;
}): React.ReactElement {
  const players = team?.players ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-sm",
            tone === "primary" ? "bg-primary" : "bg-info",
          )}
        />
        <h3
          className={cn(
            "min-w-0 flex-1 text-base font-semibold leading-tight sm:text-lg",
            tone === "primary" ? "text-primary" : "text-info",
          )}
        >
          {team?.name ?? fallback}
        </h3>
        {players.length ? (
          <span className="shrink-0 font-tabular text-xs text-muted-foreground">
            {players.length}
          </span>
        ) : null}
      </div>
      {players.length ? (
        <ul className="flex flex-col">
          {players.map((p) => (
            <li
              key={p.id}
              className="flex min-h-11 items-center gap-2.5 border-b border-border/60 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted font-tabular text-xs font-medium text-muted-foreground"
              >
                {p.jersey_no ?? ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
              {p.position ? (
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {p.position.replace(/_/g, " ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
          />
          {team
            ? t("No players listed for this team.")
            : t("Fills from an earlier result.")}
        </p>
      )}
    </div>
  );
}

export function PreMatchGate({
  match,
  officials,
  tournament,
  pending,
  onStart,
  back,
  sheets,
}: {
  match: LiveSnapshot["match"];
  /** Everyone assigned to run this match: the scorer and every official row. */
  officials: { id: string; name: string; role: string }[];
  tournament?: { time_zone?: string } | null;
  pending?: boolean;
  onStart: () => void;
  /** Back to the match list, styled by the chassis. */
  back?: React.ReactNode;
  /** The lineup editor, folded in so the sheet is still fixable from here. */
  sheets?: React.ReactNode;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);

  const homeName = match.home_team?.name ?? t("To be decided");
  const awayName = match.away_team?.name ?? t("To be decided");
  const sport = match.sport_meta?.name ?? "";
  const category = competitionLabel(
    match.leaf_key,
    match.sport_meta?.key ?? match.sport,
  );
  const startTime = match.scheduled_at
    ? new Date(match.scheduled_at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tournament?.time_zone || undefined,
      })
    : "";

  // Said once, in the dialog, so the sheet itself stays a sheet. None of these
  // stop the match: they are what the person on court is being asked to look at.
  const warnings = [
    !match.home_team || !match.away_team
      ? t("One side is still to be decided.")
      : "",
    match.home_team && !(match.home_team.players ?? []).length
      ? `${homeName}: ${t("no players listed.")}`
      : "",
    match.away_team && !(match.away_team.players ?? []).length
      ? `${awayName}: ${t("no players listed.")}`
      : "",
    officials.length === 0 ? t("No official is assigned to this match.") : "",
  ].filter(Boolean);

  return (
    <section
      data-testid="pre-match-gate"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      {/* Masthead: what is being played, and where. */}
      <div className="flex flex-col gap-3 border-b border-border p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("Not started")}
          </span>
          {back}
        </div>
        <h1
          data-testid="match-context"
          className="text-base font-semibold leading-tight tracking-tight sm:text-lg"
        >
          {[sport, category].filter(Boolean).join(" · ") ||
            `${homeName} ${t("vs")} ${awayName}`}
        </h1>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Cell label={t("Court")} value={match.venue ?? ""} />
          <Cell label={t("Start")} value={startTime} />
          <Cell label={t("Group")} value={match.group_label ?? ""} />
          <Cell
            label={t("A side")}
            value={
              match.players_per_side ? String(match.players_per_side) : ""
            }
          />
        </div>
      </div>

      {/* Who is playing. */}
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <TeamSheet team={match.home_team} tone="primary" fallback={homeName} />
        <TeamSheet team={match.away_team} tone="info" fallback={awayName} />
      </div>

      {/* Who is running it. */}
      <div className="flex flex-col gap-2 border-t border-border p-3 sm:p-4">
        <span className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Running this match")}
        </span>
        {officials.length === 0 ? (
          <p
            data-testid="gate-no-officials"
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
            />
            {t(
              "Nobody is assigned yet. You can still start, but the result will have no named official.",
            )}
          </p>
        ) : (
          <ul
            data-testid="gate-officials"
            className="flex flex-col divide-y divide-border/60"
          >
            {officials.map((o) => (
              <li
                key={`${o.id}-${o.role}`}
                className="flex min-h-11 items-center gap-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {o.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(officialRoleLabel(o.role))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The team sheets are editable from here, folded away so the screen
          still reads as one thing (the chassis folds its recorder and event
          log the same way). */}
      {sheets ? (
        <details className="border-t border-border">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:px-4">
            {t("Edit team sheets")}
          </summary>
          <div className="px-3 pb-3 sm:px-4">{sheets}</div>
        </details>
      ) : null}

      {/* One action, and it is the only one on the page. */}
      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-border bg-card/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:p-4">
        <Button
          size="lg"
          data-testid="start-match"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="h-12 w-full text-base sm:w-auto sm:min-w-48"
        >
          <Play aria-hidden="true" className="mr-1.5 h-4 w-4" />
          {t("Start match")}
        </Button>
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o) setConfirming(false);
        }}
        variant="sheet"
        ariaLabel={t("Start this match")}
      >
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold">{t("Start this match?")}</h2>
            <p className="pt-1 text-sm text-muted-foreground">
              {homeName} {t("vs")} {awayName}.{" "}
              {t("The clock starts now and the score goes public.")}
            </p>
          </div>
          {warnings.length ? (
            <ul
              data-testid="start-warnings"
              className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-muted p-2.5"
            >
              {warnings.map((w) => (
                <li
                  key={w}
                  className="flex items-start gap-1.5 text-xs text-warning"
                >
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  />
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              data-testid="cancel-start-match"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("Not yet")}
            </Button>
            <Button
              className="ml-auto h-11 min-w-36"
              data-testid="confirm-start-match"
              disabled={pending}
              onClick={onStart}
            >
              {pending ? t("Starting…") : t("Start match")}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

export type { Side };
