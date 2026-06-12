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
  it("says the schedule works when nothing is broken", () => {
    render(<ViolationsPanel violations={[]} />);
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "This schedule works. No rules are broken.",
    );
    expect(screen.queryByTestId("fix-rules-link")).toBeNull();
  });

  it("counts the problems, explains them plainly and offers next steps", async () => {
    const onRelax = vi.fn();
    const onFixRules = vi.fn();
    render(
      <ViolationsPanel
        violations={[VIOLATION]}
        onRelax={onRelax}
        onFixRules={onFixRules}
      />,
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "1 problem(s) need fixing before you publish.",
    );
    const card = screen.getByTestId("violation-pinned_round_unplaced");
    // plain title from the code (§7.7), server message as the detail
    expect(card).toHaveTextContent(
      "A round that is pinned to a date does not fit its day.",
    );
    expect(card).toHaveTextContent(
      "The pinned round does not fit inside its window.",
    );
    // the raw tokens move off the card face into a support tooltip
    expect(card).not.toHaveTextContent("round_pinned_to_window");
    expect(card).toHaveAttribute(
      "title",
      "round_pinned_to_window · leaf:football.u15",
    );
    expect(screen.getByText("What you can do:")).toBeInTheDocument();
    expect(screen.getByTestId("relax-add_day")).toHaveTextContent(
      "Add another day",
    );
    await userEvent.click(screen.getByTestId("relax-add_day"));
    expect(onRelax).toHaveBeenCalledWith(VIOLATION.relaxations[0], VIOLATION);
    // the failure verdict links back to the rules
    await userEvent.click(screen.getByTestId("fix-rules-link"));
    expect(onFixRules).toHaveBeenCalled();
  });

  it("renders read-only (disabled) relaxations without onRelax", () => {
    render(<ViolationsPanel violations={[VIOLATION]} />);
    expect(screen.getByTestId("relax-add_day")).toBeDisabled();
  });
});
