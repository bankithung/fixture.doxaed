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
