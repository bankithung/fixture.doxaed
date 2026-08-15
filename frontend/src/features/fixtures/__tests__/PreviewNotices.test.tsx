import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreviewViolation } from "@/api/tournaments";
import { PreviewNotices } from "../PreviewNotices";

const PINNED: PreviewViolation = {
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

const UNPLACED: PreviewViolation = {
  code: "matches_unplaced",
  hard: true,
  constraint: null,
  matches: ["p1", "p2", "p3", "p4"],
  params: {},
  message: "4 match(es) could not be placed.",
  relaxations: [{ action: "add_day", code: "add_day", params: {} }],
};

const LEAVES = [
  { leafKey: "spk.u14.boys", label: "Sepak Takraw · U-14 · Boys", count: 2 },
  { leafKey: "spk.u14.girls", label: "Sepak Takraw · U-14 · Girls", count: 2 },
];

describe("PreviewNotices", () => {
  it("says the schedule works when nothing is broken", () => {
    render(
      <PreviewNotices violations={[]} unplacedCount={0} unplacedByLeaf={[]} />,
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "This schedule works. No rules are broken.",
    );
    expect(screen.queryByTestId("fix-rules-link")).toBeNull();
  });

  it("counts the problems, explains them plainly and offers next steps", async () => {
    const onRelax = vi.fn();
    const onFixRules = vi.fn();
    render(
      <PreviewNotices
        violations={[PINNED]}
        unplacedCount={0}
        unplacedByLeaf={[]}
        onRelax={onRelax}
        onFixRules={onFixRules}
      />,
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "1 problem to fix before you publish.",
    );
    expect(screen.getByTestId("violation-pinned_round_unplaced")).toHaveTextContent(
      "A round that is pinned to a date does not fit its day.",
    );
    await userEvent.click(screen.getByTestId("relax-add_day"));
    expect(onRelax).toHaveBeenCalledWith(PINNED.relaxations[0], PINNED);
    await userEvent.click(screen.getByTestId("fix-rules-link"));
    expect(onFixRules).toHaveBeenCalled();
  });

  it("reports unplaced matches ONCE, inside the violation that caused them", async () => {
    const onShowUnplaced = vi.fn();
    const onShowLeaf = vi.fn();
    render(
      <PreviewNotices
        violations={[UNPLACED]}
        unplacedCount={4}
        unplacedByLeaf={LEAVES}
        onShowUnplaced={onShowUnplaced}
        onShowLeaf={onShowLeaf}
      />,
    );
    // ONE problem, not "1 problem" plus a separate "4 have no time" panel.
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "1 problem to fix before you publish.",
    );
    expect(screen.queryByTestId("unscheduled-summary")).toBeNull();
    const row = screen.getByTestId("violation-matches_unplaced");
    expect(row).toHaveTextContent("Some matches could not be given a time and venue.");
    expect(row).toHaveTextContent("4 matches");
    expect(row).toHaveTextContent("Sepak Takraw · U-14 · Boys");

    await userEvent.click(screen.getByTestId("show-unplaced"));
    expect(onShowUnplaced).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("unplaced-leaf-spk.u14.boys"));
    expect(onShowLeaf).toHaveBeenCalledWith("spk.u14.boys");
  });

  it("stands the unplaced matches up alone when no violation claims them", () => {
    render(
      <PreviewNotices
        violations={[]}
        unplacedCount={4}
        unplacedByLeaf={LEAVES}
        onShowUnplaced={vi.fn()}
      />,
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "1 problem to fix before you publish.",
    );
    expect(screen.getByTestId("unscheduled-summary")).toHaveTextContent(
      "4 match(es) have no time yet",
    );
  });

  it("counts a hard violation and unclaimed unplaced work as two problems", () => {
    render(
      <PreviewNotices
        violations={[PINNED]}
        unplacedCount={2}
        unplacedByLeaf={[]}
      />,
    );
    expect(screen.getByTestId("soft-score")).toHaveTextContent(
      "2 problems to fix before you publish.",
    );
  });

  it("keeps everything in ONE block, including skipped competitions", () => {
    render(
      <PreviewNotices
        violations={[]}
        unplacedCount={0}
        unplacedByLeaf={[]}
        skippedLeaves={["Sepak Takraw · U-14 · Girls"]}
      />,
    );
    const block = screen.getByTestId("preview-notices");
    expect(block).toContainElement(screen.getByTestId("soft-score"));
    expect(block).toContainElement(screen.getByTestId("skipped-leaves-notice"));
  });
});
