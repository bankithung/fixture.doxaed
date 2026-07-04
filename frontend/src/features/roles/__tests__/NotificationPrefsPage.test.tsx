import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationPrefsPage } from "../NotificationPrefsPage";
import { ToastProvider } from "@/components/ui/toast";
import { notificationsApi, type NotificationPrefs } from "@/api/notifications";

vi.mock("@/api/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/notifications")>();
  return {
    ...actual,
    notificationsApi: {
      ...actual.notificationsApi,
      prefs: vi.fn(),
      updatePrefs: vi.fn(),
      list: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
    },
  };
});

const PREFS: NotificationPrefs = {
  kinds: [
    {
      kind: "match_assignment",
      label: "Match assignments",
      description: "You are named scorer or official for a match.",
      in_app: true,
      email: true,
    },
    {
      kind: "dispute_raised",
      label: "Disputes raised",
      description: "A team raises a dispute in a tournament you manage.",
      in_app: true,
      email: false,
    },
  ],
  digest: false,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <NotificationPrefsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(notificationsApi.prefs).mockResolvedValue(PREFS);
  vi.mocked(notificationsApi.updatePrefs).mockResolvedValue(PREFS);
  vi.mocked(notificationsApi.list).mockResolvedValue({
    results: [
      {
        id: "n1",
        kind: "match_assignment",
        title: "You are assigned to score: A vs B",
        body: "Cup A",
        url: "/tournaments/t1/matches/m1",
        read_at: null,
        created_at: "2026-07-04T10:00:00Z",
        tournament: null,
      },
      {
        id: "n2",
        kind: "dispute_raised",
        title: "New dispute raised",
        body: "",
        url: "",
        read_at: "2026-07-04T11:00:00Z",
        created_at: "2026-07-03T10:00:00Z",
        tournament: null,
      },
    ],
    unread_count: 1,
  });
});

describe("NotificationPrefsPage", () => {
  it("renders the live matrix inside the settings drawer", async () => {
    renderPage();
    await userEvent.click(await screen.findByTestId("open-notification-settings"));
    expect(await screen.findByText("Match assignments")).toBeInTheDocument();
    const matrix = screen.getByTestId("prefs-matrix");
    expect(within(matrix).getByTestId("toggle-match_assignment-email")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(matrix).getByTestId("toggle-dispute_raised-email")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // No placeholder copy anywhere.
    expect(screen.queryByText(/coming in phase/i)).not.toBeInTheDocument();
  });

  it("saves a channel flip and the toggle lands flipped", async () => {
    // The real server echoes the updated matrix; mirror that here.
    const flipped: NotificationPrefs = {
      ...PREFS,
      kinds: PREFS.kinds.map((k) =>
        k.kind === "match_assignment" ? { ...k, email: false } : k,
      ),
    };
    vi.mocked(notificationsApi.prefs)
      .mockResolvedValueOnce(PREFS)
      .mockResolvedValue(flipped);
    vi.mocked(notificationsApi.updatePrefs).mockResolvedValue(flipped);

    renderPage();
    await userEvent.click(await screen.findByTestId("open-notification-settings"));
    const toggle = await screen.findByTestId("toggle-match_assignment-email");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(notificationsApi.updatePrefs).toHaveBeenCalledWith({
        kinds: { match_assignment: { email: false } },
      }),
    );
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("shows the full inbox with unread state and mark-all-read", async () => {
    renderPage();
    await screen.findByText("You are assigned to score: A vs B");
    const inbox = within(screen.getByTestId("notifications-inbox"));
    expect(
      inbox.getByText("You are assigned to score: A vs B"),
    ).toBeInTheDocument();
    expect(inbox.getByText("New dispute raised")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();
    // Deep-linked rows are links to their target.
    expect(
      inbox.getByRole("link", { name: /assigned to score/i }),
    ).toHaveAttribute("href", "/tournaments/t1/matches/m1");
    await userEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() =>
      expect(notificationsApi.markAllRead).toHaveBeenCalled(),
    );
  });

  it("filters the inbox by read state", async () => {
    renderPage();
    await screen.findByText("You are assigned to score: A vs B");
    await userEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.queryByText("New dispute raised")).not.toBeInTheDocument();
    expect(
      screen.getByText("You are assigned to score: A vs B"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByText("New dispute raised")).toBeInTheDocument();
    expect(
      screen.queryByText("You are assigned to score: A vs B"),
    ).not.toBeInTheDocument();
  });

  it("saves the digest opt-in", async () => {
    renderPage();
    await userEvent.click(await screen.findByTestId("open-notification-settings"));
    const toggle = await screen.findByTestId("toggle-digest");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(notificationsApi.updatePrefs).toHaveBeenCalledWith({ digest: true }),
    );
  });
});
