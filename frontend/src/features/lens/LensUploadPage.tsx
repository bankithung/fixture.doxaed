import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { lensApi, type LensOwnPhoto } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { compressImage } from "@/lib/compressImage";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";
import { Centered, PublicShell } from "@/features/registration/PublicShell";

type FileState = "waiting" | "uploading" | "done" | "error";

interface UploadItem {
  key: string;
  name: string;
  state: FileState;
  error?: string;
}

/** A picked-but-not-yet-confirmed photo, with a local preview URL. */
interface PickedPhoto {
  key: string;
  file: File;
  preview: string;
  /** Optional per-photo caption (the competition allows ~15 words each). */
  caption: string;
}

function makePreview(file: File): string {
  try {
    return typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : "";
  } catch {
    return "";
  }
}

function releasePreview(photo: PickedPhoto): void {
  if (
    photo.preview &&
    typeof URL.revokeObjectURL === "function"
  )
    URL.revokeObjectURL(photo.preview);
}

function uploadErr(e: unknown): string {
  const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
  switch (code) {
    case "quota_exceeded":
      return t("Your school reached its photo limit.");
    case "category_quota_exceeded":
      return t("Your school reached this category's photo limit.");
    case "story_full":
      return t("This photo story already holds all its photographs.");
    case "unknown_category":
      return t("This category is no longer on the campaign.");
    case "file_too_large":
      return t("This file is too large (10 MB limit).");
    case "unsupported_type":
      return t("Only JPEG, PNG and WebP photos are accepted.");
    case "invalid_image":
      return t("This file is not a valid photo.");
    case "campaign_closed":
      return t("The campaign has closed.");
    default:
      return t("Upload failed. Check your connection and try again.");
  }
}

function ownStatusChip(status: LensOwnPhoto["status"]): React.ReactElement {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
        status === "approved" && "bg-primary/10 text-primary",
        status === "pending" && "bg-muted text-muted-foreground",
        status === "removed" && "bg-destructive/10 text-destructive",
      )}
    >
      {status === "approved"
        ? t("In album")
        : status === "pending"
          ? t("Pending")
          : t("Removed")}
    </span>
  );
}

/**
 * Where a school lands after signing in behind the shared QR card (spec
 * 2026-07-10 §4.3). ONE section, mobile-first (owner 2026-08-25):
 *
 * header (school + switch) → pick category → pick photos → REVIEW them →
 * confirm uploads sequentially with per-file state → your photos below.
 * Nothing uploads until the teacher confirms the review grid, so a fat-finger
 * gallery pick never burns the school's quota.
 *
 * The session token comes from the join page as a prop (it is a credential,
 * so it never rides in the URL); the route param remains the fallback.
 */
