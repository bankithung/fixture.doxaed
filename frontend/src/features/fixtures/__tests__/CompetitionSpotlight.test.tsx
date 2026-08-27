import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { PublicScheduleMatch } from "@/api/tournaments";
import { CompetitionSpotlight } from "../CompetitionSpotlight";
import { spotlightNextUp, spotlightPick } from "../publicTournament";

const BASE = {
  leaf_key: "tt.u14.boys.singles",
  leaf_label: "Table Tennis · U-14 · Boys · Singles",
  stage: "group",
  group_label: "",
  round_no: 1,
  venue: "Audi · T1",
  home_pens: null,
  away_pens: null,
  sport: "table_tennis",
  set_scores: [] as number[][],
  current_period: "",
  day: "2026-08-28",
};

function m(
  over: Partial<PublicScheduleMatch> & { id: string },
): PublicScheduleMatch {
  return {
    ...BASE,
    match_no: 1,
    status: "scheduled",
    scheduled_at: "2026-08-28T03:30:00Z",
    home: { id: "a", name: "Alpha", short_name: "A", school: "Alpha" },
    away: { id: "b", name: "Bravo", short_name: "B", school: "Bravo" },
    home_score: null,
    away_score: null,
    ...over,
  } as PublicScheduleMatch;
}

function mount(matches: PublicScheduleMatch[]) {
  return render(
    <MemoryRouter>
      <CompetitionSpotlight
        matches={matches}
        timeZone="Asia/Kolkata"
        title="Table Tennis · U-14 · Boys · Singles"
      />
    </MemoryRouter>,
  );
}


