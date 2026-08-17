import { useState } from "react";
import { CheckCircle2, CircleAlert, Play, Users } from "lucide-react";
import type { LiveSnapshot } from "@/api/live";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * What stands between a scheduled match and a live one (owner 2026-08-17:
 * "the start match button should be somewhere the user can easily see, and
 * when the user presses start match we need to first show the list of all the
 * assigned teachers or people, and once done confirm and start").
 *
 * It exists because starting a match is the one irreversible-feeling moment on
 * match day: the clock runs, the scoreboard goes public, and the people named
 * here are the ones who will be held to the result. So the console does not
 * open on a live-looking board with armed buttons — it opens on this, which
 * says who is on court and asks once.
 *
 * Two steps rather than one tap: the first press reveals the team sheets and
 * officials, the second commits. Nothing else on the console is reachable
 * until the match is live, so this is the only thing to read.
 */

type Side = "home" | "away";

function TeamColumn({
  label,
  team,
  tone,
}: {
  label: string;
  team: LiveSnapshot["match"]["home_team"];
  tone: "primary" | "info";
}): React.ReactElement {
  const players = team?.players ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 shrink-0 rounded-sm",
            tone === "primary" ? "bg-primary" : "bg-info",
          )}
        />
        <span className="min-w-0 truncate text-sm font-semibold">
          {team?.name ?? t("TBD")}
        </span>
        <span className="ml-auto shrink-0 font-tabular text-xs text-muted-foreground">
          {players.length} {players.length === 1 ? t("player") : t("players")}
        </span>
      </div>
      <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {players.length ? (
        <ul className="flex flex-col gap-0.5">
          {players.map((p) => (
            <li key={p.id} className="truncate text-xs">
              {p.jersey_no ? (
                <span className="pr-1.5 font-tabular text-muted-foreground">
                  {p.jersey_no}
                </span>
              ) : null}
              {p.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1 text-xs text-warning">
          <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Nobody is listed for this team yet.")}
        </p>
      )}
    </div>
  );
}

export function PreMatchGate({
  match,
  officials,
  pending,
  onStart,
}: {
  match: LiveSnapshot["match"];
  /** Everyone assigned to run this match: the scorer and every official row. */
  officials: { id: string; name: string; role: string }[];
  pending?: boolean;
  onStart: () => void;
}): React.ReactElement {
  const [checking, setChecking] = useState(false);

  const nobody = officials.length === 0;

  return (
    <section
      data-testid="pre-match-gate"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("Not started")}
        </span>
        <h2 className="text-sm font-semibold">
          {checking ? t("Check who is on court") : t("Ready when you are")}
        </h2>
      </div>

      {checking ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TeamColumn label={t("Team sheet")} team={match.home_team} tone="primary" />
            <TeamColumn label={t("Team sheet")} team={match.away_team} tone="info" />
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              <Users aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Running this match")}
            </span>
            {nobody ? (
              <p
                data-testid="gate-no-officials"
                className="flex items-center gap-1 text-xs text-warning"
              >
                <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Nobody is assigned yet. You can still start, but the result will have no named official.")}
              </p>
            ) : (
              <ul data-testid="gate-officials" className="flex flex-wrap gap-1.5">
                {officials.map((o) => (
                  <li
                    key={`${o.id}-${o.role}`}
                    className="rounded-full bg-secondary px-2 py-0.5 text-xs"
                  >
                    {o.name}
                    <span className="pl-1 text-muted-foreground">{o.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Nothing can be scored until the match is started. Check the team sheets and officials first.")}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {checking ? (
          <>
            <Button
              size="lg"
              data-testid="confirm-start-match"
              disabled={pending}
              onClick={onStart}
              className="h-12 min-w-44 flex-1 text-base sm:flex-none"
            >
              <CheckCircle2 aria-hidden="true" className="mr-1.5 h-4 w-4" />
              {pending ? t("Starting…") : t("Confirm and start")}
            </Button>
            <Button
              size="lg"
              variant="outline"
              data-testid="cancel-start-match"
              disabled={pending}
              onClick={() => setChecking(false)}
              className="h-12"
            >
              {t("Back")}
            </Button>
          </>
        ) : (
          <Button
            size="lg"
            data-testid="start-match"
            disabled={pending}
            onClick={() => setChecking(true)}
            className="h-12 w-full text-base sm:w-auto sm:min-w-48"
          >
            <Play aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {t("Start match")}
          </Button>
        )}
      </div>
    </section>
  );
}

export type { Side };
