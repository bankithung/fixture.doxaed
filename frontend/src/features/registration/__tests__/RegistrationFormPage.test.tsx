import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegistrationFormPage } from "../RegistrationFormPage";
import { registrationApi } from "@/api/registration";

vi.mock("@/api/registration");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/register/tok1"]}>
        <Routes>
          <Route path="/register/:token" element={<RegistrationFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RegistrationFormPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("submits the school's teams + players via the link", async () => {
    vi.mocked(registrationApi.info).mockResolvedValue({
      tournament_name: "Kohima Cup",
      tournament_id: "t1",
    });
    vi.mocked(registrationApi.submit).mockResolvedValue({
      registered: 1,
      teams: ["Mount Hermon A"],
    });
    renderPage();
    await screen.findByRole("heading", { name: /kohima cup/i });

    await userEvent.type(
      screen.getByLabelText(/school \/ college name/i),
      "Mount Hermon",
    );
    await userEvent.type(screen.getByLabelText(/team name/i), "Mount Hermon A");
    await userEvent.type(screen.getAllByLabelText(/player name/i)[0], "Keeper");
    await userEvent.click(
      screen.getByRole("button", { name: /submit registration/i }),
    );

    await waitFor(() => expect(registrationApi.submit).toHaveBeenCalled());
    const [tok, payload] = vi.mocked(registrationApi.submit).mock.calls[0];
    expect(tok).toBe("tok1");
    expect(payload.school_name).toBe("Mount Hermon");
    expect(payload.teams[0].name).toBe("Mount Hermon A");
    expect(payload.teams[0].players[0].full_name).toBe("Keeper");
    expect(await screen.findByText(/registration received/i)).toBeInTheDocument();
  });

  it("shows an error for an invalid link", async () => {
    vi.mocked(registrationApi.info).mockRejectedValue(new Error("invalid"));
    renderPage();
    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument();
  });
});
