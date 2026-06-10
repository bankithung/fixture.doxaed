import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResponsesPage } from "../ResponsesPage";
import { ToastProvider } from "@/components/ui/toast";
import { formsApi } from "@/api/forms";
import type { FormResponseRow, FormSummary } from "../types";

vi.mock("@/api/forms");

/** Minimal schema so the detail dialog can map field keys -> labels. */
const form: FormSummary = {
  id: "form1",
  slug: "inter-school",
  title: "Inter-School Registration",
  description: "",
  purpose: "organization_registration",
  stage: "",
  status: "open",
  opens_at: null,
  closes_at: null,
  version: 1,
  response_count: 2,
  confirmation_message: "",
  settings: {},
  schema: {
    version: 1,
    sections: [
      {
        key: "school",
        title: "Your school",
        fields: [
          {
            key: "school_name",
            type: "short_text",
            label: "School name",
            role: "title",
          },
        ],
      },
    ],
  },
};

const rows: FormResponseRow[] = [
  {
    id: "r1",
    answers: { school_name: "Mount Hermon" },
    respondent_email: "hermon@example.com",
    respondent_phone: "+91 90000 00001",
    respondent_name: "Mount Hermon",
    title: "Mount Hermon",
    status: "submitted",
    mapped_entities: {},
    created_at: "2026-06-01T10:00:00Z",
  },
  {
    id: "r2",
    answers: { school_name: "Don Bosco" },
    respondent_email: "bosco@example.com",
    respondent_phone: "+91 90000 00002",
    respondent_name: "Don Bosco",
    title: "Don Bosco",
    status: "accepted",
    mapped_entities: {},
    created_at: "2026-06-02T10:00:00Z",
  },
];

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/tournaments/t1/forms/form1/responses"]}
        >
          <Routes>
            <Route
              path="/tournaments/:id/forms/:formId/responses"
              element={<ResponsesPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ResponsesPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Desktop width so the table (not the mobile cards) renders.
    window.innerWidth = 1280;
  });

  it("accepts a row → calls setResponseStatus(rid, 'accepted') and the pill updates", async () => {
    // A mutable server store so the post-mutation refetch reflects the write
    // (the page invalidates + refetches `responses` after a status change).
    const store: FormResponseRow[] = rows.map((r) => ({ ...r }));
    vi.mocked(formsApi.responses).mockImplementation(() =>
      Promise.resolve(store.map((r) => ({ ...r }))),
    );
    vi.mocked(formsApi.get).mockResolvedValue(form);
    vi.mocked(formsApi.setResponseStatus).mockImplementation(
      (_formId, rid, status) => {
        const target = store.find((r) => r.id === rid);
        if (target) target.status = status as FormResponseRow["status"];
        return Promise.resolve({ ...(target as FormResponseRow) });
      },
    );

    renderPage();

    // The first (submitted) row renders.
    const firstRow = (
      await screen.findByRole("cell", { name: /mount hermon/i })
    ).closest("tr") as HTMLTableRowElement;
    expect(firstRow).not.toBeNull();
    // Pre-condition: this row is "Submitted", not yet "Accepted".
    expect(within(firstRow).getByText(/^submitted$/i)).toBeInTheDocument();

    // Open the row's actions menu, then click Accept (menu portals to body).
    await userEvent.click(
      within(firstRow).getByRole("button", { name: /change status/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /accept/i }),
    );

    // The API was called with this row's id + the "accepted" status.
    await waitFor(() =>
      expect(formsApi.setResponseStatus).toHaveBeenCalledWith(
        "form1",
        "r1",
        "accepted",
      ),
    );

    // Optimistic update: the pill flips to "Accepted" for this row.
    await waitFor(() =>
      expect(within(firstRow).getByText(/^accepted$/i)).toBeInTheDocument(),
    );
    expect(within(firstRow).queryByText(/^submitted$/i)).toBeNull();
  });
});