async function openBoard() {
  Object.defineProperty(Element.prototype, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  await userEvent.click(screen.getByTestId("spotlight-fullscreen"));
}

describe("spotlightPick", () => {
  it("prefers what is being played over anything else", () => {
    const pick = spotlightPick([
      m({ id: "done", status: "completed", home_score: 2, away_score: 0 }),
      m({ id: "next", scheduled_at: "2026-08-28T09:00:00Z" }),
      m({ id: "live", status: "live", scheduled_at: "2026-08-28T04:00:00Z" }),
    ]);
    expect(pick).toEqual({ match: expect.objectContaining({ id: "live" }), kind: "live" });
  });

  it("falls to the EARLIEST unplayed match when nothing is on", () => {
    // The owner's sepak page: every group match played, the knockout to come.
    const pick = spotlightPick([
      m({ id: "later", scheduled_at: "2026-08-29T06:00:00Z" }),
      m({ id: "sooner", scheduled_at: "2026-08-29T02:00:00Z" }),
      m({ id: "done", status: "completed", home_score: 2, away_score: 1 }),
    ]);
    expect(pick?.kind).toBe("next");
    expect(pick?.match.id).toBe("sooner");
  });

  it("falls to the LATEST result when the competition is over", () => {
    const pick = spotlightPick([
      m({ id: "early", status: "completed", scheduled_at: "2026-08-28T02:00:00Z" }),
      m({ id: "final", status: "completed", scheduled_at: "2026-08-29T08:00:00Z" }),
    ]);
    expect(pick?.kind).toBe("done");
    // The last thing PLAYED, not the first: a group stage has no final yet,
    // and "what happened" means the most recent result.
    expect(pick?.match.id).toBe("final");
  });

  it("sorts an unscheduled match last rather than calling it next", () => {
    const pick = spotlightPick([
      m({ id: "floating", scheduled_at: null, day: null }),
      m({ id: "timed", scheduled_at: "2026-08-29T02:00:00Z" }),
    ]);
    expect(pick?.match.id).toBe("timed");
  });

  it("has nothing to show for an empty competition", () => {
    expect(spotlightPick([])).toBeNull();
  });

  it("names the match after the spotlight, skipping the played ones", () => {
    const live = m({ id: "live", status: "live" });
    const next = spotlightNextUp(
      [
        live,
        m({ id: "done", status: "completed" }),
        m({ id: "then", scheduled_at: "2026-08-28T09:00:00Z" }),
      ],
      live,
    );
    expect(next?.id).toBe("then");
  });
});

describe("CompetitionSpotlight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("leads a competition with the match being played", () => {
    mount([
      m({ id: "live", status: "live", home_score: 1, away_score: 0 }),
      m({ id: "next", scheduled_at: "2026-08-28T09:00:00Z" }),
    ]);
    const s = screen.getByTestId("competition-spotlight");
    expect(s).toHaveAttribute("data-kind", "live");
    expect(screen.getByText("Now playing")).toBeInTheDocument();
  });

  it("still leads with something when no match is on", () => {
    // The bug this replaces: the sepak page had no live match, so the live
    // band rendered nothing and the page opened on finished group tables.
    mount([
      m({ id: "done", status: "completed", home_score: 2, away_score: 0 }),
      m({ id: "next", scheduled_at: "2026-08-29T02:00:00Z" }),
    ]);
    expect(screen.getByTestId("competition-spotlight")).toHaveAttribute(
      "data-kind",
      "next",
    );
    expect(screen.getByText("Up next")).toBeInTheDocument();
  });

  it("goes full screen, and asks the browser for real fullscreen too", async () => {
    const req = vi.fn().mockResolvedValue(undefined);
    // jsdom implements neither side of the Fullscreen API.
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: req,
    });
    mount([m({ id: "live", status: "live" }), m({ id: "then", scheduled_at: "2026-08-28T09:00:00Z" })]);

    const section = screen.getByTestId("competition-spotlight");
    expect(section).toHaveAttribute("data-board", "off");
    // What is coming is only named on the board, where nobody can scroll.
    expect(screen.queryByTestId("spotlight-next")).toBeNull();

    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));
    expect(section).toHaveAttribute("data-board", "on");
    expect(req).toHaveBeenCalled();
    expect(screen.getByTestId("spotlight-next")).toHaveTextContent("Up next");

    // Toggling back leaves the board.
    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));
    expect(section).toHaveAttribute("data-board", "off");
  });

  it("still fills the viewport when the browser refuses fullscreen", async () => {
    // Refused without a gesture, absent on older iOS Safari, inert in an
    // iframe. The CSS board is what the state drives, so the projector still
    // gets a full-viewport screen.
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: vi.fn().mockRejectedValue(new Error("denied")),
    });
    mount([m({ id: "live", status: "live" })]);

    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));
    expect(screen.getByTestId("competition-spotlight")).toHaveAttribute(
      "data-board",
      "on",
    );
  });

  it("leaves the board on Escape", async () => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    mount([m({ id: "live", status: "live" })]);

    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));
    expect(screen.getByTestId("competition-spotlight")).toHaveAttribute("data-board", "on");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("competition-spotlight")).toHaveAttribute("data-board", "off");
  });

  it("puts the state and the way out at the very top of the board", async () => {
    // Owner 2026-08-26: "the exit full screen and the latest result text
    // should be at the very top". The section used to centre ALL its children,
    // so the header floated in the middle of the screen.
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined),
    });
    mount([m({ id: "done", status: "completed", home_score: 2, away_score: 0 })]);
    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));

    const section = screen.getByTestId("competition-spotlight");
    const bar = screen.getByTestId("spotlight-fullscreen").parentElement!;
    // The bar is the FIRST child of the board, and it does not grow.
    expect(section.firstElementChild).toBe(bar);
    expect(bar.className).toMatch(/shrink-0/);
    expect(bar).toHaveTextContent("Latest result");
    expect(bar).toHaveTextContent("Exit full screen");
    // The body below it is what takes the leftover height.
    expect(section.children[1]!.className).toMatch(/flex-1/);
  });

  it("carries no team name at all — the crest is the whole identity", async () => {
    // Owner 2026-08-27: "no need to show the team name, we will keep only the
    // team logo and the scores". Read from 20m a badge lands faster than a
    // 40-character school name, and the names were most of the ink.
    const long = "Holy Cross Higher Secondary School ST-1";
    mount([
      m({
        id: "done",
        status: "completed",
        home_score: 0,
        away_score: 2,
        away: { id: "hc", name: long, short_name: "HC", school: "Holy Cross" },
      }),
    ]);
    await openBoard();

    // Nothing VISIBLE names the side...
    const painted = screen.queryAllByText(long).filter(
      (el) => !el.className.includes("sr-only"),
    );
    expect(painted).toEqual([]);
    // ...but a screen reader is not left with an unlabelled badge.
    expect(screen.getByText(long).className).toMatch(/sr-only/);
  });

  it("shows the crest whole rather than cropping it to a circle", async () => {
    // Owner 2026-08-27: "make sure the logo is not cropped and bigger size".
    // The shared TeamCrest is a circular avatar and uses object-cover, which
    // cuts a wide school badge — exactly the thing the hall is now reading.
    mount([m({ id: "done", status: "completed", home_score: 2, away_score: 0 })]);
    await openBoard();

    for (const crest of screen.getAllByTestId("team-crest-fallback")) {
      expect(crest.className).toMatch(/object-contain/);
      expect(crest.className).not.toMatch(/object-cover/);
      expect(crest.className).not.toMatch(/rounded-full/);
      // Bigger, and sized off the viewport rather than a fixed box.
      expect(crest.className).toMatch(/clamp\(/);
    }
  });

  it("scales with the viewport instead of with a breakpoint", async () => {
    // Owner 2026-08-26: "it need to be bigger and responsive". One board has
    // to fill a phone at the court and a hall screen 20m away.
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined),
    });
    mount([m({ id: "done", status: "completed", home_score: 2, away_score: 0 })]);
    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));

    const score = screen.getByLabelText("Open the match centre");
    expect(score.className).toMatch(/clamp\(/);
    expect(score.className).toMatch(/vw/);
  });

  it("names the competition once, and the kickoff once", async () => {
    // A knockout's group_label IS its competition label, so the meta line was
    // reprinting the heading; and an unplayed match wore its kickoff as the
    // centrepiece AND again underneath itself.
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined),
    });
    mount([
      m({
        id: "next",
        leaf_label: "Sepak Takraw · U-14 · Boys",
        group_label: "Sepak Takraw · U-14 · Boys · 3rd Place",
        scheduled_at: "2026-08-29T02:40:00Z",
      }),
    ]);
    await userEvent.click(screen.getByTestId("spotlight-fullscreen"));

    const meta = screen.getByTestId("spotlight-meta");
    // What the group ADDS survives; the competition it repeats does not.
    expect(meta).toHaveTextContent("3rd Place");
    expect(meta).not.toHaveTextContent("Sepak Takraw");
    // The kickoff is the centrepiece of an unplayed match, so it is not under
    // it as well.
    expect(meta).not.toHaveTextContent("08:10");
    expect(screen.getByLabelText("Open the match centre")).toHaveTextContent("08:10");
  });

  it("keeps the kickoff in the meta line once a match HAS been played", async () => {
    mount([
      m({
        id: "done",
        status: "completed",
        home_score: 2,
        away_score: 0,
        scheduled_at: "2026-08-29T08:15:00Z",
        venue: "Mph · T1",
      }),
    ]);
    const meta = screen.getByTestId("spotlight-meta");
    expect(meta).toHaveTextContent("13:45");
    expect(meta).toHaveTextContent("Mph · T1");
  });

  it("shows EVERY set on its own row, the one in play included", async () => {
    // Owner 2026-08-27: "all the set scores should be shown". liveSetView
    // drops the last row (the card shows it as the headline score), so reading
    // from it left the set in play off the board.
    mount([
      m({
        id: "live",
        status: "live",
        sport: "table_tennis",
        set_scores: [[11, 8], [9, 11], [11, 6], [5, 3]],
        home_score: 2,
        away_score: 1,
      }),
    ]);
    await openBoard();

    const rows = screen.getByTestId("spotlight-set-rows");
    expect(rows.children).toHaveLength(4);
    expect(rows.children[0]).toHaveTextContent("11-8");
    expect(rows.children[3]).toHaveTextContent("5-3");
    // The set still being played is flagged, not scored like a finished one.
    expect(rows.children[3]).toHaveAttribute("data-live");
    expect(rows.children[0]).not.toHaveAttribute("data-live");
    // Stacked, not wrapped side by side.
    expect(rows.className).toMatch(/flex-col/);
  });

  it("still shows the sets of a COMPLETED match", async () => {
    // The gap this found: liveSetView returns null once a match is not in
    // play, so a finished match reached the board with no sets on it at all —
    // exactly when every set matters most.
    mount([
      m({
        id: "done",
        status: "completed",
        sport: "table_tennis",
        set_scores: [[11, 8], [9, 11], [11, 6]],
        home_score: 2,
        away_score: 1,
      }),
    ]);
    await openBoard();

    const rows = screen.getByTestId("spotlight-set-rows");
    expect(rows.children).toHaveLength(3);
    // Nothing is in play, so nothing is flagged.
    expect(rows.querySelector("[data-live]")).toBeNull();
  });

  it("pairs each crest with its OWN score in one column", async () => {
    // Owner 2026-08-27: "the score and the logo in one column". A single
    // combined "11 - 7" in the middle belonged to neither badge, and the eye
    // had to work out which end went with which side.
    mount([m({ id: "done", status: "completed", home_score: 11, away_score: 7 })]);
    await openBoard();

    const crests = screen.getAllByTestId("team-crest-fallback");
    const scores = screen.getAllByTestId("spotlight-side-score");
    expect(crests).toHaveLength(2);
    expect(scores).toHaveLength(2);
    // Home badge and 11 share a column; away badge and 7 share the other.
    expect(crests[0]!.parentElement).toBe(scores[0]!.parentElement);
    expect(crests[1]!.parentElement).toBe(scores[1]!.parentElement);
    expect(scores[0]!).toHaveTextContent("11");
    expect(scores[1]!).toHaveTextContent("7");
    // The two columns sit either side of the middle, on one row.
    const row = crests[0]!.parentElement!.parentElement!;
    expect(row.className).toMatch(/grid-cols-\[1fr_auto_1fr\]/);
    expect(row).toContainElement(crests[1]!);
  });

  it("shows a kickoff instead of scores before a ball is played", async () => {
    // A column with a badge and a stray 0 would read as a result.
    mount([m({ id: "next", status: "scheduled" })]);
    await openBoard();

    expect(screen.queryAllByTestId("spotlight-side-score")).toEqual([]);
    expect(screen.getAllByTestId("team-crest-fallback")).toHaveLength(2);
  });

  it("moves to the next match on its own once the live one finishes", () => {
    // No timer and no stored state: the pick is derived, so the next payload
    // moves the board. This is "once done we will show the next match".
    const live = m({ id: "live", status: "live" });
    const then = m({ id: "then", scheduled_at: "2026-08-28T09:00:00Z" });
    const { rerender } = mount([live, then]);
    expect(screen.getByTestId("competition-spotlight")).toHaveAttribute("data-kind", "live");

    rerender(
      <MemoryRouter>
        <CompetitionSpotlight
          matches={[{ ...live, status: "completed", home_score: 2, away_score: 0 }, then]}
          timeZone="Asia/Kolkata"
        />
      </MemoryRouter>,
    );
    const s = screen.getByTestId("competition-spotlight");
    expect(s).toHaveAttribute("data-kind", "next");
    expect(s).toHaveTextContent("Up next");
  });
});
