import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  lensApi,
  type LensCampaign,
  type LensOverview,
  type LensPhoto,
} from "@/api/lens";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { LensConsolePage } from "../LensConsolePage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    lensApi: {
      ...actual.lensApi,
      overview: vi.fn(),
      open: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
      reopen: vi.fn(),
      shareCard: vi.fn(),
      issueCodes: vi.fn(),
      rotate: vi.fn(),
      revoke: vi.fn(),
      photos: vi.fn(),
      approve: vi.fn(),
      hide: vi.fn(),
      award: vi.fn(),
    },
  };
});

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      get: vi.fn(),
    },
  };
});

const CAMPAIGN: LensCampaign = {
  id: "c1",
  title: "Guest Lens",
  tagline: "36 Shots Challenge",
  instructions: "Scan and upload.",
  consent_note: "Photos may be used for highlights.",
  max_photos_per_institution: 36,
  award_categories: ["Best Team Spirit", "Best Action Shot"],
  category_limits: {},
  is_open: true,
  opened_at: "2026-07-10T05:00:00Z",
  closed_at: null,
  share_minted_at: null,
};

const OVERVIEW: LensOverview = {
  campaign: CAMPAIGN,
  fixtures_ready: true,
  stats: {
    institutions_total: 3,
    passes_active: 2,
    photos_total: 5,
    photos_pending: 2,
    photos_approved: 3,
    photos_hidden: 0,
  },
  passes: [
    {
      id: "p1",
      institution_id: "i1",
      institution_name: "Grace School",
      is_active: true,
      has_code: false,
      photos_used: 4,
      last_minted_at: "2026-07-10T06:00:00Z",
    },
  ],
};

function photo(over: Partial<LensPhoto> & { id: string }): LensPhoto {
  return {
    upload_ref: `ref-${over.id}`,
    institution_id: "i1",
    institution_name: "Grace School",
    caption: "",
    category: "",
    url: `/media/lens_photos/c1/${over.id}.jpg`,
    thumb_url: `/media/lens_photos/c1/${over.id}_t.jpg`,
    width: 1600,
    height: 1200,
    size: 250_000,
    status: "pending",
    hidden_reason: "",
    award_category: "",
    created_at: "2026-07-10T07:00:00Z",
    ...over,
  };
}

const CARD = {
  campaign_id: "c1",
  title: "Guest Lens",
  tagline: "36 Shots Challenge",
  join_url: "https://fixture.doxaed.com/lens/join/tok123",
  token: "tok123",
  qr_data_uri: "data:image/png;base64,abc123",
};

const CODE = {
  pass_id: "p1",
  institution_id: "i1",
  institution_name: "Grace School",
  code: "MK4TQ9RB",
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/lens/c1"]}>
          <Routes>
            <Route
              path="/tournaments/:id/lens/:campaignId"
              element={<LensConsolePage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lensApi.overview).mockResolvedValue(OVERVIEW);
  vi.mocked(lensApi.photos).mockResolvedValue({ photos: [] });
  vi.mocked(lensApi.open).mockResolvedValue({ campaign: CAMPAIGN });
  vi.mocked(lensApi.update).mockResolvedValue({ campaign: CAMPAIGN });
  vi.mocked(lensApi.shareCard).mockResolvedValue({ card: CARD });
  vi.mocked(lensApi.issueCodes).mockResolvedValue({ codes: [CODE], skipped: 0 });
  vi.mocked(lensApi.approve).mockResolvedValue({
    photo: photo({ id: "ph1", status: "approved" }),
  });
  vi.mocked(lensApi.hide).mockResolvedValue({
    photo: photo({ id: "ph1", status: "hidden" }),
  });
  vi.mocked(lensApi.award).mockResolvedValue({
    photo: photo({ id: "ph1", status: "approved", award_category: "Best Action Shot" }),
  });
  vi.mocked(tournamentsApi.get).mockResolvedValue({
    id: "t1",
    slug: "nagaland-cup",
    name: "Nagaland Schools Cup",
  } as unknown as Tournament);
});

