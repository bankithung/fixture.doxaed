import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { InviteAcceptPage } from "../InviteAcceptPage";
import { orgsApi } from "@/api/orgs";
import { ApiError } from "@/types/api";

vi.mock("@/api/orgs");
// Configurable auth-store stub: tests flip `authState.user` to simulate a
// logged-out invitee vs. a signed-in (possibly wrong) account.
const hoisted = vi.hoisted(() => ({
  authState: {
    user: null as { email: string } | null,
    refreshMe: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("@/features/auth/authStore", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel(hoisted.authState),
}));

function renderPage(token = "tok-123") {
  return render(
    <MemoryRouter initialEntries={[`/accept?token=${token}`]}>
      <InviteAcceptPage />
    </MemoryRouter>,
  );
}

describe("InviteAcceptPage (logged out)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.authState.user = null;
  });

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

describe("InviteAcceptPage (signed in as the wrong account)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.authState.user = { email: "banki@example.com" };
  });

  it("warns and offers an account switch instead of silently accepting", async () => {
    vi.mocked(orgsApi.acceptInvitation).mockRejectedValue(
      new ApiError(409, {
        detail: "email_mismatch",
        invited_email: "meri@example.com",
        current_email: "banki@example.com",
      }),
    );
    renderPage();

    // A signed-in user sees a direct "Accept invite" button.
    await userEvent.click(
      screen.getByRole("button", { name: /accept invite/i }),
    );

    // The backend refuses the cross-account accept → wrong-account warning.
    expect(await screen.findByText(/meri@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/banki@example.com/)).toBeInTheDocument();

    // Switching accounts signs the wrong account out.
    await userEvent.click(
      screen.getByRole("button", { name: /switch account/i }),
    );
    expect(hoisted.authState.logout).toHaveBeenCalled();
  });
});
