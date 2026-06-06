import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DisputesPanel } from "../DisputesPanel";
import { disputesApi } from "@/api/disputes";

vi.mock("@/api/disputes");

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DisputesPanel tournamentId="t1" />
    </QueryClientProvider>,
  );
}

describe("DisputesPanel", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists disputes and raises a new one", async () => {
    vi.mocked(disputesApi.list).mockResolvedValue([
      {
        id: "d1", kind: "score", description: "Wrong score", status: "open",
        resolution: "", match: null, created_at: "", reviewed_at: null,
      },
    ]);
    vi.mocked(disputesApi.raise).mockResolvedValue({
      id: "d2", kind: "conduct", description: "Bad behaviour reported",
      status: "open", resolution: "", match: null, created_at: "", reviewed_at: null,
    });
    renderPanel();

    expect(await screen.findByText("Wrong score")).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText(/describe the issue/i),
      "Bad behaviour reported",
    );
    await userEvent.click(screen.getByRole("button", { name: /raise dispute/i }));

    await waitFor(() => expect(disputesApi.raise).toHaveBeenCalled());
    const [tid, payload] = vi.mocked(disputesApi.raise).mock.calls[0];
    expect(tid).toBe("t1");
    expect(payload.description).toBe("Bad behaviour reported");
    expect(payload.event_id).toBeTruthy();
  });
});
