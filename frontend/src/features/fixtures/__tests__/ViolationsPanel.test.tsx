import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreviewViolation } from "@/api/tournaments";
import { ViolationsPanel } from "../ViolationsPanel";

const VIOLATION: PreviewViolation = {
  code: "pinned_round_unplaced",
  hard: true,
  constraint: {
    type: "round_pinned_to_window", scope: "leaf:football.u15",
    hard: true, weight: 5, params: { round: "final" },
  },
  matches: ["p7"],
  params: { round: "final", scope: "leaf:football.u15" },
  message: "The pinned round does not fit inside its window.",
  relaxations: [
    { action: "add_day", code: "add_day", params: { after: "2026-06-21" } },
    { action: "add_venue", code: "add_venue", params: {} },
  ],
};

describe("ViolationsPanel", () => {
  it("renders the all-clear quality strip when there are no violations", () => {
    render(<ViolationsPanel violations={[]} softScore={0.87} />);
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "No hard violations",
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent("87%");
  });

  it("explains hard violations from the stable code and offers relaxations", async () => {
    const onRelax = vi.fn();
    render(
      <ViolationsPanel
        violations={[VIOLATION]}
        softScore={0.5}
        onRelax={onRelax}
      />,
    );
    const card = screen.getByTestId("violation-pinned_round_unplaced");
    // localized title from the code (§9 A5), server message as the detail
    expect(card).toHaveTextContent("A pinned round does not fit its window");
    expect(card).toHaveTextContent(
      "The pinned round does not fit inside its window.",
    );
    expect(card).toHaveTextContent("round_pinned_to_window");
    await userEvent.click(screen.getByTestId("relax-add_day"));
    expect(onRelax).toHaveBeenCalledWith(VIOLATION.relaxations[0], VIOLATION);
  });

  it("renders read-only (disabled) relaxations without onRelax", () => {
    render(<ViolationsPanel violations={[VIOLATION]} softScore={null} />);
    expect(screen.getByTestId("relax-add_day")).toBeDisabled();
  });
});
