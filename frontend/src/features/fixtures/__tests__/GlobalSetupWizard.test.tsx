import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfig,
  type TournamentSettings,
} from "@/api/tournaments";
import { qk } from "@/lib/queryKeys";
import { GlobalSetupWizard } from "../GlobalSetupWizard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      updateDrawConfig: vi.fn(),
      venues: vi.fn(),
      createVenue: vi.fn(),
      updateVenue: vi.fn(),
      deleteVenue: vi.fn(),
      settings: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

const DEFAULTS = { format: "round_robin" } as unknown as DrawConfig;

const SETTINGS = {
  rules: {},
  constraints: [],
  rules_frozen_at: null,
  can_edit: true,
  can_manage: true,
  can_delete: true,
} as unknown as TournamentSettings;

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: {},
    defaults: DEFAULTS,
  });
  vi.mocked(tournamentsApi.venues).mockResolvedValue({ venues: [] });
  vi.mocked(tournamentsApi.settings).mockResolvedValue(SETTINGS);
  vi.mocked(tournamentsApi.updateSettings).mockResolvedValue(SETTINGS);
  vi.mocked(tournamentsApi.updateDrawConfig).mockResolvedValue({
    leaf_key: "*",
    draw_config: {},
    effective: DEFAULTS,
    has_matches: false,
  });
  vi.mocked(tournamentsApi.createVenue).mockResolvedValue({
    id: "v-new",
    name: "MP Hall",
    venue_type: "hall",
    windows: [],
    count: 4,
  });
});

async function toStep(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
  }
}

