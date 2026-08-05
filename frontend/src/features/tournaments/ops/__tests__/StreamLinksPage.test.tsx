import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { streamingApi, type CourtStreamRow, type StreamLink } from "@/api/streaming";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type StagePayload,
  type Tournament,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { StreamLinksPage } from "../StreamLinksPage";

vi.mock("@/api/streaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/streaming")>();
  return {
    ...actual,
    streamingApi: {
      ...actual.streamingApi,
      courtStreams: vi.fn(),
      saveCourtStream: vi.fn(),
      deleteCourtStream: vi.fn(),
      links: vi.fn(),
      saveLink: vi.fn(),
      updateLink: vi.fn(),
      deleteLink: vi.fn(),
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
      stage: vi.fn(),
      matchesEnriched: vi.fn(),
    },
  };
});

const DAY = "2026-08-04";
const COURT_A = "11111111-1111-1111-1111-111111111111";
const COURT_B = "22222222-2222-2222-2222-222222222222";
const YT_DAY = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YT_DEFAULT = "https://youtu.be/aaaaaaaaaaa";

const TOURNAMENT = {
  id: "t1",
  slug: "cup",
  name: "Nagaland Schools Cup",
  status: "live",
  organization_slug: "acme",
  sport_code: "football",
  sports: [],
  // Everything on this page is keyed by the LOCAL tournament day.
  time_zone: "Asia/Kolkata",
  created_at: "2026-07-01T00:00:00Z",
} as Tournament;

const MANAGER: StagePayload = {
  stage: "ready",
  status: "live",
  order: ["setup", "fixtures", "ready"],
  allowed_to: [],
  can_manage: true,
  modules: [],
  rules_frozen_at: null,
  stages: [],
};

function court(over: Partial<CourtStreamRow> & { court_id: string }): CourtStreamRow {
  return {
    court_name: "MP Hall · T1",
    venue_id: "v1",
    index: 1,
    watch_url: "",
    enabled: false,
    yt_stream_id: "",
    has_stream_key: false,
    live_watch_url: null,
    is_streaming: false,
    public_link: `/api/public/tournaments/cup/t1/court/${over.court_id}/live/`,
    ...over,
  };
}

const COURTS: CourtStreamRow[] = [
  // No link of its own; a standing default is what a spectator gets.
  court({ court_id: COURT_A, court_name: "MP Hall · T1", watch_url: YT_DEFAULT }),
  // Nothing anywhere.
  court({ court_id: COURT_B, court_name: "MP Hall · T2", index: 2 }),
];

const DAY_LINK: StreamLink = {
  id: "link-b",
  scope: "court_day",
  match_id: null,
  court_id: COURT_B,
  day: DAY,
  leaf_key: "",
  watch_url: YT_DAY,
  enabled: true,
  updated_at: null,
};

function match(over: Partial<ControlRoomMatch> & { id: string }): ControlRoomMatch {
  return {
    stage: "group",
    group_label: "Group A",
    round_no: 1,
    match_no: 1,
    status: "scheduled",
    home_team: { id: "th", name: "Alpha", short_name: "ALP" },
    away_team: { id: "ta", name: "Bravo", short_name: "BRA" },
    home_score: null,
    away_score: null,
    sport: "",
    set_scores: [],
    leaf_key: "football.u15.girls",
    leaf_label: "Football · U-15 · Girls",
    venue: "MP Hall · T1",
    scoring: null,
    // 09:00 IST on DAY (03:30 UTC) — the day bucket must be the LOCAL one.
    scheduled_at: `${DAY}T03:30:00Z`,
    locked_at: null,
    scorer: null,
    officials: [],
    ...over,
  };
}

const MATCHES: ControlRoomMatch[] = [
  match({ id: "m1" }),
  match({ id: "m2", venue: "MP Hall · T2", match_no: 2 }),
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/streams"]}>
          <Routes>
            <Route path="/tournaments/:id/streams" element={<StreamLinksPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.get).mockResolvedValue(TOURNAMENT);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(MANAGER);
  vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue(MATCHES);
  vi.mocked(streamingApi.courtStreams).mockResolvedValue({ court_streams: COURTS });
  vi.mocked(streamingApi.links).mockResolvedValue({ stream_links: [DAY_LINK] });
});

