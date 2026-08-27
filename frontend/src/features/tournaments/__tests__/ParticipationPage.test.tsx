import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentRoster } from "@/api/tournaments";
import { ParticipationPage } from "../ParticipationPage";

/**
 * The participation workbench (owner 2026-08-17). Its whole reason to exist is
 * the question the draw needs answered before it runs: WHO is in more than one
 * event — not how many.
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, roster: vi.fn() },
  };
});

const BASE = {
  kind: "student" as const,
  gender: "",
  date_of_birth: null,
  contact_email: "",
  contact_phone: "",
  attributes: {},
  group: null,
};

const TT = "table_tennis.u_14.boys.singles";
const TT2 = "table_tennis.u_14.boys.doubles";
const SPK = "sepak_takraw.u_14.boys";

const DATA: TournamentRoster = {
  can_manage: true,
  roster_mode: "roster_first",
  scope: "inter_school",
  group_kind: "",
  counts: { students: 3, teachers: 0, multi_entry: 2 },
  members: [
    {
      ...BASE,
      id: "m1",
      full_name: "Imli Jamir",
      class_section: "8-A",
      roll_no: "12",
      institution: { id: "i1", name: "Grace Academy" },
      entries: [
        { team_id: "t1", team: "Grace A", leaf_key: TT, role: "player" },
        { team_id: "t2", team: "Grace B", leaf_key: TT2, role: "player" },
      ],
    },
    {
      ...BASE,
      id: "m2",
      full_name: "Toshi Ao",
      class_section: "9-B",
      roll_no: "3",
      institution: { id: "i2", name: "Lorna's School" },
      entries: [
        { team_id: "t3", team: "Lorna A", leaf_key: TT, role: "player" },
        { team_id: "t4", team: "Lorna S", leaf_key: SPK, role: "player" },
      ],
    },
    {
      ...BASE,
      id: "m3",
      full_name: "Aben Kikon",
      class_section: "7-C",
      roll_no: "21",
      institution: { id: "i1", name: "Grace Academy" },
      entries: [{ team_id: "t1", team: "Grace A", leaf_key: TT, role: "player" }],
    },
  ],
} as TournamentRoster;

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/participation"]}>
          <Routes>
            <Route
              path="/tournaments/:id/participation"
              element={<ParticipationPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.roster).mockResolvedValue(DATA);
});

describe("ParticipationPage", () => {
  it("leads with the number the draw cares about and lists everyone", async () => {
    mount();
    await screen.findByTestId("participation-m1");
    expect(screen.getByTestId("stat-people")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-multi")).toHaveTextContent("2");
    // Two events in ONE sport is a lesser clash than two sports — counted apart.
    expect(screen.getByTestId("stat-cross-sport")).toHaveTextContent("1");
    expect(screen.getByTestId("participation-m1")).toBeInTheDocument();
    expect(screen.getByTestId("participation-m3")).toBeInTheDocument();
  });

  it("shows the details the form collected, and no column it never asked for", async () => {
    // A roster-first event asks for a date of birth and an age-proof document
    // and never asks for a class or a roll number; the list used to show a
    // hardcoded Class and Roll and nothing else (owner 2026-08-19).
    vi.mocked(tournamentsApi.roster).mockResolvedValue({
      ...DATA,
      members: DATA.members.map((m) => ({
        ...m,
        class_section: "",
        roll_no: "",
        gender: "male",
        date_of_birth: "2013-04-02",
        documents:
          m.id === "m1"
            ? [
                {
                  name: "birth.pdf",
                  label: "Birth certificate",
                  url: "/api/forms/uploads/abc/",
                  content_type: "application/pdf",
                },
              ]
            : [],
      })),
    } as TournamentRoster);
    mount();
    const row = await screen.findByTestId("participation-m1");
    // Written the way the squad panel writes it (locale-formatted, not raw ISO).
    expect(row.querySelector('[data-col="dob"]')).toHaveTextContent(/Apr.*2013/);
    expect(row.querySelector('[data-col="gender"]')).toHaveTextContent("Male");
    // The document is the file itself, not a count — the reason to open the
    // list is to check what a school actually sent.
    const doc = within(row as HTMLElement).getByRole("link", {
      name: "Birth certificate",
    });
    expect(doc).toHaveAttribute("href", "/api/forms/uploads/abc/");
    // Columns nobody filled are not there at all.
    expect(row.querySelector('[data-col="class"]')).toBeNull();
    expect(row.querySelector('[data-col="roll"]')).toBeNull();
  });

  it("keeps Class and Roll for an event whose form does ask for them", async () => {
    mount();
    const row = await screen.findByTestId("participation-m1");
    expect(row.querySelector('[data-col="class"]')).toHaveTextContent("8-A");
    expect(row.querySelector('[data-col="roll"]')).toHaveTextContent("12");
    expect(row.querySelector('[data-col="dob"]')).toBeNull();
  });

  it("marks the rows that are in more than one event", async () => {
    mount();
    expect(await screen.findByTestId("participation-m1")).toHaveAttribute("data-multi");
    expect(screen.getByTestId("participation-m3")).not.toHaveAttribute("data-multi");
  });

  it("names the sport and the category on each entry", async () => {
    mount();
    const row = await screen.findByTestId("participation-m2");
    expect(row).toHaveTextContent("Table Tennis");
    expect(row).toHaveTextContent("Sepak Takraw");
    expect(row).toHaveTextContent("U 14 · Boys · Singles");
  });

  it("the multi count IS the filter: clicking it shows exactly those people", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("stat-multi"));
    expect(screen.getByTestId("participation-m1")).toBeInTheDocument();
    expect(screen.getByTestId("participation-m2")).toBeInTheDocument();
    // The single-event person is gone.
    expect(screen.queryByTestId("participation-m3")).toBeNull();
  });

  it("narrows again to the people spanning two sports", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("stat-cross-sport"));
    expect(screen.getByTestId("participation-m2")).toBeInTheDocument();
    // Imli is in two table tennis events, not two sports.
    expect(screen.queryByTestId("participation-m1")).toBeNull();
  });

  it("searches across name, class, roll and school", async () => {
    mount();
    await userEvent.type(await screen.findByTestId("participation-search"), "9-B");
    expect(screen.getByTestId("participation-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("participation-m1")).toBeNull();
  });

  it("sorts by the event count, busiest first, and flips on a second click", async () => {
    mount();
    const rowIds = () =>
      screen
        .getAllByTestId(/^participation-m/)
        .map((el) => el.getAttribute("data-testid"));
    // Default is busiest-first, so the single-event person is last.
    expect((await screen.findAllByTestId(/^participation-m/)).length).toBe(3);
    expect(rowIds()[2]).toBe("participation-m3");
    await userEvent.click(screen.getByTestId("participation-sort-events"));
    expect(rowIds()[0]).toBe("participation-m3");
  });

  it("the Matrix is the grid: one column per competition, ticked per person", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("participation-view-matrix"));
    const matrix = screen.getByTestId("participation-matrix");
    // Only the competitions actually in use become columns.
    expect(within(matrix).getByText("Table Tennis · U 14 · Boys · Singles")).toBeInTheDocument();
    expect(within(matrix).getByText("Sepak Takraw · U 14 · Boys")).toBeInTheDocument();
    // Imli's row carries two ticks, which is the clash, readable across.
    const row = screen.getByTestId("participation-matrix-m1");
    expect(within(row).getAllByLabelText(/^Imli Jamir: /)).toHaveLength(2);
  });

  it("clears back to the whole list", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("stat-multi"));
    expect(screen.queryByTestId("participation-m3")).toBeNull();
    await userEvent.click(screen.getByTestId("participation-clear"));
    expect(screen.getByTestId("participation-m3")).toBeInTheDocument();
  });

  it("says so plainly when a filter matches nobody", async () => {
    mount();
    await userEvent.type(await screen.findByTestId("participation-search"), "zzzz");
    expect(screen.getByText("Nobody matches that")).toBeInTheDocument();
  });
});

describe("ParticipationWorkbench \u00b7 the sheet reads like a spreadsheet", () => {
  it("numbers the rows and lets a column be dragged wider", async () => {
    // Owner 2026-08-19: "the columns the user should be able to drag and
    // increase width so that I can view full text."
    mount();
    await screen.findByTestId("participation-m1");
    const sheet = screen.getByTestId("participation-sheet");
    // A row-number gutter, exactly as a spreadsheet has one.
    const gutter = sheet.querySelectorAll("[data-row-number]");
    expect(gutter).toHaveLength(3);
    expect(gutter[0]).toHaveTextContent("1");
    expect(gutter[2]).toHaveTextContent("3");

    const handle = screen.getByTestId("participation-resize-name");
    const before = Number(handle.getAttribute("aria-valuenow"));
    // Reachable without a pointer: the arrow keys resize too.
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);

    // Once moved, the offer to put them back appears.
    expect(screen.getByTestId("participation-reset-columns")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("participation-reset-columns"));
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before);
  });

  it("keeps a width narrower than the grab handle out of reach", async () => {
    mount();
    const handle = await screen.findByTestId("participation-resize-roll");
    handle.focus();
    for (let i = 0; i < 12; i++) await userEvent.keyboard("{ArrowLeft}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
      Number(handle.getAttribute("aria-valuemin")),
    );
  });

  it("sorting still works from the heading beside the handle", async () => {
    mount();
    await screen.findByTestId("participation-m1");
    const rowIds = () =>
      screen.getAllByTestId(/^participation-m/).map((el) => el.getAttribute("data-testid"));
    await userEvent.click(screen.getByTestId("participation-sort-events"));
    expect(rowIds()[0]).toBe("participation-m3");
  });
});

describe("ParticipationWorkbench \u00b7 the filters live in a drawer", () => {
  it("opens one Filter button, picks a value, and counts what it left", async () => {
    // Owner 2026-08-19: "make it like this page filter, the sidebar" — six
    // dropdowns on the toolbar competed with the table for its room.
    mount();
    await screen.findByTestId("participation-m1");
    await userEvent.click(screen.getByTestId("participation-open-filters"));
    const drawer = await screen.findByTestId("participation-filter-drawer");

    // The filter NAMES down the left, the chosen filter's values on the right.
    expect(within(drawer).getByTestId("participation-pane-school")).toBeInTheDocument();
    await userEvent.click(within(drawer).getByTestId("participation-pane-events"));
    // Every value carries the count it would leave.
    const multi = within(drawer).getByTestId("participation-value-multi");
    expect(multi).toHaveTextContent("2");
    await userEvent.click(multi);

    expect(screen.queryByTestId("participation-m3")).toBeNull();
    // The button shows how many filters the drawer is holding.
    expect(screen.getByTestId("participation-open-filters")).toHaveTextContent("1");
  });

  it("clears everything from inside the drawer", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("stat-multi"));
    expect(screen.queryByTestId("participation-m3")).toBeNull();
    await userEvent.click(screen.getByTestId("participation-open-filters"));
    await userEvent.click(await screen.findByTestId("participation-drawer-clear"));
    expect(screen.getByTestId("participation-m3")).toBeInTheDocument();
  });
});

describe("ParticipationWorkbench \u00b7 the printed document", () => {
  it("prints the rows the filters left, and says which filters those were", async () => {
    // Owner 2026-08-27: the sheet exported as a spreadsheet only. What the
    // host carries into the room where the draw is settled is a document.
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    mount();
    await screen.findByTestId("participation-m1");
    await userEvent.click(screen.getByTestId("stat-multi"));
    await userEvent.click(screen.getByTestId("participation-export-pdf"));

    const html = String(w.document.write.mock.calls[0]?.[0] ?? "");
    expect(html).toContain("Imli Jamir");
    // m3 is in one event only, so the filter dropped it — and so does the paper.
    expect(html).not.toContain("Aben Kikon");
    expect(html).toContain("In two or more");
    open.mockRestore();
  });

  it("prints the matrix when the matrix is what is on screen", async () => {
    const w = {
      document: { write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
    mount();
    await screen.findByTestId("participation-m1");
    await userEvent.click(screen.getByTestId("participation-view-matrix"));
    await userEvent.click(screen.getByTestId("participation-export-pdf"));

    expect(String(w.document.write.mock.calls[0]?.[0] ?? "")).toContain(
      "participation matrix",
    );
    open.mockRestore();
  });

  describe("on a phone", () => {
    // useBreakpoint reads window.innerWidth through useSyncExternalStore, so a
    // narrow viewport is all it takes to get the mobile shell under test.
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 390);
    });

    it("pins the Filter button to the bottom of the screen", async () => {
      // Owner 2026-08-27: "the filter button doesn't stay stuck on the bottom
      // of the screen but it's placed somewhere below". It was an inline
      // toolbar button, so on a phone it scrolled away with the list and
      // stranded you mid-table with no way back to the filters.
      mount();
      await screen.findByTestId("participation-cards");

      const bar = screen.getByTestId("participation-bottom-bar");
      expect(bar).toBeInTheDocument();
      // `fixed`, not `sticky`: the panel above is a rounded card with
      // overflow-hidden, which would clip a sticky child instead of pinning it.
      expect(bar.className).toMatch(/\bfixed\b/);
      expect(bar.className).toMatch(/bottom-0/);
      expect(bar.className).not.toMatch(/\bsticky\b/);
      // The Filter button lives IN the bar, and only there.
      expect(bar).toContainElement(
        screen.getByTestId("participation-open-filters"),
      );
      expect(screen.getAllByTestId("participation-open-filters")).toHaveLength(1);
    });

    it("opens the same drawer from the bottom bar", async () => {
      mount();
      await screen.findByTestId("participation-cards");
      await userEvent.click(screen.getByTestId("participation-open-filters"));

      expect(
        await screen.findByTestId("participation-filter-drawer"),
      ).toBeInTheDocument();
    });
  });
});
