import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreviewMatch } from "@/api/tournaments";
import { EMPTY_FILTERS, buildRows, type GridFilters } from "../previewGrid";
import { PreviewToolbar } from "../PreviewToolbar";

function m(over: Partial<PreviewMatch> & { ref: string }): PreviewMatch {
  return {
    leaf_key: "table_tennis.u_14.boys.1v1",
    stage: "group",
    group_label: "Table Tennis · U-14 · Boys · Singles · Group A",
    round_no: 1,
    home: { team_id: "t1" },
    away: { team_id: "t2" },
    scheduled_at: "2026-08-16T13:59:00",
    venue: "T1",
    duration_minutes: 20,
    ...over,
  } as PreviewMatch;
}

const NAMES = new Map([
  ["t1", "Amazing School"],
  ["t2", "Lorna's School"],
]);

const ROWS = buildRows(
  [
    m({ ref: "p1" }),
    m({ ref: "p2", venue: "T2" }),
    m({
      ref: "p3",
      leaf_key: "sepak_takraw.u_14.girls.3v3",
      group_label: "Sepak Takraw · U-14 · Girls · Group B",
      venue: "Court A",
    }),
  ],
  NAMES,
  ["p3"],
);

function mount(filters: GridFilters = EMPTY_FILTERS, visible = ROWS.length) {
  const onFilters = vi.fn();
  const onGroupBy = vi.fn();
  const onExportCsv = vi.fn();
  const onExportPdf = vi.fn();
  render(
    <PreviewToolbar
      rows={ROWS}
      filters={filters}
      onFilters={onFilters}
      groupBy="day_venue"
      onGroupBy={onGroupBy}
      visible={visible}
      onExportCsv={onExportCsv}
      onExportPdf={onExportPdf}
    />,
  );
  return { onFilters, onGroupBy, onExportCsv, onExportPdf };
}

describe("PreviewToolbar", () => {
  it("keeps ONE filter button instead of a row of dropdowns", async () => {
    mount();
    expect(screen.getByTestId("sheet-count")).toHaveTextContent("3 rows");
    expect(screen.queryByTestId("filter-drawer")).toBeNull();
    await userEvent.click(screen.getByTestId("open-filters"));
    expect(screen.getByTestId("filter-drawer")).toBeInTheDocument();
  });

  it("picks a value from the drawer, filter names on the left", async () => {
    const { onFilters } = mount();
    await userEvent.click(screen.getByTestId("open-filters"));
    // Sport pane opens first; its values carry the count they would give.
    expect(screen.getByTestId("filter-value-table_tennis")).toHaveTextContent(
      "Table Tennis",
    );
    expect(screen.getByTestId("filter-value-table_tennis")).toHaveTextContent("2");
    await userEvent.click(screen.getByTestId("filter-value-sepak_takraw"));
    // Picking a sport drops a category left over from another sport.
    expect(onFilters).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      sport: "sepak_takraw",
      category: "",
    });
  });

  it("moves between filters through the left rail", async () => {
    const { onFilters } = mount();
    await userEvent.click(screen.getByTestId("open-filters"));
    await userEvent.click(screen.getByTestId("filter-pane-venue"));
    await userEvent.click(screen.getByTestId("filter-value-T2"));
    expect(onFilters).toHaveBeenCalledWith({ ...EMPTY_FILTERS, venue: "T2" });
  });

  it("filters by the scheduler's verdict, not just the data", async () => {
    const { onFilters } = mount();
    await userEvent.click(screen.getByTestId("open-filters"));
    await userEvent.click(screen.getByTestId("filter-pane-status"));
    expect(screen.getByTestId("filter-value-unplaced")).toHaveTextContent("1");
    await userEvent.click(screen.getByTestId("filter-value-unplaced"));
    expect(onFilters).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      status: "unplaced",
    });
  });

  it("types into the search box without opening the drawer", async () => {
    const { onFilters } = mount();
    await userEvent.type(screen.getByTestId("filter-search"), "g");
    expect(onFilters).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: "g" });
    expect(screen.queryByTestId("filter-drawer")).toBeNull();
  });

  it("restates applied filters as chips you can remove one at a time", async () => {
    const { onFilters } = mount({
      ...EMPTY_FILTERS,
      sport: "table_tennis",
      status: "unplaced",
    });
    // The button carries how many filters the drawer holds.
    expect(screen.getByTestId("open-filters")).toHaveTextContent("2");
    expect(screen.getByTestId("chip-filter-sport")).toHaveTextContent("Table Tennis");
    expect(screen.getByTestId("chip-filter-status")).toHaveTextContent("No time yet");

    await userEvent.click(screen.getByRole("button", { name: "Clear Sport filter" }));
    expect(onFilters).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      sport: "",
      status: "unplaced",
    });

    await userEvent.click(screen.getByTestId("clear-filters"));
    expect(onFilters).toHaveBeenCalledWith(EMPTY_FILTERS);
  });

  it("shows the visible/total tally and offers both exports", async () => {
    const { onExportCsv, onExportPdf } = mount(
      { ...EMPTY_FILTERS, sport: "table_tennis" },
      2,
    );
    expect(screen.getByTestId("sheet-count")).toHaveTextContent("2 of 3 rows");
    await userEvent.click(screen.getByTestId("export-csv"));
    expect(onExportCsv).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("export-pdf"));
    expect(onExportPdf).toHaveBeenCalled();
  });

  it("changes the group bands", async () => {
    const { onGroupBy } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Group by" }));
    await userEvent.click(screen.getByRole("option", { name: "Competition" }));
    expect(onGroupBy).toHaveBeenCalledWith("competition");
  });

  it("closes the drawer from its own footer", async () => {
    mount();
    await userEvent.click(screen.getByTestId("open-filters"));
    await userEvent.click(screen.getByTestId("drawer-done"));
    expect(screen.queryByTestId("filter-drawer")).toBeNull();
  });
});
