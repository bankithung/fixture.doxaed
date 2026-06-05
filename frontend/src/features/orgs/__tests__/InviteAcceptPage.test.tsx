import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { InviteAcceptPage } from "../InviteAcceptPage";
import { orgsApi } from "@/api/orgs";
import { ApiError } from "@/types/api";

vi.mock("@/api/orgs");
// Logged-out invitee: stub the auth store with no user.
vi.mock("@/features/auth/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: null, refreshMe: () => Promise.resolve() }),
}));

function renderPage(token = "tok-123") {
  return render(
    <MemoryRouter initialEntries={[`/accept?token=${token}`]}>
      <InviteAcceptPage />
    </MemoryRouter>,
  );
}

describe("InviteAcceptPage (logged out)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates an account inline and accepts with a password", async () => {
    vi.mocked(orgsApi.acceptInvitation).mockResolvedValue({
      org_slug: "ws-1",
      tournament_id: "t1",
    });
    renderPage();

    await userEvent.type(
      screen.getByLabelText(/create a password/i),
      "BrandNewPass99!",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create account & join/i }),
    );

    await waitFor(() =>
      expect(orgsApi.acceptInvitation).toHaveBeenCalledWith(
        "tok-123",
        expect.objectContaining({ password: "BrandNewPass99!" }),
      ),
    );
    expect(await screen.findByText(/you're in/i)).toBeInTheDocument();
  });

  it("offers sign-in when the email already has an account", async () => {
    vi.mocked(orgsApi.acceptInvitation).mockRejectedValue(
      new ApiError(401, { detail: "login_required" }),
    );
    renderPage();

    await userEvent.type(
      screen.getByLabelText(/create a password/i),
      "BrandNewPass99!",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create account & join/i }),
    );

    expect(
      await screen.findByRole("link", { name: /sign in to continue/i }),
    ).toBeInTheDocument();
  });
});
