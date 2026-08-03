import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type TournamentMember,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { BulkAssignDialog } from "../BulkAssignDialog";

/** A client-side timeout/abort: the response never arrived, but the server may
 * well have committed the write (production bug, 2026-08). */
function timeoutError(): Error {
  return Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
}

const RESULT = {
  assigned: 1,
  skipped: 1,
  total: 2,
  warnings: [] as { match_id: string; code: string; count: number }[],
  scope: "court",
  key: "T1",
};

/** The `event_id` sent on the nth bulkAssignCrew call. */
function eventIdOf(call: number): string {
  return vi.mocked(tournamentsApi.bulkAssignCrew).mock.calls[call]![1].event_id;
}

/** Pick "Ada Ref" in the person combobox (submit stays disabled until then). */
async function pickPerson(): Promise<void> {
  await userEvent.click(screen.getByLabelText("Person"));
  await userEvent.click(await screen.findByText(/Ada Ref/));
}

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      members: vi.fn(),
      bulkAssignCrew: vi.fn(),
    },
  };
});

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
    sport: "sepak_takraw",
    set_scores: [],
    leaf_key: "sepak.u14.girls",
    venue: "T1",
    scoring: null,
    scheduled_at: "2026-08-29T04:00:00Z",
    locked_at: null,
    leaf_label: "Sepak Takraw · u-14 · girls",
    scorer: null,
    officials: [],
    ...over,
  };
}

// Two matches on T1 (one already has a scorer), one on T2.
const MATCHES: ControlRoomMatch[] = [
  match({ id: "m1", venue: "T1" }),
  match({ id: "m2", venue: "T1", scorer: { id: "u1", name: "Scott" } }),
  match({ id: "m3", venue: "T2", match_no: 3 }),
];

const MEMBERS: TournamentMember[] = [
  {
    id: "mem1",
    user_id: "u9",
    full_name: "Ada Ref",
    email: "ada@test.local",
    role: "referee",
    status: "active",
  } as TournamentMember,
];

function mount(props?: Partial<React.ComponentProps<typeof BulkAssignDialog>>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BulkAssignDialog
          tournamentId="t1"
          day="2026-08-29"
          matches={MATCHES}
          canManage
          canAssignOfficials
          initialScope="court"
          initialKey="T1"
          onClose={onClose}
          {...props}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, invalidate, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.members).mockResolvedValue(MEMBERS);
  vi.mocked(tournamentsApi.bulkAssignCrew).mockResolvedValue({ ...RESULT });
});

afterEach(() => vi.clearAllMocks());

