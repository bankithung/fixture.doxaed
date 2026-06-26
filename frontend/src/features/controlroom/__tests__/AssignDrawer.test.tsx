import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { AssignDrawer } from "../AssignDrawer";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      members: vi.fn(),
      assignOfficial: vi.fn(),
      removeOfficial: vi.fn(),
      assignScorer: vi.fn(),
    },
  };
});

const MATCH = {
  id: "m1",
  stage: "group",
  group_label: "Group A",
  round_no: 1,
  match_no: 1,
  status: "scheduled",
  home_team: { id: "th", name: "Alpha", short_name: "ALP" },
  away_team: { id: "ta", name: "Bravo", short_name: "BRA" },
  home_score: null,
  away_score: null,
  sport: "",
  set_scores: [],
  leaf_key: "football.u15",
  venue: "Main",
  scoring: null,
  scheduled_at: "2026-06-20T03:30:00Z",
  locked_at: null,
  leaf_label: "Football U15",
  scorer: null,
  officials: [
    { id: "o1", user_id: "u9", name: "Ref Roy", role: "referee", status: "assigned" },
  ],
} as ControlRoomMatch;

function mount(match: ControlRoomMatch = MATCH) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AssignDrawer tournamentId="t1" match={match} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.members).mockResolvedValue([
    {
      id: "mem1",
      user_id: "u1",
      email: "alice@x.io",
      full_name: "Alice",
      role: "referee",
      status: "active",
      assigned_at: "2026-06-01T00:00:00Z",
    },
  ]);
  vi.mocked(tournamentsApi.assignOfficial).mockResolvedValue({
    officials: MATCH.officials,
    warning: null,
  });
  vi.mocked(tournamentsApi.removeOfficial).mockResolvedValue({ officials: [] });
});

describe("AssignDrawer", () => {
  it("lists current officials and assigns a new one", async () => {
    mount();
    // Existing official shows.
    expect(within(screen.getByTestId("official-o1")).getByText("Ref Roy")).toBeInTheDocument();

    // Pick a person (role defaults to referee) and add.
    await userEvent.click(await screen.findByRole("button", { name: /person/i }));
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await userEvent.click(screen.getByTestId("add-official"));

    await waitFor(() =>
      expect(tournamentsApi.assignOfficial).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({ user_id: "u1", role: "referee" }),
      ),
    );
  });

  it("removes an official", async () => {
    mount();
    await userEvent.click(
      within(screen.getByTestId("official-o1")).getByRole("button", {
        name: /remove/i,
      }),
    );
    await waitFor(() =>
      expect(tournamentsApi.removeOfficial).toHaveBeenCalledWith("m1", "o1"),
    );
  });

  it("assigns the scorer seat", async () => {
    vi.mocked(tournamentsApi.assignScorer).mockResolvedValue(MATCH);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^scorer$/i }));
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await waitFor(() =>
      expect(tournamentsApi.assignScorer).toHaveBeenCalledWith("m1", "u1"),
    );
  });
});
