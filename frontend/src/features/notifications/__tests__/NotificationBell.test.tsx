import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationBell } from "../NotificationBell";
import { notificationsApi } from "@/api/notifications";

vi.mock("@/api/notifications");

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationBell", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows the unread count and opens the panel", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      unread_count: 2,
      results: [
        { id: "n1", kind: "x", title: "Team registered", body: "Mount Hermon", url: "", read_at: null, created_at: "", tournament: null },
      ],
    });
    renderBell();

    expect(await screen.findByText("2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(await screen.findByText("Team registered")).toBeInTheDocument();
  });

  it("marks all read", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValue({
      unread_count: 1,
      results: [
        { id: "n1", kind: "x", title: "Hi", body: "", url: "", read_at: null, created_at: "", tournament: null },
      ],
    });
    vi.mocked(notificationsApi.markAllRead).mockResolvedValue({ marked: 1 });
    renderBell();

    await screen.findByText("1");
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await userEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() => expect(notificationsApi.markAllRead).toHaveBeenCalled());
  });
});