export function LensUploadPage({
  sessionToken,
  onSwitchSchool,
}: {
  sessionToken?: string;
  /** Called by the header's Switch control — the join page resets its form. */
  onSwitchSchool?: () => void;
} = {}): React.ReactElement {
  const { token: routeToken = "" } = useParams();
  const token = sessionToken ?? routeToken;
  const qc = useQueryClient();
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [deleteRef, setDeleteRef] = useState<string | null>(null);
  // The own-photo currently open in the preview sheet, and its caption draft.
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  // The preview opens as a VIEW of what was submitted; editing is a deliberate
  // step, not the default state (owner 2026-08-25).
  const [previewEditing, setPreviewEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  const [pvTitle, setPvTitle] = useState("");
  const [pvDesc, setPvDesc] = useState("");
  // "" = no category picked yet (campaigns without categories stay on "").
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  // "Your photos" filter: null = everything. A school with 36 photos across
  // six categories cannot find one by scrolling (owner 2026-08-25).
  const [galleryCat, setGalleryCat] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // Picked photos awaiting confirmation.
  const [picked, setPicked] = useState<PickedPhoto[]>([]);
  // Local draft of the story title/description: used BOTH in the review step
  // (mandatory title before upload) and in the story band afterwards.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [storyDescDraft, setStoryDescDraft] = useState("");
  const resetStoryDrafts = (): void => {
    setTitleDraft(null);
    setStoryDescDraft("");
  };
  const storyTitleDraft = titleDraft ?? "";

  const q = useQuery({
    queryKey: qk.lensPass(token),
    queryFn: () => lensApi.passContext(token),
    enabled: Boolean(token),
    retry: false,
  });

  // The open preview's stepper, published by the sheet as it renders so the
  // key handler can reach a list that is derived further down.
  const previewGoRef = useRef<((step: number) => void) | null>(null);
  // Left/right walk the open preview: on a desk the keyboard IS the pager.
  useEffect(() => {
    if (previewRef === null || previewEditing) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      previewGoRef.current?.(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewRef, previewEditing]);

  // Release any leftover preview URLs when the page goes away.
  useEffect(() => {
    return () => {
      setPicked((cur) => {
        cur.forEach(releasePreview);
        return [];
      });
    };
  }, []);

  if (q.isLoading) {
    return (
      <PublicShell>
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
          <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
        </div>
      </PublicShell>
    );
  }
  if (q.isError || !q.data) {
    return (
      <PublicShell>
        <Centered>
          <Camera aria-hidden="true" className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="mt-3 text-lg font-semibold">
            {t("This link is not valid")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Ask the organizers for the current card.")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  const ctx = q.data;
  const used = ctx.quota.used;
  const max = ctx.quota.max;
  const remaining = Math.max(0, max - used);
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;

  const categories = ctx.campaign.award_categories ?? [];
  const limits = ctx.campaign.category_limits ?? {};
  const byCategory = ctx.quota.by_category ?? {};
  const storyCategories = ctx.campaign.story_categories ?? [];

  // Room check per category: a story category has room while its entry still
  // lacks frames; an ordinary category while the school is under its cap.
  const roomIn = (cat: string): number => {
    if (storyCategories.includes(cat)) {
      const frames =
        ctx.stories.find((st) => st.category === cat)?.photos.length ?? 0;
      return Math.max(0, ctx.campaign.story_photos_per_entry - frames);
    }
    const capN = limits[cat];
    if (capN === undefined) return Infinity;
    return Math.max(0, capN - (byCategory[cat] ?? 0));
  };

  const category = selectedCat ?? categories.find((c) => roomIn(c) > 0) ?? "";
  const isStoryCat = storyCategories.includes(category);
  const story = isStoryCat
    ? (ctx.stories.find((s) => s.category === category) ?? null)
    : null;
  const storyFrames = story
    ? [...story.photos].sort((a, b) => a.position - b.position)
    : [];
  const open = ctx.campaign.is_open;
  // What "Your photos" is showing, and how many sit under each category —
  // the count is what makes the filter readable before it is used.
  const galleryCounts = ctx.photos.reduce<Record<string, number>>((acc, p) => {
    const key = p.category || "";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const galleryCats = Object.keys(galleryCounts).sort((a, b) =>
    a.localeCompare(b),
  );
  const shownPhotos = galleryCat
    ? ctx.photos.filter((p) => (p.category || "") === galleryCat)
    : ctx.photos;

  const catLimit = category ? limits[category] : undefined;
  const catUsed = category ? (byCategory[category] ?? 0) : 0;
  const catRemaining = isStoryCat
    ? Math.max(
        0,
        ctx.campaign.story_photos_per_entry -
          (story ? storyFrames.length : 0),
      )
    : catLimit === undefined
      ? Infinity
      : Math.max(0, catLimit - catUsed);
  const effectiveRemaining = Math.min(remaining, catRemaining);
  // The picker locks when there is nowhere to put a photo: the school is out
  // of quota, or every category is full. Campaigns without categories only
  // answer to the overall quota.
  const noSlots =
    remaining === 0 ||
    (categories.length > 0 && category === "");
  const pickerLocked = running || noSlots || effectiveRemaining === 0;

  // Dropdown options with usage in the label; a full category says so.
  const categoryOptions = categories.map((cat) => {
    const capN = storyCategories.includes(cat)
      ? ctx.campaign.story_photos_per_entry
      : limits[cat];
    const usedN = storyCategories.includes(cat)
      ? (ctx.stories.find((st) => st.category === cat)?.photos.length ?? 0)
      : (byCategory[cat] ?? 0);
    const full =
      !storyCategories.includes(cat) &&
      capN !== undefined &&
      roomIn(cat) === 0;
    return {
      value: cat,
      label: `${cat}${capN !== undefined ? ` (${usedN}/${capN})` : ""}${
        full ? ` · ${t("Full")}` : ""
      }`,
    };
  });

  const setItem = (key: string, patch: Partial<UploadItem>): void => {
    setItems((cur) =>
      cur.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );
  };

  const pickFiles = (files: File[]): void => {
    const room = Math.max(0, effectiveRemaining - picked.length);
    const accepted = files.slice(0, room);
    if (accepted.length < files.length) {
      push({
        kind: "info",
        title: t("Some photos were skipped"),
        description: t("Not enough slots left for all of them."),
      });
    }
    if (accepted.length === 0) return;
    setPicked((cur) => [
      ...cur,
      ...accepted.map((f, i) => ({
        key: `${Date.now()}-${i}-${f.name}`,
        file: f,
        preview: makePreview(f),
        caption: "",
      })),
    ]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const unpick = (key: string): void => {
    setPicked((cur) => {
      const target = cur.find((x) => x.key === key);
      if (target) releasePreview(target);
      return cur.filter((x) => x.key !== key);
    });
  };

  const clearPicked = (): void => {
    picked.forEach(releasePreview);
    setPicked([]);
  };

  const confirmUpload = async (): Promise<void> => {
    if (picked.length === 0 || running) return;
    // A story entry names itself at submit time: title is MANDATORY here,
    // description optional (owner 2026-08-25).
    const isStoryBatch =
      isStoryCat && category !== "" && picked.length > 0;
    const storyTitle = storyTitleDraft.trim();
    if (isStoryBatch && !storyTitle) return;
    const batch: UploadItem[] = picked.map((p) => ({
      key: p.key,
      name: p.file.name,
      state: "waiting",
    }));
    setItems(batch);
    setRunning(true);
    let storyId: string | null = null;
    // Sequential on purpose: school connections choke on parallel uploads,
    // and the per-file list stays honest about what is actually in flight.
    for (let i = 0; i < picked.length; i += 1) {
      const photo = picked[i];
      setItem(photo.key, { state: "uploading" });
      try {
        const compact = await compressImage(photo.file, { preferJpeg: true });
        const fd = new FormData();
        fd.append("file", compact, compact.name);
        if (photo.caption.trim()) fd.append("caption", photo.caption.trim());
        if (category) fd.append("category", category);
        fd.append("event_id", newEventId());
        const res = await lensApi.upload(token, fd);
        storyId = res.photo.story_id ?? storyId;
        setItem(photo.key, { state: "done" });
      } catch (e) {
        setItem(photo.key, { state: "error", error: uploadErr(e) });
      }
    }
    // Name the entry the uploads just created.
    if (isStoryBatch && storyId) {
      try {
        await lensApi.setStoryTitle(token, storyId, {
          title: storyTitle,
          ...(storyDescDraft.trim() ? { description: storyDescDraft.trim() } : {}),
        });
        push({ kind: "success", title: t("Story saved") });
      } catch {
        push({
          kind: "error",
          title: t(
            "Uploaded, but the title could not be saved. Set it below.",
          ),
        });
      }
    }
    setRunning(false);
    clearPicked();
    resetStoryDrafts();
    void qc.invalidateQueries({ queryKey: qk.lensPass(token) });
  };

  const removePhoto = async (uploadRef: string): Promise<void> => {
    try {
      await lensApi.removeOwn(token, uploadRef);
      push({ kind: "success", title: t("Photo removed") });
      void qc.invalidateQueries({ queryKey: qk.lensPass(token) });
    } catch (e) {
      const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
      push({
        kind: "error",
        title:
          code === "photo_locked"
            ? t("This photo is already in review and cannot be removed.")
            : t("Could not remove the photo."),
      });
    } finally {
      setDeleteRef(null);
    }
  };

  const switchSchool = (): void => {
    if (onSwitchSchool) {
      onSwitchSchool();
      return;
    }
    // Direct-mount fallback: clearing the stored session reloads into the
    // join page behind the same card.
    try {
      sessionStorage.removeItem("lens.session");
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <PublicShell tournamentName={ctx.tournament.name}>
      {/* ONE section: everything lives in a single panel, starting from its
          own header (owner 2026-08-25). */}
      <main className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
        <section className="panel overflow-hidden" data-testid="upload-root">
          {/* Header: album name, your school, and the way out. */}
          {/* Phone-tight header: the SCHOOL is the title, and the switch is
              an icon button on the same row (owner 2026-08-25) — no wrap,
              no album-name noise. */}
          <header className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
            <h1
              data-testid="school-chip"
              className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight"
              title={ctx.institution.name}
            >
              {ctx.institution.name}
            </h1>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={switchSchool}
              data-testid="switch-school"
              aria-label={t("Switch school")}
              title={t("Sign in as a different school")}
            >
              <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">{t("Switch school")}</span>
            </Button>
          </header>

          {open ? (
            <div className="flex flex-col gap-3 p-3 sm:p-4">
              {/* Quota: one quiet inline line, never a slab. */}
              <div
                className="flex items-center gap-2"
                data-testid="quota-band"
              >
                <span className="font-tabular text-sm font-semibold">
                  {used}/{max}
                </span>
                <div
                  role="progressbar"
                  aria-valuenow={used}
                  aria-valuemin={0}
                  aria-valuemax={max}
                  aria-label={t("Photos used")}
                  className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {t("photos")}
                </span>
              </div>

              {/* Categories: ONE compact dropdown (house Select), not a wall
                  of chips. Usage rides in the option label; full ones say so. */}
              {categories.length > 0 ? (
                <div data-testid="category-picker">
                  <Select
                    size="lg"
                    className="w-full"
                    aria-label={t("Photo category")}
                    value={category}
                    onChange={(v) => {
                      setSelectedCat(v || null);
                      // A new category is a new batch: the previous one's
                      // report belongs to the category it was uploaded to.
                      setItems([]);
                    }}
                    options={categoryOptions}
                  />
                  {category !== "" &&
                  catRemaining === 0 &&
                  (isStoryCat || catLimit !== undefined) ? (
                    <p
                      className="pt-1 text-xs text-muted-foreground"
                      data-testid="category-full-hint"
                    >
                      {isStoryCat
                        ? t("Story complete.")
                        : t("Category limit reached.")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <input
                ref={inputRef}
                id="lens-file-input"
                data-testid="file-input"
                type="file"
                accept="image/*"
                multiple
                disabled={pickerLocked || picked.length >= effectiveRemaining}
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) pickFiles(files);
                }}
              />
              {/* The picker comes back the moment a batch stops running. The
                  finished list below is a REPORT of what just uploaded, not a
                  mode: leaving it in place of the button stranded a school
                  that wanted to upload to a second category (owner
                  2026-08-25). */}
              {!running ? (
                <label htmlFor="lens-file-input">
                  <span
                    className={cn(
                      "inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover",
                      (pickerLocked ||
                        picked.length >= effectiveRemaining) &&
                        "pointer-events-none opacity-50",
                    )}
                  >
                    <Camera aria-hidden="true" className="h-4 w-4" />
                    {remaining === 0
                      ? t("Photo limit reached")
                      : categories.length > 0 && category === ""
                        ? t("All categories are full")
                        : effectiveRemaining === 0 ||
                            picked.length >= effectiveRemaining
                          ? picked.length > 0
                            ? t("Slot limit reached for this batch")
                            : t("Category limit reached")
                          : t("Choose photos")}
                  </span>
                </label>
              ) : null}

              {/* REVIEW before upload: nothing leaves the phone until the
                  teacher confirms what they picked. */}
              {picked.length > 0 && !running ? (
                <div
                  className="rounded-lg border border-border p-2.5"
                  data-testid="review-area"
                >
                  <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {picked.map((p) => (
                      <li key={p.key} className="relative">
                        <img
                          src={p.preview}
                          alt={p.file.name}
                          className="aspect-square w-full rounded-md border border-border object-cover"
                        />
                        <button
                          type="button"
                          aria-label={`${t("Remove")} ${p.file.name}`}
                          data-testid={`unpick-${p.key}`}
                          onClick={() => unpick(p.key)}
                          className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground"
                        >
                          <X aria-hidden="true" className="h-3.5 w-3.5" />
                        </button>
                        {/* An ordinary photo carries its own caption. A
                            STORY frame does not: the entry is named once, by
                            its title, and a caption beside it is the same
                            sentence typed twice (owner 2026-08-25). */}
                        {!isStoryCat ? (
                          <input
                            value={p.caption}
                            data-testid={`pick-caption-${p.key}`}
                            maxLength={200}
                            placeholder={t("Caption…")}
                            aria-label={`${t("Caption")} ${p.file.name}`}
                            onChange={(e) =>
                              setPicked((cur) =>
                                cur.map((x) =>
                                  x.key === p.key
                                    ? { ...x, caption: e.target.value }
                                    : x,
                                ),
                              )
                            }
                            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem]"
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {/* A STORY batch names itself here, BEFORE uploading:
                      title is mandatory, description optional. It sits under
                      its own heading because it names the ENTRY, not the
                      photograph above it. */}
                  {isStoryCat ? (
                    <div className="mt-2.5 flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
                      <p className="text-xs font-medium">
                        {t("Your story entry")}
                      </p>
                      <input
                        value={titleDraft ?? ""}
                        data-testid="review-story-title"
                        maxLength={120}
                        placeholder={`${t("Story title")} *`}
                        aria-label={t("Story title")}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-card px-2.5 text-sm"
                      />
                      <textarea
                        value={storyDescDraft}
                        data-testid="review-story-description"
                        rows={2}
                        maxLength={1000}
                        placeholder={t("Description (optional)")}
                        aria-label={t("Description")}
                        onChange={(e) => setStoryDescDraft(e.target.value)}
                        className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm"
                      />
                      {!storyTitleDraft.trim() ? (
                        <p className="text-xs text-destructive">
                          {t("A story title is required.")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {category
                        ? `${t("To")} ${category}`
                        : t("Ready to upload")}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearPicked}
                      data-testid="cancel-pick-btn"
                    >
                      {t("Cancel")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void confirmUpload()}
                      disabled={
                        picked.length === 0 ||
                        (isStoryCat && !storyTitleDraft.trim())
                      }
                      data-testid="confirm-upload-btn"
                    >
                      {t("Upload")} ({picked.length})
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* Per-file progress while the confirmed batch is in flight. */}
              {items.length > 0 ? (
                <ul className="flex flex-col gap-1" data-testid="upload-list">
                  {items.map((it) => (
                    <li
                      key={it.key}
                      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      {it.state === "uploading" ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                        />
                      ) : it.state === "done" ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-success"
                        />
                      ) : it.state === "error" ? (
                        <AlertTriangle
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-destructive"
                        />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{it.name}</span>
                      <span
                        className={cn(
                          "shrink-0",
                          it.state === "error"
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {it.state === "done"
                          ? t("Uploaded")
                          : it.state === "uploading"
                            ? t("Uploading")
                            : it.state === "error"
                              ? it.error
                              : t("Waiting")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p
              className="px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="closed-state"
            >
              {t("Uploads have closed.")}
            </p>
          )}

          {/* Your photos. */}
          <section className="border-t border-border">
            <div className="flex items-center gap-2 px-3 pt-3 sm:px-4">
              <h2 className="panel-title">{t("Your photos")}</h2>
              <span className="font-tabular text-xs text-muted-foreground">
                {galleryCat ? `${shownPhotos.length}/${ctx.photos.length}` : ctx.photos.length}
              </span>
              {ctx.photos.length > 0 ? (
                <button
                  type="button"
                  data-testid="gallery-filter-btn"
                  onClick={() => setFilterOpen(true)}
                  className={cn(
                    "ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium",
                    galleryCat
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Filter aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="max-w-[9rem] truncate">
                    {galleryCat || t("Filter")}
                  </span>
                </button>
              ) : null}
            </div>
            {galleryCat ? (
              <div className="px-3 pt-2 sm:px-4">
                <button
                  type="button"
                  data-testid="gallery-filter-clear"
                  onClick={() => setGalleryCat(null)}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                >
                  {galleryCat}
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </div>
            ) : null}
            {ctx.photos.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("Nothing uploaded yet.")}
              </p>
            ) : shownPhotos.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("No photo in that category yet.")}
              </p>
            ) : (
              <ul className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-4">
                {shownPhotos.map((p) => (
                  <li
                    key={p.upload_ref}
                    className="relative flex flex-col gap-1"
                    data-testid={`own-photo-${p.upload_ref}`}
                  >
                    <button
                      type="button"
                      aria-label={`${t("Preview")} ${p.caption || p.category || p.upload_ref}`}
                      data-testid={`preview-${p.upload_ref}`}
                      onClick={() => {
                        setPreviewRef(p.upload_ref);
                        setCaptionDraft(null);
                        setPreviewEditing(false);
                      }}
                      className="block w-full overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <img
                        src={p.thumb_url}
                        alt={p.caption || t("Uploaded photo")}
                        loading="lazy"
                        className="aspect-square w-full rounded-md border border-border object-cover transition-transform hover:scale-[1.03]"
                      />
                    </button>
                    {p.category ? (
                      <p className="truncate text-[0.625rem] text-muted-foreground">
                        {p.category}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-1">
                      {ownStatusChip(p.status)}
                      {ctx.campaign.is_open && p.status === "pending" ? (
                        <button
                          type="button"
                          aria-label={t("Remove this photo")}
                          data-testid={`delete-${p.upload_ref}`}
                          onClick={() => setDeleteRef(p.upload_ref)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      </main>

      {/* Category filter for "Your photos": the house bottom sheet, with a
          count beside every category so the list is readable before it is
          used. */}
      <Dialog
        open={filterOpen}
        onOpenChange={setFilterOpen}
        ariaLabel={t("Filter by category")}
        variant="sheet"
      >
        <DialogHeader>
          <DialogTitle>{t("Filter by category")}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-1" data-testid="gallery-filter-list">
          <li>
            <button
              type="button"
              data-testid="gallery-filter-all"
              onClick={() => {
                setGalleryCat(null);
                setFilterOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md border px-3 py-2.5 text-sm",
                !galleryCat
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "border-border hover:bg-muted",
              )}
            >
              {t("All categories")}
              <span className="font-tabular text-xs">{ctx.photos.length}</span>
            </button>
          </li>
          {galleryCats.map((cat) => (
            <li key={cat || "none"}>
              <button
                type="button"
                data-testid={`gallery-filter-${cat || "none"}`}
                onClick={() => {
                  setGalleryCat(cat);
                  setFilterOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-sm",
                  galleryCat === cat
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-border hover:bg-muted",
                )}
              >
                <span className="min-w-0 truncate">
                  {cat || t("No category")}
                </span>
                <span className="font-tabular text-xs">
                  {galleryCounts[cat]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      {/* Own-photo preview: the picture big, its caption EDITABLE while
          pending, plus status and remove. */}
      <Dialog
        open={previewRef !== null}
        onOpenChange={(o) => {
          if (!o) setPreviewRef(null);
        }}
        ariaLabel={t("Photo preview")}
        variant="sheet"
      >
        {(() => {
          // The preview steps through the list ON SCREEN, filter included:
          // that is the set the school is working through, and jumping into a
          // hidden category would be a different album.
          const idx = shownPhotos.findIndex(
            (x) => x.upload_ref === previewRef,
          );
          const photo = shownPhotos[idx];
          if (!photo) return null;
          const go = (step: number): void => {
            const next = shownPhotos[idx + step];
            if (!next) return;
            setPreviewRef(next.upload_ref);
            // An edit belongs to the photo it was started on.
            setPreviewEditing(false);
            setCaptionDraft(null);
          };
          previewGoRef.current = go;
          const editable = ctx.campaign.is_open && photo.status === "pending";
          // A frame of a photo story is described by its STORY: one title and
          // one description for the whole entry. An ordinary photo carries its
          // own caption. Either way the sheet shows what was submitted first.
          const inStory = ctx.stories.find((x) => x.id === photo.story_id);
          const startEdit = (): void => {
            setCaptionDraft(photo.caption ?? "");
            setPvTitle(inStory?.title ?? "");
            setPvDesc(inStory?.description ?? "");
            setPreviewEditing(true);
          };
          const Field = ({
            label,
            value,
          }: {
            label: string;
            value: string;
          }): React.ReactElement => (
            <div className="flex flex-col gap-0.5">
              <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              {value ? (
                <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
              ) : (
                <p className="text-sm text-muted-foreground/60">{t("Not set")}</p>
              )}
            </div>
          );
          const dirty = inStory
            ? pvTitle.trim() !== (inStory.title ?? "") ||
              pvDesc.trim() !== (inStory.description ?? "")
            : (captionDraft ?? "") !== (photo.caption ?? "");
          const save = async (): Promise<void> => {
            try {
              if (inStory) {
                if (!pvTitle.trim()) return;
                await lensApi.setStoryTitle(token, inStory.id, {
                  title: pvTitle.trim(),
                  description: pvDesc.trim(),
                });
              } else {
                await lensApi.editOwnCaption(
                  token,
                  photo.upload_ref,
                  captionDraft ?? "",
                );
              }
              push({ kind: "success", title: t("Saved") });
              void qc.invalidateQueries({ queryKey: qk.lensPass(token) });
              setPreviewEditing(false);
              setCaptionDraft(null);
            } catch (e) {
              const code =
                e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
              push({
                kind: "error",
                title:
                  code === "photo_locked"
                    ? t("This photo is already in review.")
                    : t("Could not save."),
              });
            }
          };
          return (
            <>
              <DialogHeader>
                <DialogTitle>
                  {inStory ? inStory.title || t("Your story") : t("Your photo")}
                </DialogTitle>
                <DialogDescription>
                  {photo.category || t("No category")} ·{" "}
                  {ownStatusChip(photo.status)}
                </DialogDescription>
              </DialogHeader>
              <img
                src={photo.url}
                alt={photo.caption || inStory?.title || t("Uploaded photo")}
                className="max-h-[50vh] w-full rounded-md object-contain"
                data-testid="preview-image"
              />

              {shownPhotos.length > 1 && !previewEditing ? (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="preview-prev"
                    disabled={idx <= 0}
                    onClick={() => go(-1)}
                  >
                    <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                    {t("Previous")}
                  </Button>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {idx + 1} {t("of")} {shownPhotos.length}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="preview-next"
                    disabled={idx >= shownPhotos.length - 1}
                    onClick={() => go(1)}
                  >
                    {t("Next")}
                    <ChevronRight aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}

              {!previewEditing ? (
                <div className="flex flex-col gap-3" data-testid="preview-details">
                  {inStory ? (
                    <>
                      <Field label={t("Story title")} value={inStory.title} />
                      <Field
                        label={t("Description")}
                        value={inStory.description}
                      />
                    </>
                  ) : (
                    <Field label={t("Caption")} value={photo.caption} />
                  )}
                  {!editable ? (
                    <p className="text-xs text-muted-foreground">
                      {t("Locked once reviewed.")}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-2" data-testid="preview-edit">
                  {inStory ? (
                    <>
                      <label className="text-xs font-medium" htmlFor="pv-title">
                        {t("Story title")} *
                      </label>
                      <input
                        id="pv-title"
                        value={pvTitle}
                        data-testid="preview-title-input"
                        maxLength={120}
                        onChange={(e) => setPvTitle(e.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-card px-2.5 text-sm"
                      />
                      <label className="text-xs font-medium" htmlFor="pv-desc">
                        {t("Description (optional)")}
                      </label>
                      <textarea
                        id="pv-desc"
                        value={pvDesc}
                        data-testid="preview-description-input"
                        rows={3}
                        maxLength={1000}
                        onChange={(e) => setPvDesc(e.target.value)}
                        className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm"
                      />
                    </>
                  ) : (
                    <>
                      <label className="text-xs font-medium" htmlFor="own-caption">
                        {t("Caption")}
                      </label>
                      <input
                        id="own-caption"
                        value={captionDraft ?? ""}
                        data-testid="caption-input"
                        maxLength={200}
                        placeholder={t("Describe this photo (optional)")}
                        onChange={(e) => setCaptionDraft(e.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-card px-2.5 text-sm"
                      />
                    </>
                  )}
                </div>
              )}

              <DialogFooter>
                {editable && !previewEditing ? (
                  <Button
                    variant="destructive"
                    className="mr-auto"
                    data-testid="remove-from-preview-btn"
                    onClick={() => {
                      setDeleteRef(photo.upload_ref);
                      setPreviewRef(null);
                    }}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                    {t("Remove")}
                  </Button>
                ) : null}
                {previewEditing ? (
                  <>
                    <Button
                      variant="outline"
                      data-testid="preview-cancel-edit"
                      onClick={() => {
                        setPreviewEditing(false);
                        setCaptionDraft(null);
                      }}
                    >
                      {t("Cancel")}
                    </Button>
                    <Button
                      data-testid="preview-save-btn"
                      disabled={!dirty || (!!inStory && !pvTitle.trim())}
                      onClick={() => void save()}
                    >
                      {t("Save")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setPreviewRef(null)}
                    >
                      {t("Close")}
                    </Button>
                    {editable ? (
                      <Button data-testid="preview-edit-btn" onClick={startEdit}>
                        <Pencil aria-hidden="true" className="h-4 w-4" />
                        {t("Edit")}
                      </Button>
                    ) : null}
                  </>
                )}
              </DialogFooter>
            </>
          );
        })()}
      </Dialog>

      <Dialog
        open={deleteRef !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteRef(null);
        }}
        ariaLabel={t("Remove photo")}
        variant="sheet"
      >
        <DialogHeader>
          <DialogTitle>{t("Remove this photo?")}</DialogTitle>
          <DialogDescription>
            {t("It frees one slot of your school's photo limit.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteRef(null)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-btn"
            onClick={() => {
              if (deleteRef) void removePhoto(deleteRef);
            }}
          >
            {t("Remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </PublicShell>
  );
}
