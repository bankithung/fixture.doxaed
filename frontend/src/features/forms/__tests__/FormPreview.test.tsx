import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormPreview } from "../FormPreview";
import type { FormSchema } from "../types";

/** A two-branch schema: choosing "Sepak" reveals the Sepak section and never
 *  the TT section, exercising goto-based branching through the shared
 *  evaluator. */
const schema: FormSchema = {
  version: 1,
  sections: [
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
            { value: "sepak", label: "Sepak Takraw", goto: "sepak" },
            { value: "tt", label: "Table Tennis", goto: "tt" },
          ],
        },
      ],
    },
    {
      key: "sepak",
      title: "Sepak categories",
      visibility: { field: "competition", op: "equals", value: "sepak" },
      fields: [{ key: "sepak_field", type: "short_text", label: "Sepak team name" }],
    },
    {
      key: "tt",
      title: "Table Tennis categories",
      visibility: { field: "competition", op: "equals", value: "tt" },
      fields: [{ key: "tt_field", type: "short_text", label: "TT team name" }],
    },
  ],
};

describe("FormPreview", () => {
  it("shows/hides a conditional section as the answer changes", async () => {
    render(<FormPreview schema={schema} />);

    // Initially only the first section is reachable.
    expect(
      screen.getByRole("heading", { name: /^competition$/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/which competition/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/sepak team name/i)).toBeNull();
    expect(screen.queryByLabelText(/tt team name/i)).toBeNull();

    // Choose Sepak — the Sepak section appears, the TT section does not.
    await userEvent.click(screen.getByLabelText(/sepak takraw/i));
    expect(screen.getByLabelText(/sepak team name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/tt team name/i)).toBeNull();

    // Switch to Table Tennis — the branch flips.
    await userEvent.click(screen.getByLabelText(/table tennis/i));
    expect(screen.getByLabelText(/tt team name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/sepak team name/i)).toBeNull();
  });
});
