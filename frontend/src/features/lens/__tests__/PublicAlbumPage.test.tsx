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
  story_categories: [],
  stories: [],
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
  // jsdom runs no animation frames and reports zero heights, so the wall
  // never actually drifts here — what these tests pin is the list it draws
  // and the controls around it, not the rAF loop.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

describe("PublicAlbumPage", () => {
  it("renders the hero and every approved photo on one endless wall", async () => {
    mount();

    expect(await screen.findByText("Guest Lens")).toBeInTheDocument();
    expect(screen.getByText("36 Shots Challenge")).toBeInTheDocument();
    const wall = await screen.findByTestId("album-wall");
    expect(within(wall).getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(within(wall).getByTestId("album-photo-r2")).toBeInTheDocument();
    expect(within(wall).getByTestId("album-photo-r3")).toBeInTheDocument();
    expect(
      vi.mocked(lensApi.publicAlbum),
    ).toHaveBeenCalledWith("nagaland-cup", "t1", undefined);
  });

  it("loops each column twice, and the copy is scenery rather than a second album", async () => {
    mount();
    const wall = await screen.findByTestId("album-wall");

    // Every photo is drawn twice so the wrap has no seam...
    expect(within(wall).getAllByRole("button", { hidden: true }).length).toBe(6);
    // ...but only one copy is in the album: the other is hidden from AT and
    // untabbable, or the wall would announce the event twice over.
    expect(within(wall).getAllByRole("button")).toHaveLength(3);
    expect(within(wall).getAllByTestId(/^album-photo-/)).toHaveLength(3);
  });

  it("names the category on every tile, so an ungrouped wall still reads category-wise", async () => {
    mount();
    const tile = await screen.findByTestId("album-photo-r2");
    expect(within(tile).getByText("Best Team Spirit")).toBeInTheDocument();
  });

  it("runs the wall on one category when a chip is picked", async () => {
    mount();
    await screen.findByTestId("album-wall");

    await userEvent.click(screen.getByTestId("album-filter-Best Action Shot"));

    const wall = screen.getByTestId("album-wall");
    expect(within(wall).getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(within(wall).queryByTestId("album-photo-r2")).toBeNull();
  });

  it("matches a photo by the category it was uploaded to, not just its prize", async () => {
    mount();
    await screen.findByTestId("album-wall");

    await userEvent.click(screen.getByTestId("album-filter-Best Team Spirit"));

    const wall = screen.getByTestId("album-wall");
    expect(within(wall).getByTestId("album-photo-r2")).toBeInTheDocument();
    expect(within(wall).queryByTestId("album-photo-r3")).toBeNull();
  });

  it("filters by school alongside the category", async () => {
    mount();
    await screen.findByTestId("album-wall");

    await userEvent.click(screen.getByLabelText("Filter by school"));
    await userEvent.click(await screen.findByRole("option", { name: /Pine Academy/ }));

    const wall = screen.getByTestId("album-wall");
    expect(within(wall).getByTestId("album-photo-r3")).toBeInTheDocument();
    expect(within(wall).queryByTestId("album-photo-r1")).toBeNull();
  });

  it("can be stopped, because motion nobody asked for must be stoppable", async () => {
    mount();
    const wall = await screen.findByTestId("album-wall");
    expect(wall).toHaveAttribute("data-running", "true");

    await userEvent.click(screen.getByTestId("wall-motion-toggle"));
    expect(screen.getByTestId("album-wall")).toHaveAttribute(
      "data-running",
      "false",
    );
    expect(screen.getByTestId("wall-motion-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("holds still while a photo is open behind it", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("album-photo-r3"));

    expect(screen.getByTestId("album-lightbox")).toBeInTheDocument();
    expect(screen.getByTestId("album-wall")).toHaveAttribute(
      "data-running",
      "false",
    );
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
      story_categories: [],
      institutions: [],
      photos: [],
      stories: [],
    });
    mount();

    expect(await screen.findByTestId("album-empty")).toBeInTheDocument();
    expect(
      screen.getByText("The album opens when the host approves the first photos."),
    ).toBeInTheDocument();
  });

  it("counts a story's frames as photos, and leads with the prize", async () => {
    // An album whose every approved entry is a STORY reported 0 photos from 0
    // schools, and every category chip read 0 (owner 2026-08-25).
    vi.mocked(lensApi.publicAlbum).mockResolvedValue({
      ...ALBUM,
      photos: [],
      institutions: [{ id: "i1", name: "Grace School", count: 4 }],
      story_categories: ["Best Team Spirit"],
      stories: [
        {
          id: "s1",
          institution_id: "i1",
          institution_name: "Grace School",
          title: "Road to the final",
          description: "",
          category: "Best Team Spirit",
          award_category: "Best Team Spirit",
          photos: [
            {
              upload_ref: "f1",
              url: "/m/f1.jpg",
              thumb_url: "/m/f1_t.jpg",
              caption: "",
              position: 1,
              created_at: "2026-08-25T10:00:00Z",
            },
            {
              upload_ref: "f2",
              url: "/m/f2.jpg",
              thumb_url: "/m/f2_t.jpg",
              caption: "",
              position: 2,
              created_at: "2026-08-25T10:01:00Z",
            },
          ],
        },
      ],
      totals: {
        photos: 2,
        wall_photos: 0,
        story_photos: 2,
        stories: 1,
        schools: 1,
      },
    } as unknown as PublicAlbum);
    mount();

    expect(await screen.findByText(/2 photos/)).toBeInTheDocument();
    expect(screen.getByText(/1 school/)).toBeInTheDocument();
    // The prize leads the album, and a STORY can hold it.
    const strip = screen.getByTestId("winners-strip");
    expect(within(strip).getByText("Road to the final")).toBeInTheDocument();
    // The wall says why it is empty instead of blaming the filter.
    expect(
      screen.getByText("Every approved photo is part of a story above."),
    ).toBeInTheDocument();
  });
});
