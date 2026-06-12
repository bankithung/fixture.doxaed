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
  it("captions the server summary in plain words with the progress bar and hints", () => {
    render(<ReadinessChecklist competition={COMPETITION} />);
    // the server's "3/5" summary, never recomputed client-side
    expect(screen.getByText("3 of 5 checks passed")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", {
      name: "Setup progress for Football · U15",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "5");
    // §7.3 plain labels with the server hint as the detail
    expect(screen.getByText("Teams registered")).toBeInTheDocument();
    expect(screen.getByText("Seed numbers")).toBeInTheDocument();
    expect(screen.getByText("Scheduling rules checked")).toBeInTheDocument();
    expect(screen.getByText("Current draw")).toBeInTheDocument();
    expect(screen.getByText("4 registered teams")).toBeInTheDocument();
    expect(
      screen.getByText("No venues defined — add at least one."),
    ).toBeInTheDocument();
    // no onFix → hints only, no action buttons
    expect(screen.queryByRole("button", { name: "Fix this" })).toBeNull();
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
    const buttons = screen.getAllByRole("button", { name: "Fix this" });
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
