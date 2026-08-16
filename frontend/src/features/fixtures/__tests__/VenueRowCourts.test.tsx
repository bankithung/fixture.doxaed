import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VenueRow, type VenueDraft } from "../VenueRow";

/**
 * Per-court category reservations in the venue editor (spec 2026-08-16):
 * "court one boys, court two girls" — which the venue-wide sport chips could
 * never express, because both courts are in the same hall.
 */

const COMPETITIONS = [
  { key: "table_tennis.u14.boys", label: "Table Tennis · U14 · Boys" },
  { key: "table_tennis.u14.girls", label: "Table Tennis · U14 · Girls" },
];

function draft(over: Partial<VenueDraft> = {}): VenueDraft {
  return {
    name: "MP Hall",
    venue_type: "hall",
    count: 2,
    from: "",
    to: "",
    break_from: "",
    break_to: "",
    sports: [],
    ...over,
  };
}

function mount(value: VenueDraft, onChange = vi.fn()) {
  render(
    <VenueRow
      value={value}
      index={0}
      onChange={onChange}
      onRemove={vi.fn()}
      competitionOptions={COMPETITIONS}
    />,
  );
  return onChange;
}

describe("VenueRow — per-court categories", () => {
  it("offers every competition on every court of the venue", () => {
    mount(draft());

    expect(screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.boys"))
      .toBeInTheDocument();
    expect(screen.getByTestId("venue-0-court-2-comp-table_tennis.u14.girls"))
      .toBeInTheDocument();
    expect(screen.getByText("Court 1")).toBeInTheDocument();
    expect(screen.getByText("Court 2")).toBeInTheDocument();
  });

  it("reserves one court without touching the other", async () => {
    const onChange = mount(draft());

    await userEvent.click(
      screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.boys"),
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        courts: [{ index: 1, competitions: ["table_tennis.u14.boys"] }],
      }),
    );
  });

  it("shows an existing reservation as pressed, and clears it on a second tap", async () => {
    const value = draft({
      courts: [{ index: 2, competitions: ["table_tennis.u14.girls"] }],
    });
    const onChange = mount(value);

    const chip = screen.getByTestId("venue-0-court-2-comp-table_tennis.u14.girls");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    // The other court is untouched — no reservation means it takes anything.
    expect(
      screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.girls"),
    ).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ courts: [{ index: 2, competitions: [] }] }),
    );
  });

  it("names a single-court venue by the venue itself", () => {
    mount(draft({ count: 1, name: "Court A" }));
    expect(screen.getByText("Court A")).toBeInTheDocument();
    expect(screen.queryByText("Court 2")).toBeNull();
  });

  it("stays out of the way when the event has only one competition", () => {
    render(
      <VenueRow
        value={draft()}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        competitionOptions={[COMPETITIONS[0]]}
      />,
    );
    expect(screen.queryByText("Per-court categories")).toBeNull();
  });
});
