import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormsListPage } from "../FormsListPage";
import { ToastProvider } from "@/components/ui/toast";
import { formsApi } from "@/api/forms";
import type { FormSummary } from "../types";

vi.mock("@/api/forms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/forms")>();
  return {
    ...actual,
    formsApi: {
      ...actual.formsApi,
      list: vi.fn(),
      remove: vi.fn(),
      institutionLinks: vi.fn(),
    },
  };
});

function mk(overrides: Partial<FormSummary>): FormSummary {
  return {
    id: "f1",
    slug: "f1",
    title: "School Registration",
    description: "",
    purpose: "organization_registration",
    stage: "org_registration",
    status: "open",
    opens_at: null,
    closes_at: null,
    version: 1,
    response_count: 5,
    confirmation_message: "",
    settings: {},
    schema: { version: 1, sections: [] },
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/forms"]}>
          <Routes>
            <Route path="/tournaments/:id/forms" element={<FormsListPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.innerWidth = 1280;
});
afterEach(() => vi.restoreAllMocks());

describe("FormsListPage", () => {
  it("renders the forms list", async () => {
    vi.mocked(formsApi.list).mockResolvedValue([
      mk({ id: "f1", title: "School Registration", status: "open" }),
      mk({ id: "f2", title: "Team Registration", status: "draft" }),
    ]);

    renderPage();

    expect(await screen.findByText("School Registration")).toBeInTheDocument();
    expect(screen.getByText("Team Registration")).toBeInTheDocument();
    expect(formsApi.list).toHaveBeenCalledWith("t1");
  });

  it("deletes a form after confirming in the dialog", async () => {
    vi.mocked(formsApi.list).mockResolvedValue([
      mk({ id: "f1", title: "School Registration" }),
    ]);
    vi.mocked(formsApi.remove).mockResolvedValue(undefined);

    renderPage();

    await screen.findByText("School Registration");

    // Trash icon → confirmation dialog (not an immediate delete).
    await userEvent.click(screen.getByTestId("delete-form-f1"));
    const dialog = await screen.findByRole("dialog", { name: /delete form/i });
    // The confirm copy mentions the response count.
    expect(within(dialog).getByText(/5 responses/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByTestId("confirm-delete-form"));

    await waitFor(() => expect(formsApi.remove).toHaveBeenCalledWith("f1"));
  });

  it("mints + lists per-institution links for a team form", async () => {
    vi.mocked(formsApi.list).mockResolvedValue([
      mk({
        id: "team1",
        title: "Team registration",
        purpose: "team_registration",
        status: "open",
      }),
    ]);
    vi.mocked(formsApi.institutionLinks).mockResolvedValue({
      minted: 1,
      total: 1,
      links: [
        { institution_id: "i1", name: "Springfield High", minted: true, path: "/r/abc" },
      ],
    });

    renderPage();

    await screen.findByText("Team registration");
    await userEvent.click(screen.getByTestId("links-team1"));

    expect(await screen.findByText("Springfield High")).toBeInTheDocument();
    expect(formsApi.institutionLinks).toHaveBeenCalledWith("team1");
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there are no forms", async () => {
    vi.mocked(formsApi.list).mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(/no registration forms yet/i),
    ).toBeInTheDocument();
  });
});
