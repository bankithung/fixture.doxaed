import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldEditor } from "../FieldEditor";
import { useBuilderStore } from "../builderStore";
import type { Option } from "../types";

/** Seed the builder store with one dropdown field carrying `options`. */
function seed(options: Option[] = [{ value: "opt1", label: "Option 1" }]): void {
  useBuilderStore.getState().load({
    version: 1,
    sections: [
      {
        key: "s1",
        title: "Section 1",
        fields: [{ key: "f1", type: "dropdown", label: "School name", options }],
      },
    ],
  });
}

/** Renders the editor against the live store field so updateField round-trips
 *  back into the rendered options (mirrors FormCanvas). */
function Harness(): React.ReactElement {
  const section = useBuilderStore((s) => s.schema.sections[0]);
  return <FieldEditor section={section} field={section.fields[0]} />;
}

const opts = (): Option[] =>
  useBuilderStore.getState().schema.sections[0].fields[0].options ?? [];

beforeEach(() => seed());

describe("FieldEditor — dropdown option editor", () => {
  it("bulk-adds options from a comma-separated list on Enter", async () => {
    render(<Harness />);
    await userEvent.type(
      screen.getByPlaceholderText(/separated by commas/i),
      "Don Bosco, Holy Cross, St. Xavier{Enter}",
    );
    expect(opts().map((o) => o.label)).toEqual([
      "Option 1",
      "Don Bosco",
      "Holy Cross",
      "St. Xavier",
    ]);
    // Values are slugged from the label (uniquified), so they read sensibly.
    expect(opts().map((o) => o.value)).toEqual([
      "opt1",
      "don_bosco",
      "holy_cross",
      "st_xavier",
    ]);
  });

  it("skips blanks and duplicate labels when bulk-adding", async () => {
    seed([{ value: "opt1", label: "Don Bosco" }]);
    render(<Harness />);
    await userEvent.type(
      screen.getByPlaceholderText(/separated by commas/i),
      "Don Bosco, , Holy Cross,,Holy Cross{Enter}",
    );
    expect(opts().map((o) => o.label)).toEqual(["Don Bosco", "Holy Cross"]);
  });

  it("reorders options by dragging a row onto another position", () => {
    seed([
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ]);
    render(<Harness />);
    const handles = screen.getAllByTitle(/drag to reorder/i);
    const rows = document.querySelectorAll("[data-option-row]");
    const dataTransfer = { effectAllowed: "", setDragImage: () => {} };
    // Drag the first option (A) and drop it on the third row → A lands last.
    fireEvent.dragStart(handles[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.drop(rows[2], { dataTransfer });
    expect(opts().map((o) => o.label)).toEqual(["B", "C", "A"]);
  });
});
