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

const ORDER_OPTIONS = [
  { value: "table_tennis", label: "All of Table Tennis" },
  { value: "table_tennis.u_14.boys", label: "U-14 · Boys" },
  { value: "table_tennis.u_14.girls", label: "U-14 · Girls" },
  { value: "sepak_takraw", label: "All of Sepak Takraw" },
  { value: "sepak_takraw.u_14.boys", label: "Sepak · U-14 · Boys" },
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
      orderOptions={ORDER_OPTIONS}
      onChange={onChange}
      onRemove={onRemove}
      index={0}
    />,
  );
  return { onChange, onRemove };
}

const PRIORITY_SPEC: ConstraintType = {
  type: "competition_priority",
  label: "Which competition is scheduled first",
  hard: false,
  params_schema: { order: "order", mode: "str" },
  param_options: { mode: ["sequential", "within_round"] },
  scopes: ["all", "sport"],
  layer: "S",
};

const CLOSING_SPEC: ConstraintType = {
  type: "closing_rounds_window",
  label: "Finals and semi-finals play on the closing days",
  hard: true,
  params_schema: {
    rounds_from_end: "int",
    from_date: "date_or_last_day",
    exclusive: "bool",
  },
  scopes: ["all", "sport", "leaf"],
  layer: "S",
};

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
    await userEvent.click(screen.getByRole("button", { name: "Team, rule 1" }));
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

  it("preferences expose a 1-10 strength; switching to Must hides it", async () => {
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
      screen.getByRole("button", { name: "Scope, rule 1" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Football · U15" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "leaf:football.u15" }),
    );
  });

  // ------------------------------------------------ competition priority
  it("ranks competitions in a numbered list the host builds", async () => {
    const { onChange } = mount(
      { type: "competition_priority", scope: "all", hard: false, weight: 5,
        params: { order: ["table_tennis.u_14.boys"], mode: "sequential" } },
      PRIORITY_SPEC,
    );
    // The order reads as an order: position, name, and its own moves.
    expect(screen.getByTestId("constraint-0-order-item-0")).toHaveTextContent(
      "U-14 · Boys",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to the order" }));
    await userEvent.click(screen.getByRole("option", { name: "U-14 · Girls" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          order: ["table_tennis.u_14.boys", "table_tennis.u_14.girls"],
          mode: "sequential",
        },
      }),
    );
  });

  it("moves an entry up and down, and removes it", async () => {
    const params = {
      order: ["table_tennis.u_14.boys", "table_tennis.u_14.girls"],
      mode: "sequential",
    };
    const { onChange } = mount(
      { type: "competition_priority", scope: "all", hard: false, weight: 5, params },
      PRIORITY_SPEC,
    );
    // First row cannot move up, last cannot move down — no dead controls.
    expect(screen.getByTestId("constraint-0-order-up-0")).toBeDisabled();
    expect(screen.getByTestId("constraint-0-order-down-1")).toBeDisabled();

    await userEvent.click(screen.getByTestId("constraint-0-order-up-1"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          order: ["table_tennis.u_14.girls", "table_tennis.u_14.boys"],
        }),
      }),
    );
    await userEvent.click(screen.getByTestId("constraint-0-order-remove-0"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          order: ["table_tennis.u_14.girls"],
        }),
      }),
    );
  });

  it("ranks within the rule's own sport, since sports run in parallel", async () => {
    // Owner 2026-08-17: ordering table tennis against sepak says nothing when
    // they are on separate courts, so a sport-scoped rule offers only its own.
    mount(
      { type: "competition_priority", scope: "sport:table_tennis", hard: false,
        weight: 5, params: { order: [], mode: "sequential" } },
      PRIORITY_SPEC,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to the order" }));
    expect(
      screen.getByRole("option", { name: "U-14 · Boys" }),
    ).toBeInTheDocument();
    // Another sport's competitions are not on offer here.
    expect(screen.queryByRole("option", { name: /Sepak/ })).toBeNull();
    expect(
      screen.getByText(
        "Ranked within this sport only. Other sports play in parallel on their own courts, so add a separate rule per sport.",
      ),
    ).toBeInTheDocument();
  });

  it("says plainly that an empty order changes nothing", () => {
    mount(
      { type: "competition_priority", scope: "all", hard: false, weight: 5,
        params: { order: [], mode: "sequential" } },
      PRIORITY_SPEC,
    );
    expect(
      screen.getByText("Nothing ranked yet, so the schedule keeps its usual order."),
    ).toBeInTheDocument();
  });

  it("offers the priority mode as words, not stored keys", async () => {
    const { onChange } = mount(
      { type: "competition_priority", scope: "all", hard: false, weight: 5,
        params: { order: [], mode: "sequential" } },
      PRIORITY_SPEC,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /How strongly the order applies/ }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "All progress together, priority goes first" }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ mode: "within_round" }),
      }),
    );
  });

  // -------------------------------------------------- closing rounds window
  it("takes a real date or the standing 'last day' answer", async () => {
    const { onChange } = mount(
      { type: "closing_rounds_window", scope: "all", hard: true, weight: 5,
        params: { rounds_from_end: 2, from_date: "last_day", exclusive: false } },
      CLOSING_SPEC,
    );
    // "Last day" is on, so the date box is inert rather than showing a
    // half-truth alongside it.
    expect(screen.getByTestId("constraint-0-from_date-last-day")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("constraint-0-from_date")).toBeDisabled();

    await userEvent.click(screen.getByTestId("constraint-0-from_date-last-day"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ from_date: "" }),
      }),
    );
  });

  it("renders a bool param as its two answers", async () => {
    const { onChange } = mount(
      { type: "closing_rounds_window", scope: "all", hard: true, weight: 5,
        params: { rounds_from_end: 1, from_date: "last_day", exclusive: false } },
      CLOSING_SPEC,
    );
    expect(screen.getByTestId("constraint-0-exclusive-off")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByTestId("constraint-0-exclusive-on"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ exclusive: true }),
      }),
    );
  });

  it("explains what the closing-round count is counted from", () => {
    mount(
      { type: "closing_rounds_window", scope: "all", hard: true, weight: 5,
        params: { rounds_from_end: 2, from_date: "last_day", exclusive: true } },
      CLOSING_SPEC,
    );
    expect(
      screen.getByText(
        "Counted back from each competition's own last round, so 2 means its final and semi-finals.",
      ),
    ).toBeInTheDocument();
  });
});

