import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Layers,
  MapPin,
  Play,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { LiveSnapshot } from "@/api/live";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TeamCrest } from "@/components/ui/TeamCrest";
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
 *
 * **The layout is a match sheet, in the order it is read** (owner 2026-08-19,
 * "redesign this page properly"). Four decisions carry it:
 *
 * 1. *Nothing is said twice.* A knockout's `group_label` IS its competition
 *    label (`generate.py` names every bracket match after the category), so
 *    the old fixed four-cell strip printed "Table Tennis · Open Category ·
 *    Boys · Doubles" underneath a heading that already said it. Every cell
 *    here drops out when it is empty or when it merely repeats the heading.
 * 2. *The two squads are one opposition, not two lists.* They sit either side
 *    of a `vs` rail and each is labelled Home or Away, because an official
 *    reading a sheet has to know which end of the table a school is on. The
 *    rail is a real grid column, so it becomes a full-width divider when the
 *    columns stack on a phone.
 * 3. *A number box means a shirt number.* Table tennis and sepak rosters carry
 *    none, and the old sheet drew an empty grey square beside every player. A
 *    squad with no numbers gets a plain ordinal instead.
 * 4. *Readiness is readable before the press, not only inside the confirm.*
 *    The same warnings the dialog lists are counted in the action bar, and
 *    each squad states how many of its players are named against the
 *    category's on-court cap.
 */

type Side = "home" | "away";

type Team = LiveSnapshot["match"]["home_team"];

/** Bracket-role labels. Anything unlisted is humanized from its own key, so a
 * new stage type reads sensibly here without a change. */
const STAGE_LABELS: Record<string, string> = {
  group: "Group stage",
  knockout: "Knockout",
  grand_final: "Grand final",
  plate: "Plate",
  swiss: "Swiss",
};

