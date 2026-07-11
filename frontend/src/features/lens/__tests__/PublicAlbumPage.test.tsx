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
});

describe("PublicAlbumPage", () => {
  it("renders the hero and the approved-photo grid", async () => {
    mount();

    expect(await screen.findByText("Guest Lens")).toBeInTheDocument();
    expect(screen.getByText("36 Shots Challenge")).toBeInTheDocument();
    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(
      vi.mocked(lensApi.publicAlbum),
    ).toHaveBeenCalledWith("nagaland-cup", "t1");
  });

  it("filters the grid by award category", async () => {
    mount();
    await screen.findByTestId("album-grid");

    await userEvent.click(screen.getByTestId("album-filter-Best Action Shot"));

    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("album-photo-r1")).toBeInTheDocument();
    expect(screen.queryByTestId("album-photo-r2")).toBeNull();
  });

  it("filters the grid by the category a photo was uploaded to", async () => {
    mount();
    await screen.findByTestId("album-grid");

    await userEvent.click(screen.getByTestId("album-filter-Best Team Spirit"));

    const grid = screen.getByTestId("album-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("album-photo-r2")).toBeInTheDocument();
    expect(screen.queryByTestId("album-photo-r3")).toBeNull();
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
