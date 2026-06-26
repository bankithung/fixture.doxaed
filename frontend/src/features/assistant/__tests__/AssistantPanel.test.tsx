import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantWidget } from "../AssistantPanel";
import { useAssistantStore } from "../assistantStore";
import { assistantApi } from "@/api/assistant";

vi.mock("@/api/assistant", () => ({
  assistantApi: { chat: vi.fn() },
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAssistantStore.setState({ open: false, byTournament: {} });
});

describe("AssistantWidget", () => {
  it("renders nothing for non-managers", () => {
    wrap(<AssistantWidget tournamentId="t1" canManage={false} />);
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
  });

  it("opens the panel and shows starter suggestions", async () => {
    wrap(<AssistantWidget tournamentId="t1" canManage />);
    await userEvent.click(screen.getByTestId("assistant-launcher"));
    expect(screen.getByTestId("assistant-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("assistant-suggestion").length).toBeGreaterThan(0);
  });

  it("sends a message and renders the reply + action receipts", async () => {
    vi.mocked(assistantApi.chat).mockResolvedValue({
      reply: "Dates are set.",
      actions: [{ label: "Match days set to Aug 1–3", ok: true }],
      changed: true,
    });
    wrap(<AssistantWidget tournamentId="t1" canManage />);
    await userEvent.click(screen.getByTestId("assistant-launcher"));

    await userEvent.type(screen.getByTestId("assistant-input"), "set dates aug 1 to 3");
    await userEvent.click(screen.getByTestId("assistant-send"));

    // User bubble shows immediately; assistant reply + receipt after resolve.
    expect(screen.getByText("set dates aug 1 to 3")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Dates are set.")).toBeInTheDocument(),
    );
    expect(screen.getByText("Match days set to Aug 1–3")).toBeInTheDocument();

    // The history sent carries the user's message.
    expect(assistantApi.chat).toHaveBeenCalledWith("t1", [
      { role: "user", content: "set dates aug 1 to 3" },
    ]);
  });

  it("shows a friendly error bubble when the call fails", async () => {
    vi.mocked(assistantApi.chat).mockRejectedValue(new Error("boom"));
    wrap(<AssistantWidget tournamentId="t1" canManage />);
    await userEvent.click(screen.getByTestId("assistant-launcher"));
    await userEvent.type(screen.getByTestId("assistant-input"), "hi");
    await userEvent.click(screen.getByTestId("assistant-send"));
    await waitFor(() =>
      expect(screen.getByText("Couldn't reach the assistant")).toBeInTheDocument(),
    );
  });
});
