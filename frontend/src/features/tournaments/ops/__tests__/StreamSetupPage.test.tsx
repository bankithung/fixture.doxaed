import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { StreamSetupPage } from "../StreamSetupPage";

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
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const ORIGIN = window.location.origin;
/** The venue shape that breaks every hand-typed URL: a space and a middle dot. */
const PHONE_URL_A = `${ORIGIN}/broadcast/t/cup/t1/court/Court2%20%C2%B7%20T3`;
const OBS_URL_A = `${ORIGIN}/overlay/t/cup/t1/court/Court2%20%C2%B7%20T3`;

const TOURNAMENT = {
  id: "t1",
  slug: "cup",
  name: "Nagaland Schools Cup",
  status: "live",
  organization_slug: "acme",
  sport_code: "football",
  sports: [],
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
    court_name: "Court2 · T3",
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
  court({ court_id: COURT_A }),
  court({ court_id: COURT_B, court_name: "Court 1", index: 2 }),
];

const DAY_LINK: StreamLink = {
  id: "link-b",
  scope: "court_day",
  match_id: null,
  court_id: COURT_B,
  day: DAY,
  leaf_key: "",
  watch_url: YT,
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
    venue: "Court2 · T3",
    scoring: null,
    // 09:00 IST on DAY — the day bucket must be the LOCAL one.
    scheduled_at: `${DAY}T03:30:00Z`,
    locked_at: null,
    scorer: null,
    officials: [],
    ...over,
  };
}

