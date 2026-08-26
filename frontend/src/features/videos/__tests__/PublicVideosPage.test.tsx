import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { videosApi, type PublicVideosPayload } from "@/api/videos";
import { PublicVideosPage } from "../PublicVideosPage";

vi.mock("@/api/videos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/videos")>();
  return {
    ...actual,
    videosApi: { ...actual.videosApi, publicVideos: vi.fn() },
  };
});

const PAYLOAD: PublicVideosPayload = {
  tournament: { id: "t1", slug: "cup", name: "Demo Meet", status: "live" },
  albums: [
    {
      id: "a1", title: "Day 1", description: "Friday", position: 1, video_count: 2,
      videos: [
        {
          id: "v1", event: "U-14 Boys Final", note: "",
          youtube_url: "https://youtu.be/dQw4w9WgXcQ",
          facebook_url: "https://facebook.com/v/1",
          instagram_url: "", youtube_id: "dQw4w9WgXcQ", position: 1, played_on: null, tags: [], schools: [],
        },
        {
          id: "v2", event: "Opening ceremony", note: "",
          youtube_url: "", facebook_url: "",
          instagram_url: "https://instagram.com/p/abc",
          youtube_id: "", position: 2, played_on: null, tags: [], schools: [],
        },
      ],
    },
    {
      id: "a2", title: "Finals", description: "", position: 2, video_count: 1,
      videos: [
        {
          id: "v3", event: "Open Boys Final", note: "",
          youtube_url: "https://youtu.be/xyz123abc", facebook_url: "",
          instagram_url: "", youtube_id: "xyz123abc", position: 1, played_on: null, tags: [], schools: [],
        },
      ],
    },
  ],
  facets: {
    days: [{ day: "2026-08-28", count: 2 }],
    tags: [{ tag: "Table Tennis", count: 2 }],
    schools: [{ id: "i1", name: "Grace Academy", crest: "", count: 1 }],
  },
  totals: { albums: 2, videos: 3 },
};

function renderPage(entry = "/t/cup/t1/videos"): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/t/:slug/:id/videos" element={<PublicVideosPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicVideosPage", () => {
  beforeEach(() => {
    vi.mocked(videosApi.publicVideos).mockResolvedValue(PAYLOAD);
  });

  it("lists the host's albums with their videos", async () => {
    renderPage();
    expect(await screen.findByTestId("video-album-a1")).toBeInTheDocument();
    expect(screen.getByTestId("video-album-a2")).toBeInTheDocument();
    expect(screen.getByTestId("video-v1")).toHaveTextContent("U-14 Boys Final");
  });

  it("loads the YouTube player only on click, never on sight", async () => {
    renderPage();
    const card = await screen.findByTestId("video-v1");
    // A dozen live iframes would pull megabytes before anyone chose anything.
    expect(screen.queryByTestId("video-frame-v1")).toBeNull();
    await userEvent.click(within(card).getByTestId("video-play-v1"));
    const frame = await screen.findByTestId("video-frame-v1");
    expect(frame).toHaveAttribute(
      "src",
      expect.stringContaining("youtube.com/embed/dQw4w9WgXcQ"),
    );
  });

  it("puts each platform behind its own icon, and only the ones that exist", async () => {
    renderPage();
    const v1 = await screen.findByTestId("video-v1");
    expect(within(v1).getByTestId("video-yt-v1")).toHaveAttribute(
      "href",
      "https://youtu.be/dQw4w9WgXcQ",
    );
    expect(within(v1).getByTestId("video-fb-v1")).toHaveAttribute("target", "_blank");
    // No Instagram link on this one, so no Instagram icon.
    expect(within(v1).queryByTestId("video-ig-v1")).toBeNull();
  });

  it("still lists a video with no YouTube link, without a dead player", async () => {
    renderPage();
    const v2 = await screen.findByTestId("video-v2");
    expect(within(v2).queryByTestId("video-play-v2")).toBeNull();
    expect(within(v2).getByTestId("video-ig-v2")).toBeInTheDocument();
  });

  it("filters to one album, and the choice rides the URL", async () => {
    renderPage("/t/cup/t1/videos?album=a2");
    expect(await screen.findByTestId("video-album-a2")).toBeInTheDocument();
    expect(screen.queryByTestId("video-album-a1")).toBeNull();
  });

  it("says so plainly when the host has published nothing", async () => {
    vi.mocked(videosApi.publicVideos).mockResolvedValue({
      ...PAYLOAD, albums: [], totals: { albums: 0, videos: 0 },
    });
    renderPage();
    expect(await screen.findByText("No videos yet.")).toBeInTheDocument();
  });
});
