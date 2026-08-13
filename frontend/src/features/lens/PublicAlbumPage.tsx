import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Camera, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { lensApi, type PublicAlbumPhoto } from "@/api/lens";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The public shared event album ("20 schools. 2 days. 1 shared album."):
 * approved Guest Lens photos as a sports-product gallery, no login
 * (spec 2026-07-10 §4.4).
 *
 * ONE view: a vertical wall of photographs that keeps loading as you scroll
 * (owner 2026-08-13). It replaced a 3D sphere of school "planets" — pretty,
 * but it answered "whose photos are these?" when what a visitor actually asks
 * is "show me the photos", and it could only ever show one school at a time.
 *
 * Category is a first-class way through the album, not just a filter: with no
 * chip selected the wall is grouped into a section per category, so the whole
 * album can be read category-wise in one scroll. Pick a chip and it narrows to
 * that one. Both paths share one lightbox, so prev/next always walks exactly
 * what is on screen.
 */

/** How many photos enter the DOM per step. An event album runs to hundreds of
 * images; rendering them all costs a school phone its scroll. */
const PAGE = 24;

/** Sentinel key for photos filed under no category. Double underscore so
 * it can never collide with a category a manager typed. */
const UNCATEGORISED = "__other";

function PhotoTile({
  photo,
  awarded,
  onOpen,
}: {
  photo: PublicAlbumPhoto;
  awarded: boolean;
  onOpen: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={`album-photo-${photo.upload_ref}`}
      onClick={onOpen}
      className="group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-lg border border-border bg-card shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={photo.thumb_url}
        alt={photo.caption || photo.institution_name}
        loading="lazy"
        className="w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
      />
      {awarded ? (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[0.625rem] font-medium text-primary-foreground">
          <Award aria-hidden="true" className="h-3 w-3" />
          {photo.award_category}
        </span>
      ) : null}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5 text-left text-[0.6875rem] font-medium text-white">
        {photo.institution_name}
      </span>
    </button>
  );
}

