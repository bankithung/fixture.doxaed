import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicFormPage } from "../PublicFormPage";
import { formsApi } from "@/api/forms";
import type { FormSchema } from "../types";

vi.mock("@/api/forms");

/**
 * Sepak / Table Tennis example schema:
 *   school → competition (single_choice with per-option goto) →
 *   conditional Sepak categories vs TT categories → confirm.
 * Choosing "Sepak Takraw only" must reach the Sepak section and NEVER the TT
 * one (the shared `formLogic` traversal drives this, mirroring the backend).
 */
const schema: FormSchema = {
  version: 1,
  sections: [
    {
      key: "school",
      title: "Your school",
      fields: [
        {
          key: "school_name",
          type: "short_text",
          label: "School name",
          required: true,
          role: "title",
        },
      ],
    },
    {
      key: "competition",
      title: "Competition",
      fields: [
        {
          key: "competition",
          type: "single_choice",
          label: "Which competition?",
          required: true,
          options: [
            { value: "sepak", label: "Sepak Takraw only", goto: "sepak" },
            { value: "tt", label: "Table Tennis only", goto: "tt" },
          ],
        },
      ],
    },
    {
      key: "sepak",
      title: "Sepak categories",
      visibility: { field: "competition", op: "in", value: ["sepak", "both"] },
      next: "confirm",
      fields: [
        {
          key: "sepak_cats",
          type: "multi_choice",
          label: "Sepak categories",
          required: true,
          options: [{ value: "u14b", label: "U14 Boys" }],
        },
      ],
    },
    {
      key: "tt",
      title: "Table Tennis categories",
      visibility: { field: "competition", op: "in", value: ["tt", "both"] },
      next: "confirm",
      fields: [
        {
          key: "tt_cats",
          type: "multi_choice",
          label: "TT categories",
          required: true,
          options: [{ value: "u14b", label: "U14 Boys" }],
        },
      ],
    },
    {
      key: "confirm",
      title: "Confirm",
      fields: [
        {
          key: "agree",
          type: "single_choice",
          label: "I confirm the entries are correct",
          required: true,
          options: [{ value: "yes", label: "Yes" }],
        },
      ],
    },
  ],
};

function renderPage(path = "/f/form1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/f/:formId" element={<PublicFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicFormPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("walks the chosen branch, hides the other, and submits only reachable answers", async () => {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Nagaland Schools Cup",
      form: {
        id: "form1",
        title: "Inter-School Registration",
        description: "Register your school's entries.",
        schema,
        confirmation_message: "Thanks! Send documents by 20 Aug 2026.",
      },
    });
    vi.mocked(formsApi.publicSubmit).mockResolvedValue({
      response_id: "r1",
      message: "Thanks! Send documents by 20 Aug 2026.",
    });

    renderPage();
    await screen.findByRole("heading", { name: /inter-school registration/i });

    // Section 1: school name → Next.
    await userEvent.type(screen.getByLabelText(/school name/i), "Mount Hermon");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    // Section 2: choose Sepak Takraw only → Next.
    await userEvent.click(screen.getByLabelText(/sepak takraw only/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    // Section 3 should be the Sepak categories — the TT branch must NOT appear.
    expect(screen.getByLabelText(/u14 boys/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /sepak categories/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /table tennis categories/i }),
    ).toBeNull();

    await userEvent.click(screen.getByLabelText(/u14 boys/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    // Final section: confirm → Submit.
    await userEvent.click(screen.getByLabelText(/^yes$/i));
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(formsApi.publicSubmit).toHaveBeenCalled());
    const [formId, body] = vi.mocked(formsApi.publicSubmit).mock.calls[0];
    expect(formId).toBe("form1");
    expect(body.answers).toMatchObject({
      school_name: "Mount Hermon",
      competition: "sepak",
      sepak_cats: ["u14b"],
      agree: "yes",
    });
    // The hidden TT branch must never contribute an answer.
    expect(body.answers).not.toHaveProperty("tt_cats");
    expect(typeof body.event_id).toBe("string");
    expect(body.event_id.length).toBeGreaterThan(0);

    // Confirmation message from the server is shown.
    expect(
      await screen.findByText(/send documents by 20 aug 2026/i),
    ).toBeInTheDocument();
  });

  it("renders a closed state when the form is not accepting submissions", async () => {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Nagaland Schools Cup",
      closed: true,
    });

    renderPage();
    expect(
      await screen.findByText(/registration (is )?closed/i),
    ).toBeInTheDocument();
    // No submit button on a closed form.
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });
});
