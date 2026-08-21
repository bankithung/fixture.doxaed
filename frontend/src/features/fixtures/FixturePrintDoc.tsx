import { memo, useMemo } from "react";
import {
  type PublicCourtLink,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import { t } from "@/lib/t";
import { buildCourtLanes } from "./CourtBoard";
import { MatchSheet } from "./MatchSheet";
import { fmtDay } from "./publicMatchCard";
import { toMatchRow, type Bracket } from "./bracketModel";
import {
  splitLabel,
  type Competition,
  type RosterIndex,
} from "./publicTournament";

/**
 * The fixture as PAPER — the same boards the page shows, cut to A4 landscape.
 *
 * Two rules shape this file:
 *
 *  1. It renders the SAME components as the screen (`MatchSheet` per court,
 *     `BracketView`'s FifaBracket tree), never a stripped B&W lookalike. The
 *     old print sheet was a four-column table that shared nothing with the
 *     page, so what an organiser pinned up never matched what a parent read.
 *     A print stylesheet does the rest (`.print-doc` in index.css): colours
 *     kept, headers repeated on every page, no row split across a page break.
 *
 *  2. Every fixture prints TWICE (owner 2026-08-21): first by team, exactly as
 *     shown, then the same fixture again with every player named under the
 *     team that entered them. The knockout is the same tree both times — the
 *     detailed pass grows the cards to hold the names rather than swapping the
 *     draw for a list, because the flow IS how a draw is read.
 *
 * The doc is `hidden print:block`: it costs nothing on screen and is already
 * in the DOM when the print dialog opens (a document built inside `onclick`
 * would race the dialog).
 */

/** What the reader is looking at, and therefore what Print produces. */
export type PrintScope =
  | {
      kind: "day";
      day: string;
      view: string;
      matches: PublicScheduleMatch[];
      courts: PublicCourtLink[] | undefined;
    }
  | { kind: "competition"; comp: Competition; days: number }
  | { kind: "knockout"; bracket: Bracket | null };

/** The box a bracket has to fit on ONE A4 landscape page, in CSS px: 277mm
 * across and 190mm down, less the tree's own padding, the page header and the
 * timezone footnote. The tree scales itself into this instead of scrolling —
 * paper scrolls neither way, and an overflowing bracket is not continued
 * overleaf, it is sliced through the middle of a card. */
const PAGE_W = 1000;
// 190mm of paper, less the page header, the tree's own padding and its
// timezone footnote — measured, not guessed: at 560 the section came out
// 774px against 718px of page and the final round fell overleaf.
const PAGE_H = 480;

function Page({
  testid,
  tournamentName,
  title,
  meta,
  detailed,
  children,
}: {
  testid: string;
  tournamentName: string;
  title: string;
  meta?: string;
  detailed: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      data-testid={testid}
      className="break-after-page pb-4 last:break-after-auto"
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-border pb-2">
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">
            {tournamentName}
          </h1>
          <p className="text-sm text-muted-foreground">{title}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {detailed ? t("With player names") : t("Order of play")}
          {meta ? ` · ${meta}` : ""}
        </p>
      </header>
      {children}
    </section>
  );
}

/** A competition's knockout only — the group stage prints as a sheet above. */
function koOnly(matches: PublicScheduleMatch[]): PublicScheduleMatch[] {
  return matches.filter((m) => m.stage === "knockout");
}

/** Memoised: the page re-renders on every live tick, and the paper is a second
 * and third copy of the whole scope. It only changes when the scope, the
 * numbering or the rosters do. */
export const FixturePrintDoc = memo(function FixturePrintDoc({
  tournamentName,
  timeZone,
  numbers,
  rosters,
  scope,
}: {
  tournamentName: string;
  timeZone: string;
  numbers: Map<string, number>;
  /** Empty until the rosters land; the detailed pass then says "No team
   * sheet" per side rather than disappearing. */
  rosters: RosterIndex;
  scope: PrintScope;
}): React.ReactElement | null {
  const lanes = useMemo(
    () =>
      scope.kind === "day"
        ? buildCourtLanes(scope.matches, scope.courts)
        : [],
    [scope],
  );

  /** One pass over the scope. `sheet` is undefined on the team pass and the
   * roster index on the detailed one — the ONE difference between them, so the
   * two can never drift into different fixtures. */
  const pass = (detailed: boolean): React.ReactElement[] => {
    const sheet = detailed ? rosters : undefined;
    const tag = detailed ? "detailed" : "teams";

    if (scope.kind === "knockout") {
      const b = scope.bracket;
      if (!b) return [];
      // The tree, and ONLY the tree (owner 2026-08-21): a knockout is read as
      // a flow chart, and the order-of-play table beside it said the same
      // thing again in a shape nobody reads a draw in.
      return [
        <Page
          key={`ko-${tag}`}
          testid={`print-page-knockout-${tag}`}
          tournamentName={tournamentName}
          title={`${t("Knockout")} · ${splitLabel(b.label).join(" · ")}`}
          meta={`${b.matches.length} ${t("matches")}`}
          detailed={detailed}
        >
          <BracketView
            matches={b.matches}
            timeZone={timeZone}
            matchNumbers={numbers}
            rosters={sheet}
            fitWidth={PAGE_W}
            fitHeight={PAGE_H}
            idScope={`print-${tag}`}
          />
        </Page>,
      ];
    }

    if (scope.kind === "competition") {
      const { comp, days } = scope;
      const label = splitLabel(comp.label).join(" · ");
      const groups = comp.groups.filter(
        (g) => g.matches.some((m) => m.stage !== "knockout"),
      );
      const ko = koOnly(comp.matches);
      const out: React.ReactElement[] = [];
      // ONE GROUP, ONE PAGE (owner 2026-08-21). Stacked into a single section
      // they ran across page boundaries: a group's heading could sit at the
      // foot of one page with its matches overleaf, and two groups shared a
      // page with nothing to say where one ended. A group is a thing an
      // organiser pins up on its own.
      for (const g of groups) {
        const ms = g.matches
          .filter((m) => m.stage !== "knockout")
          .sort((a, b) =>
            (a.scheduled_at ?? "~") < (b.scheduled_at ?? "~") ? -1 : 1,
          );
        out.push(
          <Page
            key={`group-${g.key}-${tag}`}
            testid={`print-page-group-${g.label}-${tag}`}
            tournamentName={tournamentName}
            title={`${label} · ${g.label}`}
            meta={`${ms.length} ${t("matches")}`}
            detailed={detailed}
          >
            <div className="overflow-hidden rounded-lg border border-border">
              <MatchSheet
                matches={ms}
                timeZone={timeZone}
                numbers={numbers}
                showCourt
                showDay={days > 1}
                showCompetition={false}
                idScope={`print-${tag}-${comp.key}-${g.key}`}
                rosters={sheet}
              />
            </div>
          </Page>,
        );
      }
      if (ko.length > 0) {
        out.push(
          <Page
            key={`compko-${tag}`}
            testid={`print-page-comp-knockout-${tag}`}
            tournamentName={tournamentName}
            title={`${label} · ${t("Knockout")}`}
            meta={`${ko.length} ${t("matches")}`}
            detailed={detailed}
          >
            <CompetitionTree
              matches={ko}
              timeZone={timeZone}
              numbers={numbers}
              rosters={sheet}
              idScope={`print-${tag}`}
            />
          </Page>,
        );
      }
      return out;
    }

    // A match day: one sheet per court, exactly as the board reads it, unless
    // the reader switched to the clock — then it is the one day-long sheet.
    const dayLabel = scope.day ? fmtDay(scope.day) : t("Match day");
    if (scope.view === "time" || lanes.length === 0) {
      const ordered = [...scope.matches].sort((a, b) =>
        (a.scheduled_at ?? "~") < (b.scheduled_at ?? "~") ? -1 : 1,
      );
      if (ordered.length === 0) return [];
      return [
        <Page
          key={`time-${tag}`}
          testid={`print-page-day-${tag}`}
          tournamentName={tournamentName}
          title={dayLabel}
          meta={`${ordered.length} ${t("matches")}`}
          detailed={detailed}
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <MatchSheet
              matches={ordered}
              timeZone={timeZone}
              numbers={numbers}
              showCourt
              idScope={`print-${tag}-byTime`}
              rosters={sheet}
            />
          </div>
        </Page>,
      ];
    }
    return lanes.map((lane) => (
      <Page
        key={`court-${lane.key}-${tag}`}
        testid={`print-page-court-${lane.name}-${tag}`}
        tournamentName={tournamentName}
        title={`${dayLabel} · ${lane.name}`}
        meta={`${lane.matches.length} ${t("matches")}`}
        detailed={detailed}
      >
        <div className="overflow-hidden rounded-lg border border-border">
          <MatchSheet
            matches={lane.matches}
            timeZone={timeZone}
            numbers={numbers}
            idScope={`print-${tag}-${lane.name}`}
            rosters={sheet}
          />
        </div>
      </Page>
    ));
  };

  const teams = pass(false);
  if (teams.length === 0) return null;
  return (
    <div data-testid="fixture-print-doc" className="print-doc hidden print:block">
      {teams}
      {pass(true)}
    </div>
  );
});

/** One competition's tree, the same filter `CompetitionBracket` uses on
 * screen. Separate so the knockout page stays a one-liner. */
function CompetitionTree({
  matches,
  timeZone,
  numbers,
  rosters,
  idScope,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string;
  numbers: Map<string, number>;
  rosters: RosterIndex | undefined;
  idScope: string;
}): React.ReactElement {
  const rows = useMemo(() => matches.map(toMatchRow), [matches]);
  return (
    <BracketView
      matches={rows}
      timeZone={timeZone}
      matchNumbers={numbers}
      rosters={rosters}
      fitWidth={PAGE_W}
      fitHeight={PAGE_H}
      idScope={idScope}
    />
  );
}