const MATCHES: ControlRoomMatch[] = [
  match({ id: "m1" }),
  match({ id: "m2", venue: "Court 1", match_no: 2 }),
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/streams/setup"]}>
          <Routes>
            <Route
              path="/tournaments/:id/streams/setup"
              element={<StreamSetupPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The first court opens by itself; this opens the second one. */
async function openCourtB(): Promise<void> {
  await userEvent.click(await screen.findByTestId(`setup-toggle-${COURT_B}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.get).mockResolvedValue(TOURNAMENT);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(MANAGER);
  vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue(MATCHES);
  vi.mocked(streamingApi.courtStreams).mockResolvedValue({ court_streams: COURTS });
  vi.mocked(streamingApi.links).mockResolvedValue({ stream_links: [DAY_LINK] });
});

describe("StreamSetupPage", () => {
  it("renders one setup block per court, and says which already has a link", async () => {
    mount();

    expect(await screen.findByTestId(`setup-court-${COURT_A}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^setup-court-/)).toHaveLength(2);

    // Court B is already live for the day; Court A has nothing anywhere. A
    // walk-up has to be able to see what still needs doing.
    expect(screen.getByTestId(`setup-source-${COURT_B}`)).toHaveTextContent(
      "This day",
    );
    expect(screen.getByTestId(`setup-source-${COURT_A}`)).toHaveTextContent(
      "No link",
    );

    // The first court is already open — a setup page that opens on a list of
    // closed rows is the disclosure problem again.
    expect(screen.getByTestId(`setup-toggle-${COURT_A}`)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId(`setup-body-${COURT_A}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`setup-body-${COURT_B}`)).not.toBeInTheDocument();
  });

  it("leads with a QR code requested for THAT court, with a text alternative", async () => {
    mount();

    const qr = await screen.findByTestId(`qr-${COURT_A}`);
    expect(qr).toHaveAttribute(
      "src",
      `/api/tournaments/t1/court-streams/${COURT_A}/broadcast-qr/`,
    );
    // Not decorative: it is the only way the URL reaches the phone, so it says
    // what scanning it does.
    expect(qr).toHaveAccessibleName(
      "QR code. Scanning it with a phone camera opens the broadcast page for Court2 · T3.",
    );

    await openCourtB();
    expect(screen.getByTestId(`qr-${COURT_B}`)).toHaveAttribute(
      "src",
      `/api/tournaments/t1/court-streams/${COURT_B}/broadcast-qr/`,
    );
  });

  it("falls back to the URL when the QR image cannot load", async () => {
    mount();
    fireEvent.error(await screen.findByTestId(`qr-${COURT_A}`));

    expect(screen.getByTestId(`qr-failed-${COURT_A}`)).toBeInTheDocument();
    // The URL is still on screen, selectable and copyable.
    expect(screen.getByTestId(`camera-url-${COURT_A}`)).toHaveTextContent(
      PHONE_URL_A,
    );
  });

  it("carries both URLs for the court, percent-encoded, and copies them exactly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();

    // The court is addressed by the fixture's VENUE string, middle dot and
    // all — `Court2 · T3` → `Court2%20%C2%B7%20T3`, in the QR payload and in
    // both copy buttons.
    expect(await screen.findByTestId(`camera-url-${COURT_A}`)).toHaveTextContent(
      PHONE_URL_A,
    );
    expect(screen.getByTestId(`overlay-url-${COURT_A}`)).toHaveTextContent(
      OBS_URL_A,
    );

    await userEvent.click(screen.getByTestId(`camera-copy-${COURT_A}`));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PHONE_URL_A));
    expect(await screen.findByText("Phone broadcast URL copied")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(`overlay-copy-${COURT_A}`));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(OBS_URL_A));

    // Named by their court, reachable by name and not by icon alone.
    expect(
      screen.getByRole("button", {
        name: "Copy the phone broadcast URL for Court2 · T3",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy the OBS overlay URL for Court2 · T3" }),
    ).toBeInTheDocument();
  });

  it("spells out the phone steps, which need no equipment", async () => {
    mount();
    const phone = await screen.findByTestId(`setup-phone-${COURT_A}`);

    expect(phone).toHaveTextContent(/tap Start camera/);
    expect(phone).toHaveTextContent(/Tap Full screen/);
    expect(phone).toHaveTextContent(/YouTube app → Create → Go live → Screen/);
    expect(phone).toHaveTextContent(/paste it into the box below/);
    expect(phone).toHaveTextContent(/Watch live/);
    expect(phone).toHaveTextContent(/never touches the microphone/);
  });

  it("carries the OBS settings that are load-bearing, unchanged", async () => {
    mount();
    const table = await screen.findByTestId(`setup-obs-settings-${COURT_A}`);

    expect(within(table).getByText("1920")).toBeInTheDocument();
    expect(within(table).getByText("1080")).toBeInTheDocument();
    // The two OFFs whose defaults must not be "improved".
    expect(
      within(table).getByRole("rowheader", {
        name: "Refresh browser when scene becomes active",
      }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("rowheader", {
        name: "Shutdown source when not visible",
      }),
    ).toBeInTheDocument();
    expect(table).toHaveTextContent(/OFF \(this is the default/);

    const obs = screen.getByTestId(`setup-obs-${COURT_A}`);
    expect(obs).toHaveTextContent(/above the camera source/);
    expect(obs).toHaveTextContent(/throws away the overlay's live state mid-rally/);
    expect(obs).toHaveTextContent(/Do not resize the source by dragging/);
    expect(screen.getByTestId(`setup-obs-options-${COURT_A}`)).toHaveTextContent(
      "?scale=0.667",
    );
  });

  it("closes the loop on the same page: pasting the link publishes the button", async () => {
    vi.mocked(streamingApi.saveLink).mockImplementation(async () => {
      vi.mocked(streamingApi.links).mockResolvedValue({
        stream_links: [{ ...DAY_LINK, court_id: COURT_A, id: "new" }],
      });
      return { ...DAY_LINK, court_id: COURT_A, id: "new" };
    });
    mount();

    await userEvent.type(
      await screen.findByTestId(`setup-link-${COURT_A}-input`),
      YT,
    );
    await userEvent.click(screen.getByTestId(`setup-link-${COURT_A}-save`));

    await waitFor(() => {
      expect(streamingApi.saveLink).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          scope: "court_day",
          court_id: COURT_A,
          day: DAY,
          watch_url: YT,
        }),
      );
    });
    // Every write carries a client event_id (invariant 3).
    expect(vi.mocked(streamingApi.saveLink).mock.calls[0][1].event_id).toBeTruthy();

    // And the court's state on this page follows the write — no going back to
    // the board to find out whether it landed.
    await waitFor(() => {
      expect(screen.getByTestId(`setup-source-${COURT_A}`)).toHaveTextContent(
        "This day",
      );
    });
  });

  it("shows a court that is already live its link, prefilled and clearable", async () => {
    mount();
    await openCourtB();

    expect(screen.getByTestId(`setup-link-${COURT_B}-input`)).toHaveValue(YT);
    expect(screen.getByTestId(`setup-effective-${COURT_B}`)).toHaveAttribute(
      "href",
      YT,
    );
    expect(screen.getByTestId(`setup-link-${COURT_B}-clear`)).toBeInTheDocument();
  });

  it("warns about a channel /live paste before spending a round trip", async () => {
    mount();
    await userEvent.type(
      await screen.findByTestId(`setup-link-${COURT_A}-input`),
      "https://www.youtube.com/@school/live",
    );

    expect(
      await screen.findByTestId(`setup-link-${COURT_A}-warning`),
    ).toHaveTextContent(/channel-level/);
    // Advisory only — the server is the authority, so Save stays live.
    expect(screen.getByTestId(`setup-link-${COURT_A}-save`)).toBeEnabled();
  });

  it("keeps the troubleshooting notes to hand without leading with them", async () => {
    mount();
    const toggle = await screen.findByTestId("setup-help-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const body = screen.getByTestId("setup-help-body");
    expect(body).toHaveTextContent(/Amber means nothing has been confirmed/);
    expect(body).toHaveTextContent(/matched against the fixture's venue text/);
  });

  it("gets back to the board it came from", async () => {
    mount();
    expect(await screen.findByTestId("setup-back")).toHaveAttribute(
      "href",
      "/tournaments/t1/streams",
    );
  });

  it("a non-manager can read the setup but not publish a link", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue({
      ...MANAGER,
      can_manage: false,
    });
    mount();

    expect(await screen.findByTestId(`setup-link-${COURT_A}-input`)).toBeDisabled();
    // The instructions are still readable — the gate is on publishing, not on
    // knowing how to point a phone at a court.
    expect(screen.getByTestId(`qr-${COURT_A}`)).toBeInTheDocument();
  });

  it("says so plainly when there are no courts yet", async () => {
    vi.mocked(streamingApi.courtStreams).mockResolvedValue({ court_streams: [] });
    mount();

    expect(await screen.findByTestId("setup-no-courts")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^setup-court-/)).toHaveLength(0);
  });

  it("shows no half-built URL before the tournament's slug has loaded", async () => {
    vi.mocked(tournamentsApi.get).mockResolvedValue({
      ...TOURNAMENT,
      slug: "",
    } as Tournament);
    mount();

    expect(await screen.findByTestId(`setup-no-slug-${COURT_A}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`camera-url-${COURT_A}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`qr-${COURT_A}`)).not.toBeInTheDocument();
  });
});
