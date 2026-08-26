import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { videosApi, type VideoAlbumsPayload } from "@/api/videos";
import { ToastProvider } from "@/components/ui/toast";
import { VideoAlbumsPage } from "../VideoAlbumsPage";

vi.mock("@/api/videos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/videos")>();
  return {
    ...actual,
    videosApi: {
      ...actual.videosApi,
      albums: vi.fn(),
      createAlbum: vi.fn(),
      addVideo: vi.fn(),
      removeAlbum: vi.fn(),
      removeVideo: vi.fn(),
    },
  };
});

const PAYLOAD: VideoAlbumsPayload = {
  can_manage: true,
  schools: [{ id: "i1", name: "Grace Academy", crest: "" }],
  suggested_tags: ["Table Tennis", "U-14"],
  albums: [
    {
      id: "a1", title: "Day 1", description: "", position: 1, video_count: 1,
      videos: [
        {
          id: "v1", event: "U-14 Boys Final", note: "",
          youtube_url: "https://youtu.be/dQw4w9WgXcQ", facebook_url: "",
          instagram_url: "", youtube_id: "dQw4w9WgXcQ", position: 1, played_on: null, tags: [], schools: [],
        },
      ],
    },
  ],
};

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/videos"]}>
          <Routes>
            <Route path="/tournaments/:id/videos" element={<VideoAlbumsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("VideoAlbumsPage", () => {
  beforeEach(() => {
    vi.mocked(videosApi.albums).mockResolvedValue(PAYLOAD);
    vi.mocked(videosApi.createAlbum).mockResolvedValue({
      id: "a2", title: "Finals", description: "", position: 0,
      videos: [], video_count: 0,
    });
    vi.mocked(videosApi.addVideo).mockResolvedValue({
      id: "v9", event: "Open Final", note: "",
      youtube_url: "https://youtu.be/abc123", facebook_url: "",
      instagram_url: "", youtube_id: "abc123", position: 0, played_on: null, tags: [], schools: [],
    });
  });

  it("creates an album", async () => {
    renderPage();
    await screen.findByTestId("album-a1");
    await userEvent.type(screen.getByTestId("album-title-input"), "Finals");
    await userEvent.click(screen.getByTestId("create-album-btn"));
    await waitFor(() =>
      expect(videosApi.createAlbum).toHaveBeenCalledWith("t1", { title: "Finals" }),
    );
  });

  it("adds an event with its links, and refuses one that points nowhere", async () => {
    renderPage();
    const album = await screen.findByTestId("album-a1");
    await userEvent.click(within(album).getByTestId("album-add-toggle-a1"));

    const save = screen.getByTestId("video-save-a1");
    await userEvent.type(screen.getByTestId("video-event-a1"), "Open Final");
    // An event with no link anywhere is not a video: the button stays shut.
    expect(save).toBeDisabled();

    await userEvent.type(
      screen.getByTestId("video-yt-input-a1"),
      "https://youtu.be/abc123",
    );
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() =>
      expect(videosApi.addVideo).toHaveBeenCalledWith("t1", "a1", {
        event: "Open Final",
        played_on: null,
        tags: [],
        schools: [],
        youtube_url: "https://youtu.be/abc123",
        facebook_url: "",
        instagram_url: "",
      }),
    );
  });

  it("shows the host the same card the public tab shows", async () => {
    renderPage();
    const album = await screen.findByTestId("album-a1");
    expect(within(album).getByTestId("video-v1")).toHaveTextContent(
      "U-14 Boys Final",
    );
    expect(within(album).getByTestId("video-play-v1")).toBeInTheDocument();
  });

  it("hides every control from someone who cannot manage the tournament", async () => {
    vi.mocked(videosApi.albums).mockResolvedValue({ ...PAYLOAD, can_manage: false });
    renderPage();
    await screen.findByTestId("album-a1");
    expect(screen.queryByTestId("create-album-btn")).toBeNull();
    expect(screen.queryByTestId("album-add-toggle-a1")).toBeNull();
    expect(screen.queryByTestId("video-remove-v1")).toBeNull();
  });
});
