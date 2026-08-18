import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicFormPage } from "../PublicFormPage";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
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

    // Final section: confirm → Review → Submit.
    await userEvent.click(screen.getByLabelText(/^yes$/i));
    await userEvent.click(screen.getByRole("button", { name: /^review$/i }));
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

  it("chain questions unfold NESTED under the option that reveals them", async () => {
    // Grouped chain (as the generator emits): sports → per-sport card →
    // categories → gender, each child gated on its parent option.
    const chainSchema: FormSchema = {
      version: 1,
      sections: [
        {
          key: "comp",
          title: "Competition selection",
          fields: [
            {
              key: "sports",
              type: "multi_choice",
              label: "Which sport(s)?",
              required: true,
              options: [{ value: "sepak", label: "Sepak Takraw" }],
            },
            {
              key: "categories_sepak",
              type: "multi_choice",
              label: "Sepak Takraw categories",
              required: true,
              group: "sepak",
              group_label: "Sepak Takraw",
              short_label: "Categories",
              visibility: { field: "sports", op: "includes", value: "sepak" },
              options: [{ value: "sepak.u16", label: "under 16" }],
            },
            {
              key: "categories_sepak_u16",
              type: "multi_choice",
              label: "Sepak Takraw · under 16",
              required: true,
              group: "sepak",
              group_label: "Sepak Takraw",
              short_label: "under 16",
              indent: 1,
              visibility: {
                field: "categories_sepak",
                op: "includes",
                value: "sepak.u16",
              },
              options: [
                { value: "sepak.u16.male", label: "male" },
                { value: "sepak.u16.female", label: "female" },
              ],
            },
          ],
        },
      ],
    };
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Anpsa",
      form: {
        id: "form1",
        title: "Institution registration",
        description: "",
        schema: chainSchema,
        confirmation_message: "",
      },
    });
    renderPage();
    await screen.findByRole("heading", { name: /institution registration/i });

    // Nothing below the sports question until a sport is picked.
    expect(screen.queryByLabelText("under 16")).toBeNull();
    await userEvent.click(screen.getByLabelText("Sepak Takraw"));
    const u16 = await screen.findByLabelText("under 16");
    expect(screen.queryByLabelText("male")).toBeNull();

    // Ticking "under 16" reveals its genders DIRECTLY under that option row.
    await userEvent.click(u16);
    const male = await screen.findByLabelText("male");
    const optionWrap = u16.closest("label")!.parentElement!;
    expect(optionWrap.contains(male)).toBe(true);
    expect(optionWrap.contains(screen.getByLabelText("female"))).toBe(true);

    // Unticking folds the branch back up.
    await userEvent.click(u16);
    await waitFor(() => expect(screen.queryByLabelText("male")).toBeNull());
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
            {
              key: "contact_name",
              type: "short_text",
              label: "Contact person",
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

    // The code panel appears; everything else in the section is HIDDEN until
    // verification (no prefilled details leak), and Next is blocked.
    expect(await screen.findByText("School access code")).toBeInTheDocument();
    expect(screen.queryByLabelText(/contact person/i)).toBeNull();
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
    // Edit mode confirmed + prior answers prefilled + hidden fields return.
    expect(
      await screen.findByText(/editing your existing registration/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/contact person/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByLabelText(/team name/i)).toHaveValue("Don Bosco Blue");

    await userEvent.click(screen.getByRole("button", { name: /^review$/i }));
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => expect(formsApi.publicSubmit).toHaveBeenCalled());
    expect(vi.mocked(formsApi.publicSubmit).mock.calls[0][1].access_token).toBe(
      "signed-token",
    );
  });

  it("manager path: no code panel, school details prefill on selection", async () => {
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
            { key: "contact_name", type: "short_text", label: "Contact person" },
          ],
        },
      ],
    };
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "Anpsa",
      can_manage: true,
      competition_fields: [],
      form: {
        id: "form1",
        title: "Team registration",
        description: "",
        schema: teamSchema,
        confirmation_message: "",
      },
    });
    vi.mocked(formsApi.teamAccess).mockResolvedValue({
      access_token: "mgr-token",
      expires_in: 7200,
      editing: false,
      prefill: { institution_id: "i1", contact_name: "Fr. K" },
    });

    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
    // Organizer banner, no code prompt.
    expect(screen.getByText(/signed in as an organizer/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /select your institution/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Don Bosco" }));

    // Manager prefill fetched with an empty code; contact auto-fills.
    await waitFor(() =>
      expect(formsApi.teamAccess).toHaveBeenCalledWith("form1", {
        institution_id: "i1",
        code: "",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/contact person/i)).toHaveValue("Fr. K"),
    );
    expect(screen.queryByText("School access code")).toBeNull();
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
    // ...and advancing past this section (to Review) is blocked client-side.
    await userEvent.click(screen.getByRole("button", { name: /^review$/i }));
    expect(formsApi.publicSubmit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /submit/i }),
    ).toBeNull();

    // Renaming clears the error.
    await userEvent.type(names[1], " Two");
    expect(
      screen.queryByText(/two teams here have the same name/i),
    ).toBeNull();
  });

  // Participants-first (spec 2026-08-17): a school's roll of children is PII,
  // so the person pickers are empty in the public schema and arrive only with
  // the access-code exchange.
  it("fills the student picker from the school's own roster, after the code", async () => {
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
                { value: "i1", label: "Don Bosco", requires_code: true },
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
                  key: "players_u15",
                  type: "group",
                  label: "Player",
                  repeatable: true,
                  fields: [
                    {
                      key: "player_member_u15",
                      type: "dropdown",
                      label: "Student",
                      required: true,
                      options: [],
                      data_source: { type: "roster_students" },
                    },
                  ],
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
      editing: false,
      prefill: { institution_id: "i1" },
      roster: {
        enabled: true,
        students: [
          { value: "p1", label: "Imli Jamir", class_section: "9-B" },
          { value: "p2", label: "Toshi Ao", class_section: "9-A" },
        ],
        teachers: [],
      },
    });

    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
    await userEvent.click(
      screen.getByRole("button", { name: /select your institution/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Don Bosco" }));

    await userEvent.type(screen.getByLabelText("Access code"), "K7MWPX2A");
    await userEvent.click(screen.getByRole("button", { name: /verify code/i }));
    await userEvent.click(await screen.findByRole("button", { name: /next/i }));

    await userEvent.click(screen.getByRole("button", { name: /add team/i }));
    await userEvent.click(screen.getByRole("button", { name: /add player/i }));

    // The picker now offers this school's children — named as the school knows
    // them, so two "Imli"s are told apart.
    await userEvent.click(screen.getByRole("button", { name: /student/i }));
    expect(
      await screen.findByRole("option", { name: "Imli Jamir · 9-B" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Toshi Ao · 9-A" }),
    ).toBeInTheDocument();
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

/**
 * The participants-first team form (owner 2026-08-17): a school declares its
 * people in step one, then PICKS them per competition. The picker resolves
 * from this same form's answers, so before anything is typed it is genuinely
 * empty — and an empty box that says nothing reads as "the form did not
 * change" (owner 2026-08-18, on a live tournament that had switched
 * correctly). It has to name the step to go and fill.
 */
const pickerSchema: FormSchema = {
  version: 1,
  sections: [
    {
      key: "participants",
      title: "Your participants",
      next: "teams",
      fields: [
        {
          key: "participant_students",
          type: "group",
          label: "Student",
          repeatable: true,
          row_key: "participant_id",
          fields: [
            { key: "participant_id", type: "hidden", label: "" },
            { key: "participant_name", type: "short_text", label: "Full name" },
            { key: "participant_events", type: "multi_choice", label: "Playing in",
              options: [{ value: "tt.u14.boys", label: "TT U14 Boys" }] },
          ],
        },
      ],
    },
    {
      key: "teams",
      title: "Teams · Table Tennis · U-14 · Boys",
      fields: [
        {
          key: "teams_tt",
          type: "group",
          label: "Team",
          repeatable: true,
          fields: [
            {
              key: "player_member_tt",
              type: "dropdown",
              label: "Student",
              data_source: {
                type: "form_group",
                group: "participant_students",
                value_field: "participant_id",
                label_field: "participant_name",
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("PublicFormPage · participants-first pickers", () => {
  beforeEach(() => vi.resetAllMocks());

  function mountPicker() {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: {
        id: "form1",
        title: "Team registration",
        description: "",
        schema: pickerSchema,
        confirmation_message: "Thanks",
      },
    });
    renderPage();
  }

  it("tells the school where to add people when the picker is still empty", async () => {
    mountPicker();
    await screen.findByRole("heading", { name: /team registration/i });
    // Straight to the teams step without declaring anyone.
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText(/Teams · Table Tennis/);
    await userEvent.click(screen.getByRole("button", { name: "Add Team" }));
    // The picker names the step that feeds it, rather than sitting empty.
    expect(
      await screen.findByText(
        'Add your people in "Your participants" first, then pick them here.',
      ),
    ).toBeInTheDocument();
  });

  it("offers the people the school typed, and drops the hint once it can", async () => {
    mountPicker();
    await screen.findByRole("heading", { name: /team registration/i });
    await userEvent.click(screen.getByRole("button", { name: "Add Student" }));
    await userEvent.type(
      await screen.findByLabelText(/full name/i),
      "Aben Kikon",
    );
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText(/Teams · Table Tennis/);
    await userEvent.click(screen.getByRole("button", { name: "Add Team" }));

    expect(
      screen.queryByText(/first, then pick them here/),
    ).not.toBeInTheDocument();
    // The declared student is a real choice on the team row.
    await userEvent.click(screen.getByRole("button", { name: /student/i }));
    expect(
      await screen.findByRole("option", { name: "Aben Kikon" }),
    ).toBeInTheDocument();
  });
});

/**
 * A saved row collapses to its name (owner 2026-08-18). A school entering
 * forty students was reading forty open forms at once.
 */
const rowSchema: FormSchema = {
  version: 1,
  sections: [
    {
      key: "participants",
      title: "Your participants",
      fields: [
        {
          key: "participant_students",
          type: "group",
          label: "Student",
          repeatable: true,
          row_key: "participant_id",
          row_title: "participant_name",
          fields: [
            { key: "participant_id", type: "hidden", label: "" },
            { key: "participant_name", type: "short_text", label: "Full name", required: true },
            { key: "participant_class", type: "short_text", label: "Class & section" },
          ],
        },
      ],
    },
  ],
};

describe("PublicFormPage · saved rows collapse to a name", () => {
  beforeEach(() => vi.resetAllMocks());

  async function mountRows() {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: rowSchema, confirmation_message: "Thanks" },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
  }

  it("opens a new row, saves it to one line, and reopens it to edit", async () => {
    await mountRows();
    await userEvent.click(screen.getByTestId("row-add-participant_students"));
    // A row you just asked for opens ready to type in.
    expect(screen.getByTestId("row-open-participant_students-0")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/full name/i), "Aben Kikon");
    await userEvent.click(screen.getByTestId("row-save-participant_students-0"));

    // Saved: one line carrying the name, no fields.
    const saved = screen.getByTestId("row-saved-participant_students-0");
    expect(saved).toHaveTextContent("Aben Kikon");
    expect(screen.queryByLabelText(/class & section/i)).not.toBeInTheDocument();

    // Edit puts it back exactly as it was, answers intact.
    await userEvent.click(screen.getByTestId("row-edit-participant_students-0"));
    expect(screen.getByLabelText(/full name/i)).toHaveValue("Aben Kikon");
  });

  it("will not collapse a row that has no name to show", async () => {
    await mountRows();
    await userEvent.click(screen.getByTestId("row-add-participant_students"));
    // Nothing typed: saving would leave an unidentifiable strip.
    expect(screen.getByTestId("row-save-participant_students-0")).toBeDisabled();
  });

  it("keeps each row's open state to itself", async () => {
    await mountRows();
    await userEvent.click(screen.getByTestId("row-add-participant_students"));
    await userEvent.type(screen.getByLabelText(/full name/i), "Aben Kikon");
    await userEvent.click(screen.getByTestId("row-save-participant_students-0"));
    await userEvent.click(screen.getByTestId("row-add-participant_students"));

    // The second is open for typing; the first stays saved.
    expect(screen.getByTestId("row-open-participant_students-1")).toBeInTheDocument();
    expect(screen.getByTestId("row-saved-participant_students-0")).toHaveTextContent(
      "Aben Kikon",
    );
  });
});

describe("PublicFormPage · progress", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows how far through the form you are, and how much is left", async () => {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: pickerSchema, confirmation_message: "Thanks" },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    // Two sections plus the review step: three in total.
    const bar = screen.getByTestId("form-progress");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(screen.getByText(/2 left/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByTestId("form-progress")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );
  });
});

describe("PublicFormPage · a row's fields line up", () => {
  beforeEach(() => vi.resetAllMocks());

  it("gives no grid cell to a hidden field, so the name starts the row", async () => {
    // Every generated person group opens with a hidden row id. Giving it a
    // cell left a hole and pushed the name into the far column (owner
    // 2026-08-18: "the name input is going to the right leaving gaps").
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: rowSchema, confirmation_message: "Thanks" },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
    await userEvent.click(screen.getByTestId("row-add-participant_students"));

    const cells = Array.from(
      screen.getByTestId("row-open-participant_students-0")
        .querySelectorAll(":scope > div.grid > div"),
    );
    // Two visible fields (name, class) — the hidden id gets no cell at all.
    expect(cells).toHaveLength(2);
    // And the name, being what the row IS, takes the whole row.
    expect(cells[0]!.className).toContain("sm:col-span-2");
    expect(cells[0]!.textContent).toContain("Full name");
  });
});

describe("PublicFormPage · a rejected answer says which one", () => {
  beforeEach(() => vi.resetAllMocks());

  it("puts the message on the failing row and opens it", async () => {
    // Owner 2026-08-18: a nested failure printed one detached line at the
    // bottom, so "not an allowed option" named nothing.
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: rowSchema, confirmation_message: "Thanks" },
    });
    vi.mocked(formsApi.publicSubmit).mockRejectedValue(
      new ApiError(400, {
        errors: { "participant_students.0.participant_class": "not_an_allowed_option" },
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
    await userEvent.click(screen.getByTestId("row-add-participant_students"));
    await userEvent.type(screen.getByLabelText(/full name/i), "Aben Kikon");
    await userEvent.click(screen.getByTestId("row-save-participant_students-0"));
    // Saved, so the offending answer is out of sight.
    expect(screen.getByTestId("row-saved-participant_students-0")).toBeInTheDocument();

    // One section, so the next step IS the review, then submit.
    await userEvent.click(screen.getByRole("button", { name: /review/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^submit/i }));

    // The row reopens itself and carries the message.
    expect(
      await screen.findByTestId("row-error-participant_students-0"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("row-open-participant_students-0")).toBeInTheDocument();
  });
});

describe("PublicFormPage · a person picker counts their entries", () => {
  beforeEach(() => vi.resetAllMocks());

  it("says how many times each student is already assigned", async () => {
    // Owner 2026-08-18: "how will I know if a student is in multiple
    // categories, it is hard to tell".
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: pickerSchema, confirmation_message: "Thanks" },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    await userEvent.click(screen.getByRole("button", { name: "Add Student" }));
    await userEvent.type(await screen.findByLabelText(/full name/i), "Aben Kikon");
    await userEvent.click(screen.getByRole("button", { name: /review|next/i }));
    await screen.findByText(/Teams · Table Tennis/);

    // Not yet picked anywhere: the name stands alone.
    await userEvent.click(screen.getByRole("button", { name: "Add Team" }));
    await userEvent.click(screen.getByRole("button", { name: /student/i }));
    expect(
      await screen.findByRole("option", { name: "Aben Kikon" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Aben Kikon" }));

    // Picked once, so the next picker says so.
    await userEvent.click(screen.getByRole("button", { name: "Add Team" }));
    const pickers = screen.getAllByRole("button", { name: /student/i });
    await userEvent.click(pickers[pickers.length - 1]!);
    expect(
      await screen.findByRole("option", { name: /Aben Kikon · 1 entry/ }),
    ).toBeInTheDocument();
  });
});

describe("PublicFormPage · date of birth and live checks", () => {
  beforeEach(() => vi.resetAllMocks());

  const dobSchema: FormSchema = {
    version: 1,
    sections: [
      {
        key: "who",
        title: "Who",
        fields: [
          { key: "dob", type: "date", label: "Date of birth" },
          { key: "name", type: "short_text", label: "Full name", required: true },
        ],
      },
    ],
  };

  async function mountDob() {
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: { id: "form1", title: "Team registration", description: "",
        schema: dobSchema, confirmation_message: "Thanks" },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
  }

  it("asks for month, day and year separately, not a calendar", async () => {
    await mountDob();
    // Three pickers, and NO native date input.
    expect(
      screen.getByRole("button", { name: /Date of birth: month/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Date of birth: day/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Date of birth: year/i }),
    ).toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it("clears a required message the moment the field is filled", async () => {
    await mountDob();
    // First check fails on the empty required name.
    await userEvent.click(screen.getByRole("button", { name: /review|next/i }));
    expect(await screen.findByText(/required/i)).toBeInTheDocument();

    // Typing fixes it live, with no second press of Next.
    await userEvent.type(screen.getByLabelText(/full name/i), "Aben Kikon");
    await waitFor(() =>
      expect(screen.queryByText(/required/i)).not.toBeInTheDocument(),
    );
  });
});

describe("PublicFormPage · a row is compact", () => {
  beforeEach(() => vi.resetAllMocks());

  it("pairs pickers on one line however many options they hold", async () => {
    // Owner 2026-08-18: "Teacher" and "Role" were stacked because the option
    // COUNT was being read as width. A dropdown is one control either way.
    const many = Array.from({ length: 30 }, (_, i) => ({
      value: `p${i}`,
      label: `Person ${i}`,
    }));
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: {
        id: "form1", title: "Team registration", description: "",
        confirmation_message: "Thanks",
        schema: {
          version: 1,
          sections: [{
            key: "s", title: "Teams",
            fields: [{
              key: "staff", type: "group", label: "Teacher in charge",
              repeatable: true, row_key: "sid", row_title: "who",
              fields: [
                { key: "sid", type: "hidden", label: "" },
                { key: "who", type: "dropdown", label: "Teacher", options: many },
                { key: "role", type: "dropdown", label: "Role",
                  options: [{ value: "coach", label: "Coach" }] },
              ],
            }],
          }],
        } as FormSchema,
      },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });
    await userEvent.click(screen.getByTestId("row-add-staff"));

    const cells = Array.from(
      screen.getByTestId("row-open-staff-0")
        .querySelectorAll(":scope > div.grid > div"),
    );
    // Teacher spans the row (it names the row); Role sits beside, not under.
    expect(cells).toHaveLength(2);
    expect(cells[1]!.className).not.toContain("col-span-2");
    // Save shares the header line rather than costing a row of its own.
    const header = screen.getByTestId("row-open-staff-0").firstElementChild!;
    expect(header.querySelector('[data-testid="row-save-staff-0"]')).not.toBeNull();
  });
});

describe("PublicFormPage · the form reads like the directory", () => {
  beforeEach(() => vi.resetAllMocks());

  it("carries the same per-sport tally band once a sport is ticked", async () => {
    // Owner 2026-08-18: the registration form and the public directory should
    // read as one product; the directory's summary band is the tell.
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: {
        id: "form1", title: "Team registration", description: "",
        confirmation_message: "Thanks",
        schema: {
          version: 1,
          sections: [{
            key: "institution", title: "Your institution",
            fields: [
              { key: "sports", type: "multi_choice", label: "Which sports?",
                required: true,
                options: [
                  { value: "table_tennis", label: "Table Tennis" },
                  { value: "sepak_takraw", label: "Sepak Takraw" },
                ] },
              { key: "categories_table_tennis", type: "multi_choice",
                label: "Table Tennis competitions", required: true,
                visibility: { field: "sports", op: "includes", value: "table_tennis" },
                options: [
                  { value: "table_tennis.u_14.boys", label: "U-14 · Boys" },
                  { value: "table_tennis.u_14.girls", label: "U-14 · Girls" },
                ] },
            ],
          }],
        } as FormSchema,
      },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    // Nothing ticked: no band, exactly as the directory shows none with no data.
    expect(screen.queryByTestId("entry-summary")).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: "Table Tennis" }));
    const band = await screen.findByTestId("entry-summary");
    expect(band).toHaveTextContent("Table Tennis");

    // Ticking competitions counts them, like the directory's per-game counts.
    await userEvent.click(screen.getByRole("checkbox", { name: "U-14 · Boys" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "U-14 · Girls" }));
    expect(screen.getByTestId("entry-summary")).toHaveTextContent("2");
  });
});

describe("PublicFormPage · competitions are a tick-mark table", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lays the competitions out as rows and columns, and ticks a whole row", async () => {
    // Owner 2026-08-18: "like the public directory page where we show a list
    // and then tick mark". A flat column of eight checkboxes hid the structure.
    vi.mocked(formsApi.publicGet).mockResolvedValue({
      tournament_name: "ANPSA Dimapur",
      form: {
        id: "form1", title: "Team registration", description: "",
        confirmation_message: "Thanks",
        schema: {
          version: 1,
          sections: [{
            key: "institution", title: "Your institution",
            fields: [{
              key: "categories_table_tennis", type: "multi_choice",
              label: "Table Tennis competitions", required: true,
              layout: "matrix",
              options: [
                { value: "tt.u14.boys.singles", label: "U-14 · Boys · Singles",
                  row: "U-14", col: "Boys · Singles" },
                { value: "tt.u14.boys.doubles", label: "U-14 · Boys · Doubles",
                  row: "U-14", col: "Boys · Doubles" },
                { value: "tt.open.boys.singles", label: "Open · Boys · Singles",
                  row: "Open", col: "Boys · Singles" },
              ],
            }],
          }],
        } as FormSchema,
      },
    });
    renderPage();
    await screen.findByRole("heading", { name: /team registration/i });

    // It is a real table: column headers and row headers, not a list.
    expect(screen.getByRole("columnheader", { name: "Boys · Singles" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Boys · Doubles" })).toBeInTheDocument();

    // A combination the tournament does not run has no checkbox at all.
    expect(screen.queryByLabelText("Open · Boys · Doubles")).toBeNull();

    // One cell ticks one competition.
    await userEvent.click(screen.getByLabelText("U-14 · Boys · Singles"));
    expect(screen.getByLabelText("U-14 · Boys · Singles")).toBeChecked();

    // The row header ticks the whole age group in one click.
    await userEvent.click(screen.getByLabelText("All of U-14"));
    expect(screen.getByLabelText("U-14 · Boys · Doubles")).toBeChecked();
    expect(screen.getByLabelText("Open · Boys · Singles")).not.toBeChecked();
  });
});