describe("GlobalSetupWizard", () => {
  it("saves calendar, constraints and venues across the three channels", async () => {
    wrap(<GlobalSetupWizard tournamentId="t1" onClose={() => {}} />);
    // Step 0 — calendar + blackout chips.
    fireEvent.change(await screen.findByLabelText("First match day"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Last match day"), {
      target: { value: "2026-08-05" },
    });
    fireEvent.change(screen.getByTestId("blackouts-input"), {
      target: { value: "2026-08-02" },
    });
    await userEvent.click(screen.getByTestId("blackouts-add"));
    expect(screen.getByTestId("blackouts")).toHaveTextContent("2026-08-02");

    // Step 1 — add a venue with a count.
    await toStep(1);
    await userEvent.click(screen.getByTestId("add-venue"));
    fireEvent.change(screen.getByTestId("venue-name-0"), {
      target: { value: "MP Hall" },
    });
    fireEvent.change(screen.getByTestId("venue-count-0"), {
      target: { value: "4" },
    });

    // Step 2 — defaults; Sunday church is ON by default (first run).
    await toStep(1);
    expect(screen.getByTestId("sunday-church")).toBeChecked();

    // Step 3 — review + save.
    await toStep(1);
    await userEvent.click(screen.getByTestId("save-global-setup"));

    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
        leaf_key: "*",
        config: {
          calendar: {
            date_start: "2026-08-01",
            date_end: "2026-08-05",
            daily_start: "09:00",
            daily_end: "18:00",
            slot_minutes: 90,
          },
        },
        event_id: expect.any(String),
      }),
    );
    expect(tournamentsApi.createVenue).toHaveBeenCalledWith("t1", {
      name: "MP Hall",
      venue_type: "ground",
      windows: [],
      count: 4,
      sports: [],
      breaks: [],
    });
    const constraints =
      vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1].constraints!;
    const byType = Object.fromEntries(constraints.map((c) => [c.type, c]));
    expect(byType.blackout_dates.params).toEqual({ dates: ["2026-08-02"] });
    expect(byType.recurring_blackout_window.params).toEqual({
      days: ["sun"],
      from: "00:00",
      to: "13:00",
      label: "sunday_church",
    });
    expect(byType.min_rest_minutes.params).toEqual({ minutes: 60 });
    expect(byType.max_matches_per_team_per_day.params).toEqual({ count: 1 });
  });

  it("prefills stored values and preserves unmanaged constraint records", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": {
          calendar: {
            date_start: "2026-08-01",
            date_end: "2026-08-03",
            daily_start: "08:00",
            daily_end: "17:00",
            slot_minutes: 60,
          },
        },
      },
      defaults: DEFAULTS,
    });
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      ...SETTINGS,
      constraints: [
        {
          type: "team_unavailable",
          scope: "team:abc",
          hard: true,
          weight: 5,
          params: { team_id: "abc", dates: ["2026-08-02"] },
        },
        {
          type: "blackout_dates",
          scope: "all",
          hard: true,
          weight: 5,
          params: { dates: ["2026-08-03"] },
        },
      ],
    });
    vi.mocked(tournamentsApi.venues).mockResolvedValue({
      venues: [
        { id: "v1", name: "Main Ground", venue_type: "ground", windows: [], count: 1 },
      ],
    });

    wrap(<GlobalSetupWizard tournamentId="t1" onClose={() => {}} />);
    expect(await screen.findByLabelText("First match day")).toHaveValue(
      "2026-08-01",
    );
    expect(screen.getByTestId("blackouts")).toHaveTextContent("2026-08-03");

    // Walk through untouched and save.
    await toStep(3);
    // Stored calendar exists → church reflects the absent record (off).
    await userEvent.click(screen.getByTestId("save-global-setup"));

    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalled(),
    );
    const constraints =
      vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1].constraints!;
    // Scoped record preserved verbatim; managed blackout re-emitted.
    expect(
      constraints.find((c) => c.type === "team_unavailable")?.scope,
    ).toBe("team:abc");
    expect(
      constraints.find((c) => c.type === "blackout_dates")?.params.dates,
    ).toEqual(["2026-08-03"]);
    expect(
      constraints.some((c) => c.type === "recurring_blackout_window"),
    ).toBe(false);
    // Unchanged venue → no writes, no deletes.
    expect(tournamentsApi.updateVenue).not.toHaveBeenCalled();
    expect(tournamentsApi.deleteVenue).not.toHaveBeenCalled();
    expect(tournamentsApi.createVenue).not.toHaveBeenCalled();
  });

  it("auto-detects ceremony dates from the match window", async () => {
    wrap(<GlobalSetupWizard tournamentId="t1" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("First match day"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Last match day"), {
      target: { value: "2026-08-05" },
    });
    // Adding the opening ceremony prefills its date with the first match day…
    await userEvent.click(screen.getByTestId("opening-add"));
    expect(screen.getByTestId("opening-date")).toHaveValue("2026-08-01");
    // …and the closing ceremony with the last match day.
    await userEvent.click(screen.getByTestId("closing-add"));
    expect(screen.getByTestId("closing-date")).toHaveValue("2026-08-05");
  });

  it("opens at the deep-linked step, rendered inline (not as a modal)", async () => {
    wrap(
      <GlobalSetupWizard tournamentId="t1" onClose={() => {}} initialStep={1} />,
    );
    expect(await screen.findByTestId("add-venue")).toBeInTheDocument();
    // full-page panel: heading + reassurance line, zero Dialog chrome
    const panel = screen.getByTestId("global-setup-inline");
    expect(
      within(panel).getByText("Step 1 · When & where"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("absorbs calendar changes made elsewhere while the form is pristine", async () => {
    // Open with no stored calendar (fields blank).
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {},
      defaults: DEFAULTS,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <GlobalSetupWizard tournamentId="t1" onClose={() => {}} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("First match day")).toHaveValue("");

    // The assistant writes dates behind the open wizard → the query refetches.
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": {
          calendar: {
            date_start: "2026-07-01",
            date_end: "2026-07-02",
            daily_start: "09:00",
            daily_end: "18:00",
            slot_minutes: 45,
          },
        },
      },
      defaults: DEFAULTS,
    });
    await client.invalidateQueries({ queryKey: qk.drawConfig("t1") });

    // Pristine form picks up the new dates without a remount.
    await waitFor(() =>
      expect(screen.getByLabelText("First match day")).toHaveValue("2026-07-01"),
    );
    expect(screen.getByLabelText("Last match day")).toHaveValue("2026-07-02");
  });

  it("does not clobber an in-progress edit when data changes elsewhere", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {},
      defaults: DEFAULTS,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <GlobalSetupWizard tournamentId="t1" onClose={() => {}} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    // User starts typing a date → the form is now dirty.
    fireEvent.change(await screen.findByLabelText("First match day"), {
      target: { value: "2026-09-09" },
    });

    // A concurrent change lands and refetches…
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": { calendar: { date_start: "2026-07-01", date_end: "2026-07-02" } },
      },
      defaults: DEFAULTS,
    });
    await client.invalidateQueries({ queryKey: qk.drawConfig("t1") });

    // …but the user's in-progress edit is preserved (not overwritten).
    await waitFor(() => expect(tournamentsApi.drawConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("First match day")).toHaveValue("2026-09-09");
  });

  it("overall break mode: saves one daily_break window, no per-venue break", async () => {
    wrap(<GlobalSetupWizard tournamentId="t1" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("First match day"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Last match day"), {
      target: { value: "2026-08-05" },
    });

    // Step 1 — Venues. Overall is the default break mode; its inputs are here.
    await toStep(1);
    await userEvent.click(screen.getByTestId("add-venue"));
    fireEvent.change(screen.getByTestId("venue-name-0"), {
      target: { value: "MP Hall" },
    });
    // Per-venue inputs are hidden in overall mode.
    expect(screen.queryByLabelText("Venue break starts at")).toBeNull();
    fireEvent.change(screen.getByLabelText("Daily break starts at"), {
      target: { value: "13:00" },
    });
    fireEvent.change(screen.getByLabelText("Daily break ends at"), {
      target: { value: "14:00" },
    });

    await toStep(2); // play times → review
    await userEvent.click(screen.getByTestId("save-global-setup"));

    await waitFor(() =>
      expect(tournamentsApi.createVenue).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ name: "MP Hall", breaks: [] }),
      ),
    );
    const constraints =
      vi.mocked(tournamentsApi.updateSettings).mock.calls.at(-1)![1].constraints!;
    const dailyBreak = constraints.find(
      (c) =>
        c.type === "recurring_blackout_window" && c.params.label === "daily_break",
    );
    expect(dailyBreak?.params).toEqual({
      days: [],
      from: "13:00",
      to: "14:00",
      label: "daily_break",
    });
  });

  it("per-venue break mode: saves Venue.breaks, no daily_break window", async () => {
    wrap(<GlobalSetupWizard tournamentId="t1" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("First match day"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Last match day"), {
      target: { value: "2026-08-05" },
    });

    await toStep(1); // Venues
    await userEvent.click(screen.getByTestId("break-mode-per-venue"));
    await userEvent.click(screen.getByTestId("add-venue"));
    fireEvent.change(screen.getByTestId("venue-name-0"), {
      target: { value: "MP Hall" },
    });
    fireEvent.change(screen.getByLabelText("Venue break starts at"), {
      target: { value: "12:00" },
    });
    fireEvent.change(screen.getByLabelText("Venue break ends at"), {
      target: { value: "13:00" },
    });

    await toStep(2); // play times → review
    await userEvent.click(screen.getByTestId("save-global-setup"));

    await waitFor(() =>
      expect(tournamentsApi.createVenue).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          name: "MP Hall",
          breaks: [{ from: "12:00", to: "13:00" }],
        }),
      ),
    );
    const constraints =
      vi.mocked(tournamentsApi.updateSettings).mock.calls.at(-1)![1].constraints!;
    expect(
      constraints.find(
        (c) =>
          c.type === "recurring_blackout_window" &&
          c.params.label === "daily_break",
      ),
    ).toBeUndefined();
  });
});
