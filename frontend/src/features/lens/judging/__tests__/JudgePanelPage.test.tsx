import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { judgingApi, type JudgePanel } from "@/api/lens";
import { ToastProvider } from "@/components/ui/toast";
import { JudgePanelPage } from "../JudgePanelPage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    judgingApi: { ...actual.judgingApi, panel: vi.fn(), score: vi.fn() },
  };
});

const PHOTO_CRITERIA = [
  { key: "timing", label: "Timing and Action", max: 30 },
  { key: "composition", label: "Composition and Framing", max: 20 },
  { key: "emotion", label: "Emotion and Story", max: 15 },
  { key: "technical", label: "Technical Quality", max: 15 },
  { key: "originality", label: "Originality and Visual Impact", max: 10 },
  { key: "relevance", label: "Relevance to the Category", max: 10 },
];
const STORY_CRITERIA = [
  { key: "storytelling", label: "Storytelling and Narrative", max: 30 },
  { key: "sequence", label: "Sequence and Connection", max: 20 },
  { key: "emotion", label: "Emotion and Human Interest", max: 15 },
  { key: "originality", label: "Originality and Creativity", max: 15 },
  { key: "composition", label: "Composition and Visual Quality", max: 10 },
  { key: "relevance", label: "Relevance to the Tournament", max: 10 },
];

const PANEL: JudgePanel = {
  judge: { name: "M. Sema" },
  campaign: { title: "ANPSA Photography 2026", tagline: "Capture the moment" },
  rubrics: {
    photo: { criteria: PHOTO_CRITERIA, guide: "Does it capture a strong moment?" },
    story: { criteria: STORY_CRITERIA, guide: "Do the four work together?" },
  },
  entries: [
    {
      kind: "photo",
      id: "p1",
      category: "Best Sepaktakraw Photograph",
      caption: "The winning spike",
      photos: [{ url: "/m/p1.jpg", thumb_url: "/m/p1_t.jpg" }],
    },
    {
      kind: "story",
      id: "s1",
      category: "Beyond the Court: A Photo Story",
      caption: "Road to the final",
      description: "From warm-up to podium",
      photos: [
        { url: "/m/f1.jpg", thumb_url: "/m/f1_t.jpg" },
        { url: "/m/f2.jpg", thumb_url: "/m/f2_t.jpg" },
        { url: "/m/f3.jpg", thumb_url: "/m/f3_t.jpg" },
        { url: "/m/f4.jpg", thumb_url: "/m/f4_t.jpg" },
      ],
    },
  ],
  totals: { entries: 2, scored: 0 },
};

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/lens/judge/tok123"]}>
          <Routes>
            <Route path="/lens/judge/:token" element={<JudgePanelPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("JudgePanelPage", () => {
  beforeEach(() => {
    vi.mocked(judgingApi.panel).mockResolvedValue(PANEL);
    vi.mocked(judgingApi.score).mockResolvedValue({ total: 0, marks: {} });
  });

  it("never shows a school or a photographer", async () => {
    renderPage();
    await screen.findByTestId("judge-entry-p1");
    // The payload does not carry them, so there is nothing to leak.
    expect(screen.queryByText(/Grace Academy/)).toBeNull();
    expect(screen.getByTestId("judge-progress")).toHaveTextContent("0/2");
  });

  it("scores a photograph on the published rubric and totals to 100", async () => {
    renderPage();
    const entry = await screen.findByTestId("judge-entry-p1");
    for (const c of PHOTO_CRITERIA) {
      const slider = within(entry).getByTestId(`mark-p1-${c.key}`);
      expect(slider).toHaveAttribute("max", String(c.max));
      fireRange(slider as HTMLInputElement, c.max);
    }
    expect(within(entry).getByText("100")).toBeInTheDocument();

    await userEvent.click(within(entry).getByTestId("save-p1"));
    await waitFor(() =>
      expect(judgingApi.score).toHaveBeenCalledWith("tok123", {
        kind: "photo",
        entry_id: "p1",
        marks: {
          timing: 30, composition: 20, emotion: 15,
          technical: 15, originality: 10, relevance: 10,
        },
        note: "",
      }),
    );
  });

  it("shows a photo story as ONE entry of four, on the story rubric", async () => {
    renderPage();
    const story = await screen.findByTestId("judge-entry-s1");
    expect(within(story).getByText("Road to the final")).toBeInTheDocument();
    expect(within(story).getByText("From warm-up to podium")).toBeInTheDocument();
    expect(within(story).getAllByRole("img")).toHaveLength(4);
    // The STORY rubric, not the photo one.
    expect(within(story).getByText("Storytelling and Narrative")).toBeInTheDocument();
    expect(within(story).queryByText("Timing and Action")).toBeNull();
  });

  it("says so plainly when the link is not valid", async () => {
    vi.mocked(judgingApi.panel).mockRejectedValue(new Error("nope"));
    renderPage();
    expect(await screen.findByText("This link is not valid.")).toBeInTheDocument();
  });
});

/** A range input needs a native setter to fire React's onChange. */
function fireRange(el: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
