import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { InviteCreateModal } from "../InviteCreateModal";
import { orgsApi } from "@/api/orgs";
import { ApiError } from "@/types/api";
import type { OrgInvitation } from "@/types/user";

function renderModal(open = true): {
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <InviteCreateModal
          orgSlug="acme"
          open={open}
          onOpenChange={onOpenChange}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  // Stable UUID for the event_id assertion.
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => "11111111-2222-3333-4444-555555555555",
    configurable: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("InviteCreateModal", () => {
  it("renders form fields and the v1Users role catalog", () => {
    renderModal();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    // every catalog role is rendered as a checkbox
    [
      "Admin",
      "Co-organizer",
      "Game coordinator",
      "Match scorer",
      "Referee",
      "Team manager",
    ].forEach((label) => {
      expect(
        screen.getByRole("checkbox", { name: new RegExp(label, "i") }),
      ).toBeInTheDocument();
    });
  });

  it("submits successfully and reveals the token + share link", async () => {
    const sent: OrgInvitation = {
      id: "inv-1",
      org_id: "o1",
      email: "newbie@example.com",
      roles: ["admin"],
      status: "pending",
      invited_by_email: "owner@example.com",
      expires_at: "2099-01-01T00:00:00Z",
      token: "tok-secret-abc",
    };
    const spy = vi.spyOn(orgsApi, "createInvitation").mockResolvedValue(sent);

    renderModal();

    const email = screen.getByLabelText(/^email$/i);
    await userEvent.clear(email);
    await userEvent.type(email, "newbie@example.com");

    await userEvent.click(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith("acme", {
      email: "newbie@example.com",
      roles: ["admin"],
      event_id: "11111111-2222-3333-4444-555555555555",
    });

    // Sent view: token + share link visible.
    const tokenInput = await screen.findByTestId("invite-token");
    expect((tokenInput as HTMLInputElement).value).toBe("tok-secret-abc");
    const linkInput = screen.getByTestId("invite-link") as HTMLInputElement;
    expect(linkInput.value).toContain("/accept?token=tok-secret-abc");
  });

  it("shows the backend error message when creation fails", async () => {
    vi.spyOn(orgsApi, "createInvitation").mockRejectedValue(
      new ApiError(400, { detail: "Email already invited" }),
    );

    renderModal();
    await userEvent.type(
      screen.getByLabelText(/^email$/i),
      "dupe@example.com",
    );
    await userEvent.click(screen.getByTestId("invite-submit"));

    const err = await screen.findByTestId("invite-error");
    expect(err.textContent).toMatch(/already invited/i);
    // Form is still showing — token surface should NOT be present.
    expect(screen.queryByTestId("invite-token")).toBeNull();
  });

  it("blocks submit and shows an email error for invalid input", async () => {
    const spy = vi.spyOn(orgsApi, "createInvitation");
    renderModal();

    const emailInput = screen.getByLabelText(/^email$/i) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    const form = emailInput.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(await screen.findByTestId("email-error")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires at least one role", async () => {
    const spy = vi.spyOn(orgsApi, "createInvitation");
    renderModal();

    // Uncheck the default-checked Admin role via fireEvent for jsdom stability.
    const adminCheckbox = screen.getByRole("checkbox", {
      name: /admin/i,
    }) as HTMLInputElement;
    fireEvent.click(adminCheckbox);
    expect(adminCheckbox.checked).toBe(false);

    const emailInput = screen.getByLabelText(/^email$/i) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "valid@example.com" } });
    const form = emailInput.closest("form");
    fireEvent.submit(form as HTMLFormElement);

    expect(await screen.findByTestId("roles-error")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
