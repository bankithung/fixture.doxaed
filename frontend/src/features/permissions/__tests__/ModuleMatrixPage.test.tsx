import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { screen, within, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { ModuleMatrixPage } from "../ModuleMatrixPage";
import { permissionsApi } from "@/api/permissions";
import type { ModuleMatrixResponse } from "@/types/user";
import { ApiError } from "@/types/api";

const FIXTURE: ModuleMatrixResponse = {
  modules: [
    {
      key: "org.settings",
      scope: "org",
      label: "Org settings",
      description: "Org-level configuration",
    },
    {
      key: "tournament.scoring_console",
      scope: "tournament",
      label: "Scoring console",
      description: "Live scoring",
    },
  ],
  members: [
    {
      user_id: "u1",
      user_email: "alice@example.com",
      user_full_name: "Alice Smith",
      roles: ["admin"],
      cells: { "org.settings": "default" },
      role_defaults: {
        "org.settings": true,
        "tournament.scoring_console": false,
      },
    },
  ],
};

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/o/acme/permissions"]}>
          <Routes>
            <Route
              path="/o/:orgSlug/permissions"
              element={<ModuleMatrixPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ModuleMatrixPage", () => {
  it("renders members and modules from the aggregate matrix endpoint", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);

    renderPage();

    expect(
      await screen.findByRole("heading", { name: /module overrides/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Alice Smith")).toBeInTheDocument();
    // Module label appears in the column header.
    expect(screen.getByText("Org settings")).toBeInTheDocument();
  });

  it("editing a cell enables the row Save button", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);

    renderPage();

    const row = await screen.findByRole("row", { name: /alice@example/i });
    // No Save button present until dirty.
    expect(
      within(row).queryByRole("button", { name: /save row for/i }),
    ).toBeNull();

    const cells = within(row).getAllByRole("switch");
    await userEvent.click(cells[1]);

    const saveBtn = await within(row).findByRole("button", {
      name: /save row for alice/i,
    });
    expect(saveBtn).toBeEnabled();
  });

  it("Save calls PUT with the merged cells map and an event_id", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);
    const setSpy = vi
      .spyOn(permissionsApi, "setGrants")
      .mockResolvedValue({ ok: true });

    renderPage();

    const row = await screen.findByRole("row", { name: /alice@example/i });
    const cells = within(row).getAllByRole("switch");
    await userEvent.click(cells[1]); // tournament.scoring_console -> grant

    const saveBtn = await within(row).findByRole("button", {
      name: /save row for alice/i,
    });
    await userEvent.click(saveBtn);

    await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    const [slug, userId, payload] = setSpy.mock.calls[0];
    expect(slug).toBe("acme");
    expect(userId).toBe("u1");
    expect(payload.cells).toEqual({
      "org.settings": "default",
      "tournament.scoring_console": "grant",
    });
    expect(typeof payload.event_id).toBe("string");
    expect(payload.event_id.length).toBeGreaterThan(0);
  });

  it("optimistic update keeps the edited state visible while the PUT is in-flight, then clears edits on success", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);

    let resolveSet!: (v: { ok: true }) => void;
    vi.spyOn(permissionsApi, "setGrants").mockImplementation(
      () =>
        new Promise((res) => {
          resolveSet = res;
        }),
    );

    renderPage();

    const row = await screen.findByRole("row", { name: /alice@example/i });
    const cells = within(row).getAllByRole("switch");
    await userEvent.click(cells[1]); // -> grant
    expect(cells[1].getAttribute("data-state")).toBe("grant");

    const saveBtn = await within(row).findByRole("button", {
      name: /save row for alice/i,
    });
    await userEvent.click(saveBtn);

    // Cell stays in optimistic "grant" state during the in-flight save.
    expect(cells[1].getAttribute("data-state")).toBe("grant");

    // Resolve the PUT.
    resolveSet({ ok: true });

    // After success, the row's edits clear and the Save button disappears.
    await waitFor(() =>
      expect(
        within(row).queryByRole("button", { name: /save row for/i }),
      ).toBeNull(),
    );
  });

  it("on save error, edits remain (operator can retry) and a toast surfaces", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);
    vi.spyOn(permissionsApi, "setGrants").mockRejectedValue(
      new ApiError(500, { detail: "Internal Server Error" }),
    );

    renderPage();

    const row = await screen.findByRole("row", { name: /alice@example/i });
    const cells = within(row).getAllByRole("switch");
    await userEvent.click(cells[1]);
    expect(cells[1].getAttribute("data-state")).toBe("grant");

    const saveBtn = await within(row).findByRole("button", {
      name: /save row for alice/i,
    });
    await userEvent.click(saveBtn);

    // Toast surfaces the failure.
    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();

    // Edit is preserved so the user can retry.
    expect(cells[1].getAttribute("data-state")).toBe("grant");
    expect(
      within(row).getByRole("button", { name: /save row for alice/i }),
    ).toBeInTheDocument();
  });

  it("Reset to defaults clears all unsaved edits without calling the API", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue(FIXTURE);
    const setSpy = vi.spyOn(permissionsApi, "setGrants");

    renderPage();

    const row = await screen.findByRole("row", { name: /alice@example/i });
    const cells = within(row).getAllByRole("switch");
    await userEvent.click(cells[1]);
    expect(cells[1].getAttribute("data-state")).toBe("grant");

    const reset = screen.getByRole("button", {
      name: /reset all unsaved edits to defaults/i,
    });
    await userEvent.click(reset);

    expect(cells[1].getAttribute("data-state")).toBe("default");
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("renders a graceful 403 card when the user can't access the matrix", async () => {
    vi.spyOn(permissionsApi, "matrix").mockRejectedValue(
      new ApiError(403, { detail: "forbidden" }),
    );

    renderPage();

    expect(
      await screen.findByRole("heading", { name: /access required/i }),
    ).toBeInTheDocument();
  });

  it("renders an empty state when there are no members", async () => {
    vi.spyOn(permissionsApi, "matrix").mockResolvedValue({
      modules: FIXTURE.modules,
      members: [],
    });

    renderPage();

    expect(await screen.findByText(/no members yet/i)).toBeInTheDocument();
  });
});
