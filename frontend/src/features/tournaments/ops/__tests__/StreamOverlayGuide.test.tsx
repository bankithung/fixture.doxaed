import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import type { CourtStreamRow } from "@/api/streaming";
import { StreamOverlayGuide } from "../StreamOverlayGuide";

const COURT_A = "11111111-1111-1111-1111-111111111111";
const COURT_B = "22222222-2222-2222-2222-222222222222";

function court(over: Partial<CourtStreamRow> & { court_id: string }): CourtStreamRow {
  return {
    court_name: "Court 1",
    venue_id: "v1",
    index: 1,
    watch_url: "",
    enabled: false,
    yt_stream_id: "",
    has_stream_key: false,
    live_watch_url: null,
    is_streaming: false,
    public_link: "",
    ...over,
  };
}

const COURTS: CourtStreamRow[] = [
  // The shape that breaks hand-typed URLs: a space and a middle dot.
  court({ court_id: COURT_A, court_name: "Court2 · T3" }),
  court({ court_id: COURT_B, court_name: "Court 1", index: 2 }),
];

const ORIGIN = window.location.origin;
const URL_A = `${ORIGIN}/overlay/t/cup/t1/court/Court2%20%C2%B7%20T3`;
const URL_B = `${ORIGIN}/overlay/t/cup/t1/court/Court%201`;

function mount(courts: CourtStreamRow[] = COURTS, slug = "cup") {
  return render(
    <ToastProvider>
      <StreamOverlayGuide slug={slug} tournamentId="t1" courts={courts} />
    </ToastProvider>,
  );
}

async function open(): Promise<void> {
  await userEvent.click(screen.getByTestId("overlay-guide-toggle"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StreamOverlayGuide", () => {
  it("starts collapsed and opens from the keyboard", async () => {
    mount();
    const toggle = screen.getByTestId("overlay-guide-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("overlay-guide-body")).not.toBeInTheDocument();

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("overlay-guide-body")).toBeInTheDocument();
  });

  it("renders ONE ready-made overlay URL per court, percent-encoded", async () => {
    mount();
    await open();

    expect(screen.getByTestId(`overlay-url-${COURT_A}`)).toHaveTextContent(
      URL_A,
    );
    expect(screen.getByTestId(`overlay-url-${COURT_B}`)).toHaveTextContent(
      URL_B,
    );
    // Exactly one row per court, no more.
    expect(screen.getAllByTestId(/^overlay-url-row-/)).toHaveLength(2);
  });

  it("copies that exact string — the encoding is what OBS receives", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();
    await open();

    await userEvent.click(screen.getByTestId(`overlay-copy-${COURT_A}`));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_A));
    // A copy is announced, not silent (the toast region is a live region).
    expect(await screen.findByText("Overlay URL copied")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId(`overlay-copy-${COURT_B}`));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(URL_B));
  });

  it("names the court in the copy button, and offers the URL as text as well", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    mount();
    await open();

    // Reachable by its accessible name, not by icon alone.
    const btn = screen.getByRole("button", {
      name: "Copy the overlay URL for Court2 · T3",
    });
    await userEvent.click(btn);
    // A blocked clipboard is not a dead end: the URL is on screen, selectable.
    expect(
      await screen.findByText("Could not copy the overlay URL"),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`overlay-url-${COURT_A}`)).toHaveTextContent(
      URL_A,
    );
  });

  it("carries the OBS settings that are load-bearing, unchanged", async () => {
    mount();
    await open();

    const table = screen.getByTestId("overlay-guide-obs-settings");
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

    // The 1280x720 scale, and the reason not to drag the source.
    expect(screen.getByTestId("overlay-guide-options")).toHaveTextContent(
      "?scale=0.667",
    );
    expect(screen.getByTestId("overlay-guide-body")).toHaveTextContent(
      /Do not resize the source by dragging/,
    );
  });

  it("closes the loop back to this page's paste boxes", async () => {
    mount();
    await open();
    expect(screen.getByTestId("overlay-guide-body")).toHaveTextContent(
      /paste it into this court's box below/,
    );
    expect(screen.getByTestId("overlay-guide-body")).toHaveTextContent(
      /Watch live/,
    );
  });

  it("answers the phone question honestly: no compositor, no burned-in score", async () => {
    mount();
    await open();
    const phone = screen.getByTestId("overlay-guide-phone");
    expect(phone).toHaveTextContent(/will not get the score burned into/);
    expect(phone).toHaveTextContent(/read the live score on the public page/);
    expect(phone).toHaveTextContent(/OBS on a laptop and use the phone as the camera/);
    // No third-party app is claimed to work.
    expect(phone).toHaveTextContent(/We have not tested any of them/);
  });

  it("says so plainly when there are no courts yet", async () => {
    mount([]);
    await open();
    expect(screen.getByTestId("overlay-guide-no-courts")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^overlay-url-row-/)).toHaveLength(0);
  });

  it("shows no half-built URL before the tournament's slug has loaded", async () => {
    mount(COURTS, "");
    await open();
    expect(screen.getByTestId("overlay-guide-no-courts")).toBeInTheDocument();
  });
});
