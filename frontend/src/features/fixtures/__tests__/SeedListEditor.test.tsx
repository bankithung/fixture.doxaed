import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SeedListEditor, type SeedTeam } from "../SeedListEditor";

const TEAMS: SeedTeam[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Bravo" },
  { id: "c", name: "Charlie" },
];

describe("SeedListEditor", () => {
  it("renders rows in order with their seed rank", () => {
    render(<SeedListEditor teams={TEAMS} onChange={() => {}} />);
    expect(screen.getByTestId("seed-row-0")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("seed-row-0")).toHaveTextContent("1");
    expect(screen.getByTestId("seed-row-2")).toHaveTextContent("Charlie");
  });

  it("moves a team down with the button", async () => {
    const onChange = vi.fn();
    render(<SeedListEditor teams={TEAMS} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Move Alpha down"));
    expect(onChange).toHaveBeenCalledWith([
      { id: "b", name: "Bravo" },
      { id: "a", name: "Alpha" },
      { id: "c", name: "Charlie" },
    ]);
  });

  it("moves a focused row with the arrow keys", () => {
    const onChange = vi.fn();
    render(<SeedListEditor teams={TEAMS} onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId("seed-row-1"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith([
      { id: "b", name: "Bravo" },
      { id: "a", name: "Alpha" },
      { id: "c", name: "Charlie" },
    ]);
  });

  it("disables the edge buttons", () => {
    render(<SeedListEditor teams={TEAMS} onChange={() => {}} />);
    expect(screen.getByLabelText("Move Alpha up")).toBeDisabled();
    expect(screen.getByLabelText("Move Charlie down")).toBeDisabled();
  });
});
