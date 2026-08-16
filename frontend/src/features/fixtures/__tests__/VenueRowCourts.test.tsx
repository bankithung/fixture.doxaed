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

  it("shows an existing reservation as checked, and clears it on a second tap", async () => {
    const value = draft({
      courts: [{ index: 2, competitions: ["table_tennis.u14.girls"] }],
    });
    const onChange = mount(value);

    const box = screen.getByTestId("venue-0-court-2-comp-table_tennis.u14.girls");
    expect(box).toBeChecked();
    // The other court is untouched — no reservation means it takes anything.
    expect(
      screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.girls"),
    ).not.toBeChecked();

    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ courts: [{ index: 2, competitions: [] }] }),
    );
  });

  it("groups the competitions instead of listing every leaf flat", () => {
    mount(draft());
    // The sport and the category are rows of their own now…
    expect(screen.getByTestId("venue-0-court-1-comp-table_tennis")).toBeInTheDocument();
    expect(screen.getByTestId("venue-0-court-1-comp-table_tennis.u14")).toBeInTheDocument();
    // …and each row is named by its own segment, not the whole path.
    expect(screen.getByText("Table Tennis")).toBeInTheDocument();
    expect(screen.getByText("U14")).toBeInTheDocument();
    expect(screen.getByText("Boys")).toBeInTheDocument();
  });

  it("checking a sport reserves the court for all of it, stored as the prefix", async () => {
    const onChange = mount(draft());

    await userEvent.click(screen.getByTestId("venue-0-court-1-comp-table_tennis"));

    // Not two leaf keys — the prefix, which is what Court.competitions means.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        courts: [{ index: 1, competitions: ["table_tennis"] }],
      }),
    );
  });

  it("a group reads partial while only some of it is reserved", () => {
    mount(
      draft({ courts: [{ index: 1, competitions: ["table_tennis.u14.boys"] }] }),
    );
    expect(
      screen.getByTestId("venue-0-court-1-comp-table_tennis"),
    ).toHaveAttribute("data-state", "partial");
    expect(
      screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.boys"),
    ).toHaveAttribute("data-state", "on");
  });

  it("expands a stored sport prefix down to its leaves", () => {
    mount(draft({ courts: [{ index: 1, competitions: ["table_tennis"] }] }));
    // Stored as one prefix, shown as every competition under it.
    expect(screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.boys")).toBeChecked();
    expect(screen.getByTestId("venue-0-court-1-comp-table_tennis.u14.girls")).toBeChecked();
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