export function PublicAlbumPage(): React.ReactElement {
  const { slug = "", id = "", campaignId = "" } = useParams();
  const [category, setCategory] = useState<string>("");
  const [school, setSchool] = useState<string>("");
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

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

  /** With no category chosen the wall reads category-wise: one section each,
   * in the campaign's own order, with everything unfiled last. */
  const sections = useMemo(() => {
    if (category) return null;
    const cats = q.data?.award_categories ?? [];
    const order = [...cats, UNCATEGORISED];
    const by = new Map<string, PublicAlbumPhoto[]>();
    for (const p of photos) {
      const key = p.category && cats.includes(p.category) ? p.category : UNCATEGORISED;
      const slot = by.get(key);
      if (slot) slot.push(p);
      else by.set(key, [p]);
    }
    return order
      .filter((c) => (by.get(c)?.length ?? 0) > 0)
      .map((c) => ({ key: c, label: c === UNCATEGORISED ? t("More photos") : c, items: by.get(c)! }));
  }, [photos, category, q.data]);

  // Reset the reveal window whenever the list underneath it changes, or a
  // narrow filter would inherit a scroll position it never earned.
  useEffect(() => {
    setShown(PAGE);
  }, [category, school]);

  const hasMore = shown < photos.length;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown((n) => n + PAGE);
        }
      },
      // Start the next batch before the visitor reaches the end, so the wall
      // reads as continuous rather than as pages that stall.
      { rootMargin: "600px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, photos.length]);

  const winners = useMemo(
    () => (q.data?.photos ?? []).filter(awarded),
    [q.data, awarded],
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

  const campaign = q.data?.campaign ?? null;
  const total = q.data?.photos.length ?? 0;
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

  // Slice AFTER grouping so a section's tail is revealed with the wall, never
  // a section whose header appears with nothing under it.
  let budget = shown;
  const drawn = (sections ?? []).map((s) => {
    const take = Math.max(0, Math.min(budget, s.items.length));
    budget -= take;
    return { ...s, items: s.items.slice(0, take) };
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
        <ShareButton title={campaign?.title} />
        <ThemeToggle />
      </header>

      <main className="flex w-full flex-1 flex-col px-0 py-0 sm:px-6 sm:py-6">
        {/* One combined section: nothing about this album sits outside it. */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden border-y border-border bg-card sm:rounded-xl sm:border sm:shadow-sm">
          {q.isLoading ? (
            <div className="h-72 animate-pulse bg-muted/40" />
          ) : q.isError ? (
            <p role="alert" className="px-4 py-16 text-center text-sm text-destructive">
              {t("This album could not be loaded.")}
            </p>
          ) : !campaign || total === 0 ? (
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
                <p className="font-tabular text-xs text-muted-foreground">
                  {total} {t("photos")} · {q.data?.institutions.length}{" "}
                  {t("schools")}
                </p>
              </div>

              {/* Prize winners lead: they are the editorial top of the album. */}
              {winners.length > 0 ? (
                <div
                  aria-label={t("Award winners")}
                  className="border-b border-border px-4 py-3 sm:px-5"
                  data-testid="winners-strip"
                >
                  <p className="pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t("Prize winners")}
                  </p>
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {winners.map((w) => (
                      <button
                        key={w.upload_ref}
                        type="button"
                        onClick={() => {
                          setCategory("");
                          setSchool("");
                          setOpenRef(w.upload_ref);
                        }}
                        className="flex w-40 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <img
                          src={w.thumb_url}
                          alt={w.caption || w.institution_name}
                          loading="lazy"
                          className="aspect-[4/3] w-full object-cover"
                        />
                        <div className="flex flex-col gap-0.5 px-2.5 py-2">
                          <span className="flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
                            <Award aria-hidden="true" className="h-3 w-3" />
                            {w.award_category}
                          </span>
                          <span className="truncate text-xs font-medium">
                            {w.institution_name}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Filters — one control height per row (owner 2026-07-26).
                  Categories scroll rather than wrap on a phone. */}
              <div className="sticky top-[57px] z-10 flex flex-col gap-2 border-b border-border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
                <div className="flex items-center gap-2 overflow-x-auto sm:contents">
                  {chip("", t("All"), total)}
                  {(q.data?.award_categories ?? []).map((cat) =>
                    chip(
                      cat,
                      cat,
                      (q.data?.photos ?? []).filter(
                        (p) => p.category === cat || p.award_category === cat,
                      ).length,
                    ),
                  )}
                </div>
                <div className="w-full sm:ml-auto sm:w-56">
                  <Select
                    aria-label={t("Filter by school")}
                    value={school}
                    onChange={setSchool}
                    options={schoolOptions}
                  />
                </div>
              </div>

              {/* The wall. */}
              {photos.length === 0 ? (
                <p className="px-4 py-14 text-center text-sm text-muted-foreground">
                  {t("No photos match this filter.")}
                </p>
              ) : (
                <div className="px-4 py-4 sm:px-5" data-testid="album-grid">
                  {sections ? (
                    drawn.map((s) =>
                      s.items.length === 0 ? null : (
                        <section
                          key={s.key}
                          data-testid={`album-section-${s.key}`}
                          className="mb-2"
                        >
                          <div className="sticky top-[125px] z-[5] -mx-4 mb-2 flex items-baseline gap-2 bg-card px-4 py-1.5 sm:-mx-5 sm:px-5">
                            <h2 className="text-sm font-semibold">{s.label}</h2>
                            <span className="font-tabular text-xs text-muted-foreground">
                              {s.items.length}
                            </span>
                          </div>
                          <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
                            {s.items.map((p) => (
                              <PhotoTile
                                key={p.upload_ref}
                                photo={p}
                                awarded={awarded(p)}
                                onOpen={() => setOpenRef(p.upload_ref)}
                              />
                            ))}
                          </div>
                        </section>
                      ),
                    )
                  ) : (
                    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
                      {photos.slice(0, shown).map((p) => (
                        <PhotoTile
                          key={p.upload_ref}
                          photo={p}
                          awarded={awarded(p)}
                          onOpen={() => setOpenRef(p.upload_ref)}
                        />
                      ))}
                    </div>
                  )}

                  {hasMore ? (
                    <div
                      ref={sentinel}
                      data-testid="album-sentinel"
                      className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
                    >
                      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                      {t("Loading more photos")}
                    </div>
                  ) : (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {photos.length} {t("photos")}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>

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
    </div>
  );
}
