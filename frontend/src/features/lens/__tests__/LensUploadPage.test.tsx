import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { lensApi, type LensPassContext } from "@/api/lens";
import { compressImage } from "@/lib/compressImage";
import { ApiError } from "@/types/api";
import { LensUploadPage } from "../LensUploadPage";

vi.mock("@/api/lens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/lens")>();
  return {
    ...actual,
    lensApi: {
      ...actual.lensApi,
      passContext: vi.fn(),
      upload: vi.fn(),
      removeOwn: vi.fn(),
      editOwnCaption: vi.fn(),
      setStoryTitle: vi.fn(),
      reorderStory: vi.fn(),
    },
  };
});

vi.mock("@/lib/compressImage", () => ({
  compressImage: vi.fn(async (f: File) => f),
}));

const CTX: LensPassContext = {
  tournament: { id: "t1", slug: "nagaland-cup", name: "Nagaland Schools Cup" },
  institution: { id: "i1", name: "Grace School" },
  campaign: {
    title: "Guest Lens",
    tagline: "36 Shots Challenge",
    instructions: "Upload your best photos.",
    consent_note: "Photos may be used for highlights.",
    is_open: true,
    max_photos_per_institution: 36,
    award_categories: ["Best Team Spirit", "Best Action Shot"],
    category_limits: { "Best Action Shot": 4 },
    story_categories: [],
    story_photos_per_entry: 4,
  },
  stories: [],
  quota: { used: 12, max: 36, by_category: { "Best Action Shot": 3 } },
  photos: [
    {
      upload_ref: "r1",
      url: "/media/lens_photos/c1/r1.jpg",
      thumb_url: "/media/lens_photos/c1/r1_t.jpg",
      caption: "",
      category: "Best Team Spirit",
      story_id: null,
      position: 0,
      status: "pending",
      created_at: "2026-07-10T07:00:00Z",
    },
    {
      upload_ref: "r2",
      url: "/media/lens_photos/c1/r2.jpg",
      thumb_url: "/media/lens_photos/c1/r2_t.jpg",
      caption: "",
      category: "",
      story_id: null,
      position: 0,
      status: "approved",
      created_at: "2026-07-10T07:05:00Z",
    },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/lens/tok123"]}>
          <Routes>
            <Route path="/lens/:token" element={<LensUploadPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lensApi.passContext).mockResolvedValue(CTX);
  vi.mocked(lensApi.upload).mockResolvedValue({
    photo: {
      upload_ref: "r3",
      url: "/media/lens_photos/c1/r3.jpg",
      thumb_url: "/media/lens_photos/c1/r3_t.jpg",
      caption: "",
      category: "Best Team Spirit",
      story_id: null,
      position: 0,
      status: "pending",
      created_at: "2026-07-10T08:00:00Z",
    },
  });
  vi.mocked(lensApi.removeOwn).mockResolvedValue({ removed: true });
});

