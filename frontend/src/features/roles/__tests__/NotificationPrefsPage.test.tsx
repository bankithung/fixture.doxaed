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
});

describe("NotificationPrefsPage", () => {
  it("renders the live matrix from the server catalog", async () => {
    renderPage();
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

  it("saves the digest opt-in", async () => {
    renderPage();
    const toggle = await screen.findByTestId("toggle-digest");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(notificationsApi.updatePrefs).toHaveBeenCalledWith({ digest: true }),
    );
  });
});
