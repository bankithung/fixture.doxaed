import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisibilityRuleEditor } from "../VisibilityRuleEditor";
import type { Field, Visibility } from "../types";

/** A single choice trigger with the three Sepak/TT competition options. */
const trigger: Field = {
  key: "competition",
  type: "single_choice",
  label: "Which competition?",
  options: [
    { value: "sepak", label: "Sepak Takraw" },
    { value: "tt", label: "Table Tennis" },
    { value: "both", label: "Both" },
  ],
};

describe("VisibilityRuleEditor", () => {
  it("authoring 'is one of' + checking two options stores an array value", async () => {
    const user = userEvent.setup();
    let rule: Visibility | null = null;
    const onChange = vi.fn((next: Visibility | null) => {
      rule = next;
    });

    const { rerender } = render(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={rule}
        triggers={[trigger]}
        onChange={onChange}
      />,
    );

    // 1. Pick the trigger field (Always show -> competition).
    await user.click(screen.getByLabelText(/condition field/i));
    await user.click(screen.getByRole("option", { name: /which competition/i }));
    rerender(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={rule}
        triggers={[trigger]}
        onChange={onChange}
      />,
    );

    // 2. Switch the operator to "is one of".
    await user.click(screen.getByLabelText(/condition operator/i));
    await user.click(screen.getByRole("option", { name: /is one of/i }));
    rerender(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={rule}
        triggers={[trigger]}
        onChange={onChange}
      />,
    );

    // 3. The value editor is now a checkbox list (not a Select).
    const sepakBox = screen.getByLabelText(/sepak takraw/i) as HTMLInputElement;
    const bothBox = screen.getByLabelText(/^both$/i) as HTMLInputElement;
    expect(sepakBox.type).toBe("checkbox");

    await user.click(sepakBox);
    rerender(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={rule}
        triggers={[trigger]}
        onChange={onChange}
      />,
    );
    await user.click(bothBox);

    // The final stored value is an ARRAY of the two checked option values.
    expect(rule).toEqual({
      field: "competition",
      op: "in",
      value: ["sepak", "both"],
    });
  });

  it("round-trips: loading value ['sepak','both'] shows both boxes checked", () => {
    render(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={{ field: "competition", op: "in", value: ["sepak", "both"] }}
        triggers={[trigger]}
        onChange={() => {}}
      />,
    );

    expect(
      (screen.getByLabelText(/sepak takraw/i) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByLabelText(/^both$/i) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByLabelText(/table tennis/i) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("unchecking a loaded option removes it from the array", async () => {
    const user = userEvent.setup();
    let rule: Visibility | null = {
      field: "competition",
      op: "in",
      value: ["sepak", "both"],
    };
    const onChange = (next: Visibility | null) => {
      rule = next;
    };

    render(
      <VisibilityRuleEditor
        label="Show this section when"
        rule={rule}
        triggers={[trigger]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByLabelText(/sepak takraw/i));
    expect(rule).toEqual({
      field: "competition",
      op: "in",
      value: ["both"],
    });
  });

  it("single-value ops (equals) keep a single Select, not checkboxes", () => {
    render(
      <VisibilityRuleEditor
        label="Show this field when"
        rule={{ field: "competition", op: "equals", value: "sepak" }}
        triggers={[trigger]}
        onChange={() => {}}
      />,
    );
    // No checkbox list — a single accessible value Select instead.
    expect(screen.queryByLabelText(/^both$/i)).toBeNull();
    expect(screen.getByLabelText(/condition value/i)).toBeInTheDocument();
  });

  it("'is answered' shows no value input", () => {
    render(
      <VisibilityRuleEditor
        label="Show this field when"
        rule={{ field: "competition", op: "answered" }}
        triggers={[trigger]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/condition value/i)).toBeNull();
    expect(screen.queryByLabelText(/sepak takraw/i)).toBeNull();
  });

  it("a non-choice trigger keeps a free-text value input", () => {
    const textTrigger: Field = {
      key: "age",
      type: "number",
      label: "Age",
    };
    render(
      <VisibilityRuleEditor
        label="Show this field when"
        rule={{ field: "age", op: "gt", value: "12" }}
        triggers={[textTrigger]}
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText(/condition value/i) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("12");
  });
});
