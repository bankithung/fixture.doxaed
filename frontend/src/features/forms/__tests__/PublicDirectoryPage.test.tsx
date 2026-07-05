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
  form_title: "School Registration · Sepak Takraw & Table Tennis 2026",
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
      label: "Sepak Takraw · U-14 · Girls",
      count: 2,
    },
    {
      leaf_key: "sepak.u14.boys",
      label: "Sepak Takraw · U-14 · Boys",
      count: 1,
    },
  ],
  entries: [
    {
      name: "Grace High",
      region: "Kohima",
      kind: "school",
      competitions: [
        { leaf_key: "sepak.u14.girls", label: "Sepak Takraw · U-14 · Girls" },
      ],
      values: { competition: "both", sepak_categories: ["u14_girls"] },
    },
    {
      name: "Mount Hermon",
      region: "",
      kind: "school",
      competitions: [
        { leaf_key: "sepak.u14.girls", label: "Sepak Takraw · U-14 · Girls" },
        { leaf_key: "sepak.u14.boys", label: "Sepak Takraw · U-14 · Boys" },
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

    // Appears as the page eyebrow AND the merged panel's title.
    expect(
      (await screen.findAllByText("Registered institutions")).length,
    ).toBeGreaterThan(0);
    // The headline count lives in the panel toolbar now.
    expect(screen.getByTestId("registered-count")).toHaveTextContent(
      "2registered",
    );
    // The form's own choice questions become rail filters.
    expect(screen.getAllByText("Which competition?").length).toBeGreaterThan(0);
    // A chosen option surfaces in the table cells.
    expect(screen.getAllByText("U-14 Girls").length).toBeGreaterThan(0);
    // Entries table.
    expect(screen.getByText("Grace High")).toBeInTheDocument();
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
    // The Breakdown view is gone — only Directory + Competitions remain
    // (RangePills buttons, not tabs).
    expect(screen.queryByRole("button", { name: "Breakdown" })).toBeNull();
    expect(screen.getByRole("button", { name: "Directory" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Competitions" }),
    ).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Competitions" }));
    expect(screen.queryByRole("table")).toBeNull();

    // Back to the directory list.
    await userEvent.click(screen.getByRole("button", { name: "Directory" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("filters the entries by search", async () => {
    renderPage();
    await screen.findByText("Grace High");

    // Filters live in the right-side drawer now.
    await userEvent.click(screen.getByTestId("open-directory-filters"));
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
    // One chip per MAIN game. Both institutions entered Sepak Takraw →
    // 2 DISTINCT institutions (sub-categories never appear here); the
    // total lives in the panel toolbar.
    expect(within(summary).getByText("Sepak Takraw")).toBeInTheDocument();
    expect(within(summary).getAllByText("2").length).toBeGreaterThan(0);
    expect(within(summary).queryByText(/U-14/)).toBeNull();
    expect(screen.getByTestId("registered-count")).toHaveTextContent(
      "2registered",
    );
  });

  it("hides the per-game KPI cards when the admin chose total-only", async () => {
    vi.mocked(formsApi.directory).mockResolvedValue({
      ...DATA,
      kpi_mode: "total",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    renderPage();
    await screen.findByText("Grace High");

    // Total-only mode: the per-game strip disappears entirely; the toolbar
    // count remains.
    expect(
      screen.queryByRole("region", { name: "Registration summary" }),
    ).toBeNull();
    expect(screen.getByTestId("registered-count")).toHaveTextContent(
      "2registered",
    );
  });

  it("Competitions tab is a full report · all competitions with server counts", async () => {
    renderPage();
    await screen.findByText("Grace High");

    await userEvent.click(screen.getByRole("button", { name: "Competitions" }));
    const section = screen.getByRole("region", {
      name: "Entries by competition",
    });
    // Counts only (no school names); every configured competition is shown
    // with its server-side registration count (owner 2026-06-16).
    expect(within(section).queryByText("Grace High")).toBeNull();
    const row = (label: string) =>
      within(section).getByText(label).closest("li") as HTMLElement;
    expect(within(row("U-14 · Girls")).getByText("2")).toBeInTheDocument();
    expect(within(row("U-14 · Boys")).getByText("1")).toBeInTheDocument();

    // It's a stable report — filtering the directory doesn't prune or rescale it.
    await userEvent.click(screen.getByTestId("open-directory-filters"));
    await userEvent.type(screen.getByLabelText("Search"), "zzz");
    expect(within(row("U-14 · Girls")).getByText("2")).toBeInTheDocument();
  });

  it("keeps the sport name in the strip; a custom stat label is its tooltip", async () => {
    vi.mocked(formsApi.directory).mockResolvedValue({
      ...DATA,
      kpi_labels: { sepak: "Sepak (B&G)" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    renderPage();
    await screen.findByText("Grace High");

    const summary = screen.getByRole("region", {
      name: "Registration summary",
    });
    // Two chips both reading a custom label said nothing — the sport name
    // always shows; the custom label rides along as the tooltip.
    const chip = within(summary).getByText("Sepak Takraw");
    expect(chip).toHaveAttribute("title", "Sepak (B&G)");
    expect(within(summary).queryByText("Sepak (B&G)")).toBeNull();
  });

  it("competition filter: a leaf narrows, the parent shows partial, ticking the parent restores all", async () => {
    renderPage();
    await screen.findByText("Grace High");

    // The competition tree lives in the filter drawer.
    await userEvent.click(screen.getByTestId("open-directory-filters"));
    // Drill in to the gender leaves (branches start collapsed).
    await userEvent.click(
      screen.getByRole("button", { name: "Expand Sepak Takraw" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Expand U-14" }));

    // Tick only the Boys leaf → schools without a Boys entry drop out. The
    // accessible name carries the trailing count, so match by prefix.
    await userEvent.click(screen.getByRole("checkbox", { name: /^Boys/ }));
    await waitFor(() => expect(screen.queryByText("Grace High")).toBeNull());
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();

    // The Sepak Takraw parent is now partially selected (indeterminate).
    const sepak = screen.getByRole("checkbox", {
      name: /^Sepak Takraw/,
    }) as HTMLInputElement;
    expect(sepak).not.toBeChecked();
    expect(sepak.indeterminate).toBe(true);

    // Ticking the parent selects everything under it → Grace High returns.
    await userEvent.click(sepak);
    await waitFor(() =>
      expect(screen.getByText("Grace High")).toBeInTheDocument(),
    );
    expect(screen.getByText("Mount Hermon")).toBeInTheDocument();
  });

  it("ticking a root opens its whole branch so the sub-options are visible", async () => {
    renderPage();
    await screen.findByText("Grace High");

    await userEvent.click(screen.getByTestId("open-directory-filters"));
    // Leaves are hidden initially (branches start collapsed).
    expect(screen.queryByRole("checkbox", { name: /^Girls/ })).toBeNull();

    // Tick the Sepak Takraw root → every level beneath opens automatically
    // and the leaves come up already selected.
    await userEvent.click(screen.getByRole("checkbox", { name: /^Sepak Takraw/ }));
    expect(await screen.findByRole("checkbox", { name: /^Girls/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Boys/ })).toBeChecked();
  });

  it("renders stacked cards and the filter drawer on mobile", async () => {
    window.innerWidth = 375;
    renderPage();
    await screen.findByText("Grace High");

    // No table on phones — entries render as stacked cards.
    expect(screen.queryByRole("table")).toBeNull();

    // Filters open the right drawer from the floating pill.
    await userEvent.click(
      screen.getAllByRole("button", { name: /Filters/ })[0],
    );
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
