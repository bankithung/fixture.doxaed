import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type FixtureVersion } from "@/api/tournaments";
import { FixtureVersionsPage } from "../FixtureVersionsPage";

/** Fixture versions: the way back to a fixture that has since been redrawn.
 * The page's whole job is that the newest one is not offered a Restore button
 * (it IS the fixture), and that restoring asks first. */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      fixtureVersions: vi.fn(),
      fixtureVersion: vi.fn(),
      saveFixtureVersion: vi.fn(),
      restoreFixtureVersion: vi.fn(),
    },
  };
});

function version(over: Partial<FixtureVersion> = {}): FixtureVersion {
  return {
    id: "v1",
    kind: "generated",
    kind_label: "Fixture generated",
    label: "Drew all competitions",
    match_count: 91,
    summary: { competition_count: 10, days: ["2026-08-28", "2026-08-29"], played: 0 },
    created_at: "2026-08-21T04:00:00Z",
    created_by: { id: "u1", email: "organiser@test.local" },
    ...over,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/fixtures/versions"]}>
          <Routes>
            <Route
              path="/tournaments/:id/fixtures/versions"
              element={<FixtureVersionsPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.fixtureVersions).mockResolvedValue({
    versions: [
      version({ id: "newest", label: "after the re-group", created_at: "2026-08-21T08:00:00Z" }),
      version({ id: "older", kind: "scheduled", kind_label: "Schedule run", label: "first draw" }),
    ],
  });
});

describe("FixtureVersionsPage", () => {
  it("lists every fixture newest first, and only the newest is 'current'", async () => {
    mount();
    const table = await screen.findByTestId("versions-table");
    const rows = within(table).getAllByTestId(/^version-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "version-newest",
      "version-older",
    ]);
    expect(rows[0]!).toHaveTextContent("current");
    expect(rows[0]!).toHaveTextContent("after the re-group");
    expect(rows[1]!).toHaveTextContent("Schedule run");
    expect(rows[0]!).toHaveTextContent("91");
  });

  it("offers no Restore on the fixture that IS the current one", async () => {
    mount();
    await screen.findByTestId("versions-table");
    // Restoring the fixture you already have is a no-op dressed as an action.
    expect(screen.queryByTestId("restore-newest")).toBeNull();
    expect(screen.getByTestId("restore-older")).toBeInTheDocument();
  });

  it("asks before restoring, and only then calls the server", async () => {
    vi.mocked(tournamentsApi.restoreFixtureVersion).mockResolvedValue({
      ok: true,
      restored: 91,
      created: 0,
      removed: 2,
    });
    mount();
    await screen.findByTestId("versions-table");
    await userEvent.click(screen.getByTestId("restore-older"));
    // The confirm names what is about to happen; nothing has been sent yet.
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Restore this fixture?",
    );
    expect(tournamentsApi.restoreFixtureVersion).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("confirm-restore"));
    await waitFor(() =>
      expect(tournamentsApi.restoreFixtureVersion).toHaveBeenCalledWith("older"),
    );
    expect(await screen.findByText("Fixture restored")).toBeInTheDocument();
  });

  it("says why when the server refuses a restore", async () => {
    vi.mocked(tournamentsApi.restoreFixtureVersion).mockRejectedValue({
      data: { detail: "3 match(es) already have a result." },
    });
    mount();
    await screen.findByTestId("versions-table");
    await userEvent.click(screen.getByTestId("restore-older"));
    await userEvent.click(await screen.findByTestId("confirm-restore"));
    expect(
      await screen.findByText("3 match(es) already have a result."),
    ).toBeInTheDocument();
  });

  it("opens one version in full without restoring it", async () => {
    vi.mocked(tournamentsApi.fixtureVersion).mockResolvedValue(
      version({
        id: "older",
        matches: [
          {
            id: "m1", stage: "group", stage_no: 0, group_label: "Group A",
            round_no: 1, match_no: 1, home_team_id: "a", away_team_id: "b",
            home_source: null, away_source: null, status: "scheduled",
            home_score: null, away_score: null, leaf_key: "sepak_takraw.u_14.boys",
            scheduled_at: "2026-08-28T03:30:00Z", venue: "Mph · T1",
          },
        ],
      }),
    );
    mount();
    await screen.findByTestId("versions-table");
    await userEvent.click(screen.getByTestId("view-older"));
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByTestId("version-leaf-sepak_takraw.u_14.boys"),
    ).toBeInTheDocument();
    expect(drawer).toHaveTextContent("Mph · T1");
    expect(drawer).toHaveTextContent("Group A");
    expect(tournamentsApi.restoreFixtureVersion).not.toHaveBeenCalled();
  });

  it("saves the current fixture under a name", async () => {
    vi.mocked(tournamentsApi.saveFixtureVersion).mockResolvedValue(version());
    mount();
    await screen.findByTestId("versions-table");
    await userEvent.type(screen.getByTestId("version-label"), "before I fiddle");
    await userEvent.click(screen.getByTestId("save-version"));
    await waitFor(() =>
      expect(tournamentsApi.saveFixtureVersion).toHaveBeenCalledWith(
        "t1",
        "before I fiddle",
      ),
    );
  });
});
