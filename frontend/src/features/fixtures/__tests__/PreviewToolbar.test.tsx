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
);

function mount(filters: GridFilters = EMPTY_FILTERS) {
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
      visible={ROWS.length}
      onExportCsv={onExportCsv}
      onExportPdf={onExportPdf}
    />,
  );
  return { onFilters, onGroupBy, onExportCsv, onExportPdf };
}

describe("PreviewToolbar", () => {
  it("offers each facet with the count you would get", async () => {
    const { onFilters } = mount();
    expect(screen.getByTestId("sheet-count")).toHaveTextContent("3 rows");
    await userEvent.click(screen.getByRole("button", { name: "Sport" }));
    expect(
      screen.getByRole("option", { name: "Table Tennis (2)" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Sepak Takraw (1)" }));
    // Picking a sport drops a category left over from another sport.
    expect(onFilters).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      sport: "sepak_takraw",
      category: "",
    });
  });

  it("types into the search box", async () => {
    const { onFilters } = mount();
    await userEvent.type(screen.getByTestId("filter-search"), "g");
    expect(onFilters).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: "g" });
  });

  it("restates applied filters as chips you can remove one at a time", async () => {
    const { onFilters } = mount({
      ...EMPTY_FILTERS,
      sport: "table_tennis",
      status: "unplaced",
    });
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
    const onExportCsv = vi.fn();
    const onExportPdf = vi.fn();
    render(
      <PreviewToolbar
        rows={ROWS}
        filters={{ ...EMPTY_FILTERS, sport: "table_tennis" }}
        onFilters={vi.fn()}
        groupBy="day"
        onGroupBy={vi.fn()}
        visible={2}
        onExportCsv={onExportCsv}
        onExportPdf={onExportPdf}
      />,
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
});