describe("ConstraintRow · a scoped order still reads as itself", () => {
  const SCOPED: ConstraintType = { ...PRIORITY_SPEC, scopes: ["all", "sport"] };

  it("names an entry left outside the rule's sport, and flags it as inert", () => {
    // Ranked while the rule was tournament-wide, then the rule was scoped to
    // Table Tennis: the sepak entries can no longer be added, but they are
    // still stored — and a raw leaf key in the list is what made this look
    // broken (owner 2026-08-18).
    mount(
      {
        type: "competition_priority",
        scope: "sport:table_tennis",
        hard: false,
        weight: 5,
        params: {
          order: ["table_tennis.u_14.boys", "sepak_takraw.u_14.girls"],
          mode: "within_round",
        },
      },
      SCOPED,
    );
    expect(screen.getByTestId("constraint-0-order-item-0")).toHaveTextContent(
      "U-14 · Boys",
    );
    // Not in orderOptions at all -> humanized, never the raw key.
    const stray = screen.getByTestId("constraint-0-order-item-1");
    expect(stray).toHaveTextContent("Sepak Takraw · U 14 · Girls");
    expect(stray).not.toHaveTextContent("sepak_takraw.u_14.girls");
    // And it says why it does nothing.
    expect(screen.getByTestId("constraint-0-order-inert-1")).toHaveTextContent(
      "not in this sport",
    );
  });

  it("leaves an in-scope entry unflagged", () => {
    mount(
      {
        type: "competition_priority",
        scope: "sport:table_tennis",
        hard: false,
        weight: 5,
        params: { order: ["table_tennis.u_14.boys"], mode: "within_round" },
      },
      SCOPED,
    );
    expect(screen.queryByTestId("constraint-0-order-inert-0")).toBeNull();
  });
});
