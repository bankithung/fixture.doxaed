import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Award,
  Camera,
  ChevronLeft,
  ChevronRight,
  Globe,
  LayoutGrid,
} from "lucide-react";
import { lensApi, type PublicAlbumPhoto } from "@/api/lens";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { AlbumStage } from "@/features/lens/universe/AlbumStage";
import type { OrbitSchool } from "@/features/lens/universe/SchoolOrbit";
import type { DomeItem } from "@/features/lens/universe/DomeGallery";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The public shared event album ("20 schools. 2 days. 1 shared album."):
 * approved Guest Lens photos as a sports-product gallery, no login
 * (spec 2026-07-10 §4.4). One combined section — award winners lead, then the
 * album itself in either of two views:
 *
 *  - **Sphere** (default, owner 2026-07-27): a solar system with one planet per
 *    school, orbiting by itself; pick a school and the camera flies into a
 *    rotatable sphere of that school's photos.
 *  - **Grid**: the filterable masonry, which stays the exhaustive, low-power,
 *    keyboard-complete route through every photo.
 *
 * Both views share one filter pair and one lightbox, so prev/next always walks
 * whatever list is on screen.
 */

const VIEW_KEY = "album:view";

type View = "sphere" | "grid";

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "sphere";
  } catch {
    return "sphere";
  }
}

export function PublicAlbumPage(): React.ReactElement {
  const { slug = "", id = "", campaignId = "" } = useParams();
  const [category, setCategory] = useState<string>("");
  /** null = no school chosen (the orbit); "" = every photo; else one school. */
  const [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState<View>(storedView);
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

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode: the view is simply not remembered */
    }
  }, [view]);

  // Only surface awards for categories that still exist on the campaign: a
  // manager can remove a category that already had a winner, and neither the
  // backend nor award_photo reconciles the photo's stale award_category, so an
  // orphaned prize label must not leak into the public album.
  const liveCategories = useMemo(
    () => new Set(q.data?.award_categories ?? []),
    [q.data],
  );

  // A chip matches photos filed under the category by the uploading school as
  // well as the photo holding that category's award.
  const byCategory = useMemo(() => {
    const all = q.data?.photos ?? [];
    return all.filter(
      (p) =>
        !category || p.category === category || p.award_category === category,
    );
  }, [q.data, category]);

  /** Schools present in the current category, busiest first — the planets. */
  const schools = useMemo<OrbitSchool[]>(() => {
    const m = new Map<string, OrbitSchool>();
    for (const p of byCategory) {
      const seen = m.get(p.institution_name);
      if (!seen) {
        m.set(p.institution_name, {
          name: p.institution_name,
          count: 1,
          cover: p.thumb_url,
        });
      } else {
        seen.count += 1;
        // A prize shot represents its school better than whatever landed first.
        if (p.award_category && liveCategories.has(p.award_category)) {
          seen.cover = p.thumb_url;
        }
      }
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [byCategory, liveCategories]);

  // A one-school album has no system worth orbiting: fly straight in.
  const effFocus = schools.length <= 1 && focus === null ? "" : focus;

  const photos = useMemo(
    () =>
      effFocus ? byCategory.filter((p) => p.institution_name === effFocus) : byCategory,
    [byCategory, effFocus],
  );

  const domeItems = useMemo<DomeItem[]>(
    () =>
      photos.map((p) => ({
        key: p.upload_ref,
        thumb: p.thumb_url,
        alt: p.caption || p.institution_name,
        awarded: Boolean(p.award_category && liveCategories.has(p.award_category)),
      })),
    [photos, liveCategories],
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
  const total = q.data?.photos.length ?? 0;
  const schoolOptions = [
    { value: "", label: t("All schools") },
    ...(q.data?.institutions ?? []).map((i) => ({
      value: i.name,
      label: `${i.name} (${i.count})`,
    })),
  ];

  const viewButton = (
    kind: View,
    Icon: typeof Globe,
    labelText: string,
  ): React.ReactElement => (
    <button
      type="button"
      aria-pressed={view === kind}
      data-testid={`album-view-${kind}`}
      onClick={() => setView(kind)}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
        view === kind
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {/* Icon-only on a phone: the label wrapped the toggle onto its own line
          and pushed the sphere under the fold. */}
      <span className="hidden sm:inline">{labelText}</span>
      <span className="sr-only sm:hidden">{labelText}</span>
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
              {/* Title band. Everything above the stage is on a budget: on a
                  390px phone the chrome had the sphere starting below the
                  fold, so the toggle stays on this line at every width. */}
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
                <div className="min-w-0">
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
                <div
                  role="group"
                  aria-label={t("Album view")}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary/60 p-1"
                >
                  {viewButton("sphere", Globe, t("Sphere"))}
                  {viewButton("grid", LayoutGrid, t("Grid"))}
                </div>
              </div>

              {/* Filters — one control height per row (owner 2026-07-26).
                  Categories scroll rather than wrap on a phone. */}
              <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5">
                <div className="flex items-center gap-2 overflow-x-auto sm:contents">
                  <button
                    type="button"
                    aria-pressed={category === ""}
                    onClick={() => setCategory("")}
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors",
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
                        "inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                        category === cat
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                {/* In sphere view below lg the planet rail IS the school
                    picker, so this would be a second door to one job. */}
                <div
                  className={cn(
                    "w-full sm:ml-auto sm:w-56",
                    view === "sphere" && "hidden lg:block",
                  )}
                >
                  <Select
                    aria-label={t("Filter by school")}
                    value={effFocus ?? ""}
                    onChange={(v) => setFocus(v || null)}
                    options={schoolOptions}
                  />
                </div>
              </div>

              {/* The album. */}
              {photos.length === 0 ? (
                <p className="px-4 py-14 text-center text-sm text-muted-foreground">
                  {t("No photos match this filter.")}
                </p>
              ) : view === "sphere" ? (
                <AlbumStage
                  photos={domeItems}
                  schools={schools}
                  total={total}
                  focus={effFocus}
                  onFocus={setFocus}
                  onOpen={setOpenRef}
                  paused={openPhoto !== null}
                />
              ) : (
                <div
                  className="columns-2 gap-3 px-4 py-4 sm:columns-3 sm:px-5 lg:columns-4"
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

              {/* Prize winners close the section. They lead editorially, but
                  the sphere is what the page is for — 260px of strip above it
                  pushed the stage under the fold. */}
              {winners.length > 0 ? (
                <div
                  aria-label={t("Award winners")}
                  className="border-t border-border px-4 py-3 sm:px-5"
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
                          setFocus("");
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
