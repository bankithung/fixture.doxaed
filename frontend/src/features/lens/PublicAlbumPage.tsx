import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Camera, ChevronLeft, ChevronRight } from "lucide-react";
import { lensApi, type PublicAlbumPhoto } from "@/api/lens";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { InfiniteWall } from "./InfiniteWall";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

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

export function PublicAlbumPage(): React.ReactElement {
  const { slug = "", id = "", campaignId = "" } = useParams();
  const [category, setCategory] = useState<string>("");
  const [school, setSchool] = useState<string>("");
  const [openRef, setOpenRef] = useState<string | null>(null);

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
