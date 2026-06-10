import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  competitions: [
    {
      leaf_key: "sepak.u14.girls",
      label: "Sepak Takraw — U-14 — Girls",
      count: 2,
    },
    {
      leaf_key: "sepak.u14.boys",
      label: "Sepak Takraw — U-14 — Boys",
      count: 1,
    },
  ],
  entries: [
    {
      name: "Grace High",
      region: "Kohima",
      kind: "school",
      competitions: [
        { leaf_key: "sepak.u14.girls", label: "Sepak Takraw — U-14 — Girls" },
      ],
      values: { competition: "both", sepak_categories: ["u14_girls"] },
    },
    {
      name: "Mount Hermon",
      region: "",
      kind: "school",
      competitions: [
        { leaf_key: "sepak.u14.girls", label: "Sepak Takraw — U-14 — Girls" },
        { leaf_key: "sepak.u14.boys", label: "Sepak Takraw — U-14 — Boys" },
      ],
      values: { competition: "sepak", sepak_categories: ["u14_girls", "u14_boys"] },
    },
  ],
  count: 2,
  form_open: true,
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
  // Desktop width unless a test overrides it (mobile renders stacked cards).
  window.innerWidth = 1024;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(formsApi.directory).mockResolvedValue(DATA as any);
});
afterEach(() => {
  window.innerWidth = 1024;
  vi.restoreAllMocks();
});

describe("PublicDirectoryPage", () => {
  it("renders the header, total, filters, and entries", async () => {
    renderPage();

    expect(
      await screen.findByText("Registered institutions"),
    ).toBeInTheDocument();
    // Total stat tile (label unique to the hero count).
    expect(screen.getByText("institutions registered")).toBeInTheDocument();
    // The form's own choice questions become rail filters.
    expect(screen.getAllByText("Which competition?").length).toBeGreaterThan(0);
    // A chosen option surfaces in the table cells.
    expect(screen.getAllByText("U-14 Girls").length).toBeGreaterThan(0);
    // Entries table.
    expect(screen.getByText("Grace High")).toBeInTheDocument();
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
    // The Breakdown tab is gone — only Directory + Competitions remain.
    expect(screen.queryByRole("tab", { name: "Breakdown" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    // While the form is open the header links back to the registration form.
    expect(
      screen.getByRole("link", { name: /Register your institution/ }),
    ).toHaveAttribute("href", "/f/form1");
  });

  it("hides the register CTA once the form has closed", async () => {
    vi.mocked(formsApi.directory).mockResolvedValue({
      ...DATA,
      form_open: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    renderPage();
    await screen.findByText("Grace High");

    expect(
      screen.queryByRole("link", { name: /Register your institution/ }),
    ).toBeNull();
  });

  it("toggles between the competitions view and the directory list", async () => {
    renderPage();
    await screen.findByText("Grace High"); // table shown by default
    expect(screen.getByRole("table")).toBeInTheDocument();

    // Competitions view replaces the table with the sport → category report.
    await userEvent.click(screen.getByRole("tab", { name: "Competitions" }));
    expect(screen.queryByRole("table")).toBeNull();

    // Back to the directory list.
    await userEvent.click(screen.getByRole("tab", { name: "Directory" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
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

  it("shows per-main-game registration KPI cards by default", async () => {
    renderPage();
    await screen.findByText("Grace High");

    const summary = screen.getByRole("region", {
      name: "Registration summary",
    });
    // The total card plus a matching card per game. Both institutions
    // entered Sepak Takraw → 2 DISTINCT institutions (sub-categories never
    // appear in the headline).
    expect(within(summary).getByText("institutions registered")).toBeInTheDocument();
    expect(within(summary).getByText("Sepak Takraw")).toBeInTheDocument();
    expect(within(summary).getAllByText("2").length).toBeGreaterThan(0);
    expect(within(summary).queryByText(/U-14/)).toBeNull();
  });

  it("hides the per-game KPI cards when the admin chose total-only", async () => {
    vi.mocked(formsApi.directory).mockResolvedValue({
      ...DATA,
      kpi_mode: "total",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    renderPage();
    await screen.findByText("Grace High");

    const summary = screen.getByRole("region", {
      name: "Registration summary",
    });
    expect(within(summary).getByText("institutions registered")).toBeInTheDocument();
    expect(within(summary).queryByText("Sepak Takraw")).toBeNull();
  });

  it("applies the active filters to the Competitions tab", async () => {
    renderPage();
    await screen.findByText("Grace High");

    await userEvent.click(screen.getByRole("tab", { name: "Competitions" }));
    // Unfiltered: both institutions appear as chips under their competitions.
    expect(screen.getAllByText("Grace High").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mount Hermon")).toHaveLength(2);

    await userEvent.type(screen.getByLabelText("Search"), "Mount");

    // The competitions view honours the search: Grace High's chip is gone,
    // Mount Hermon stays listed under both of its competitions.
    await waitFor(() => expect(screen.queryByText("Grace High")).toBeNull());
    expect(screen.getAllByText("Mount Hermon")).toHaveLength(2);
  });

  it("renders stacked cards and a filter bottom-sheet on mobile", async () => {
    window.innerWidth = 375;
    renderPage();
    await screen.findByText("Grace High");

    // No table on phones — entries render as stacked cards.
    expect(screen.queryByRole("table")).toBeNull();

    // Filters live behind the toolbar button → bottom sheet.
    await userEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.type(within(sheet).getByLabelText("Search"), "Mount");
    await userEvent.click(
      within(sheet).getByRole("button", { name: /Show 1 institution/ }),
    );

    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(screen.queryByText("Grace High")).toBeNull();
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
  });
});
