import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentWorkspace } from "../TournamentWorkspace";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";

vi.mock("@/api/tournaments");

const BASE_ORDER = [
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
  house_setup: "Houses & members",
  team_registration: "Team registration",
  members: "Members & roles",
  fixtures: "Fixtures",
  ready: "Ready",
};

// A within-school event swaps institution registration for house setup; the
// server's `order` is the one list, so the screen follows it.
const INTRA_ORDER = [
  "setup",
  "house_setup",
  "team_registration",
  "members",
  "fixtures",
  "ready",
];

function stagePayload(
  current: string,
  opts: { order?: string[]; allowedTo?: string[] } = {},
) {
  const ORDER = opts.order ?? BASE_ORDER;
  const curIdx = ORDER.indexOf(current);
  return {
    stage: current,
    status: "published",
    order: ORDER,
    allowed_to: opts.allowedTo ?? [],
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
              <Route path="houses" element={<div>HOUSES PAGE</div>} />
              <Route path="teams" element={<div>TEAMS PAGE</div>} />
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

describe("within-school flow", () => {
  // The Houses page is stage two of a sports day. It carries the flow's
  // Continue control like every other stage work page — it had none, because
  // the page was missing from TAB_DEFS and so never counted as a `flowPage`,
  // which left an admin who had named their houses with no way forward.
  it("the Houses page offers Continue to the next stage", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue(
      stagePayload("house_setup", {
        order: INTRA_ORDER,
        allowedTo: ["team_registration"],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
    renderAt("/tournaments/t1/houses");
    await screen.findByText("HOUSES PAGE");

    expect(
      await screen.findByRole("button", { name: /Continue/ }),
    ).toBeInTheDocument();
    // …and it names where it goes (the stage strip also lists the label, so
    // anchor on the Continue card's own copy).
    expect(await screen.findByText(/Done with this step\?/)).toBeInTheDocument();
  });

  it("the mobile stage strip can reach the Houses page", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue(
      stagePayload("house_setup", {
        order: INTRA_ORDER,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
    renderAt("/tournaments/t1/sports");
    await screen.findByText("SPORTS PAGE");

    // Reached stages are tappable chips; house_setup was inert because the
    // workspace's own STAGE_ROUTE had no entry for it.
    await userEvent.click(
      await screen.findByRole("button", { name: /Houses & members/ }),
    );
    expect(await screen.findByText("HOUSES PAGE")).toBeInTheDocument();
  });

  it("does not lock the Houses page behind its own stage", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue(
      stagePayload("house_setup", {
        order: INTRA_ORDER,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
    renderAt("/tournaments/t1/houses");
    expect(await screen.findByText("HOUSES PAGE")).toBeInTheDocument();
    expect(screen.queryByText(/isn't active yet/)).toBeNull();
  });
});
