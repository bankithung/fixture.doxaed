import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  lensApi,
  type LensJoinContext,
  type LensPassContext,
} from "@/api/lens";
import { ApiError } from "@/types/api";
import { LensJoinPage } from "../LensJoinPage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    lensApi: {
      ...actual.lensApi,
      joinContext: vi.fn(),
      join: vi.fn(),
      passContext: vi.fn(),
      upload: vi.fn(),
      removeOwn: vi.fn(),
    },
  };
});

const JOIN: LensJoinContext = {
  tournament: { id: "t1", slug: "nagaland-cup", name: "Nagaland Schools Cup" },
  campaign: {
    id: "c1",
    title: "Guest Lens",
    tagline: "36 Shots Challenge",
    instructions: "Capture the event from your school's point of view.",
    consent_note: "Photos may be used for highlights.",
    is_open: true,
  },
  institutions: [
    { id: "i1", name: "Grace School" },
    { id: "i2", name: "Bethel Higher Secondary School" },
  ],
};

const PASS_CTX: LensPassContext = {
  tournament: JOIN.tournament,
  institution: { id: "i1", name: "Grace School" },
  campaign: {
    title: "Guest Lens",
    tagline: "36 Shots Challenge",
    instructions: "Upload your best photos.",
    consent_note: "Photos may be used for highlights.",
    is_open: true,
    max_photos_per_institution: 36,
    award_categories: ["Best Team Spirit"],
    category_limits: {},
    story_categories: [],
    story_photos_per_entry: 4,
  },
  stories: [],
  quota: { used: 0, max: 36, by_category: {} },
  photos: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/lens/join/card-token"]}>
          <Routes>
            <Route path="/lens/join/:token" element={<LensJoinPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(lensApi.joinContext).mockResolvedValue(JOIN);
  vi.mocked(lensApi.passContext).mockResolvedValue(PASS_CTX);
});

describe("LensJoinPage", () => {
  it("names the album, lists the schools, and opens uploads on a good code", async () => {
    vi.mocked(lensApi.join).mockResolvedValue({
      token: "session-token",
      institution: { id: "i1", name: "Grace School" },
    });
    mount();

    expect(await screen.findByText("Guest Lens")).toBeInTheDocument();
    expect(screen.getByText("36 Shots Challenge")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("school-i1"));
    await userEvent.type(screen.getByTestId("code-input"), "mk4tq9rb");
    // Typed lowercase off a slip; the field carries it as the code reads.
    expect(screen.getByTestId("code-input")).toHaveValue("MK4TQ9RB");
    await userEvent.click(screen.getByTestId("join-submit"));

    await waitFor(() => expect(lensApi.join).toHaveBeenCalledTimes(1));
    expect(vi.mocked(lensApi.join).mock.calls[0][1]).toEqual({
      institution_id: "i1",
      code: "MK4TQ9RB",
    });

    // The upload page takes over in place, and the session token never lands
    // in the URL where it would ride into browser history.
    await waitFor(() =>
      expect(lensApi.passContext).toHaveBeenCalledWith("session-token"),
    );
    expect(window.location.pathname).not.toContain("session-token");
  });

  it("filters a long school list down to what a teacher can hit", async () => {
    mount();
    await screen.findByTestId("school-list");

    await userEvent.type(screen.getByTestId("school-search"), "bethel");
    expect(screen.getByTestId("school-i2")).toBeInTheDocument();
    expect(screen.queryByTestId("school-i1")).toBeNull();
  });

  it("cannot be submitted without both a school and a code", async () => {
    mount();
    const submit = await screen.findByTestId("join-submit");
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByTestId("school-i1"));
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByTestId("code-input"), "MK4TQ9RB");
    expect(submit).toBeEnabled();
  });

  it("says what to do about a wrong code, and about a lockout", async () => {
    vi.mocked(lensApi.join).mockRejectedValue(
      new ApiError(400, { code: "invalid_code" }),
    );
    mount();
    await userEvent.click(await screen.findByTestId("school-i1"));
    await userEvent.type(screen.getByTestId("code-input"), "WRONGWRO");
    await userEvent.click(screen.getByTestId("join-submit"));

    expect(await screen.findByTestId("join-error")).toHaveTextContent(
      /does not match this school/i,
    );
    // Still on the join form: nothing opened.
    expect(lensApi.passContext).not.toHaveBeenCalled();

    vi.mocked(lensApi.join).mockRejectedValue(
      new ApiError(400, { code: "locked" }),
    );
    await userEvent.click(screen.getByTestId("join-submit"));
    expect(await screen.findByTestId("join-error")).toHaveTextContent(
      /15 minutes/i,
    );
  });

  it("shows a retired card as retired instead of an empty picker", async () => {
    vi.mocked(lensApi.joinContext).mockRejectedValue(
      new ApiError(404, { detail: "card_not_found" }),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not valid any more/i,
    );
  });

  it("says a closed album is closed rather than taking a code for nothing", async () => {
    vi.mocked(lensApi.joinContext).mockResolvedValue({
      ...JOIN,
      campaign: { ...JOIN.campaign, is_open: false },
    });
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent(/closed/i);
    expect(screen.queryByTestId("code-input")).toBeNull();
  });

  it("keeps a school signed in across a reload of the same card", async () => {
    sessionStorage.setItem(
      "lens.session",
      JSON.stringify({ card: "card-token", token: "session-token" }),
    );
    mount();

    await waitFor(() =>
      expect(lensApi.passContext).toHaveBeenCalledWith("session-token"),
    );
    // No second trip through the code form.
    expect(lensApi.joinContext).not.toHaveBeenCalled();
  });

  it("does not carry a session from one card to another", async () => {
    sessionStorage.setItem(
      "lens.session",
      JSON.stringify({ card: "a-different-card", token: "session-token" }),
    );
    mount();

    expect(await screen.findByTestId("code-input")).toBeInTheDocument();
    expect(lensApi.passContext).not.toHaveBeenCalled();
  });
});
