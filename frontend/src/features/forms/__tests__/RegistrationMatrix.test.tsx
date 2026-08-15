import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DirectoryCompetition, DirectoryEntry } from "@/api/forms";
import { RegistrationMatrix } from "../RegistrationMatrix";

const COMPETITIONS: DirectoryCompetition[] = [
  { leaf_key: "tt.u14.boys.1v1", label: "Table Tennis · U-14 · Boys · Singles", count: 2 },
  { leaf_key: "tt.open.girls.2v2", label: "Table Tennis · Open Category · Girls · Doubles", count: 1 },
  { leaf_key: "spk.u14.boys", label: "Sepak Takraw · U-14 · Boys", count: 1 },
];

const ENTRIES: DirectoryEntry[] = [
  {
    name: "Grace Academy",
    region: "",
    kind: "school",
    competitions: [
      { leaf_key: "tt.u14.boys.1v1", label: "Table Tennis · U-14 · Boys · Singles" },
      { leaf_key: "spk.u14.boys", label: "Sepak Takraw · U-14 · Boys" },
    ],
    values: {},
  },
  {
    name: "Riverbelt School",
    region: "",
    kind: "school",
    competitions: [
      { leaf_key: "tt.open.girls.2v2", label: "Table Tennis · Open Category · Girls · Doubles" },
    ],
    values: {},
  },
];

function mount() {
  render(
    <RegistrationMatrix
      entries={ENTRIES}
      competitions={COMPETITIONS}
      nameLabel="School name"
    />,
  );
}

describe("RegistrationMatrix", () => {
  it("bands the columns by sport and codes each competition", () => {
    mount();
    expect(
      screen.getByRole("columnheader", { name: "Table Tennis" }),
    ).toHaveAttribute("colspan", "2");
    expect(
      screen.getByRole("columnheader", { name: "Sepak Takraw" }),
    ).toHaveAttribute("colspan", "1");
    // "U-14 · Boys · Singles" -> UBS; "Open · Girls · Doubles" -> OGD.
    expect(screen.getByTitle("Table Tennis · U-14 · Boys · Singles")).toHaveTextContent(
      "UBS",
    );
    expect(
      screen.getByTitle("Table Tennis · Open Category · Girls · Doubles"),
    ).toHaveTextContent("OGD");
  });

  it("spells every code out in the legend, with both cell states", () => {
    mount();
    const legend = screen.getByTestId("matrix-legend");
    expect(within(legend).getByText("Competition legend")).toBeInTheDocument();
    expect(
      within(legend).getByText("Table Tennis · U-14 · Boys · Singles"),
    ).toBeInTheDocument();
    expect(within(legend).getByText("Registered")).toBeInTheDocument();
    expect(within(legend).getByText("Not registered")).toBeInTheDocument();
  });

  it("ticks what a school entered and crosses what it did not", () => {
    mount();
    const grace = screen.getByTestId("cell-0-UBS");
    expect(within(grace).getByText("Registered")).toBeInTheDocument();
    const graceMissing = screen.getByTestId("cell-0-OGD");
    expect(within(graceMissing).getByText("Not registered")).toBeInTheDocument();
    // Row 2 is the other way round.
    expect(
      within(screen.getByTestId("cell-1-OGD")).getByText("Registered"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("cell-1-UB")).getByText("Not registered"),
    ).toBeInTheDocument();
  });

  it("keeps every configured competition, including one nobody entered", () => {
    render(
      <RegistrationMatrix
        entries={[]}
        competitions={COMPETITIONS}
        nameLabel="School name"
      />,
    );
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThanOrEqual(5);
    expect(
      screen.getByText("No institutions match these filters."),
    ).toBeInTheDocument();
  });
});
