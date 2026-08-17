import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentRoster } from "@/api/tournaments";
import { ParticipantsPage } from "../ParticipantsPage";

/**
 * The participants route is READ-ONLY (owner 2026-08-17: "the students will be
 * added by the institutes, not the host, so no need of the add — we will go
 * for view only"). The people arrive on the school's own team form, so a
 * host-side add box was a second, competing way to create the same person.
 *
 * It renders the same workbench the Team registration page embeds, so there is
 * one list rather than two that can disagree.
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, roster: vi.fn() },
  };
});

const DATA = {
  can_manage: true,
  roster_mode: "roster_first",
  scope: "inter_school",
  group_kind: "",
  counts: { students: 1, teachers: 0, multi_entry: 1 },
  members: [
    {
      id: "m1",
      full_name: "Imli Jamir",
      kind: "student" as const,
      class_section: "9-B",
      roll_no: "21",
      gender: "",
      date_of_birth: null,
      contact_email: "",
      contact_phone: "",
      attributes: {},
      institution: { id: "i1", name: "Grace School" },
      group: null,
      entries: [
        {
          team_id: "t1",
          team: "Grace TT",
          leaf_key: "table_tennis.u14.boys",
          role: "player",
        },
        {
          team_id: "t2",
          team: "Grace Sepak",
          leaf_key: "sepak.u14.boys",
          role: "player",
        },
      ],
    },
  ],
} as unknown as TournamentRoster;

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
  it("lists everyone the schools entered, with the competitions each is in", async () => {
    mount();
    const row = await screen.findByTestId("participation-m1");
    expect(row).toHaveTextContent("Imli Jamir");
    expect(row).toHaveTextContent("Grace School");
    expect(row).toHaveTextContent("Table Tennis");
    expect(row).toHaveTextContent("Sepak");
    // In two events, so the draw has to keep them apart.
    expect(row).toHaveAttribute("data-multi");
  });

  it("offers no way for the host to add or withdraw a person", async () => {
    mount();
    await screen.findByTestId("participation-m1");
    // The school owns its own list; the host reads it.
    expect(screen.queryByLabelText("Full name")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add participant/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Withdraw/ })).toBeNull();
  });
});
