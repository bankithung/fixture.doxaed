import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentRoster } from "@/api/tournaments";
import { ParticipantsPage } from "../ParticipantsPage";

/**
 * The participants console (spec 2026-08-17). Its reason to exist is the one
 * column a team list cannot have: every competition a person ended up in — the
 * owner's "we can see if one student is in multiple sports".
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      roster: vi.fn(),
      declareParticipant: vi.fn(),
      withdrawParticipant: vi.fn(),
    },
  };
});

const MEMBER = {
  id: "m1",
  full_name: "Imli Jamir",
  kind: "student" as const,
  class_section: "9-B",
  roll_no: "21",
  gender: "",
  date_of_birth: "2012-03-04",
  contact_email: "",
  contact_phone: "",
  attributes: {},
  institution: { id: "i1", name: "Grace School" },
  group: null,
  entries: [
    { team_id: "t1", team: "Grace TT", leaf_key: "table_tennis.u14.boys", role: "player" },
    { team_id: "t2", team: "Grace Sepak", leaf_key: "sepak.u14.boys", role: "player" },
  ],
};

const DATA: TournamentRoster = {
  can_manage: true,
  roster_mode: "roster_first",
  scope: "inter_school",
  group_kind: "",
  counts: { students: 2, teachers: 1, multi_entry: 1 },
  members: [
    MEMBER,
    {
      ...MEMBER,
      id: "m2",
      full_name: "Toshi Ao",
      roll_no: "22",
      entries: [],
    },
    {
      ...MEMBER,
      id: "m3",
      full_name: "Mr Ao",
      kind: "teacher" as const,
      class_section: "",
      roll_no: "",
      entries: [
        {
          team_id: "t1",
          team: "Grace TT",
          leaf_key: "table_tennis.u14.boys",
          role: "in_charge",
        },
      ],
    },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/participants"]}>
          <Routes>
            <Route
              path="/tournaments/:id/participants"
              element={<ParticipantsPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.roster).mockResolvedValue(DATA);
});

describe("ParticipantsPage", () => {
  it("shows every competition a person ended up in", async () => {
    mount();

    const row = await screen.findByTestId("participant-m1");
    expect(within(row).getByText("Table Tennis · U14 · Boys")).toBeInTheDocument();
    expect(within(row).getByText("Sepak · U14 · Boys")).toBeInTheDocument();
    // A person in two competitions is marked, because that is the row the draw
    // has to keep apart.
    expect(row).toHaveAttribute("data-multi");
    expect(screen.getByTestId("participant-m2")).not.toHaveAttribute("data-multi");
  });

  it("says plainly when someone is on no team yet", async () => {
    mount();
    const row = await screen.findByTestId("participant-m2");
    expect(within(row).getByText("Not on a team yet")).toBeInTheDocument();
  });

  it("counts the people committed to more than one competition", async () => {
    mount();
    const counts = await screen.findByTestId("roster-counts");
    const multi = within(counts).getByText("in more than one").closest("li");
    expect(multi).toHaveTextContent("1");
    expect(within(counts).getByText("students").closest("li")).toHaveTextContent(
      "2",
    );
  });

  it("marks a teacher as one, so a class column reads correctly", async () => {
    mount();
    const row = await screen.findByTestId("participant-m3");
    expect(within(row).getByText("Teacher")).toBeInTheDocument();
  });

  it("filters by kind through the server, not by hiding rows", async () => {
    mount();
    await screen.findByTestId("participant-m1");

    await userEvent.click(screen.getByLabelText("Filter by kind"));
    await userEvent.click(screen.getByRole("option", { name: "Teachers" }));

    expect(vi.mocked(tournamentsApi.roster)).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ kind: "teacher" }),
    );
  });

  it("lets an organizer declare somebody by hand", async () => {
    vi.mocked(tournamentsApi.declareParticipant).mockResolvedValue(MEMBER);
    mount();
    await screen.findByTestId("participant-m1");

    await userEvent.type(screen.getByLabelText("Full name"), "New Child");
    await userEvent.type(screen.getByLabelText("Class & section"), "8-A");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(vi.mocked(tournamentsApi.declareParticipant)).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ full_name: "New Child", class_section: "8-A" }),
    );
  });

  it("withdraws a participant", async () => {
    vi.mocked(tournamentsApi.withdrawParticipant).mockResolvedValue(undefined);
    mount();
    await screen.findByTestId("participant-m2");

    await userEvent.click(screen.getByLabelText("Withdraw Toshi Ao"));
    expect(vi.mocked(tournamentsApi.withdrawParticipant)).toHaveBeenCalledWith(
      "t1",
      "m2",
    );
  });

  it("hides every write control from a member who cannot manage", async () => {
    vi.mocked(tournamentsApi.roster).mockResolvedValue({
      ...DATA,
      can_manage: false,
    });
    mount();
    await screen.findByTestId("participant-m1");

    expect(screen.queryByLabelText("Full name")).toBeNull();
    expect(screen.queryByLabelText("Withdraw Imli Jamir")).toBeNull();
  });

  it("explains an empty list differently from an empty filter", async () => {
    vi.mocked(tournamentsApi.roster).mockResolvedValue({
      ...DATA,
      counts: { students: 0, teachers: 0, multi_entry: 0 },
      members: [],
    });
    mount();

    expect(
      await screen.findByText("Nobody has been entered yet"),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("Search participants"),
      "zz",
    );
    expect(await screen.findByText("Nobody matches that")).toBeInTheDocument();
  });
});
