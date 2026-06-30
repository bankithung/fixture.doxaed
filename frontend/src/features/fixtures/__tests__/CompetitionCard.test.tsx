import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import type {
  MatchRow,
  ReadinessCheck,
  TeamRow,
} from "@/api/tournaments";
import { CompetitionCard } from "../CompetitionCard";
import type { Competition } from "../setupJourney";

function team(id: string): TeamRow {
  return {
    id, name: id, short_name: id, school: "S", pool: "", sport: "football",
    leaf_key: "football.u15", status: "registered", player_count: 7,
  } as TeamRow;
}

function match(over: Partial<MatchRow>): MatchRow {
  return {
    id: "m1", stage: "group", group_label: "A", round_no: 1, match_no: 1,
    status: "scheduled",
    home_team: { id: "a", name: "Alpha", short_name: "A" },
    away_team: { id: "b", name: "Bravo", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
    ...over,
  } as MatchRow;
}

function comp(
  checks: ReadinessCheck[],
  over: Partial<Competition> = {},
): Competition {
  return {
    leafKey: "football.u15",
    label: "Football · U15",
    sport: "football",
    teams: [team("a"), team("b")],
    matches: [],
    readiness: {
      leaf_key: "football.u15", label: "Football · U15",
      ready: !checks.some((c) => c.status === "fail"),
      summary: "3/5", checks,
    },
    ...over,
  };
}

function mount(
  competition: Competition,
  over: Partial<Parameters<typeof CompetitionCard>[0]> = {},
) {
  const onAction = vi.fn();
  const onToggleDetail = vi.fn();
  const onFix = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <CompetitionCard
            competition={competition}
            drawFormat=""
            tournamentId="t1"
            canManage
            canRepair
            kept={false}
            detailOpen={false}
            fixable={new Set(["teams", "venues"])}
            onToggleDetail={onToggleDetail}
            onAction={onAction}
            onFix={onFix}
            {...over}
          />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onAction, onToggleDetail, onFix };
}

describe("CompetitionCard", () => {
  it("ready: one sentence, ONE primary (legacy generate testid) and a quiet format link", async () => {
    const { onAction } = mount(comp([]));
    expect(screen.getByText("Ready to preview.")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    const primary = screen.getByTestId("generate-football.u15");
    expect(primary).toHaveTextContent("Preview the draw");
    await userEvent.click(primary);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "preview" }),
    );
    // capability kept: Step 2 stays reachable from a ready card
    await userEvent.click(screen.getByTestId("change-format-football.u15"));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "format" }),
    );
  });

  it("globalsUnset demotes a ready card: Step 1 sentence + Open Step 1, never Preview", async () => {
    const { onAction } = mount(comp([]), { globalsUnset: true });
    expect(
      screen.getByText("Finish Step 1 (dates and venues) first."),
    ).toBeInTheDocument();
    expect(screen.getByText("Action needed")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText(/Ready to preview/)).toBeNull();
    const primary = screen.getByTestId("card-action-football.u15");
    expect(primary).toHaveTextContent("Open Step 1");
    await userEvent.click(primary);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "step1" }),
    );
  });

  it("format warn: quiet note with an inline Choose format button (primary stays preview)", async () => {
    const { onAction } = mount(comp([{ id: "format_chosen", status: "warn" }]));
    expect(
      screen.getByText(/No format picked. League used by default./),
    ).toBeInTheDocument();
    expect(screen.getByTestId("generate-football.u15")).toBeInTheDocument();
    expect(screen.queryByTestId("change-format-football.u15")).toBeNull();
    await userEvent.click(screen.getByTestId("choose-format-football.u15"));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "format" }),
    );
  });

  it("blocked: no raw summary badge; checklist only behind See what's missing", async () => {
    const blocked = comp(
      [{ id: "enough_teams", status: "fail", hint: "0 registered", fix: "teams" }],
      { teams: [] },
    );
    const { onToggleDetail } = mount(blocked);
    expect(
      screen.getByText("0 of 2 teams. Needs 2 to draw."),
    ).toBeInTheDocument();
    // the n/5 badge is gone from the card face
    expect(screen.queryByText("3/5")).toBeNull();
    expect(screen.queryByText("Teams registered")).toBeNull();
    await userEvent.click(screen.getByTestId("whats-missing-football.u15"));
    expect(onToggleDetail).toHaveBeenCalled();
  });

  it("blocked + open: renders the checklist detail with Fix deep-links and the hint", async () => {
    const blocked = comp(
      [{ id: "enough_teams", status: "fail", hint: "0 registered", fix: "teams" }],
      { teams: [] },
    );
    const { onFix } = mount(blocked, { detailOpen: true });
    expect(screen.getByText("Teams registered")).toBeInTheDocument();
    expect(screen.getByText("3 of 5 checks passed")).toBeInTheDocument();
    expect(
      screen.getByText("Fix the items marked above, then you can preview the draw."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fix this" }));
    expect(onFix).toHaveBeenCalledWith("teams", "football.u15");
  });

  it("drawn: sentence + View matches toggle; the body holds the read-only result card", async () => {
    const drawn = comp([], {
      matches: [match({ scheduled_at: "2026-06-20T09:00:00" })],
    });
    const { onToggleDetail } = mount(drawn);
    expect(
      screen.getByText("1 match over 1 day."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("competition-result-card")).toBeNull();
    await userEvent.click(
      screen.getByTestId("card-link-view_matches-football.u15"),
    );
    expect(onToggleDetail).toHaveBeenCalled();

    mount(drawn, { detailOpen: true });
    expect(screen.getByTestId("competition-result-card")).toBeInTheDocument();
  });

  it("drawn + knockout matches: the body offers View bracket", () => {
    const drawn = comp([], {
      matches: [match({ stage: "knockout", group_label: "" })],
    });
    mount(drawn, { detailOpen: true });
    expect(screen.getByTestId("view-bracket-football.u15")).toHaveAttribute(
      "href",
      "/tournaments/t1/bracket",
    );
  });

  it("D2 drift: the banner replaces the sentence; Keep routes the dismissal", async () => {
    const stale = comp([{ id: "already_generated", status: "warn" }], {
      matches: [match({})],
    });
    const { onAction } = mount(stale);
    expect(screen.getByTestId("inputs-changed-banner")).toBeInTheDocument();
    expect(screen.queryByText(/no times yet/)).toBeNull();
    await userEvent.click(screen.getByTestId("keep-draw"));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "keep" }),
    );
    await userEvent.click(screen.getByTestId("re-preview"));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "preview" }),
    );
  });

  it("viewers see the sentence but no manage verbs and no drift banner", () => {
    const stale = comp([{ id: "already_generated", status: "warn" }], {
      matches: [match({})],
    });
    mount(stale, { canManage: false });
    expect(screen.queryByTestId("inputs-changed-banner")).toBeNull();
    expect(screen.getByText("1 match drawn, no times yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("card-link-adjust_schedule-football.u15")).toBeNull();
    mount(comp([]), { canManage: false });
    expect(screen.queryByTestId("generate-football.u15")).toBeNull();
  });
});
