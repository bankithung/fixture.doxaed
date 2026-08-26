import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Award,
  Camera,
  ChevronLeft,
  ChevronRight,
  ScanLine,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { lensApi, type PublicAlbumPhoto } from "@/api/lens";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { InfiniteWall } from "./InfiniteWall";
import { QrScanDialog } from "./QrScanDialog";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";

/**
 * The public shared event album ("20 schools. 2 days. 1 shared album."):
 * approved Guest Lens photos as a sports-product gallery, no login
 * (spec 2026-07-10 §4.4).
 *
 * ONE view: an endless wall of photographs that drifts on its own and wraps
 * forever (owner 2026-08-13, see `InfiniteWall`). It replaced a 3D sphere of
 * school "planets" — pretty, but it answered "whose photos are these?" when
 * what a visitor actually asks is "show me the photos", and it could only ever
 * show one school at a time.
 *
 * Category is a way through the album rather than a hidden property: every
 * chip carries its count, every tile names the category it was filed under,
 * and picking a chip runs the wall on that category alone. The lightbox walks
 * exactly the list the wall is showing.
 */

export function AlbumPanel({
  slug,
  id,
  campaignId = "",
}: {
  slug: string;
  id: string;
  campaignId?: string;
}): React.ReactElement {
  const [category, setCategory] = useState<string>("");
  const [school, setSchool] = useState<string>("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const { isMobile } = useBreakpoint();
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const navigate = useNavigate();

  const q = useQuery({
    queryKey: [...qk.publicAlbum(slug, id), campaignId],
    queryFn: () => lensApi.publicAlbum(slug, id, campaignId || undefined),
    enabled: Boolean(slug && id),
    retry: false,
  });

  useEffect(() => {
    if (q.data?.campaign) document.title = q.data.campaign.title;
  }, [q.data]);

  // Only surface awards for categories that still exist on the campaign: a
  // manager can remove a category that already had a winner, and neither the
  // backend nor award_photo reconciles the photo's stale award_category, so an
  // orphaned prize label must not leak into the public album.
  const liveCategories = useMemo(
    () => new Set(q.data?.award_categories ?? []),
    [q.data],
  );
  const awarded = useCallback(
    (p: PublicAlbumPhoto) =>
      Boolean(p.award_category && liveCategories.has(p.award_category)),
    [liveCategories],
  );

  /** Everything the filters allow, in album order. This is the list the
   * lightbox walks, so it must match what the page draws. */
  const photos = useMemo(() => {
    const all = q.data?.photos ?? [];
    return all.filter(
      (p) =>
        (!category || p.category === category || p.award_category === category) &&
        (!school || p.institution_name === school),
    );
  }, [q.data, category, school]);

  /** Every prize, whichever shape it took. A story can win an award too, and
   * leaving it out of the winners band meant an album whose only prizes were
   * stories showed no winners at all (owner 2026-08-25). */
  const winners = useMemo(() => {
    const live = new Set(q.data?.award_categories ?? []);
    const fromWall = (q.data?.photos ?? [])
      .filter(awarded)
      .map((p) => ({
        key: p.upload_ref,
        award: p.award_category,
        thumb: p.thumb_url,
        school: p.institution_name,
        title: p.caption,
        openRef: p.upload_ref,
        storyId: "",
      }));
    const fromStories = (q.data?.stories ?? [])
      .filter((st) => st.award_category && live.has(st.award_category))
      .map((st) => ({
        key: `story-${st.id}`,
        award: st.award_category,
        thumb: st.photos[0]?.thumb_url ?? "",
        school: st.institution_name,
        title: st.title,
        openRef: "",
        storyId: st.id,
      }));
    // A prize declared on a single FRAME of a story. The wall excludes story
    // frames by design, so an award given to one was invisible everywhere
    // (owner 2026-08-26) — it belongs here as much as any other winner.
    const fromFrames = (q.data?.stories ?? []).flatMap((st) =>
      st.photos
        .filter((f) => f.award_category && live.has(f.award_category))
        .map((f) => ({
          key: `frame-${f.upload_ref}`,
          award: f.award_category ?? "",
          thumb: f.thumb_url,
          school: st.institution_name,
          title: f.caption || st.title,
          openRef: "",
          storyId: st.id,
        })),
    );
    return [...fromWall, ...fromStories, ...fromFrames];
  }, [q.data, awarded]);

  // Photo-story entries render as ONE unit each (title + frames in order).
  // A story whose category was removed from the campaign must not leak here,
  // same rule as orphaned photo awards above.
  const liveStoryCategories = useMemo(
    () => new Set(q.data?.story_categories ?? []),
    [q.data],
  );
  const stories = useMemo(
    () =>
      (q.data?.stories ?? []).filter(
        (s) =>
          liveStoryCategories.has(s.category) &&
          (!school || s.institution_name === school) &&
          (!category || s.category === category),
      ),
    [q.data, liveStoryCategories, category, school],
  );

  const openIdx = photos.findIndex((p) => p.upload_ref === openRef);
  const openPhoto: PublicAlbumPhoto | null =
    openIdx >= 0 ? photos[openIdx] : null;

  useEffect(() => {
    if (!openPhoto) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" && openIdx < photos.length - 1) {
        setOpenRef(photos[openIdx + 1].upload_ref);
      }
      if (e.key === "ArrowLeft" && openIdx > 0) {
        setOpenRef(photos[openIdx - 1].upload_ref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPhoto, openIdx, photos]);

  const activeFilters = (category ? 1 : 0) + (school ? 1 : 0);
  const campaign = q.data?.campaign ?? null;
  // The wall is not the album: a story's frames are approved photographs too,
  // and counting only the wall told an album made entirely of stories that it
  // held nothing (owner 2026-08-25).
  const wallTotal = q.data?.photos.length ?? 0;
  const total =
    q.data?.totals?.photos ??
    wallTotal +
      (q.data?.stories ?? []).reduce((n, st) => n + st.photos.length, 0);
  const schoolCount =
    q.data?.totals?.schools ?? q.data?.institutions.length ?? 0;
  /** Photographs filed under a category, wall and stories alike. */
  const countIn = (cat: string): number =>
    (q.data?.photos ?? []).filter(
      (p) => p.category === cat || p.award_category === cat,
    ).length +
    (q.data?.stories ?? [])
      .filter((st) => st.category === cat || st.award_category === cat)
      .reduce((n, st) => n + st.photos.length, 0);
  const schoolOptions = [
    { value: "", label: t("All schools") },
    ...(q.data?.institutions ?? []).map((i) => ({
      value: i.name,
      label: `${i.name} (${i.count})`,
    })),
  ];

  const chip = (value: string, label: string, count?: number): React.ReactElement => (
    <button
      key={value || "all"}
      type="button"
      aria-pressed={category === value}
      data-testid={value ? `album-filter-${value}` : "album-filter-all"}
      onClick={() => setCategory(category === value ? "" : value)}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        category === value
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count != null ? (
        <span className="font-tabular text-[0.6875rem] opacity-70">{count}</span>
      ) : null}
    </button>
  );

  return (
    <>
        {/* One combined section: nothing about this album sits outside it. */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden border-y border-border bg-card sm:rounded-xl sm:border sm:shadow-sm">
          {q.isLoading ? (
            <div className="h-72 animate-pulse bg-muted/40" />
          ) : q.isError ? (
            <p role="alert" className="px-4 py-16 text-center text-sm text-destructive">
              {t("This album could not be loaded.")}
            </p>
          ) : !campaign || (total === 0 && (q.data?.stories ?? []).length === 0) ? (
            <div
              className="flex flex-col items-center gap-2 px-4 py-16 text-center"
              data-testid="album-empty"
            >
              <Camera aria-hidden="true" className="h-8 w-8 text-muted-foreground" />
              <h1 className="text-lg font-semibold">
                {campaign?.title ?? t("Event album")}
              </h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t("The album opens when the host approves the first photos.")}
              </p>
            </div>
          ) : (
            <>
              <div className="border-b border-border px-4 py-3 sm:px-5 sm:py-4">
                <p className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-primary sm:text-[0.6875rem]">
                  {campaign.tagline}
                </p>
                <h1 className="truncate text-lg font-semibold tracking-tight sm:text-2xl">
                  {campaign.title}
                </h1>
                <p
                  data-testid="album-counts"
                  className="font-tabular text-xs text-muted-foreground"
                >
                  {total} {total === 1 ? t("photo") : t("photos")} ·{" "}
                  {schoolCount} {schoolCount === 1 ? t("school") : t("schools")}
                  {stories.length
                    ? ` · ${stories.length} ${stories.length === 1 ? t("story") : t("stories")}`
                    : ""}
                </p>
              </div>

              {/* Filters sit under the header, ABOVE the winners and the
                  stories, because they govern both. Below them a reader
                  scrolls past everything the control filters before reaching
                  it (owner 2026-08-25). On a desk they are an inline row; on a phone six
                  category chips plus a school select stacked three rows deep,
                  so there they live behind one thumb-reachable button instead
                  (owner 2026-08-25). */}
              {!isMobile ? (
                <div className="sticky top-[57px] z-10 flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-3 sm:px-5">
                  <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("Filter")}
                  </span>
                  {chip("", t("All"), total)}
                  {(q.data?.award_categories ?? []).map((cat) =>
                    chip(cat, cat, countIn(cat)),
                  )}
                  {category || school ? (
                    <button
                      type="button"
                      data-testid="album-filter-reset"
                      onClick={() => {
                        setCategory("");
                        setSchool("");
                      }}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary"
                    >
                      {t("Clear")}
                    </button>
                  ) : null}
                  <div className="ml-auto w-56">
                    <Select
                      aria-label={t("Filter by school")}
                      value={school}
                      onChange={setSchool}
                      options={schoolOptions}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {category || t("All categories")}
                    {school ? ` · ${school}` : ""}
                  </span>
                  {category || school ? (
                    <button
                      type="button"
                      data-testid="album-filter-clear"
                      onClick={() => {
                        setCategory("");
                        setSchool("");
                      }}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary"
                    >
                      {t("Clear")}
                    </button>
                  ) : null}
                </div>
              )}

              {/* Prizes lead the album: the first thing a visitor wants is
                  who won (owner 2026-08-25). A winner may be a single
                  photograph or a whole story. */}
              {winners.length > 0 ? (
                <div
                  className="border-b border-border px-4 py-3 sm:px-5"
                  data-testid="winners-strip"
                >
                  <p className="pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t("Prize winners")}
                  </p>
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {winners.map((w) => (
                      <button
                        key={w.key}
                        type="button"
                        data-testid={`winner-${w.key}`}
                        onClick={() => {
                          setCategory("");
                          setSchool("");
                          if (w.openRef) setOpenRef(w.openRef);
                          else
                            document
                              .getElementById(`story-${w.storyId}`)
                              ?.scrollIntoView({ block: "center" });
                        }}
                        className="flex w-36 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-40"
                      >
                        {w.thumb ? (
                          <img
                            src={w.thumb}
                            alt={w.title || w.school}
                            loading="lazy"
                            className="aspect-[4/3] w-full object-cover"
                          />
                        ) : (
                          <span className="aspect-[4/3] w-full bg-muted" />
                        )}
                        <div className="flex flex-col gap-0.5 px-2.5 py-2">
                          <span className="flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
                            <Award aria-hidden="true" className="h-3 w-3" />
                            <span className="truncate">{w.award}</span>
                          </span>
                          <span className="truncate text-xs font-medium">
                            {w.title || w.school}
                          </span>
                          {w.title ? (
                            <span className="truncate text-[0.6875rem] text-muted-foreground">
                              {w.school}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Photo stories first: they are entries, not wall tiles, so
                  they read best before the endless drift begins. */}
              {stories.length > 0 ? (
                <div
                  aria-label={t("Photo stories")}
                  className="border-b border-border px-4 py-3 sm:px-5"
                  data-testid="album-stories"
                >
                  <p className="pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t("Photo stories")}
                  </p>
                  <ul className="flex flex-col gap-3">
                    {stories.map((s) => (
                      <li
                        key={s.id}
                        id={`story-${s.id}`}
                        className="scroll-mt-24 rounded-lg border border-border bg-card p-2.5 shadow-sm"
                        data-testid={`album-story-${s.id}`}
                      >
                        <div className="flex flex-col gap-1 pb-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-semibold">
                              {s.title || t("Untitled story")}
                            </span>
                            {s.award_category &&
                            liveCategories.has(s.award_category) ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                <Award aria-hidden="true" className="h-3 w-3" />
                                {s.award_category}
                              </span>
                            ) : null}
                            <span className="ml-auto shrink-0 font-tabular text-[0.6875rem] text-muted-foreground">
                              {s.photos.length}{" "}
                              {s.photos.length === 1 ? t("photo") : t("photos")}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {s.institution_name}
                            {s.category ? ` · ${s.category}` : ""}
                          </span>
                          {/* The description the school wrote was never shown
                              anywhere (owner 2026-08-25). */}
                          {s.description ? (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {s.description}
                            </p>
                          ) : null}
                        </div>
                        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {[...s.photos]
                            .sort((a, b) => a.position - b.position)
                            .map((f) => (
                              <li key={f.upload_ref}>
                                <img
                                  src={f.url}
                                  alt={f.caption || s.institution_name}
                                  loading="lazy"
                                  className="aspect-[4/3] w-full rounded-md border border-border object-cover"
                                />
                                {/* A frame is numbered, not captioned: a story
                                    is named once by its title, so "No caption"
                                    under every frame was pure noise (owner
                                    2026-08-25). */}
                                <p className="mt-0.5 flex items-start gap-1 text-[0.6875rem] leading-snug text-muted-foreground">
                                  <span className="font-tabular font-semibold text-foreground">
                                    {f.position}
                                  </span>
                                  {f.caption ? (
                                    <span className="min-w-0">{f.caption}</span>
                                  ) : null}
                                </p>
                              </li>
                            ))}
                        </ol>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* The wall. */}
              {photos.length === 0 ? (
                <p className="px-4 py-14 text-center text-sm text-muted-foreground">
                  {stories.length > 0 && wallTotal === 0
                    ? t("Every approved photo is part of a story above.")
                    : t("No photo matches this filter.")}
                </p>
              ) : (
                <div className="py-4" data-testid="album-grid">
                  <InfiniteWall
                    photos={photos}
                    isAwarded={awarded}
                    onOpen={setOpenRef}
                    paused={openPhoto !== null}
                  />
                </div>
              )}
            </>
          )}
        </section>

      {/* Mobile: one door to the filters, thumb-reachable, stating what is on
          screen so the drawer is only opened on purpose. */}
      {isMobile && campaign ? (
        <>
          <div className="h-16" aria-hidden="true" />
          <div
            data-testid="album-bottom-bar"
            className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border bg-card/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-card/85"
          >
            <span className="min-w-0 flex-1 truncate font-tabular text-xs text-muted-foreground">
              {category ? countIn(category) : total}{" "}
              {t("photos")}
            </span>
            <Button
              data-testid="album-filters-open"
              className="h-11 shrink-0 px-4 text-sm"
              onClick={() => setSheetOpen(true)}
            >
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              {t("Filters")}
              {activeFilters > 0 ? (
                <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground px-1 font-tabular text-[0.6875rem] font-bold text-primary">
                  {activeFilters}
                </span>
              ) : null}
            </Button>
          </div>
        </>
      ) : null}

      <Dialog
        open={isMobile && sheetOpen}
        onOpenChange={setSheetOpen}
        variant="sheet"
        ariaLabel={t("Filter the album")}
      >
        <div data-testid="album-filter-sheet" className="flex flex-col gap-4">
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
          />
          <h2 className="text-base font-semibold">{t("Filters")}</h2>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("Category")}
            </span>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="album-sheet-all"
                onClick={() => setCategory("")}
                className={cn(
                  "flex items-center justify-between rounded-md border px-3 py-2.5 text-sm",
                  !category
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-border",
                )}
              >
                {t("All categories")}
                <span className="font-tabular text-xs">{total}</span>
              </button>
              {(q.data?.award_categories ?? []).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  data-testid={`album-sheet-${cat}`}
                  onClick={() => setCategory(cat)}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-sm",
                    category === cat
                      ? "border-primary/40 bg-primary/10 font-medium text-primary"
                      : "border-border",
                  )}
                >
                  <span className="min-w-0 truncate">{cat}</span>
                  <span className="font-tabular text-xs">{countIn(cat)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("School")}
            </span>
            <Select
              size="lg"
              aria-label={t("Filter by school")}
              value={school}
              onChange={setSchool}
              options={schoolOptions}
            />
          </div>

          <Button
            data-testid="album-sheet-apply"
            className="h-12 w-full text-base"
            onClick={() => setSheetOpen(false)}
          >
            {t("Show photos")}
          </Button>
        </div>
      </Dialog>

      {/* Scan the poster's QR right here: the phone opens its camera, reads
          the join link, and walks into the school-code upload flow. */}
      <div
        className={cn(
          "pointer-events-none fixed left-1/2 z-20 -translate-x-1/2",
          // Clear of the filter bar, which owns the bottom edge on a phone.
          isMobile ? "bottom-[4.75rem]" : "bottom-4",
        )}
      >
        <Button
          size="lg"
          onClick={() => setScanOpen(true)}
          data-testid="scan-upload"
          className="pointer-events-auto shadow-lg"
        >
          <ScanLine aria-hidden="true" className="mr-2 h-5 w-5" />
          {t("Scan & upload")}
        </Button>
      </div>
      <QrScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onToken={(token) => {
          setScanOpen(false);
          navigate(`/lens/join/${token}`);
        }}
      />

      {/* Lightbox. */}
      <Dialog
        open={openPhoto !== null}
        onOpenChange={(o) => {
          if (!o) setOpenRef(null);
        }}
        ariaLabel={t("Photo viewer")}
      >
        {openPhoto ? (
          <div className="flex flex-col gap-3" data-testid="album-lightbox">
            <img
              src={openPhoto.url}
              alt={openPhoto.caption || openPhoto.institution_name}
              className="max-h-[65vh] w-full rounded-md object-contain"
            />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {openPhoto.institution_name}
                </p>
                {openPhoto.caption ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {openPhoto.caption}
                  </p>
                ) : null}
              </div>
              {awarded(openPhoto) ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  <Award aria-hidden="true" className="h-3 w-3" />
                  {openPhoto.award_category}
                </span>
              ) : null}
              <button
                type="button"
                aria-label={t("Previous photo")}
                disabled={openIdx <= 0}
                onClick={() => setOpenRef(photos[openIdx - 1]?.upload_ref ?? null)}
                className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={t("Next photo")}
                disabled={openIdx >= photos.length - 1}
                onClick={() => setOpenRef(photos[openIdx + 1]?.upload_ref ?? null)}
                className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** The standalone route's chrome around the same panel. */
export function PublicAlbumPage(): React.ReactElement {
  const { slug = "", id = "", campaignId = "" } = useParams();
  const q = useQuery({
    queryKey: [...qk.publicAlbum(slug, id), campaignId],
    queryFn: () => lensApi.publicAlbum(slug, id, campaignId || undefined),
    enabled: Boolean(slug && id),
    retry: false,
  });
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-4 py-3 sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <Link
          to={routes.publicSchedule(slug, id)}
          className="ml-2 min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
        >
          {t("Tournament page")}
        </Link>
        <span className="ml-auto" />
        <ShareButton title={q.data?.campaign?.title} />
        <ThemeToggle />
      </header>
      <main className="flex w-full flex-1 flex-col px-0 py-0 sm:px-6 sm:py-6">
        <AlbumPanel slug={slug} id={id} campaignId={campaignId} />
      </main>
    </div>
  );
}
