import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Camera, ChevronLeft, ChevronRight } from "lucide-react";
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
 * (spec 2026-07-10 §4.4). Award winners lead, then a filterable masonry grid
 * with an accessible lightbox.
 */
export function PublicAlbumPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [category, setCategory] = useState<string>("");
  const [school, setSchool] = useState<string>("");
  const [openRef, setOpenRef] = useState<string | null>(null);

  const q = useQuery({
    queryKey: qk.publicAlbum(slug, id),
    queryFn: () => lensApi.publicAlbum(slug, id),
    enabled: Boolean(slug && id),
    retry: false,
  });

  useEffect(() => {
    if (q.data?.campaign) document.title = q.data.campaign.title;
  }, [q.data]);

  const photos = useMemo(() => {
    const all = q.data?.photos ?? [];
    // A chip matches photos filed under the category by the uploading school
    // as well as the photo holding that category's award.
    return all.filter(
      (p) =>
        (!category ||
          p.category === category ||
          p.award_category === category) &&
        (!school || p.institution_name === school),
    );
  }, [q.data, category, school]);

  // Only surface awards for categories that still exist on the campaign: a
  // manager can remove a category that already had a winner, and neither the
  // backend nor award_photo reconciles the photo's stale award_category, so an
  // orphaned prize label must not leak into the public album.
  const liveCategories = useMemo(
    () => new Set(q.data?.award_categories ?? []),
    [q.data],
  );
  const winners = useMemo(
    () =>
      (q.data?.photos ?? []).filter(
        (p) => p.award_category && liveCategories.has(p.award_category),
      ),
    [q.data, liveCategories],
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
  const schoolOptions = [
    { value: "", label: t("All schools") },
    ...(q.data?.institutions ?? []).map((i) => ({
      value: i.name,
      label: `${i.name} (${i.count})`,
    })),
  ];

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

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
        {q.isLoading ? (
          <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
        ) : q.isError ? (
          <p role="alert" className="py-10 text-center text-sm text-destructive">
            {t("This album could not be loaded.")}
          </p>
        ) : !campaign || (q.data?.photos.length ?? 0) === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center" data-testid="album-empty">
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
            {/* Hero. */}
            <section className="flex flex-col gap-1 pt-2 text-center">
              <p className="text-[0.6875rem] font-medium uppercase tracking-[0.2em] text-primary">
                {campaign.tagline}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {campaign.title}
              </h1>
              <p className="font-tabular text-sm text-muted-foreground">
                {q.data?.photos.length} {t("photos")} ·{" "}
                {q.data?.institutions.length} {t("schools")}
              </p>
            </section>

            {/* Award winners strip. */}
            {winners.length > 0 ? (
              <section
                aria-label={t("Award winners")}
                className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
                data-testid="winners-strip"
              >
                <div className="flex gap-3">
                  {winners.map((w) => (
                    <button
                      key={w.upload_ref}
                      type="button"
                      onClick={() => {
                        setCategory("");
                        setSchool("");
                        setOpenRef(w.upload_ref);
                      }}
                      className="flex w-52 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <img
                        src={w.thumb_url}
                        alt={w.caption || w.institution_name}
                        loading="lazy"
                        className="aspect-[4/3] w-full object-cover"
                      />
                      <div className="flex flex-col gap-0.5 px-3 py-2">
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
              </section>
            ) : null}

            {/* Filters. */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={category === ""}
                onClick={() => setCategory("")}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                  category === ""
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {t("All")}
              </button>
              {(q.data?.award_categories ?? []).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={category === cat}
                  data-testid={`album-filter-${cat}`}
                  onClick={() => setCategory(category === cat ? "" : cat)}
                  className={cn(
                    "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                    category === cat
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {cat}
                </button>
              ))}
              <div className="ml-auto w-full sm:w-56">
                <Select
                  size="sm"
                  aria-label={t("Filter by school")}
                  value={school}
                  onChange={setSchool}
                  options={schoolOptions}
                />
              </div>
            </div>

            {/* Masonry grid. */}
            {photos.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("No photos match this filter.")}
              </p>
            ) : (
              <div
                className="columns-2 gap-3 sm:columns-3 lg:columns-4"
                data-testid="album-grid"
              >
                {photos.map((p) => (
                  <button
                    key={p.upload_ref}
                    type="button"
                    data-testid={`album-photo-${p.upload_ref}`}
                    onClick={() => setOpenRef(p.upload_ref)}
                    className="group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-lg border border-border bg-card shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <img
                      src={p.thumb_url}
                      alt={p.caption || p.institution_name}
                      loading="lazy"
                      className="w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                    {p.award_category && liveCategories.has(p.award_category) ? (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[0.625rem] font-medium text-primary-foreground">
                        <Award aria-hidden="true" className="h-3 w-3" />
                        {p.award_category}
                      </span>
                    ) : null}
                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5 text-left text-[0.6875rem] font-medium text-white">
                      {p.institution_name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
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
              {openPhoto.award_category &&
              liveCategories.has(openPhoto.award_category) ? (
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