function stageLabel(stage: string | undefined): string {
  if (!stage) return "";
  const known = STAGE_LABELS[stage];
  if (known) return t(known);
  const words = stage.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/** Up to two initials for a person. Deliberately not `crestInitials`, which
 * strips the words a SCHOOL name is padded with. */
function personInitials(name: string): string {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function InfoCell({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
}): React.ReactElement | null {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
          {label}
        </dt>
        <dd className="truncate text-sm font-medium">{value}</dd>
      </div>
    </div>
  );
}

function RosterCount({
  named,
  perSide,
}: {
  named: number;
  perSide: number | null;
}): React.ReactElement {
  const complete = perSide ? named >= perSide : named > 0;
  const text = perSide
    ? `${named} ${t("of")} ${perSide} ${t("named")}`
    : `${named} ${t("named")}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        complete ? "text-success" : "text-warning",
      )}
    >
      {complete ? (
        <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="font-tabular">{text}</span>
    </span>
  );
}

function TeamSheet({
  team,
  side,
  tone,
  fallback,
  perSide,
}: {
  team: Team;
  side: Side;
  tone: "primary" | "info";
  fallback: string;
  perSide: number | null;
}): React.ReactElement {
  const players = team?.players ?? [];
  const name = team?.name ?? fallback;
  // A number box only appears where there are numbers to put in it.
  const numbered = players.some((p) => p.jersey_no != null);
  return (
    <div
      data-testid={`gate-sheet-${side}`}
      className="relative flex min-w-0 flex-col gap-3 p-3 pl-4 sm:p-4 sm:pl-5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          tone === "primary" ? "bg-primary" : "bg-info",
        )}
      />
      {/* Centred rather than baseline-aligned, because the badge is the
          tallest thing on this row. It is the largest crest in the app: this
          screen exists so an official can match the sheet to the people in
          front of them, and a badge is what a school is recognised by. */}
      <div className="flex items-center gap-3">
        <TeamCrest src={team?.crest} name={name} size="xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className={cn(
              "text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em]",
              tone === "primary" ? "text-primary" : "text-info",
            )}
          >
            {side === "home" ? t("Home") : t("Away")}
          </span>
          <h3 className="min-w-0 text-base font-semibold leading-tight sm:text-lg">
            {name}
          </h3>
          {team ? <RosterCount named={players.length} perSide={perSide} /> : null}
        </div>
      </div>
      {players.length ? (
        <ol className="flex flex-col">
          {players.map((p, i) => (
            <li
              key={p.id}
              className="flex min-h-11 items-center gap-3 border-b border-border/60 py-1 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "shrink-0 font-tabular",
                  numbered
                    ? "grid h-8 w-8 place-items-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
                    : "w-5 text-right text-xs text-muted-foreground/70",
                )}
              >
                {numbered ? (p.jersey_no ?? "") : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {p.name}
              </span>
              {p.position ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] capitalize text-muted-foreground">
                  {p.position.replace(/_/g, " ")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
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
  const heading =
    [sport, category].filter(Boolean).join(" · ") ||
    `${homeName} ${t("vs")} ${awayName}`;
  const startTime = match.scheduled_at
    ? new Date(match.scheduled_at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tournament?.time_zone || undefined,
      })
    : "";
  const perSide = match.players_per_side ?? null;

  // Where the match sits in its draw, the way the printed order-of-play says
  // it. Each part drops out on its own, so a friendly with no draw behind it
  // simply has no second line.
  const drawLine = [
    stageLabel(match.stage),
    match.round_no ? `${t("Round")} ${match.round_no}` : "",
    match.match_no ? `${t("Match")} ${match.match_no}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // A knockout's group_label IS its competition label, so it would print the
  // heading a second time. Only a real group ("A", "Pool 2") earns a cell.
  // Compared on letters and digits alone, because the draw builds its label
  // from the raw leaf key while the heading humanizes it, so the two agree in
  // words long before they agree in punctuation.
  const group = (match.group_label ?? "").trim();
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const echoesHeading =
    norm(group) === norm(heading) ||
    norm(group) === norm(category) ||
    norm(group) === norm(`${sport}${category}`);
  const groupCell = group && !echoesHeading ? group : "";

  // Said once in the dialog and counted once in the action bar, so the sheet
  // itself stays a sheet. None of these stop the match: they are what the
  // person on court is being asked to look at.
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
      {/* Masthead: what is being played, where it sits in the draw, and where
          it is played. */}
      <div className="flex flex-col gap-3 border-b border-border p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {back}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
            />
            {t("Not started")}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <h1
            data-testid="match-context"
            className="text-base font-semibold leading-tight tracking-tight sm:text-lg"
          >
            {heading}
          </h1>
          {drawLine ? (
            <p
              data-testid="gate-draw-line"
              className="text-xs text-muted-foreground"
            >
              {drawLine}
            </p>
          ) : null}
        </div>
        {startTime || match.venue || groupCell || perSide ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-4">
            <InfoCell icon={Clock} label={t("Start")} value={startTime} />
            <InfoCell icon={MapPin} label={t("Court")} value={match.venue ?? ""} />
            <InfoCell
              icon={Users}
              label={t("Format")}
              value={perSide ? `${perSide} ${t("a side")}` : ""}
            />
            <InfoCell icon={Layers} label={t("Group")} value={groupCell} />
          </dl>
        ) : null}
      </div>

      {/* Who is playing. The rail between them is a real grid column, so it
          becomes a full-width divider once the sheets stack. */}
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <TeamSheet
          team={match.home_team}
          side="home"
          tone="primary"
          fallback={homeName}
          perSide={perSide}
        />
        <div className="flex items-center justify-center border-y border-border bg-muted/30 py-1.5 sm:border-x sm:border-y-0 sm:px-2 sm:py-0">
          <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
            {t("vs")}
          </span>
        </div>
        <TeamSheet
          team={match.away_team}
          side="away"
          tone="info"
          fallback={awayName}
          perSide={perSide}
        />
      </div>

      {/* Who is running it. */}
      <div className="flex flex-col gap-2 border-t border-border p-3 sm:p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          <span className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
            {t("Match officials")}
          </span>
          {officials.length ? (
            <span className="ml-auto font-tabular text-xs text-muted-foreground">
              {officials.length}
            </span>
          ) : null}
        </div>
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
          <ul data-testid="gate-officials" className="flex flex-col">
            {officials.map((o) => (
              <li
                key={`${o.id}-${o.role}`}
                className="flex min-h-11 items-center gap-2.5 border-b border-border/60 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold text-muted-foreground"
                >
                  {personInitials(o.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {o.name}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
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

      {/* One action, and it is the only one on the page. What the confirm is
          about to say is already counted here, so nobody presses blind. */}
      <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-card/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:flex-row sm:items-center sm:p-4">
        <p
          data-testid="gate-readiness"
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            warnings.length ? "text-warning" : "text-success",
          )}
        >
          {warnings.length ? (
            <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          )}
          {warnings.length === 0
            ? t("Everything is in place.")
            : warnings.length === 1
              ? t("1 thing to check before you start.")
              : `${warnings.length} ${t("things to check before you start.")}`}
        </p>
        <Button
          size="lg"
          data-testid="start-match"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="h-12 w-full text-base sm:ml-auto sm:w-auto sm:min-w-48"
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
