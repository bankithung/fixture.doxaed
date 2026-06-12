import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConstraintRecord, ConstraintType } from "@/api/tournaments";
import { ConstraintRow } from "../ConstraintRow";

const TEAMS = [
  { id: "tm1", name: "Alpha" },
  { id: "tm2", name: "Bravo" },
];

const SCOPES = [
  { value: "all", label: "Whole tournament" },
  { value: "leaf:football.u15", label: "Football · U15" },
];

function mount(record: ConstraintRecord, spec: ConstraintType) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  render(
    <ConstraintRow
      record={record}
      spec={spec}
      scopeOptions={SCOPES}
      teams={TEAMS}
      onChange={onChange}
      onRemove={onRemove}
      index={0}
    />,
  );
  return { onChange, onRemove };
}

describe("ConstraintRow", () => {
  it("renders int params as number inputs from the params_schema", () => {
    const { onChange } = mount(
      { type: "min_rest_minutes", scope: "all", hard: true, weight: 5,
        params: { minutes: 30 } },
      { type: "min_rest_minutes", label: "Minimum rest", hard: true,
        params_schema: { minutes: "int" }, scopes: ["all"], layer: "S" },
    );
    const input = screen.getByTestId("constraint-0-minutes");
    expect(input).toHaveAttribute("type", "number");
    fireEvent.change(input, { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ params: { minutes: 45 } }),
    );
  });

  it("renders time params and weekday chips; toggling a day updates the list", async () => {
    const { onChange } = mount(
      { type: "recurring_blackout_window", scope: "all", hard: true, weight: 5,
        params: { days: ["sun"], from: "00:00", to: "13:00" } },
      { type: "recurring_blackout_window", label: "Recurring blocked window",
        hard: true,
        params_schema: { days: "list", from: "time", to: "time" },
        scopes: ["all"], layer: "S" },
    );
    expect(screen.getByTestId("constraint-0-from")).toHaveAttribute("type", "time");
    expect(screen.getByTestId("constraint-0-day-sun")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByTestId("constraint-0-day-sat"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ days: ["sun", "sat"] }),
      }),
    );
  });

  it("renders a dates param as the date-chips field", async () => {
    const { onChange } = mount(
      { type: "blackout_dates", scope: "all", hard: true, weight: 5,
        params: { dates: [] } },
      { type: "blackout_dates", label: "Blackout dates", hard: true,
        params_schema: { dates: "list" }, scopes: ["all"], layer: "S" },
    );
    fireEvent.change(screen.getByTestId("constraint-0-dates-input"), {
      target: { value: "2026-08-02" },
    });
    await userEvent.click(screen.getByTestId("constraint-0-dates-add"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ params: { dates: ["2026-08-02"] } }),
    );
  });

  it("renders team_id as a team Select", async () => {
    const { onChange } = mount(
      { type: "team_unavailable", scope: "team:tm1", hard: true, weight: 5,
        params: { team_id: "tm1", dates: [] } },
      { type: "team_unavailable", label: "A team is unavailable", hard: true,
        params_schema: { team_id: "str", dates: "list" },
        scopes: ["team"], layer: "S" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Team — constraint 1" }));
    await userEvent.click(screen.getByRole("option", { name: "Bravo" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ team_id: "tm2" }),
      }),
    );
  });

  it("renders round_pinned_to_window's venues list param (increment T) as a comma-separated input", () => {
    const { onChange } = mount(
      { type: "round_pinned_to_window", scope: "leaf:football.u15", hard: true,
        weight: 5,
        params: { round: "final", date: "2026-06-28", from: "14:00",
          to: "16:00", venues: ["Main Ground"] } },
      { type: "round_pinned_to_window", label: "Pin a round to a window",
        hard: true,
        params_schema: { round: "str", date: "date", from: "time",
          to: "time", venues: "list" },
        scopes: ["all", "sport", "leaf"], layer: "S" },
    );
    const input = screen.getByTestId("constraint-0-venues");
    expect(input).toHaveValue("Main Ground");
    fireEvent.change(input, { target: { value: "Main Ground, IG Stadium" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          venues: ["Main Ground", "IG Stadium"],
        }),
      }),
    );
  });

  it("soft records expose a 1-10 weight; switching to Hard hides it", async () => {
    const record: ConstraintRecord = {
      type: "preferred_window", scope: "all", hard: false, weight: 5,
      params: { days: [], from: "09:00", to: "12:00" },
    };
    const spec: ConstraintType = {
      type: "preferred_window", label: "Preferred match window", hard: false,
      params_schema: { days: "list", from: "time", to: "time" },
      scopes: ["all", "team"], layer: "S",
    };
    const { onChange } = mount(record, spec);
    const weight = screen.getByTestId("constraint-0-weight");
    fireEvent.change(weight, { target: { value: "9" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ weight: 9 }),
    );
    await userEvent.click(screen.getByTestId("constraint-0-hard"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ hard: true }),
    );
  });

  it("changes scope through the scope Select", async () => {
    const { onChange } = mount(
      { type: "min_rest_minutes", scope: "all", hard: true, weight: 5,
        params: { minutes: 30 } },
      { type: "min_rest_minutes", label: "Minimum rest", hard: true,
        params_schema: { minutes: "int" }, scopes: ["all", "leaf"], layer: "S" },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Scope — constraint 1" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Football · U15" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "leaf:football.u15" }),
    );
  });
});
