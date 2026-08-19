import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { institutionsApi } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import { TeamsTab } from "../tabs/TeamsTab";

/**
 * The access-codes drawer shows the codes (owner 2026-08-19: "here it should
 * show the codes for all so that i can see and copy too"). Before this it said
 * only "Code sent", which cannot answer a school phoning to ask what its code
 * is.
 *
 * Two things the UI must never get wrong, both asserted here: a code that
 * exists only as a hash is reported as unreadable rather than blank or absent
 * (blank reads as "this school has no code", which would send the host down
 * the wrong path), and the copy affordances hand over the real code.
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      teams: vi.fn(),
      sports: vi.fn(),
      stage: vi.fn(),
      teamCodes: vi.fn(),
      issueTeamCodes: vi.fn(),
    },
  };
});
vi.mock("@/api/institutions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/institutions")>();
  return {
    ...actual,
    institutionsApi: { ...actual.institutionsApi, list: vi.fn() },
  };
});
vi.mock("@/api/forms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/forms")>();
  return { ...actual, formsApi: { ...actual.formsApi, list: vi.fn() } };
});

const INSTS = [
  { id: "i1", name: "Grace Academy", contact_email: "grace@s.test", has_team_code: true },
  { id: "i2", name: "Christ School", contact_email: "christ@s.test", has_team_code: true },
];

const CODES = {
  codes: [
    {
      institution_id: "i1", name: "Grace Academy",
      contact_email: "grace@s.test", code: "H7KMPQ34",
      has_code: true, readable: true, sent_at: null, grace_until: null,
    },
    {
      institution_id: "i2", name: "Christ School",
      contact_email: "christ@s.test", code: "",
      has_code: true, readable: false, sent_at: null, grace_until: null,
    },
  ],
  form_url: "https://fixture.doxaed.com/f/f1",
};

const writeText = vi.fn().mockResolvedValue(undefined);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/teams"]}>
          <Routes>
            <Route path="/tournaments/:id/teams" element={<TeamsTab />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TEAM_FORM = {
  id: "f1",
  title: "Team registration",
  purpose: "team_registration",
  stage: "team_registration",
  status: "open",
};

async function openDrawer() {
  mount();
  await userEvent.click(await screen.findByTestId("form-tools-menu"));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: /access codes/i }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  vi.mocked(tournamentsApi.teams).mockResolvedValue([]);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({ sports: [] } as never);
  vi.mocked(tournamentsApi.stage).mockResolvedValue({
    can_manage: true,
  } as never);
  vi.mocked(tournamentsApi.teamCodes).mockResolvedValue(CODES as never);
  vi.mocked(tournamentsApi.issueTeamCodes).mockResolvedValue({
    sent: 0, failed: 0, no_email: 0, skipped: 0, minted: 1,
    no_email_institutions: [], failed_institutions: [],
  } as never);
  vi.mocked(institutionsApi.list).mockResolvedValue(INSTS as never);
  vi.mocked(formsApi.list).mockResolvedValue([TEAM_FORM] as never);
});

describe("Team access codes drawer", () => {
  it("shows a readable code and copies it", async () => {
    await openDrawer();
    expect(await screen.findByTestId("code-i1")).toHaveTextContent("H7KMPQ34");

    await userEvent.click(
      screen.getByRole("button", { name: /Copy the code for Grace Academy/i }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("H7KMPQ34"));
  });

  it("says a pre-existing code is not readable rather than showing a blank", async () => {
    await openDrawer();
    await screen.findByTestId("code-i1");
    // No code box for the hash-only school...
    expect(screen.queryByTestId("code-i2")).toBeNull();
    // ...and the row explains why instead of looking like it has no code.
    expect(
      screen.getByText("Code not readable, it was issued earlier"),
    ).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("copies every readable code as one school-and-code list", async () => {
    await openDrawer();
    await screen.findByTestId("code-i1");
    await userEvent.click(screen.getByTestId("copy-all-codes"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Grace Academy: H7KMPQ34"),
    );
  });

  it("offers to mint the unreadable ones, and says the old codes keep working", async () => {
    await openDrawer();
    const cta = await screen.findByTestId("reveal-codes");
    expect(cta).toHaveTextContent("Show the other 1");
    expect(cta).toHaveAttribute(
      "title",
      expect.stringContaining("keeps working for 7 days"),
    );

    await userEvent.click(cta);
    await waitFor(() =>
      expect(tournamentsApi.issueTeamCodes).toHaveBeenCalledWith("t1", {
        reveal: true,
      }),
    );
  });

  it("does not fetch the codes for a member who cannot manage", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue({
      can_manage: false,
    } as never);
    mount();
    await waitFor(() => expect(institutionsApi.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(tournamentsApi.teamCodes).not.toHaveBeenCalled();
  });
});
