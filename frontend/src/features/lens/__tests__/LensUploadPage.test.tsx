import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  },
  quota: { used: 12, max: 36, by_category: { "Best Action Shot": 3 } },
  photos: [
    {
      upload_ref: "r1",
      url: "/media/lens_photos/c1/r1.jpg",
      thumb_url: "/media/lens_photos/c1/r1_t.jpg",
      caption: "",
      category: "Best Team Spirit",
      status: "pending",
      created_at: "2026-07-10T07:00:00Z",
    },
    {
      upload_ref: "r2",
      url: "/media/lens_photos/c1/r2.jpg",
      thumb_url: "/media/lens_photos/c1/r2_t.jpg",
      caption: "",
      category: "",
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
    expect(band).toHaveTextContent("12 of 36 photos used");
    expect(
      screen.getByText("Photos may be used for highlights."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("own-photo-r1")).toBeInTheDocument();
    expect(screen.getByText("Pending review")).toBeInTheDocument();
    expect(screen.getByText("In album")).toBeInTheDocument();
  });

  it("uploads picked files sequentially with a per-file state list", async () => {
    mount();
    await screen.findByTestId("quota-band");

    const fileA = new File(["a"], "a.jpg", { type: "image/jpeg" });
    const fileB = new File(["b"], "b.jpg", { type: "image/jpeg" });
    await userEvent.upload(screen.getByTestId("file-input"), [fileA, fileB]);

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

    await userEvent.click(screen.getByTestId("category-Best Action Shot"));
    await userEvent.upload(screen.getByTestId("file-input"), [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
    ]);

    await waitFor(() => expect(lensApi.upload).toHaveBeenCalledTimes(1));
    const [, fd] = vi.mocked(lensApi.upload).mock.calls[0];
    expect((fd as FormData).get("category")).toBe("Best Action Shot");
    // The chip shows the per-school usage against its limit.
    expect(screen.getByTestId("category-Best Action Shot")).toHaveTextContent(
      "3/4",
    );
  });

  it("blocks the picker when the selected category is at its limit", async () => {
    vi.mocked(lensApi.passContext).mockResolvedValue({
      ...CTX,
      quota: { used: 12, max: 36, by_category: { "Best Action Shot": 4 } },
    });
    mount();
    await screen.findByTestId("category-picker");

    await userEvent.click(screen.getByTestId("category-Best Action Shot"));
    expect(screen.getByTestId("file-input")).toBeDisabled();
    expect(screen.getByText("Category limit reached")).toBeInTheDocument();
    expect(screen.getByTestId("category-full-hint")).toBeInTheDocument();

    // Another category still accepts uploads.
    await userEvent.click(screen.getByTestId("category-Best Team Spirit"));
    expect(screen.getByTestId("file-input")).toBeEnabled();
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
