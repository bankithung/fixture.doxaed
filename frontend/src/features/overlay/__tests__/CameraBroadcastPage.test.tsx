import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { CameraBroadcastPage } from "../CameraBroadcastPage";

/**
 * WHAT THIS FILE CAN AND CANNOT PROVE.
 *
 * jsdom has no camera, no Wake Lock, no Fullscreen and certainly no YouTube
 * screen broadcast. What is verified here is the CONTRACT with those APIs —
 * that we ask for video and never audio, that we ask for the rear camera, that
 * every failure mode reaches the operator as words rather than a black screen,
 * that the scoreboard is the overlay's own — and that the browser APIs are
 * called with the arguments a real device needs. The picture itself, the lock
 * actually holding a phone awake, and the capture reaching YouTube can only be
 * confirmed on a real handset.
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, publicSchedule: vi.fn() },
  };
});
vi.mock("@/api/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/live")>();
  return { ...actual, liveApi: { ...actual.liveApi, snapshot: vi.fn() } };
});

const FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  stage: "group",
  stage_no: 0,
  group_label: "",
  round_no: 1,
  match_no: 1,
  day: "2026-08-03",
  leaf_key: "table_tennis.u16",
};

type Row = PublicSchedulePayload["matches"][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "m1",
    leaf_label: "Table Tennis · U-16 · Boys",
    status: "live",
    scheduled_at: "2026-08-03T04:00:00Z",
    venue: "Court2 · T3",
    home: { id: "h", name: "Alpha School", short_name: "ALP", school: "N" },
    away: { id: "a", name: "Bravo School", short_name: "BRA", school: "S" },
    home_score: 0,
    away_score: 0,
    sport: "table_tennis",
    set_scores: [],
    current_period: "game_1",
    ...FIELDS,
    ...over,
  } as Row;
}

function payload(matches: Row[]): PublicSchedulePayload {
  return {
    tournament: {
      id: "t1",
      slug: "cup",
      name: "Nagaland Schools Cup",
      status: "live",
      time_zone: "Asia/Kolkata",
    },
    matches,
  };
}

function snapshot(): LiveSnapshot {
  return {
    server_time: new Date().toISOString(),
    match: {
      id: "m1",
      status: "live",
      current_period: "game_1",
      home_team: { id: "h", name: "Alpha School", short_name: "ALP", players: [] },
      away_team: { id: "a", name: "Bravo School", short_name: "BRA", players: [] },
      home_score: 0,
      away_score: 0,
      started_at: null,
      sport: "table_tennis",
      set_scores: [],
      scoring: {
        type: "sets",
        best_of: 3,
        points: 11,
        win_by: 2,
        cap: null,
        serve: { serves_per_turn: 2, alternate_every_point: true },
      },
      sport_meta: {
        key: "table_tennis",
        name: "Table Tennis",
        family: "target",
        terms: { period: "Game", score_unit: "Points" },
        version: 1,
      },
    },
    events: [],
  } as LiveSnapshot;
}

const COURT = "Court2 · T3";

// --- the browser APIs this page stands on, all absent in jsdom -------------

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  listeners: Record<string, () => void>;
}

let tracks: FakeTrack[] = [];

function fakeStream(): MediaStream {
  const track: FakeTrack = { stop: vi.fn(), listeners: {} };
  tracks.push(track);
  const asTrack = {
    stop: track.stop,
    kind: "video",
    addEventListener: (type: string, cb: () => void) => {
      track.listeners[type] = cb;
    },
  };
  return {
    getTracks: () => [asTrack],
    getVideoTracks: () => [asTrack],
  } as unknown as MediaStream;
}

let getUserMedia: ReturnType<typeof vi.fn>;

function installMediaDevices(impl?: unknown): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: impl === undefined ? { getUserMedia } : impl,
    configurable: true,
    writable: true,
  });
}

function mediaError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function mount(search = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const url = `/broadcast/t/cup/t1/court/${encodeURIComponent(COURT)}${search}`;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/broadcast/t/:slug/:id/court/:court"
            element={<CameraBroadcastPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function start(): Promise<void> {
  await userEvent.click(await screen.findByTestId("camera-start"));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  tracks = [];
  getUserMedia = vi.fn().mockResolvedValue(fakeStream());
  installMediaDevices();
  vi.mocked(liveApi.snapshot).mockResolvedValue(snapshot());
  vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
    payload([row({ set_scores: [[11, 7], [4, 2]], home_score: 1, away_score: 0 })]),
  );
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(navigator, "wakeLock");
});

describe("CameraBroadcastPage — what we ask the phone for", () => {
  it("asks for video ONLY: the microphone has to stay free for YouTube", async () => {
    mount();
    await start();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    // THE assertion this whole page depends on. YouTube records the venue's
    // sound through the phone's mic while it screen-broadcasts this page; a
    // mic track held here contends with that capture.
    expect(constraints.audio).toBe(false);
    expect(constraints).toEqual({
      video: expect.objectContaining({ facingMode: "environment" }),
      audio: false,
    });
  });

  it("asks for the REAR camera — the one pointing at the court", async () => {
    mount();
    await start();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const video = (getUserMedia.mock.calls[0][0] as MediaStreamConstraints)
      .video as MediaTrackConstraints;
    expect(video.facingMode).toBe("environment");
  });

  it("touches the camera only behind an explicit tap (getUserMedia needs a gesture)", async () => {
    mount();
    await screen.findByTestId("camera-start");
    // Merely opening the URL must never raise a permission prompt: the API
    // requires a user gesture, and an unexplained prompt gets denied.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "idle");
  });

  it("hands the camera back when the page goes away", async () => {
    const view = mount();
    await start();
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    view.unmount();
    // A held camera keeps the privacy light on and locks out the next app.
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});

describe("CameraBroadcastPage — failures an operator can act on", () => {
  it("permission denied: says what to tap, instead of a blank screen", async () => {
    getUserMedia.mockRejectedValue(mediaError("NotAllowedError"));
    mount();
    await start();

    const err = await screen.findByTestId("camera-error");
    expect(err).toHaveAttribute("data-fault", "denied");
    expect(err).toHaveTextContent(/camera is blocked/i);
    expect(err).toHaveTextContent(/padlock/i);
    // Not a dead end: the retry is right there.
    expect(screen.getByTestId("camera-retry")).toBeInTheDocument();
    // And it is announced, for an operator looking at a phone on a tripod.
    expect(err).toHaveAttribute("role", "alert");
  });

  it("no camera on the device: sends them to the right hardware", async () => {
    getUserMedia.mockRejectedValue(mediaError("NotFoundError"));
    mount();
    await start();
    const err = await screen.findByTestId("camera-error");
    expect(err).toHaveAttribute("data-fault", "not-found");
    expect(err).toHaveTextContent(/open the link on the phone/i);
  });

  it("camera already in use: names the real culprit, and clears YouTube", async () => {
    getUserMedia.mockRejectedValue(mediaError("NotReadableError"));
    mount();
    await start();
    const err = await screen.findByTestId("camera-error");
    expect(err).toHaveAttribute("data-fault", "in-use");
    expect(err).toHaveTextContent(/Only one app can hold the camera/i);
    expect(err).toHaveTextContent(/Go live → Screen/);
  });

  it("no getUserMedia at all: names the in-app browser, and offers no retry", async () => {
    installMediaDevices(undefined);
    Object.defineProperty(navigator, "mediaDevices", {
      value: {},
      configurable: true,
      writable: true,
    });
    mount();
    await start();
    const err = await screen.findByTestId("camera-error");
    expect(err).toHaveAttribute("data-fault", "unsupported");
    expect(err).toHaveTextContent(/Open in browser/i);
    // Retrying the same unsupported browser cannot help; do not pretend.
    expect(screen.queryByTestId("camera-retry")).toBeNull();
  });

  it("an insecure page is called out as such, not as an old browser", async () => {
    // Browsers only publish mediaDevices on https, so this is what an http://
    // page actually looks like from in here.
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
      writable: true,
    });
    mount();
    await start();
    const err = await screen.findByTestId("camera-error");
    expect(err).toHaveAttribute("data-fault", "insecure");
    expect(err).toHaveTextContent(/https/);
    Reflect.deleteProperty(window, "isSecureContext");
  });

  it("recovers when the operator fixes it and taps Try again", async () => {
    getUserMedia
      .mockRejectedValueOnce(mediaError("NotAllowedError"))
      .mockResolvedValue(fakeStream());
    mount();
    await start();
    await screen.findByTestId("camera-error");

    await userEvent.click(screen.getByTestId("camera-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    expect(screen.queryByTestId("camera-error")).toBeNull();
  });

  it("says so when the OS takes the camera away mid-broadcast", async () => {
    mount();
    await start();
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    // An incoming call, or another app grabbing the lens. A frozen last frame
    // with no explanation is the worst outcome available.
    await act(async () => {
      tracks[0].listeners.ended?.();
    });
    expect(await screen.findByTestId("camera-error")).toHaveAttribute(
      "data-fault",
      "in-use",
    );
  });
});

describe("CameraBroadcastPage — the scoreboard is the overlay's own", () => {
  it("renders the same board, from the same feed and the same state selector", async () => {
    mount();
    // The board is up before the camera is: it doubles as the operator's proof
    // that this URL is pointed at the right court.
    expect(await screen.findByTestId("overlay-scorebug")).toBeInTheDocument();
    // Points in the game on the table, games won, and the finished game — all
    // produced by OverlayBoard/useCourtBoard, not by a second implementation.
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("4");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("2");
    expect(screen.getByTestId("overlay-home-games")).toHaveTextContent("1");
    expect(screen.getByTestId("overlay-home-history")).toHaveTextContent("11");
    await waitFor(() =>
      expect(screen.getByTestId("camera-board")).toHaveAttribute(
        "data-board-state",
        "live",
      ),
    );
    expect(screen.getByTestId("camera-board")).toHaveAttribute(
      "data-family",
      "target",
    );
  });

  it("follows THIS court, matched on the venue string like the overlay", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        row({ id: "elsewhere", venue: "Court 9", set_scores: [[3, 1]] }),
        row({ id: "mine", venue: COURT, set_scores: [[9, 6]] }),
      ]),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("9");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("6");
  });

  it("hides the board from assistive tech, but not the operator's controls", async () => {
    mount();
    await screen.findByTestId("overlay-scorebug");
    // The board is a video graphic. The Start button is real UI and must stay
    // reachable — this page, unlike the OBS overlay, has a human operating it.
    expect(screen.getByTestId("camera-board")).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByRole("button", { name: "Start camera" }),
    ).toBeInTheDocument();
  });

  it("scales the board to the phone, and lets ?scale= multiply that", async () => {
    // jsdom reports a 1024-wide viewport; the geometry is authored for 1920.
    const plain = mount();
    expect(screen.getByTestId("camera-board").getAttribute("style")).toContain(
      `--ov-scale: ${1024 / 1920}`,
    );
    plain.unmount();

    mount("?scale=2");
    expect(screen.getByTestId("camera-board").getAttribute("style")).toContain(
      `--ov-scale: ${(1024 / 1920) * 2}`,
    );
  });

  it("honours ?side and ?server, the overlay's own parsers", async () => {
    mount("?side=right&server=away");
    const board = await screen.findByTestId("camera-board");
    expect(board.className).toContain("ov--right");
    // 4-3 in the current game = 7 points played in 2-serve blocks. With away
    // opening the match the serve flips to home.
    await waitFor(() =>
      expect(screen.getByTestId("overlay-serving-home")).toBeInTheDocument(),
    );
  });
});

describe("CameraBroadcastPage — fit to be screen-captured", () => {
  it("gets the operator UI out of the picture once the camera is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.click(await screen.findByTestId("camera-start"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    // The pre-flight card goes the moment the picture is live.
    expect(screen.queryByTestId("camera-card")).toBeNull();
    expect(screen.getByTestId("camera-controls")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // From here every pixel is going out to the public.
    expect(screen.queryByTestId("camera-controls")).toBeNull();
    expect(screen.getByTestId("camera-root")).toHaveAttribute(
      "data-controls",
      "hidden",
    );
    // The board never goes anywhere — it is the point of the page.
    expect(screen.getByTestId("overlay-scorebug")).toBeInTheDocument();
  });

  it("brings the controls back on a tap on the picture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.click(await screen.findByTestId("camera-start"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByTestId("camera-controls")).toBeNull();

    await user.click(screen.getByTestId("camera-root"));
    expect(await screen.findByTestId("camera-controls")).toBeInTheDocument();
  });

  it("marks the page for the broadcast reset, and undoes it on the way out", async () => {
    const view = mount();
    await screen.findByTestId("camera-start");
    expect(document.documentElement.hasAttribute("data-camera-broadcast")).toBe(true);
    // No-index / no-referrer, same as the overlay: this URL should not be
    // indexed and should not leak into other sites' referrer logs.
    expect(
      document.head.querySelector('meta[name="robots"]')?.getAttribute("content"),
    ).toBe("noindex, nofollow");
    view.unmount();
    expect(document.documentElement.hasAttribute("data-camera-broadcast")).toBe(false);
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it("nudges a portrait phone without ever blocking it", async () => {
    const original = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      value: 2000,
      configurable: true,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
    mount();
    expect(await screen.findByTestId("camera-portrait-nudge")).toBeInTheDocument();
    // Nudged, not stopped: the button still works.
    expect(screen.getByTestId("camera-start")).toBeEnabled();
    Object.defineProperty(window, "innerHeight", {
      value: original,
      configurable: true,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
  });
});

describe("CameraBroadcastPage — keeping the phone awake and full screen", () => {
  it("takes a screen wake lock once the camera is live, and re-takes it after the page is hidden", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const sentinel = { release, addEventListener: vi.fn() };
    const request = vi.fn().mockResolvedValue(sentinel);
    Object.defineProperty(navigator, "wakeLock", {
      value: { request },
      configurable: true,
      writable: true,
    });

    mount();
    // Nothing is on air yet, so nothing is holding the screen awake.
    expect(request).not.toHaveBeenCalled();

    await start();
    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));

    // The spec drops a screen lock whenever the document is hidden and never
    // restores it — and this page is guaranteed to be hidden at least once,
    // when the operator switches to the YouTube app to start the broadcast.
    await act(async () => {
      sentinel.addEventListener.mock.calls
        .filter(([type]) => type === "release")
        .forEach(([, cb]) => (cb as () => void)());
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("degrades silently where there is no Wake Lock API", async () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    mount();
    await start();
    await waitFor(() =>
      expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live"),
    );
    // No warning, no error state — there is nothing an operator could do.
    expect(screen.queryByTestId("camera-error")).toBeNull();
  });

  it("asks for fullscreen on a tap, so browser chrome is not in the capture", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    mount();
    await start();
    await userEvent.click(await screen.findByTestId("camera-fullscreen"));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalled());
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  });

  it("survives a browser that refuses fullscreen (every iPhone), with advice", async () => {
    const requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error("fullscreen not allowed"));
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    mount();
    await start();
    await userEvent.click(await screen.findByTestId("camera-fullscreen"));
    // Still streamable — just with the address bar in shot. Say that rather
    // than failing the whole page.
    expect(
      await screen.findByText(/would not go full screen/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("camera-root")).toHaveAttribute("data-state", "live");
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  });
});
