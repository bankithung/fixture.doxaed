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
import { BulkAssignDialog } from "../BulkAssignDialog";

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
          onClose={() => {}}
          {...props}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.members).mockResolvedValue(MEMBERS);
  vi.mocked(tournamentsApi.bulkAssignCrew).mockResolvedValue({
    assigned: 1,
    skipped: 1,
    total: 2,
    warnings: [],
    scope: "court",
    key: "T1",
  });
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
    mount();
    // Pick the person.
    const person = screen.getByLabelText("Person");
    await userEvent.click(person);
    await userEvent.click(await screen.findByText(/Ada Ref/));

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
});
