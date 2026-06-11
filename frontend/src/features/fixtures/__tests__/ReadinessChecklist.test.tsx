import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReadinessCompetition } from "@/api/tournaments";
import { ReadinessChecklist } from "../ReadinessChecklist";

const COMPETITION: ReadinessCompetition = {
  leaf_key: "football.u15",
  label: "Football · U15",
  ready: false,
  summary: "3/5",
  checks: [
    { id: "enough_teams", status: "ok", hint: "4 registered teams" },
    { id: "format_chosen", status: "ok" },
    { id: "seeds_set", status: "ok" },
    {
      id: "venues_defined",
      status: "fail",
      hint: "No venues defined — add at least one.",
      fix: "venues",
    },
    {
      id: "constraints_reviewed",
      status: "warn",
      hint: "Constraints have not been marked reviewed.",
      fix: "constraints",
    },
    {
      id: "already_generated",
      status: "warn",
      hint: "A draw exists but its inputs have changed since.",
      fix: "diff",
    },
  ],
};

describe("ReadinessChecklist", () => {
  it("shows the summary, progress bar and per-check hints", () => {
    render(<ReadinessChecklist competition={COMPETITION} />);
    expect(screen.getByText(/3\/5/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", {
      name: /Readiness — Football · U15/,
    });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "5");
    expect(screen.getByText("4 registered teams")).toBeInTheDocument();
    expect(
      screen.getByText("No venues defined — add at least one."),
    ).toBeInTheDocument();
    // no onFix → hints only, no action buttons
    expect(screen.queryByRole("button", { name: /Fix/ })).toBeNull();
  });

  it("deep-links fixable checks and skips unknown fix targets", async () => {
    const onFix = vi.fn();
    render(
      <ReadinessChecklist
        competition={COMPETITION}
        onFix={onFix}
        fixable={new Set(["venues", "constraints"])}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Fix/ });
    // "diff" is not fixable yet → only venues + constraints get buttons
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    expect(onFix).toHaveBeenCalledWith("venues", "football.u15");
  });

  it("marks statuses on each row for icon styling", () => {
    render(<ReadinessChecklist competition={COMPETITION} />);
    expect(
      screen.getByTestId("check-football.u15-venues_defined"),
    ).toHaveAttribute("data-status", "fail");
    expect(
      screen.getByTestId("check-football.u15-enough_teams"),
    ).toHaveAttribute("data-status", "ok");
  });
});