describe("LensConsolePage", () => {
  it("saves a per-school category limit from the settings form", async () => {
    mount();

    // Settings is no longer the default tab — a running campaign opens on
    // Moderate — so open it first.
    await userEvent.click(await screen.findByTestId("lens-tab-campaign"));
    const limitInput = await screen.findByTestId("limit-Best Action Shot");
    await userEvent.type(limitInput, "10");
    await userEvent.click(screen.getByTestId("save-settings-btn"));

    await waitFor(() => expect(lensApi.update).toHaveBeenCalledTimes(1));
    // Now (tid, campaignId, body) — the console is scoped to a campaign id.
    const [tid, campaignId, body] = vi.mocked(lensApi.update).mock.calls[0];
    expect(tid).toBe("t1");
    expect(campaignId).toBe("c1");
    expect(body.category_limits).toEqual({ "Best Action Shot": 10 });
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });

  it("drops a category's limit when the category is removed", async () => {
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-campaign"));
    await userEvent.type(
      await screen.findByTestId("limit-Best Action Shot"),
      "10",
    );
    await userEvent.click(
      screen.getByLabelText("Remove category Best Action Shot"),
    );
    await userEvent.click(screen.getByTestId("save-settings-btn"));

    await waitFor(() => expect(lensApi.update).toHaveBeenCalledTimes(1));
    const [, , body] = vi.mocked(lensApi.update).mock.calls[0];
    expect(body.award_categories).toEqual(["Best Team Spirit"]);
    expect(body.category_limits).toEqual({});
  });

  it("approves a photo from the moderation lightbox and toasts", async () => {
    vi.mocked(lensApi.photos).mockResolvedValue({
      photos: [photo({ id: "ph1" }), photo({ id: "ph2" })],
    });
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-moderate"));
    await userEvent.click(await screen.findByTestId("photo-ph1"));
    await userEvent.click(await screen.findByTestId("approve-btn"));

    await waitFor(() => expect(lensApi.approve).toHaveBeenCalledTimes(1));
    const [tid, photoId, body] = vi.mocked(lensApi.approve).mock.calls[0];
    expect(tid).toBe("t1");
    expect(photoId).toBe("ph1");
    expect(body.event_id).toBeTruthy();
    expect(await screen.findByText("Photo approved")).toBeInTheDocument();
  });

  it("hides a photo with an optional reason", async () => {
    vi.mocked(lensApi.photos).mockResolvedValue({
      photos: [photo({ id: "ph1" })],
    });
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-moderate"));
    await userEvent.click(await screen.findByTestId("photo-ph1"));
    await userEvent.click(await screen.findByTestId("hide-btn"));
    await userEvent.type(
      screen.getByLabelText("Reason (optional)"),
      "not an event photo",
    );
    await userEvent.click(screen.getByTestId("confirm-hide-btn"));

    await waitFor(() => expect(lensApi.hide).toHaveBeenCalledTimes(1));
    const [, photoId, body] = vi.mocked(lensApi.hide).mock.calls[0];
    expect(photoId).toBe("ph1");
    expect(body.reason).toBe("not an event photo");
    expect(await screen.findByText("Photo hidden")).toBeInTheDocument();
  });

  it("mints ONE card for the event and prints it with the join link", async () => {
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-cards"));
    await userEvent.click(await screen.findByTestId("mint-share-card-btn"));

    await waitFor(() => expect(lensApi.shareCard).toHaveBeenCalledTimes(1));
    await screen.findByTestId("share-card");
    const qr = screen.getByAltText(/QR code opening the photo upload page/);
    expect(qr).toHaveAttribute("src", "data:image/png;base64,abc123");
    expect(screen.getByTestId("copy-share-link")).toBeInTheDocument();
    expect(screen.getByTestId("print-cards-btn")).toBeInTheDocument();
    // One card, not one per school: no per-school QR anywhere on the sheet.
    expect(screen.getAllByAltText(/QR code/)).toHaveLength(1);
  });

  it("issues per-school codes and shows each one exactly once", async () => {
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-cards"));
    await userEvent.click(await screen.findByTestId("issue-codes-btn"));

    await waitFor(() => expect(lensApi.issueCodes).toHaveBeenCalledTimes(1));
    // The slip a school gets handed, and the same code in its table row.
    expect(await screen.findByTestId("code-slip-p1")).toHaveTextContent(
      "MK4TQ9RB",
    );
    expect(screen.getByTestId("copy-code-MK4TQ9RB")).toBeInTheDocument();
    // A re-run for newcomers must not wipe the codes already on screen.
    vi.mocked(lensApi.issueCodes).mockResolvedValue({ codes: [], skipped: 1 });
    await userEvent.click(screen.getByTestId("issue-codes-btn"));
    await waitFor(() => expect(lensApi.issueCodes).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("code-slip-p1")).toBeInTheDocument();
  });

  it("assigns an award winner from the approved picker", async () => {
    vi.mocked(lensApi.photos).mockResolvedValue({
      photos: [photo({ id: "ph1", status: "approved" })],
    });
    mount();

    await userEvent.click(await screen.findByTestId("lens-tab-awards"));
    await userEvent.click(
      await screen.findByTestId("choose-winner-Best Action Shot"),
    );
    await userEvent.click(await screen.findByTestId("pick-ph1"));

    await waitFor(() => expect(lensApi.award).toHaveBeenCalledTimes(1));
    const [, photoId, body] = vi.mocked(lensApi.award).mock.calls[0];
    expect(photoId).toBe("ph1");
    expect(body.category).toBe("Best Action Shot");
    expect(await screen.findByText("Winner chosen")).toBeInTheDocument();
  });
});
