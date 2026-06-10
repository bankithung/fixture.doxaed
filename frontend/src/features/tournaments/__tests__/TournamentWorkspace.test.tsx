import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentWorkspace } from "../TournamentWorkspace";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";

vi.mock("@/api/tournaments");

const ORDER = [
  "setup",
  "org_registration",
  "team_registration",
  "members",
  "fixtures",
  "ready",
];
const LABELS: Record<string, string> = {
  setup: "Setup",
  org_registration: "Institution registration",
  team_registration: "Team registration",
  members: "Members & roles",
  fixtures: "Fixtures",
  ready: "Ready",
};

function stagePayload(current: string) {
  const curIdx = ORDER.indexOf(current);
  return {
    stage: current,
    status: "published",
    order: ORDER,
    allowed_to: [],
    can_manage: true,
    modules: [],
    rules_frozen_at: null,
    stages: ORDER.map((key, i) => ({
      key,
      label: LABELS[key],
      state: i < curIdx ? "complete" : i === curIdx ? "current" : "upcoming",
      entered_at: null,
      reopened_count: 0,
      form: null,
      counts: {},
    })),
  };
}

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tournaments/:id" element={<TournamentWorkspace />}>
              <Route path="forms" element={<div>FORMS PAGE</div>} />
              <Route path="institutions" element={<div>INSTITUTIONS PAGE</div>} />
              <Route path="sports" element={<div>SPORTS PAGE</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tournamentsApi.get).mockResolvedValue({
    id: "t1",
    name: "Anpsa",
    status: "published",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stagePayload("org_registration") as any,
  );
});

describe("TournamentWorkspace stage stepper", () => {
  it("the CURRENT stage chip navigates to its work page from a sub-page", async () => {
    renderAt("/tournaments/t1/forms");
    await screen.findByText("FORMS PAGE");

    // On the Forms sub-page, the current stage chip is a button back to the
    // stage's main page (Institutions).
    await userEvent.click(
      await screen.findByRole("button", { name: /Institution registration/ }),
    );
    expect(await screen.findByText("INSTITUTIONS PAGE")).toBeInTheDocument();
  });

  it("the current chip is inert when already on the stage's own page", async () => {
    renderAt("/tournaments/t1/institutions");
    await screen.findByText("INSTITUTIONS PAGE");

    await screen.findByText("Institution registration"); // chip rendered…
    expect(
      screen.queryByRole("button", { name: /Institution registration/ }),
    ).toBeNull(); // …but not as a button
  });

  it("earlier (completed) stages stay clickable too", async () => {
    renderAt("/tournaments/t1/forms");
    await screen.findByText("FORMS PAGE");

    await userEvent.click(
      await screen.findByRole("button", { name: /Setup/ }),
    );
    expect(await screen.findByText("SPORTS PAGE")).toBeInTheDocument();
  });

  it("future stages are not clickable", async () => {
    renderAt("/tournaments/t1/forms");
    await screen.findByText("FORMS PAGE");
    await screen.findByText("Fixtures"); // upcoming chip rendered…
    expect(screen.queryByRole("button", { name: /Fixtures/ })).toBeNull();
  });
});