describe("BulkAssignDialog", () => {
  it("previews assign/skip for the scope with only-unassigned on", async () => {
    mount();
    // T1 has 2 matches; one already has a scorer → 1 to assign, 1 skipped.
    const preview = await screen.findByTestId("bulk-preview");
    expect(preview).toHaveTextContent("1");
    expect(preview).toHaveTextContent(/skip 1/i);
  });

  it("submits the right payload and toasts a summary", async () => {
    const { onClose } = mount();
    await pickPerson();

    await userEvent.click(screen.getByTestId("bulk-submit"));

    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          scope: "court",
          key: "T1",
          day: "2026-08-29",
          role: "scorer",
          user_id: "u9",
          only_unassigned: true,
        }),
      ),
    );
    // Success still reports the counts and closes the dialog.
    expect(await screen.findByText(/Assigned 1/)).toBeInTheDocument();
    expect(screen.getByText(/skipped 1/)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps submit disabled until a person is picked", async () => {
    mount();
    expect(await screen.findByTestId("bulk-submit")).toBeDisabled();
    await pickPerson();
    expect(screen.getByTestId("bulk-submit")).toBeEnabled();
  });

  it("disables submit when the scope has nothing to assign", async () => {
    // Every match in scope already has a scorer → nothing to do.
    mount({
      matches: [
        match({ id: "m9", venue: "T9", scorer: { id: "u1", name: "Scott" } }),
      ],
      initialKey: "T9",
    });
    await pickPerson();
    expect(screen.getByTestId("bulk-preview")).toHaveTextContent(
      /Nothing to assign/i,
    );
    expect(screen.getByTestId("bulk-submit")).toBeDisabled();
  });

  it("counts all matches when only-unassigned is unchecked", async () => {
    mount();
    await screen.findByTestId("bulk-preview");
    await userEvent.click(screen.getByTestId("bulk-only-unassigned"));
    const preview = screen.getByTestId("bulk-preview");
    // Both T1 matches now targeted, none skipped.
    expect(preview).toHaveTextContent("2");
    expect(within(preview).queryByText(/skip/i)).toBeNull();
  });

  it("retries the SAME intent with the SAME event_id, and mints a new one when the intent changes", async () => {
    vi.mocked(tournamentsApi.bulkAssignCrew)
      .mockRejectedValueOnce(new ApiError(500, { detail: "server_error" }))
      .mockResolvedValue({ ...RESULT });
    mount();
    await pickPerson();

    await userEvent.click(screen.getByTestId("bulk-submit"));
    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledTimes(1),
    );

    // Same intent, pressed again → the server can replay instead of re-running.
    await userEvent.click(screen.getByTestId("bulk-submit"));
    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledTimes(2),
    );
    expect(eventIdOf(1)).toBe(eventIdOf(0));

    // Change what's being asked for → a genuinely new write needs a new key.
    await userEvent.click(screen.getByTestId("bulk-scope-category"));
    await userEvent.click(screen.getByTestId("bulk-submit"));
    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledTimes(3),
    );
    expect(eventIdOf(2)).not.toBe(eventIdOf(0));

    // …and so does toggling only-unassigned (a different set of matches).
    await userEvent.click(screen.getByTestId("bulk-only-unassigned"));
    await userEvent.click(screen.getByTestId("bulk-submit"));
    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledTimes(4),
    );
    expect(eventIdOf(3)).not.toBe(eventIdOf(2));
  });

  it("tells the truth on a client timeout: still running, refreshing — not 'could not assign'", async () => {
    vi.mocked(tournamentsApi.bulkAssignCrew).mockRejectedValue(timeoutError());
    const { invalidate, onClose } = mount();
    await pickPerson();
    invalidate.mockClear();

    await userEvent.click(screen.getByTestId("bulk-submit"));

    // The honest message, in the toast AND in the dialog.
    expect(await screen.findByTestId("bulk-still-running")).toHaveTextContent(
      /Still assigning/i,
    );
    expect(screen.getAllByText(/Still assigning/i).length).toBeGreaterThan(1);
    expect(screen.getByText(/Refreshing to show the result/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not assign the crew/i)).toBeNull();
    expect(screen.queryByText(/^Try again\.$/)).toBeNull();

    // The UI reconciles with whatever the server actually did…
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["t-control-room", "t1"],
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["t-members", "t1"] });
    // …and the dialog stays open on the refreshed preview.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("bulk-assign-dialog")).toBeInTheDocument();
  });

  it("retrying after a timeout replays the same event_id", async () => {
    vi.mocked(tournamentsApi.bulkAssignCrew)
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValue({ ...RESULT, assigned: 14, skipped: 0, total: 14 });
    mount();
    await pickPerson();

    await userEvent.click(screen.getByTestId("bulk-submit"));
    await screen.findByTestId("bulk-still-running");

    await userEvent.click(screen.getByTestId("bulk-submit"));
    await waitFor(() =>
      expect(tournamentsApi.bulkAssignCrew).toHaveBeenCalledTimes(2),
    );
    expect(eventIdOf(1)).toBe(eventIdOf(0));
  });
});

describe("bulkAssignCrew transport", () => {
  it("gets a budget that fits the work, not the 20 s default", async () => {
    // The real API module (this file mocks tournamentsApi for the component).
    const actual =
      await vi.importActual<typeof import("@/api/tournaments")>(
        "@/api/tournaments",
      );
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(RESULT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await actual.tournamentsApi.bulkAssignCrew("t1", {
      scope: "category",
      key: "sepak.u14.girls",
      day: "2026-08-29",
      role: "scorer",
      user_id: "u9",
      only_unassigned: true,
      event_id: "ev-1",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/tournaments/t1/crew/bulk-assign/",
      expect.objectContaining({ method: "POST" }),
    );
    expect(actual.BULK_ASSIGN_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(timeoutSpy).toHaveBeenCalledWith(actual.BULK_ASSIGN_TIMEOUT_MS);
    expect(timeoutSpy).not.toHaveBeenCalledWith(20_000);

    timeoutSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});
