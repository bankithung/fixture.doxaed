import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Hourglass,
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
 * The verification is the screen, not a checklist. Missing officials and
 * missing team sheets do NOT block Start: both are things a human on the day
 * can vouch for (a crew assigned verbally, a squad the umpire can see at the
 * table), so the sheet states plainly what is missing and lets the person
 * decide, which is exactly what "look in real and start" means.
 *
 * **One thing does block it: a side that is still to be decided** (owner
 * 2026-08-26: "if it is tbd then the start button should not work"). A
 * bracket slot fills from an earlier result (invariant #9) and until it does
 * the side is nobody at all: nothing to score for, nothing to check on court.
 * Nobody can vouch for a team that does not exist yet, so this is the single
 * precondition, and `transition_match` enforces the same rule server-side.
 *
 * **The 2026-08-26 rebuild** (owner: "the start button in mobile view i have
 * to scroll a lot", "the current looks like an AI slop"). Four things were
 * wrong, and each has a rule now:
 *
 * 1. *The action bar was `sticky` inside an `overflow-hidden` section*, which
 *    silently cancels sticky — the nearest scroll container becomes a clipped
 *    box that never scrolls. So Start really did sit at the bottom of a long
 *    page on a phone. The section does not clip any more; **nothing on this
 *    screen may reintroduce `overflow-hidden` on an ancestor of the bar.**
 * 2. *Nothing is said twice.* The old sheet said "to be decided" as a name,
 *    again as "Fills from an earlier result", and a third time in the
 *    readiness line. A fact appears once, in the one place it belongs.
 * 3. *An empty side names what it is WAITING ON* — "Winner of match 82",
 *    "Group A, place 2" (`home_source_label` off the pointer, invariant #9).
 *    "To be decided" is true and useless; the match number is something an
 *    official can look up on the same order-of-play they found this match on.
 *    It is the heading of that side, so no explainer line is needed under it,
 *    and there is no fake "TB" crest for a team that does not exist.
 * 4. *Facts read as facts, not as form fields.* Time and court sit on one
 *    line instead of in a 2x2 grid of boxed cells with uppercase micro-labels
 *    over each; the crew is a row of chips instead of a stacked list. That is
 *    what takes the screen from "scroll a lot" to one phone screen.
 *
 * **The layout is a match sheet, in the order it is read** (owner 2026-08-19,
 * "redesign this page properly"):
 *
 * - *The two squads are one opposition, not two lists.* They are labelled
 *   Team 1 and Team 2 (owner 2026-08-19: "instead of home and away use team 1
 *   team 2" — a school hosting on its own tables has no away side, and a
 *   table-tennis draw has no home end to speak of). `side` stays home/away
 *   underneath, because that is what the draw, the scoreboard and every score
 *   payload call it.
 * - *A number box means a shirt number.* Table tennis and sepak rosters carry
 *   none, and a squad with no numbers gets a plain ordinal instead of an empty
 *   grey square beside every player.
 * - *Readiness is readable before the press, not only inside the confirm.*
 *   The same warnings the dialog lists are counted in the action bar.
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

/** One fact, stated the way a person says it. The old sheet wrapped each of
 * these in a bordered cell under an uppercase label; four of them filled a
 * phone screen to say "12:40" and "Audi · T1". */
function Fact({
  icon: Icon,
  children,
}: {
  icon: typeof MapPin;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </span>
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
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
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

function SquadPanel({
  team,
  side,
  tone,
  perSide,
  waitingOn,
  className,
}: {
  team: Team;
  side: Side;
  tone: "primary" | "info";
  perSide: number | null;
  /** What fills this slot, when nothing has yet. */
  waitingOn: string;
  className?: string;
}): React.ReactElement {
  const players = team?.players ?? [];
  // A number box only appears where there are numbers to put in it.
  const numbered = players.some((p) => p.jersey_no != null);
  // The heading IS the answer: a team once there is one, otherwise the result
  // this slot is waiting for. Only a pointer that names nothing falls back to
  // the bare phrase, and only that case earns a line of explanation.
  const heading = team?.name ?? waitingOn ?? "";

  return (
    <div
      data-testid={`gate-sheet-${side}`}
      className={cn("relative flex min-w-0 flex-col gap-3 p-3 pl-4 sm:p-4 sm:pl-5", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          team ? (tone === "primary" ? "bg-primary" : "bg-info") : "bg-border",
        )}
      />
      <div className="flex items-center gap-3">
        {team ? (
          // The largest crest in the app: this screen exists so an official
          // can match the sheet to the people in front of them, and a badge is
          // what a school is recognised by.
          <TeamCrest src={team.crest} name={team.name} size="xl" />
        ) : (
          <span
            aria-hidden="true"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-dashed border-border text-muted-foreground"
          >
            <Hourglass className="h-5 w-5" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-xs font-medium",
              team
                ? tone === "primary"
                  ? "text-primary"
                  : "text-info"
                : "text-muted-foreground",
            )}
          >
            {side === "home" ? t("Team 1") : t("Team 2")}
          </span>
          <h2
            className={cn(
              "truncate text-base font-semibold leading-tight",
              team ? "" : "text-muted-foreground",
            )}
          >
            {heading || t("To be decided")}
          </h2>
          {team ? (
            <RosterCount named={players.length} perSide={perSide} />
          ) : null}
        </div>
      </div>
      {team && players.length ? (
        <ol className="flex flex-col">
          {players.map((p, i) => (
            <li
              key={p.id}
              className="flex min-h-9 items-center gap-3 border-b border-border/60 py-1 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "shrink-0 font-tabular",
                  numbered
                    ? "grid h-7 w-7 place-items-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
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
      ) : null}
      {team && !players.length ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
          />
          {t("No players listed for this team.")}
        </p>
      ) : null}
      {!team && !waitingOn ? (
        <p className="text-xs text-muted-foreground">
          {t("Fills from an earlier result.")}
        </p>
      ) : null}
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

  // The squad size is a fact worth stating for a team sport and noise for a
  // singles draw, where the heading already ends in the word "Singles".
  const formatCell = perSide && perSide > 2 ? `${perSide} ${t("a side")}` : "";

  // The one condition that stops the match, rather than merely being worth a
  // look. The disabled button needs a reason beside it; the sides themselves
  // say WHICH result they are waiting on, so this does not repeat them.
  const undecided = !match.home_team || !match.away_team;

  // Said once in the dialog and counted once in the action bar, so the sheet
  // itself stays a sheet. These do NOT stop the match: they are what the
  // person on court is being asked to look at.
  const warnings = [
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
      className="flex flex-col rounded-xl border border-border bg-card shadow-sm"
    >
      {/* What is being played, where it sits in the draw, and the two facts an
          official needs to know they are at the right table. */}
      <header className="flex flex-col gap-3 border-b border-border p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {back}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
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
            className="text-lg font-semibold leading-tight tracking-tight sm:text-xl"
          >
            {heading}
          </h1>
          {drawLine || groupCell ? (
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {drawLine ? (
                <span data-testid="gate-draw-line">{drawLine}</span>
              ) : null}
              {drawLine && groupCell ? (
                <span aria-hidden="true" className="text-border">
                  ·
                </span>
              ) : null}
              {groupCell ? <span>{groupCell}</span> : null}
            </p>
          ) : null}
        </div>
        {startTime || match.venue || formatCell ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm font-medium">
            {startTime ? (
              <Fact icon={Clock}>
                <span className="font-tabular">{startTime}</span>
              </Fact>
            ) : null}
            {match.venue ? <Fact icon={MapPin}>{match.venue}</Fact> : null}
            {formatCell ? <Fact icon={Users}>{formatCell}</Fact> : null}
          </div>
        ) : null}
      </header>

      {/* Who is playing. Two panels, side by side once there is room for them. */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        <SquadPanel
          team={match.home_team}
          side="home"
          tone="primary"
          perSide={perSide}
          waitingOn={match.home_source_label ?? ""}
        />
        <SquadPanel
          team={match.away_team}
          side="away"
          tone="info"
          perSide={perSide}
          waitingOn={match.away_source_label ?? ""}
          className="border-t border-border sm:border-l sm:border-t-0"
        />
      </div>

      {/* Who is running it. A crew is two or three people, so they are chips on
          one wrapping row rather than a list with a row each. */}
      <div className="flex flex-col gap-2 border-t border-border p-3 sm:p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span className="text-sm font-medium">{t("Officials")}</span>
          {officials.length ? (
            <span className="ml-auto font-tabular text-xs text-muted-foreground">
              {officials.length}
            </span>
          ) : null}
        </div>
        {officials.length === 0 ? (
          <p
            data-testid="gate-no-officials"
            className="text-xs text-muted-foreground"
          >
            {t("Nobody is assigned. The result will have no named official.")}
          </p>
        ) : (
          <ul data-testid="gate-officials" className="flex flex-wrap gap-2">
            {officials.map((o) => (
              <li
                key={`${o.id}-${o.role}`}
                className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-muted/40 py-1 pl-1 pr-3"
              >
                <span
                  aria-hidden="true"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold text-muted-foreground"
                >
                  {personInitials(o.name)}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">
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
          still reads as one thing. There is nothing to edit while a side is a
          pointer, so the fold does not appear at all. */}
      {sheets && !undecided ? (
        <details className="border-t border-border">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:px-4">
            {t("Edit team sheets")}
          </summary>
          <div className="px-3 pb-3 sm:px-4">{sheets}</div>
        </details>
      ) : null}

      {/* One action, and it is the only one on the page. It rides the bottom of
          the viewport the whole way down the sheet, so Start is never a scroll
          away on a phone — which is exactly what `overflow-hidden` on this
          section used to break. */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 rounded-b-xl border-t border-border bg-card/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:p-4">
        <p
          data-testid="gate-readiness"
          className={cn(
            "flex min-w-0 flex-1 items-start gap-1.5 text-xs font-medium",
            undecided || warnings.length ? "text-warning" : "text-success",
          )}
        >
          {undecided || warnings.length ? (
            <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0">
            {undecided
              ? t("Start opens once both sides are decided.")
              : warnings.length === 0
                ? t("Everything is in place.")
                : warnings.length === 1
                  ? t("1 thing to check before you start.")
                  : `${warnings.length} ${t("things to check before you start.")}`}
          </span>
        </p>
        <Button
          size="lg"
          data-testid="start-match"
          disabled={pending || undecided}
          onClick={() => setConfirming(true)}
          className="h-11 shrink-0 px-6 text-sm sm:h-12 sm:min-w-44 sm:text-base"
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
