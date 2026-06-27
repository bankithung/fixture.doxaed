import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { PreviewMatch } from "@/api/tournaments";
import { PreviewFilterBar } from "../PreviewFilterBar";
import {
  categoryFacets,
  competitionLabel,
  sportFacets,
  sportKey,
} from "../previewFilters";

function pm(over: Partial<PreviewMatch>): PreviewMatch {
  return {
    ref: "p1", leaf_key: "sepak_takraw.u_14.girls.3v3", stage: "group",
    group_label: "Sepak Takraw — u-14 — girls — 3v3 — Group A",
    round_no: 1, home: { team_id: "a" }, away: { team_id: "b" },
    scheduled_at: "2026-08-29T09:30:00", venue: "Court", duration_minutes: 20,
    ...over,
  };
}

const MATCHES: PreviewMatch[] = [
  pm({ ref: "p1" }),
  pm({ ref: "p2", leaf_key: "sepak_takraw.u_14.boys.3v3",
    group_label: "Sepak Takraw — u-14 — boys — 3v3 — Group A" }),
  pm({ ref: "p3", leaf_key: "table_tennis.u_14.boys.1v1", stage: "knockout",
    group_label: "Table Tennis — u-14 — boys — 1v1", duration_minutes: 15 }),
];

describe("previewFilters", () => {
  it("derives sport key, competition label and facets", () => {
    expect(sportKey(MATCHES[2]!)).toBe("table_tennis");
    // group/round suffix stripped → one entry per category
    expect(competitionLabel(MATCHES[0]!)).toBe("Sepak Takraw — u-14 — girls — 3v3");
    const sports = sportFacets(MATCHES);
    expect(sports.map((s) => [s.label, s.count])).toEqual([
      ["Sepak Takraw", 2],
      ["Table Tennis", 1],
    ]);
    expect(categoryFacets(MATCHES, "sepak_takraw")).toHaveLength(2);
  });
});

function Harness(): React.ReactElement {
  const [sport, setSport] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  return (
    <PreviewFilterBar
      matches={MATCHES}
      sport={sport}
      category={cat}
      onSport={setSport}
      onCategory={setCat}
    />
  );
}

describe("PreviewFilterBar", () => {
  it("offers sport pills, then category pills once a sport is chosen", async () => {
    render(<Harness />);
    expect(screen.getByTestId("filter-sport-all")).toHaveTextContent("All");
    expect(screen.getByTestId("filter-sport-sepak_takraw")).toHaveTextContent("2");
    // no category row until a sport is picked
    expect(screen.queryByTestId("filter-cat-all")).toBeNull();

    await userEvent.click(screen.getByTestId("filter-sport-sepak_takraw"));
    expect(screen.getByTestId("filter-cat-all")).toBeInTheDocument();
    expect(
      screen.getByTestId("filter-cat-sepak_takraw.u_14.girls.3v3"),
    ).toBeInTheDocument();
    // the other sport's category is not offered
    expect(
      screen.queryByTestId("filter-cat-table_tennis.u_14.boys.1v1"),
    ).toBeNull();
  });

  it("is hidden when there is only one competition", () => {
    const noop = vi.fn();
    const { container } = render(
      <PreviewFilterBar
        matches={[pm({ ref: "p1" })]}
        sport={null}
        category={null}
        onSport={noop}
        onCategory={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
