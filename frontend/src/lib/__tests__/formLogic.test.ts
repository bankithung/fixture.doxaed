import { describe, expect, it } from "vitest";
import {
  isVisible,
  nextSectionKey,
  reachableFieldKeys,
  reachableSections,
  validateRequired,
} from "@/lib/formLogic";
import type { FormSchema } from "@/features/forms/types";

const schema: FormSchema = {
  version: 1,
  sections: [
    {
      key: "school",
      title: "S",
      fields: [
        {
          key: "school_name",
          type: "short_text",
          label: "School",
          required: true,
          role: "title",
        },
      ],
    },
    {
      key: "competition",
      title: "C",
      fields: [
        {
          key: "competition",
          type: "single_choice",
          label: "Which?",
          required: true,
          options: [
            { value: "sepak", label: "Sepak", goto: "sepak" },
            { value: "tt", label: "TT", goto: "tt" },
            { value: "none", label: "None", goto: "confirm" },
          ],
        },
      ],
    },
    {
      key: "sepak",
      title: "Sepak",
      visibility: { field: "competition", op: "in", value: ["sepak", "both"] },
      fields: [
        {
          key: "sepak_cats",
          type: "multi_choice",
          label: "Cats",
          required: true,
          options: [{ value: "u14b", label: "U14B" }],
        },
      ],
      next: "confirm",
    },
    {
      key: "tt",
      title: "TT",
      visibility: { field: "competition", op: "in", value: ["tt", "both"] },
      fields: [
        {
          key: "tt_cats",
          type: "multi_choice",
          label: "Cats",
          required: true,
          options: [{ value: "x", label: "X" }],
        },
      ],
      next: "confirm",
    },
    {
      key: "confirm",
      title: "Confirm",
      fields: [
        {
          key: "agree",
          type: "single_choice",
          label: "OK",
          required: true,
          options: [{ value: "yes", label: "Yes" }],
        },
      ],
    },
  ],
};

describe("formLogic", () => {
  it("isVisible evaluates 'in'", () => {
    expect(
      isVisible(
        { field: "competition", op: "in", value: ["sepak", "both"] },
        { competition: "sepak" },
      ),
    ).toBe(true);
    expect(
      isVisible(
        { field: "competition", op: "in", value: ["sepak"] },
        { competition: "tt" },
      ),
    ).toBe(false);
    expect(isVisible(null, {})).toBe(true);
  });

  it("isVisible evaluates the other operators", () => {
    expect(
      isVisible({ field: "x", op: "equals", value: "a" }, { x: "a" }),
    ).toBe(true);
    expect(
      isVisible({ field: "x", op: "not_equals", value: "a" }, { x: "b" }),
    ).toBe(true);
    expect(
      isVisible({ field: "x", op: "includes", value: "a" }, { x: ["a", "b"] }),
    ).toBe(true);
    expect(isVisible({ field: "x", op: "gt", value: 3 }, { x: 5 })).toBe(true);
    expect(isVisible({ field: "x", op: "lt", value: 3 }, { x: 1 })).toBe(true);
    expect(isVisible({ field: "x", op: "answered" }, { x: "" })).toBe(false);
    expect(isVisible({ field: "x", op: "answered" }, { x: "v" })).toBe(true);
    expect(isVisible({ field: "x", op: "answered" }, { x: [] })).toBe(false);
  });

  it("nextSectionKey follows option.goto", () => {
    expect(nextSectionKey(schema.sections[1], { competition: "tt" })).toBe("tt");
  });

  it("nextSectionKey falls back to section.next when no goto matches", () => {
    expect(nextSectionKey(schema.sections[2], {})).toBe("confirm");
  });

  it("reachableSections falls through in document order with no branching", () => {
    const flat: FormSchema = {
      version: 1,
      sections: [
        { key: "a", title: "A", fields: [] },
        { key: "b", title: "B", fields: [] },
      ],
    };
    expect(reachableSections(flat, {}).map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("reachableFieldKeys excludes hidden branch", () => {
    const keys = reachableFieldKeys(schema, {
      school_name: "MH",
      competition: "sepak",
      sepak_cats: ["u14b"],
      agree: "yes",
    });
    expect(keys).toContain("sepak_cats");
    expect(keys).not.toContain("tt_cats");
  });

  it("validateRequired flags missing required reachable fields only", () => {
    const errs = validateRequired(schema, { competition: "sepak" });
    expect(errs.school_name).toBe("required");
    expect(errs.sepak_cats).toBe("required");
    expect(errs.tt_cats).toBeUndefined();
  });
});