/** The page opens on the fixture's first day when it is in the past. */
async function openDay(): Promise<void> {
  const chip = await screen.findByTestId(`stream-day-${DAY}`);
  await userEvent.click(chip);
}

describe("StreamLinksPage", () => {
  it("shows, per court, the link in effect AND which level it came from", async () => {
    mount();
    await openDay();

    // Court B has its own link for this day.
    const b = screen.getByTestId(`stream-court-${COURT_B}`);
    expect(within(b).getByTestId(`stream-source-${COURT_B}`)).toHaveTextContent(
      "This day",
    );
    expect(within(b).getByRole("link")).toHaveAttribute("href", YT_DAY);

    // Court A has nothing for the day, so it runs on its standing default —
    // the same URL a spectator gets, but NOT the same thing to an organiser.
    const a = screen.getByTestId(`stream-court-${COURT_A}`);
    expect(within(a).getByTestId(`stream-source-${COURT_A}`)).toHaveTextContent(
      "Court default",
    );
    expect(within(a).getByRole("link")).toHaveAttribute("href", YT_DEFAULT);
  });

  it("a court with nothing anywhere says so, rather than showing a dead link", async () => {
    vi.mocked(streamingApi.links).mockResolvedValue({ stream_links: [] });
    mount();
    await openDay();

    const b = screen.getByTestId(`stream-court-${COURT_B}`);
    expect(within(b).getByTestId(`stream-source-${COURT_B}`)).toHaveTextContent(
      "No link",
    );
    expect(within(b).getByTestId(`stream-none-${COURT_B}`)).toBeInTheDocument();
  });

  it("pasting a link for a court+day writes it and the board reflects it", async () => {
    vi.mocked(streamingApi.links).mockResolvedValue({ stream_links: [] });
    vi.mocked(streamingApi.saveLink).mockImplementation(async () => {
      // The server now owns the link; the refetch is what the UI shows.
      vi.mocked(streamingApi.links).mockResolvedValue({
        stream_links: [{ ...DAY_LINK, court_id: COURT_A, id: "new" }],
      });
      return { ...DAY_LINK, court_id: COURT_A, id: "new" };
    });

    mount();
    await openDay();

    await userEvent.type(
      screen.getByTestId(`stream-day-${COURT_A}-input`),
      YT_DAY,
    );
    await userEvent.click(screen.getByTestId(`stream-day-${COURT_A}-save`));

    await waitFor(() => {
      expect(streamingApi.saveLink).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          scope: "court_day",
          court_id: COURT_A,
          day: DAY,
          watch_url: YT_DAY,
        }),
      );
    });
    // Every write carries a client event_id (invariant 3).
    expect(vi.mocked(streamingApi.saveLink).mock.calls[0][1].event_id).toBeTruthy();

    const a = await screen.findByTestId(`stream-court-${COURT_A}`);
    await waitFor(() => {
      expect(within(a).getByTestId(`stream-source-${COURT_A}`)).toHaveTextContent(
        "This day",
      );
    });
  });

  it("clearing a link removes it and the court falls back to the level below", async () => {
    vi.mocked(streamingApi.links).mockResolvedValue({
      stream_links: [{ ...DAY_LINK, court_id: COURT_A, id: "link-a" }],
    });
    vi.mocked(streamingApi.deleteLink).mockImplementation(async () => {
      vi.mocked(streamingApi.links).mockResolvedValue({ stream_links: [] });
    });

    mount();
    await openDay();
    const a = screen.getByTestId(`stream-court-${COURT_A}`);
    expect(within(a).getByTestId(`stream-source-${COURT_A}`)).toHaveTextContent(
      "This day",
    );

    await userEvent.click(screen.getByTestId(`stream-day-${COURT_A}-clear`));

    await waitFor(() => {
      expect(streamingApi.deleteLink).toHaveBeenCalledWith("t1", "link-a");
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId(`stream-court-${COURT_A}`)).getByTestId(
          `stream-source-${COURT_A}`,
        ),
      ).toHaveTextContent("Court default");
    });
    // Clearing is NOT disabling: the row is gone, so there is nothing to
    // switch back on.
    expect(
      screen.queryByTestId(`stream-day-${COURT_A}-toggle`),
    ).not.toBeInTheDocument();
  });

  it("switching a link off is a distinct, reversible verb — the row stays", async () => {
    vi.mocked(streamingApi.updateLink).mockImplementation(async () => {
      vi.mocked(streamingApi.links).mockResolvedValue({
        stream_links: [{ ...DAY_LINK, enabled: false }],
      });
      return { ...DAY_LINK, enabled: false };
    });

    mount();
    await openDay();
    await userEvent.click(screen.getByTestId(`stream-day-${COURT_B}-toggle`));

    await waitFor(() => {
      expect(streamingApi.updateLink).toHaveBeenCalledWith(
        "t1",
        "link-b",
        expect.objectContaining({ enabled: false }),
      );
    });
    await waitFor(() => {
      // Still there to switch back on, but no longer applying.
      expect(screen.getByTestId(`stream-day-${COURT_B}-toggle`)).toHaveTextContent(
        "Turn on",
      );
    });
    expect(screen.getByTestId(`stream-court-${COURT_B}`)).toHaveTextContent(
      "Saved but not applying",
    );
  });

  it("warns about a channel /live paste before spending a round trip", async () => {
    mount();
    await openDay();
    await userEvent.type(
      screen.getByTestId(`stream-day-${COURT_A}-input`),
      "https://www.youtube.com/@school/live",
    );
    expect(
      await screen.findByTestId(`stream-day-${COURT_A}-warning`),
    ).toHaveTextContent(/channel-level/);
    // Advisory only — the server is still the authority, so Save stays live.
    expect(screen.getByTestId(`stream-day-${COURT_A}-save`)).toBeEnabled();
  });

  it("surfaces the SERVER's refusal message rather than inventing one", async () => {
    vi.mocked(streamingApi.saveLink).mockRejectedValue(
      new ApiError(400, {
        detail: "channel_live_url",
        message: "That is a channel-level “/live” link, which cannot identify a court.",
      }),
    );
    mount();
    await openDay();
    await userEvent.type(
      screen.getByTestId(`stream-day-${COURT_A}-input`),
      YT_DAY,
    );
    await userEvent.click(screen.getByTestId(`stream-day-${COURT_A}-save`));

    expect(await screen.findByTestId(`stream-day-${COURT_A}-error`)).toHaveTextContent(
      "cannot identify a court",
    );
  });

  it("carries the other two scopes: a category link and a per-match override", async () => {
    vi.mocked(streamingApi.saveLink).mockResolvedValue({
      ...DAY_LINK,
      scope: "category",
    });
    mount();
    await openDay();

    await userEvent.type(
      screen.getByTestId("stream-cat-football.u15.girls-input"),
      YT_DAY,
    );
    await userEvent.click(screen.getByTestId("stream-cat-football.u15.girls-save"));
    await waitFor(() => {
      expect(streamingApi.saveLink).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          scope: "category",
          leaf_key: "football.u15.girls",
          watch_url: YT_DAY,
        }),
      );
    });

    await userEvent.type(screen.getByTestId("stream-m-m1-input"), YT_DEFAULT);
    await userEvent.click(screen.getByTestId("stream-m-m1-save"));
    await waitFor(() => {
      expect(streamingApi.saveLink).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          scope: "match",
          match_id: "m1",
          watch_url: YT_DEFAULT,
        }),
      );
    });
  });

  it("a non-manager gets the board read-only", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue({
      ...MANAGER,
      can_manage: false,
    });
    mount();
    await openDay();
    expect(screen.getByTestId(`stream-day-${COURT_A}-input`)).toBeDisabled();
    expect(screen.getByTestId(`stream-day-${COURT_B}-clear`)).toBeDisabled();
  });
});