describe("LensUploadPage", () => {
  it("shows the invalid-link state on a bad or revoked token", async () => {
    vi.mocked(lensApi.passContext).mockRejectedValue(
      new ApiError(404, { detail: "pass_not_found" }),
    );
    mount();

    expect(
      await screen.findByText("This link is not valid"),
    ).toBeInTheDocument();
  });

  it("renders the quota band, consent note and own photos", async () => {
    mount();

    const band = await screen.findByTestId("quota-band");
    expect(band).toHaveTextContent("12/36");
    // The school chip names who is signed in, with a way to switch.
    expect(screen.getByTestId("school-chip")).toHaveTextContent("Grace School");
    expect(screen.getByTestId("switch-school")).toBeInTheDocument();
    expect(screen.getByTestId("own-photo-r1")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("In album")).toBeInTheDocument();
  });

  it("uploads picked files sequentially with a per-file state list", async () => {
    mount();
    await screen.findByTestId("quota-band");

    const fileA = new File(["a"], "a.jpg", { type: "image/jpeg" });
    const fileB = new File(["b"], "b.jpg", { type: "image/jpeg" });
    await userEvent.upload(screen.getByTestId("file-input"), [fileA, fileB]);

    // Nothing uploads yet: the teacher first reviews what they picked.
    expect(lensApi.upload).not.toHaveBeenCalled();
    const review = screen.getByTestId("review-area");
    // The review grid previews every picked photo by name.
    expect(within(review).getByAltText("a.jpg")).toBeInTheDocument();
    expect(within(review).getByAltText("b.jpg")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("confirm-upload-btn"));

    await waitFor(() => expect(lensApi.upload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(compressImage)).toHaveBeenCalledTimes(2);
    const [token, fd] = vi.mocked(lensApi.upload).mock.calls[0];
    expect(token).toBe("tok123");
    expect(fd).toBeInstanceOf(FormData);
    expect((fd as FormData).get("event_id")).toBeTruthy();
    // The first campaign category is preselected and rides along.
    expect((fd as FormData).get("category")).toBe("Best Team Spirit");

    const list = screen.getByTestId("upload-list");
    expect(list).toHaveTextContent("a.jpg");
    expect(list).toHaveTextContent("b.jpg");
    await waitFor(() =>
      expect(screen.getAllByText("Uploaded")).toHaveLength(2),
    );
    // The pass context refetches so the quota band and grid stay honest.
    await waitFor(() =>
      expect(lensApi.passContext).toHaveBeenCalledTimes(2),
    );
  });

  it("uploads into the category the guest picked", async () => {
    mount();
    await screen.findByTestId("category-picker");

    // Pick a different category in the dropdown; its usage rides in the label.
    await userEvent.click(screen.getByRole("button", { name: "Photo category" }));
    await userEvent.click(
      await screen.findByRole("option", {
        name: /Best Action Shot \(3\/4\)/,
      }),
    );
    await userEvent.upload(screen.getByTestId("file-input"), [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
    ]);
    await userEvent.click(await screen.findByTestId("confirm-upload-btn"));

    await waitFor(() => expect(lensApi.upload).toHaveBeenCalledTimes(1));
    const [, fd] = vi.mocked(lensApi.upload).mock.calls[0];
    expect((fd as FormData).get("category")).toBe("Best Action Shot");
  });

  it("locks the picker while a full category is selected, and defaults to one with room", async () => {
    vi.mocked(lensApi.passContext).mockResolvedValue({
      ...CTX,
      quota: { used: 12, max: 36, by_category: { "Best Action Shot": 4 } },
    });
    mount();
    await screen.findByTestId("category-picker");

    // The default is a category WITH room (Best Team Spirit), so the picker
    // opens ready to use.
    expect(screen.getByTestId("file-input")).toBeEnabled();

    const combo = screen.getByRole("button", { name: "Photo category" });
    await userEvent.click(combo);
    // The full category says so right in the option list.
    await userEvent.click(
      await screen.findByRole("option", { name: /Best Action Shot \(4\/4\) · Full/ }),
    );

    expect(screen.getByTestId("file-input")).toBeDisabled();
    expect(screen.getByText("Category limit reached")).toBeInTheDocument();
    expect(screen.getByTestId("category-full-hint")).toBeInTheDocument();
  });

  it("opens an own photo as a preview with an editable caption", async () => {
    mount();
    await screen.findByTestId("own-photo-r1");

    // Tap the pending photo: the preview sheet opens with its details.
    await userEvent.click(screen.getByTestId("preview-r1"));
    expect(await screen.findByTestId("preview-image")).toHaveAttribute(
      "src",
      "/media/lens_photos/c1/r1.jpg",
    );
    const input = screen.getByTestId("caption-input");
    expect(input).toBeEnabled();

    // Fixing the caption saves and refetches, so grid + quota stay honest.
    vi.mocked(lensApi.editOwnCaption).mockResolvedValue({
      photo: { ...CTX.photos[0], caption: "The winning spike" },
    });
    await userEvent.clear(input);
    await userEvent.type(input, "The winning spike");
    await userEvent.click(screen.getByTestId("save-caption-btn"));
    await waitFor(() =>
      expect(lensApi.editOwnCaption).toHaveBeenCalledWith(
        "tok123",
        "r1",
        "The winning spike",
      ),
    );

    // Remove is reachable from the same sheet.
    await userEvent.click(screen.getByTestId("preview-r1"));
    await userEvent.click(await screen.findByTestId("remove-from-preview-btn"));
    expect(screen.getByTestId("confirm-delete-btn")).toBeInTheDocument();
  });

  it("requires a story title in the preview before a story batch uploads", async () => {
    const STORY = "Beyond the Court - A Photo Story";
    vi.mocked(lensApi.passContext).mockResolvedValue({
      ...CTX,
      campaign: {
        ...CTX.campaign,
        award_categories: [STORY],
        category_limits: { [STORY]: 1 },
        story_categories: [STORY],
        story_photos_per_entry: 4,
      },
      stories: [],
    });
    vi.mocked(lensApi.upload).mockResolvedValue({
      photo: {
        upload_ref: "sf1",
        url: "/m/sf1.jpg",
        thumb_url: "/m/sf1_t.jpg",
        caption: "",
        category: STORY,
        story_id: "s9",
        position: 1,
        status: "pending",
        created_at: "2026-08-25T10:00:00Z",
      },
    });
    mount();
    await screen.findByTestId("category-picker");

    await userEvent.upload(screen.getByTestId("file-input"), [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
    ]);
    const review = await screen.findByTestId("review-area");

    // The preview step demands the title first; Upload stays locked.
    const titleInput = within(review).getByTestId("review-story-title");
    expect(
      within(review).getByTestId("confirm-upload-btn"),
    ).toBeDisabled();
    expect(within(review).getByText(/A story title is required/i));

    // Optional description rides along only when filled — and each
    // photograph gets its own optional caption right in the grid.
    await userEvent.type(
      within(review).getByTestId("review-story-description"),
      "From warm-up to podium",
    );
    await userEvent.type(
      within(review).getByLabelText(/Caption a\.jpg/),
      "The winning spike",
    );
    await userEvent.type(titleInput, "Road to the final");
    await userEvent.click(within(review).getByTestId("confirm-upload-btn"));

    await waitFor(() => expect(lensApi.upload).toHaveBeenCalledTimes(1));
    const [, fd] = vi.mocked(lensApi.upload).mock.calls[0];
    expect((fd as FormData).get("caption")).toBe("The winning spike");
    // The entry the uploads created is named immediately.
    await waitFor(() =>
      expect(lensApi.setStoryTitle).toHaveBeenCalledWith("tok123", "s9", {
        title: "Road to the final",
        description: "From warm-up to podium",
      }),
    );
  });

  it("shows the closed state without an uploader when the campaign closed", async () => {
    vi.mocked(lensApi.passContext).mockResolvedValue({
      ...CTX,
      campaign: { ...CTX.campaign, is_open: false },
    });
    mount();

    expect(await screen.findByTestId("closed-state")).toBeInTheDocument();
    expect(screen.queryByTestId("file-input")).toBeNull();
    // Photos stay listed read-only; pending delete affordance is gone.
    expect(screen.getByTestId("own-photo-r1")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-r1")).toBeNull();
  });

  it("deletes an own pending photo after a confirm dialog", async () => {
    mount();
    await screen.findByTestId("own-photo-r1");

    // Only the pending photo has a delete affordance.
    expect(screen.queryByTestId("delete-r2")).toBeNull();
    await userEvent.click(screen.getByTestId("delete-r1"));
    await userEvent.click(screen.getByTestId("confirm-delete-btn"));

    await waitFor(() =>
      expect(lensApi.removeOwn).toHaveBeenCalledWith("tok123", "r1"),
    );
    expect(await screen.findByText("Photo removed")).toBeInTheDocument();
  });

});
