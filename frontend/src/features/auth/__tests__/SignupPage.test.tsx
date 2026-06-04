import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SignupPage } from "../SignupPage";
import { authApi } from "@/api/auth";

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/signup"]}>
      <SignupPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SignupPage", () => {
  it("renders branded shell and required fields", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: /create your account/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByText(/full name/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /terms of service/i }),
    ).toBeInTheDocument();
  });

  it("blocks submit until accept-terms is checked", async () => {
    const spy = vi
      .spyOn(authApi, "signup")
      .mockResolvedValue({ user: {} as never });
    renderPage();
    await userEvent.type(screen.getByLabelText(/email/i), "a@example.com");
    await userEvent.type(
      screen.getByLabelText(/^password$/i),
      "longenoughpw123!",
    );
    await userEvent.click(screen.getByRole("button", { name: /sign up/i }));
    // signup() must NOT have been called because terms unchecked.
    await waitFor(() => {
      expect(
        screen.getByText(/you must accept the terms/i),
      ).toBeInTheDocument();
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("submits and shows confirmation card on success", async () => {
    vi.spyOn(authApi, "signup").mockResolvedValue({ user: {} as never });
    renderPage();
    await userEvent.type(screen.getByLabelText(/email/i), "a@example.com");
    await userEvent.type(
      screen.getByLabelText(/^password$/i),
      "longenoughpw123!",
    );
    // Check the terms checkbox.
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /sign up/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /check your email/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/a@example\.com/)).toBeInTheDocument();
  });

  it("shows password strength indicator", async () => {
    renderPage();
    const pw = screen.getByLabelText(/^password$/i);
    await userEvent.type(pw, "abc");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    // 'abc' is under 12 chars → progressbar value 1.
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
  });

  it("rejects malformed email", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.type(
      screen.getByLabelText(/^password$/i),
      "longenoughpw123!",
    );
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /sign up/i }));
    await waitFor(() => {
      expect(screen.getByText(/enter a valid email/i)).toBeInTheDocument();
    });
  });
});
