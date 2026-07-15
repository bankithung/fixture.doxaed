import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  lensApi,
  type LensCampaignSummary,
  type LensOverview,
} from "@/api/lens";
import { LensCampaignListPage } from "../LensCampaignListPage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    lensApi: {
      ...actual.lensApi,
      campaigns: vi.fn(),
      overview: vi.fn(),
      create: vi.fn(),
    },
  };
});

function summary(over: Partial<LensCampaignSummary> & { id: string; title: string }): LensCampaignSummary {
  return {
    tagline: "36 Shots",
    instructions: "",
    consent_note: "",
    max_photos_per_institution: 36,
    award_categories: [],
    category_limits: {},
    is_open: true,
    opened_at: "2026-07-10T05:00:00Z",
    closed_at: null,
    photos_total: 0,
    photos_pending: 0,
    passes_active: 0,
    ...over,
  } as LensCampaignSummary;
}

const GATE: LensOverview = {
  campaign: null,
  fixtures_ready: true,
  stats: {
    institutions_total: 3,
    passes_active: 0,
    photos_total: 0,
    photos_pending: 0,
    photos_approved: 0,
    photos_hidden: 0,
  },
  passes: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/lens"]}>
          <Routes>
            <Route path="/tournaments/:id/lens" element={<LensCampaignListPage />} />
            <Route
              path="/tournaments/:id/lens/:campaignId"
              element={<div>console for campaign</div>}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lensApi.overview).mockResolvedValue(GATE);
  vi.mocked(lensApi.campaigns).mockResolvedValue({
    campaigns: [
      summary({ id: "c1", title: "36 Shots", photos_total: 12, photos_pending: 3 }),
      summary({ id: "c2", title: "Fun Fair", is_open: false }),
    ],
  });
  vi.mocked(lensApi.create).mockResolvedValue({
    campaign: summary({ id: "c3", title: "New One" }),
  });
});

describe("LensCampaignListPage", () => {
  it("lists every campaign as a card", async () => {
    mount();
    expect(await screen.findByTestId("lens-campaign-c1")).toHaveTextContent("36 Shots");
    expect(screen.getByTestId("lens-campaign-c2")).toHaveTextContent("Fun Fair");
    expect(screen.getByTestId("lens-campaign-c1")).toHaveTextContent("12");
  });

  it("creates a new campaign and navigates to its console", async () => {
    mount();
    await screen.findByTestId("lens-campaign-c1");

    await userEvent.click(screen.getByTestId("lens-new-campaign"));
    const title = await screen.findByTestId("new-campaign-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Prize Night");
    await userEvent.click(screen.getByTestId("new-campaign-create"));

    await waitFor(() => expect(lensApi.create).toHaveBeenCalledTimes(1));
    const [tid, body] = vi.mocked(lensApi.create).mock.calls[0];
    expect(tid).toBe("t1");
    expect(body.title).toBe("Prize Night");
    expect(body.event_id).toBeTruthy();
    // Navigated to the new campaign's console.
    expect(await screen.findByText("console for campaign")).toBeInTheDocument();
  });

  it("disables New campaign until fixtures exist", async () => {
    vi.mocked(lensApi.overview).mockResolvedValue({ ...GATE, fixtures_ready: false });
    vi.mocked(lensApi.campaigns).mockResolvedValue({ campaigns: [] });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("lens-new-campaign")).toBeDisabled(),
    );
    expect(screen.getByTestId("fixtures-hint")).toBeInTheDocument();
  });
});
