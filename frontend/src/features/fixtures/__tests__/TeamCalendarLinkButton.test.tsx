import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { TeamCalendarLinkButton } from "../TeamCalendarLinkButton";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      teamCalendarLink: vi.fn(),
    },
  };
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TeamCalendarLinkButton
          tournamentId="t1"
          teamId="tm1"
          teamName="Alpha FC"
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const ICS_URL =
  "https://fixture.doxaed.com/api/public/teams/tm1/calendar.ics?token=tok";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.teamCalendarLink).mockResolvedValue({
    token: "tok",
    url: ICS_URL,
  });
});

describe("TeamCalendarLinkButton", () => {
  it("mints the signed .ics URL and copies it to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();

    await userEvent.click(screen.getByTestId("calendar-link-tm1"));
    await waitFor(() =>
      expect(tournamentsApi.teamCalendarLink).toHaveBeenCalledWith("t1", "tm1"),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ICS_URL));
    expect(await screen.findByText("Calendar link copied")).toBeInTheDocument();
  });

  it("falls back to showing the URL when the clipboard is unavailable", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    mount();

    await userEvent.click(screen.getByTestId("calendar-link-tm1"));
    expect(await screen.findByText(ICS_URL)).toBeInTheDocument();
  });

  it("toasts an error when minting fails", async () => {
    vi.mocked(tournamentsApi.teamCalendarLink).mockRejectedValue(
      new Error("403"),
    );
    mount();
    await userEvent.click(screen.getByTestId("calendar-link-tm1"));
    expect(
      await screen.findByText("Could not create the calendar link"),
    ).toBeInTheDocument();
  });
});
