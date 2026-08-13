import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { lensApi, type PublicAlbum } from "@/api/lens";
import { PublicAlbumPage } from "../PublicAlbumPage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    lensApi: {
      ...actual.lensApi,
      publicAlbum: vi.fn(),
    },
  };
});

const ALBUM: PublicAlbum = {
  campaign: { title: "Guest Lens", tagline: "36 Shots Challenge" },
  award_categories: ["Best Team Spirit", "Best Action Shot"],
  institutions: [
    { id: "i1", name: "Grace School", count: 2 },
    { id: "i2", name: "Pine Academy", count: 1 },
  ],
  photos: [
    {
      upload_ref: "r1",
      url: "/media/lens_photos/c1/r1.jpg",
      thumb_url: "/media/lens_photos/c1/r1_t.jpg",
      institution_name: "Grace School",
      caption: "Kickoff",
      category: "Best Action Shot",
      award_category: "Best Action Shot",
      created_at: "2026-07-10T08:00:00Z",
    },
    {
      upload_ref: "r2",
      url: "/media/lens_photos/c1/r2.jpg",
      thumb_url: "/media/lens_photos/c1/r2_t.jpg",
      institution_name: "Grace School",
      caption: "",
      category: "Best Team Spirit",
      award_category: "",
      created_at: "2026-07-10T07:30:00Z",
    },
    {
      upload_ref: "r3",
      url: "/media/lens_photos/c1/r3.jpg",
      thumb_url: "/media/lens_photos/c1/r3_t.jpg",
      institution_name: "Pine Academy",
      caption: "",
      category: "",
      award_category: "",
      created_at: "2026-07-10T07:00:00Z",
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
        <MemoryRouter initialEntries={["/t/nagaland-cup/t1/album"]}>
          <Routes>
            <Route path="/t/:slug/:id/album" element={<PublicAlbumPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lensApi.publicAlbum).mockResolvedValue(ALBUM);
  localStorage.clear();
  // jsdom has no IntersectionObserver; the wall must still draw its first
  // batch without one, and the tests never depend on the observer firing.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    },
  );
});

describe("PublicAlbumPage", () => {
  it("renders the hero and every approved photo in one vertical wall", async () => {
    mount();

    expect(await screen.findByText("Guest Lens")).toBeInTheDocument();
    expect(screen.getByText("36 Shots Challenge")).toBeInTheDocument();
    const grid = await screen.findByTestId("album-grid");
    expect(within(grid).getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(within(grid).getByTestId("album-photo-r2")).toBeInTheDocument();
    expect(within(grid).getByTestId("album-photo-r3")).toBeInTheDocument();
    expect(
      vi.mocked(lensApi.publicAlbum),
    ).toHaveBeenCalledWith("nagaland-cup", "t1", undefined);
  });

  it("reads category-wise by default: a section per category, unfiled last", async () => {
    mount();
    await screen.findByTestId("album-grid");

    // Each photo sits under the category it was filed in...
    const spirit = screen.getByTestId("album-section-Best Team Spirit");
    expect(within(spirit).getByTestId("album-photo-r2")).toBeInTheDocument();
    const action = screen.getByTestId("album-section-Best Action Shot");
    expect(within(action).getByTestId("album-photo-r1")).toBeInTheDocument();
    // ...and anything with no category still gets shown, at the end.
    const rest = screen.getByTestId("album-section-__other");
    expect(within(rest).getByTestId("album-photo-r3")).toBeInTheDocument();
    expect(within(rest).getByText("More photos")).toBeInTheDocument();
  });

  it("narrows to one category, and the sections collapse into that list", async () => {
    mount();
    await screen.findByTestId("album-grid");

    await userEvent.click(screen.getByTestId("album-filter-Best Action Shot"));

    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(within(grid).queryByTestId("album-photo-r2")).toBeNull();
    // One category is its own list; the per-category headers are gone.
    expect(screen.queryByTestId("album-section-Best Action Shot")).toBeNull();
  });

  it("matches a photo by the category it was uploaded to, not just its prize", async () => {
    mount();
    await screen.findByTestId("album-grid");

    await userEvent.click(screen.getByTestId("album-filter-Best Team Spirit"));

    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getByTestId("album-photo-r2")).toBeInTheDocument();
    expect(within(grid).queryByTestId("album-photo-r3")).toBeNull();
  });

  it("filters by school alongside the category", async () => {
    mount();
    await screen.findByTestId("album-grid");

    await userEvent.click(screen.getByLabelText("Filter by school"));
    await userEvent.click(await screen.findByRole("option", { name: /Pine Academy/ }));

    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getByTestId("album-photo-r3")).toBeInTheDocument();
    expect(within(grid).queryByTestId("album-photo-r1")).toBeNull();
  });

  it("holds back the tail of a long album until it is scrolled to", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...ALBUM.photos[2],
      upload_ref: `p${i}`,
      category: "",
    }));
    vi.mocked(lensApi.publicAlbum).mockResolvedValue({ ...ALBUM, photos: many });
    mount();

    const grid = await screen.findByTestId("album-grid");
    // A page of tiles, not thirty: a school phone cannot afford the rest.
    expect(within(grid).getAllByTestId(/^album-photo-/)).toHaveLength(24);
    expect(screen.getByTestId("album-sentinel")).toBeInTheDocument();
  });

  it("opens the lightbox and walks the list on screen", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("album-photo-r3"));

    const box = screen.getByTestId("album-lightbox");
    expect(within(box).getByText("Pine Academy")).toBeInTheDocument();

    await userEvent.click(within(box).getByLabelText("Previous photo"));
    expect(
      within(screen.getByTestId("album-lightbox")).getByText("Grace School"),
    ).toBeInTheDocument();
  });

  it("shows the award winners strip with category and school", async () => {
    mount();

    const strip = await screen.findByTestId("winners-strip");
    expect(within(strip).getByText("Best Action Shot")).toBeInTheDocument();
    expect(within(strip).getByText("Grace School")).toBeInTheDocument();
  });

  it("renders the empty state before any photo is approved", async () => {
    vi.mocked(lensApi.publicAlbum).mockResolvedValue({
      campaign: null,
      award_categories: [],
      institutions: [],
      photos: [],
    });
    mount();

    expect(await screen.findByTestId("album-empty")).toBeInTheDocument();
    expect(
      screen.getByText("The album opens when the host approves the first photos."),
    ).toBeInTheDocument();
  });
});
