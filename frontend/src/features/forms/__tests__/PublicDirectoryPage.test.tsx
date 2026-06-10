import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublicDirectoryPage } from "../PublicDirectoryPage";
import { formsApi } from "@/api/forms";

vi.mock("@/api/forms");

const DATA = {
  tournament_name: "Anpsa",
  form_title: "School Registration — Sepak Takraw & Table Tennis 2026",
  filters: [
    {
      key: "competition",
      label: "Which competition?",
      options: [
        { value: "sepak", label: "Sepak Takraw only" },
        { value: "both", label: "Both" },
      ],
    },
    {
      key: "sepak_categories",
      label: "Sepak categories",
      options: [
        { value: "u14_girls", label: "U-14 Girls" },
        { value: "u14_boys", label: "U-14 Boys" },
      ],
    },
  ],
  entries: [
    {
      name: "Grace High",
      region: "Kohima",
      kind: "school",
      values: { competition: "both", sepak_categories: ["u14_girls"] },
    },
    {
      name: "Mount Hermon",
      region: "",
      kind: "school",
      values: { competition: "sepak", sepak_categories: ["u14_girls", "u14_boys"] },
    },
  ],
  count: 2,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/f/form1/directory"]}>
        <Routes>
          <Route path="/f/:formId/directory" element={<PublicDirectoryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(formsApi.directory).mockResolvedValue(DATA as any);
});
afterEach(() => vi.restoreAllMocks());

describe("PublicDirectoryPage", () => {
  it("renders the header, total, dynamic stat cards, and entries", async () => {
    renderPage();

    expect(
      await screen.findByText("Registered institutions"),
    ).toBeInTheDocument();
    // Total stat tile (label unique to the hero count).
    expect(screen.getByText("institutions registered")).toBeInTheDocument();
    // A distribution card per form dimension (label appears in card + filter).
    expect(screen.getAllByText("Which competition?").length).toBeGreaterThan(0);
    // Distribution surfaces an option that was actually chosen.
    expect(screen.getAllByText("U-14 Girls").length).toBeGreaterThan(0);
    // Entries table.
    expect(screen.getByText("Grace High")).toBeInTheDocument();
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
  });

  it("toggles between the breakdown and the directory list", async () => {
    renderPage();
    await screen.findByText("Grace High"); // both shown by default

    // Breakdown only → the table (entries) is hidden.
    await userEvent.click(screen.getByRole("tab", { name: "Breakdown" }));
    expect(screen.queryByText("Grace High")).toBeNull();

    // Directory only → the stat cards (".. replied") are hidden, list returns.
    await userEvent.click(screen.getByRole("tab", { name: "Directory" }));
    expect(screen.getByText("Grace High")).toBeInTheDocument();
    expect(screen.queryAllByText(/replied/i)).toHaveLength(0);
  });

  it("filters the entries by search", async () => {
    renderPage();
    await screen.findByText("Grace High");

    await userEvent.type(screen.getByLabelText("Search"), "Mount");

    await waitFor(() =>
      expect(screen.queryByText("Grace High")).toBeNull(),
    );
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
  });
});
