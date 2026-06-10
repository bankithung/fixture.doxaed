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
          <Route path="/r/:token" element={<PublicFormPage />} />
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

  it("prefills + locks the institution on a bound per-institution link", async () => {
    vi.mocked(formsApi.publicGetByToken).mockResolvedValue({
      tournament_name: "Cup",
      form: {
        id: "team1",
        title: "Team registration",
        description: "",
        schema: {
          version: 1,
          sections: [
            {
              key: "inst",
              title: "Your institution",
              fields: [
                {
                  key: "institution_id",
                  type: "dropdown",
                  label: "Select your institution",
                  required: true,
                  options: [],
                },
                {
                  key: "contact_email",
                  type: "email",
                  label: "Contact email",
                  required: false,
                },
              ],
            },
          ],
        },
        confirmation_message: "",
      },
      prefill: { institution_id: "i-1", contact_email: "skinner@springfield.edu" },
      locked: ["institution_id"],
      bound: { institution_id: "i-1", label: "Springfield High" },
    });

    renderPage("/r/tok1");

    // Banner names the bound institution.
    expect(await screen.findByText(/registering as/i)).toBeInTheDocument();
    expect(screen.getByText("Springfield High")).toBeInTheDocument();
    // The locked institution dropdown is hidden...
    expect(
      screen.queryByLabelText(/select your institution/i),
    ).toBeNull();
    // ...and the carried-over contact is prefilled + editable.
    expect(screen.getByLabelText(/contact email/i)).toHaveValue(
      "skinner@springfield.edu",
    );
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

  it("scopes the team form's sports/categories to the selected school, pre-selected", async () => {
    const teamSchema: FormSchema = {
      version: 1,
      sections: [
        {
          key: "institution",
          title: "Your institution",
          fields: [
            {
              key: "institution_id",
              type: "dropdown",
              label: "Select your institution",
              required: true,
              data_source: { type: "institution_list" },
              options: [
                { value: "i1", label: "Don Bosco", leaves: ["sepak.u17.male"] },
                { value: "i2", label: "Grace High", leaves: ["tt.u15"] },
              ],
            },
            {
              key: "sports",
              type: "multi_choice",
              label: "Which sport(s) are you entering teams for?",
              required: true,
              options: [
                { value: "sepak", label: "Sepak Takraw" },
                { value: "tt", label: "Table Tennis" },
              ],
            },
            {
              key: "cats_sepak",
              type: "multi_choice",
              label: "Sepak categories",
              required: true,
              visibility: { field: "sports", op: "includes", value: "sepak" },
              options: [
                { value: "sepak.u17", label: "u-17" },
                { value: "sepak.u16", label: "u16" },
              ],
            },
            {
              key: "cats_sepak_u17",
              type: "multi_choice",
              label: "u-17 groups",
              required: true,
              visibility: {
                field: "cats_sepak",
                op: "includes",
                value: "sepak.u17",
              },
              options: [
                { value: "sepak.u17.male", label: "male" },
                { value: "sepak.u17.female", label: "female" },
              ],
            },
          ],
        },
        {
          key: "cat_su17m",
          title: "Teams — Sepak u-17 male",
          visibility: {
            field: "cats_sepak_u17",
            op: "includes",
            value: "sepak.u17.male",
          },
          fields: [
            {
              key: "teams",
              type: "group",
              label: "Team",
              repeatable: true,
              fields: [
                {
                  key: "team_name",
                  type: "short_text",
                  label: "Team name",
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    };
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Anpsa",
      competition_fields: ["sports", "cats_sepak", "cats_sepak_u17"],
      form: {
        id: "form1",
        title: "Team registration",
        description: "",
        schema: teamSchema,
        confirmation_message: "",
      },
    });

    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    // Before a school is chosen, the full catalog shows, nothing selected.
    expect(screen.getByLabelText("Table Tennis")).not.toBeChecked();

    // Pick Don Bosco (registered for sepak.u17.male only).
    await userEvent.click(
      screen.getByRole("button", { name: /select your institution/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Don Bosco" }));

    // Sports: only Sepak remains, pre-checked; Table Tennis is gone.
    await waitFor(() =>
      expect(screen.getByLabelText("Sepak Takraw")).toBeChecked(),
    );
    expect(screen.queryByLabelText("Table Tennis")).toBeNull();
    // Chain levels: u-17 pre-checked, u16 filtered out; male only, checked.
    expect(screen.getByLabelText("u-17")).toBeChecked();
    expect(screen.queryByLabelText("u16")).toBeNull();
    expect(screen.getByLabelText("male")).toBeChecked();
    expect(screen.queryByLabelText("female")).toBeNull();

    // Next → straight to the team/player section, no manual selection needed.
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(
      await screen.findByRole("heading", { name: /teams — sepak u-17 male/i }),
    ).toBeInTheDocument();

    // Switching school re-scopes: Grace High registered Table Tennis only.
    await userEvent.click(screen.getByRole("button", { name: /back/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /select your institution/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Grace High" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Table Tennis")).toBeChecked(),
    );
    expect(screen.queryByLabelText("Sepak Takraw")).toBeNull();
  });

  it("requires the school access code, prefills the prior registration, submits the token", async () => {
    const teamSchema: FormSchema = {
      version: 1,
      sections: [
        {
          key: "institution",
          title: "Your institution",
          fields: [
            {
              key: "institution_id",
              type: "dropdown",
              label: "Select your institution",
              required: true,
              data_source: { type: "institution_list" },
              options: [
                {
                  value: "i1",
                  label: "Don Bosco",
                  leaves: ["football.u15"],
                  requires_code: true,
                },
              ],
            },
          ],
        },
        {
          key: "cat",
          title: "Teams — U15",
          fields: [
            {
              key: "teams_u15",
              type: "group",
              label: "Team",
              repeatable: true,
              fields: [
                {
                  key: "team_name_u15",
                  type: "short_text",
                  label: "Team name",
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    };
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Anpsa",
      competition_fields: [],
      team_groups: [{ group: "teams_u15", field: "team_name_u15" }],
      form: {
        id: "form1",
        title: "Team registration",
        description: "",
        schema: teamSchema,
        confirmation_message: "",
      },
    });
    vi.mocked(formsApi.teamAccess).mockResolvedValue({
      access_token: "signed-token",
      expires_in: 7200,
      editing: true,
      prefill: {
        institution_id: "i1",
        teams_u15: [{ team_name_u15: "Don Bosco Blue" }],
      },
    });
    vi.mocked(formsApi.publicSubmit).mockResolvedValue({
      response_id: "r1",
      message: "Updated.",
    });

    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    await userEvent.click(
      screen.getByRole("button", { name: /select your institution/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Don Bosco" }));

    // The code panel appears; Next is blocked until verified.
    expect(await screen.findByText("School access code")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(
      screen.getByText(/enter your school's access code/i),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Access code"), "K7MWPX2A");
    await userEvent.click(screen.getByRole("button", { name: /verify code/i }));
    expect(formsApi.teamAccess).toHaveBeenCalledWith("form1", {
      institution_id: "i1",
      code: "K7MWPX2A",
    });
    // Edit mode confirmed + prior answers prefilled.
    expect(
      await screen.findByText(/editing your school's existing registration/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByLabelText(/team name/i)).toHaveValue("Don Bosco Blue");

    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => expect(formsApi.publicSubmit).toHaveBeenCalled());
    expect(vi.mocked(formsApi.publicSubmit).mock.calls[0][1].access_token).toBe(
      "signed-token",
    );
  });

  it("flags duplicate team names inline and blocks submit", async () => {
    const teamSchema: FormSchema = {
      version: 1,
      sections: [
        {
          key: "cat",
          title: "Teams — U15",
          fields: [
            {
              key: "teams_u15",
              type: "group",
              label: "Team",
              repeatable: true,
              fields: [
                {
                  key: "team_name_u15",
                  type: "short_text",
                  label: "Team name",
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    };
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Anpsa",
      team_groups: [{ group: "teams_u15", field: "team_name_u15" }],
      form: {
        id: "form1",
        title: "Team registration",
        description: "",
        schema: teamSchema,
        confirmation_message: "",
      },
    });

    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    // Add two teams with the same name.
    await userEvent.click(screen.getByRole("button", { name: /add team/i }));
    await userEvent.click(screen.getByRole("button", { name: /add team/i }));
    const names = screen.getAllByLabelText(/team name/i);
    await userEvent.type(names[0], "Tigers");
    await userEvent.type(names[1], "Tigers");

    // Inline error appears while typing...
    expect(
      await screen.findByText(/two teams here have the same name/i),
    ).toBeInTheDocument();
    // ...and submit is blocked client-side.
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(formsApi.publicSubmit).not.toHaveBeenCalled();

    // Renaming clears the error.
    await userEvent.type(names[1], " Two");
    expect(
      screen.queryByText(/two teams here have the same name/i),
    ).toBeNull();
  });

  it("links to the directory from a closed institution form", async () => {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Cup",
      closed: true,
      has_directory: true,
      form_id: "form-1",
    });

    renderPage();
    const link = await screen.findByRole("link", {
      name: /registered institutions/i,
    });
    expect(link).toHaveAttribute("href", "/f/form-1/directory");
  });
});
