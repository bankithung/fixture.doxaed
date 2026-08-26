import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Film, RotateCcw } from "lucide-react";
import { videosApi, type TournamentVideo } from "@/api/videos";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { Chip, FilterFab } from "@/features/fixtures/publicTournamentViews";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";
import { VideoCard } from "./VideoCard";

/**
 * Public VIDEOS tab — the footage, wherever it was published.
 *
 * The platform hosts no video. A meet is on YouTube, Facebook and Instagram by
 * the evening, so this is the host's running order over those links: the
 * YouTube one plays in place, the other two open in the app the viewer already
 * uses.
 *
 * **It is ONE section**, and every filter rides the URL, so "the Saturday
 * table tennis videos" is a link a school can send rather than an instruction
 * to scroll. Facets are counted server-side from the videos actually on the
 * page, so a filter never offers a choice that turns out to be empty.
 */
export function PublicVideosPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { isMobile } = useBreakpoint();
  const [sheetOpen, setSheetOpen] = useState(false);

  const q = useQuery({
    queryKey: ["public-videos", slug, id],
    queryFn: () => videosApi.publicVideos(slug, id),
    staleTime: 5 * 60_000,
  });

  const name = q.data?.tournament.name;
  useEffect(() => {
    if (name) document.title = `${name} · ${t("Videos")}`;
  }, [name]);

  const album = params.get("album") ?? "";
  const day = params.get("day") ?? "";
  const school = params.get("school") ?? "";
  const tag = params.get("tag") ?? "";
  const activeFilters =
    (album ? 1 : 0) + (day ? 1 : 0) + (school ? 1 : 0) + (tag ? 1 : 0);

  const setParam = (next: Record<string, string | null>): void => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };

  const facets = q.data?.facets;
  const tz = q.data?.tournament.time_zone;
  const dayLabel = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: tz || "UTC",
    });

  /** Albums with only the videos that pass every filter; empty ones drop out. */
  const shown = useMemo(() => {
    const keep = (v: TournamentVideo): boolean =>
      (!day || v.played_on === day) &&
      (!school || v.schools.some((s) => s.id === school)) &&
      (!tag || v.tags.some((x) => x.toLowerCase() === tag.toLowerCase()));
    return (q.data?.albums ?? [])
      .filter((a) => !album || a.id === album)
      .map((a) => ({ ...a, videos: a.videos.filter(keep) }))
      .filter((a) => a.videos.length > 0);
  }, [q.data, album, day, school, tag]);

  const shownCount = shown.reduce((n, a) => n + a.videos.length, 0);

  const albumChips = (
    <div
      role="tablist"
      aria-label={t("Albums")}
      className="flex flex-wrap items-center gap-1.5"
    >
      <Chip
        testid="videos-album-all"
        active={!album}
        onClick={() => setParam({ album: null })}
        label={t("All")}
        count={q.data?.totals.videos ?? 0}
      />
      {(q.data?.albums ?? []).map((a) => (
        <Chip
          key={a.id}
          testid={`videos-album-${a.id}`}
          active={album === a.id}
          onClick={() => setParam({ album: a.id })}
          label={a.title}
          count={a.video_count}
        />
      ))}
    </div>
  );

  const daySelect = (
    <Select
      size={isMobile ? "lg" : "sm"}
      value={day}
      onChange={(v) => setParam({ day: v || null })}
      aria-label={t("Filter by day")}
      className={isMobile ? "w-full" : "w-44"}
      options={[
        { value: "", label: t("Any day") },
        ...(facets?.days ?? []).map((d) => ({
          value: d.day,
          label: `${dayLabel(d.day)} (${d.count})`,
        })),
      ]}
    />
  );

  const schoolSelect = (
    <Select
      size={isMobile ? "lg" : "sm"}
      value={school}
      onChange={(v) => setParam({ school: v || null })}
      aria-label={t("Filter by school")}
      className={isMobile ? "w-full" : "w-56"}
      options={[
        { value: "", label: t("All schools") },
        ...(facets?.schools ?? []).map((s) => ({
          value: s.id,
          label: `${s.name} (${s.count})`,
        })),
      ]}
    />
  );

  const tagChips = (facets?.tags ?? []).length ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {(facets?.tags ?? []).slice(0, 18).map((x) => (
        <Chip
          key={x.tag}
          testid={`videos-tag-${x.tag}`}
          active={tag.toLowerCase() === x.tag.toLowerCase()}
          onClick={() =>
            setParam({ tag: tag.toLowerCase() === x.tag.toLowerCase() ? null : x.tag })
          }
          label={x.tag}
          count={x.count}
        />
      ))}
    </div>
  ) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={name}
        active="videos"
        connected={false}
      />
      <main className="flex w-full max-w-full min-w-0 flex-1 flex-col px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
        <section className="flex w-full min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
                {t("Videos")}
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {q.data
                  ? `${shownCount} ${shownCount === 1 ? t("video") : t("videos")}${
                      activeFilters
                        ? ` ${t("of")} ${q.data.totals.videos}`
                        : ` · ${q.data.totals.albums} ${
                            q.data.totals.albums === 1 ? t("album") : t("albums")
                          }`
                    }`
                  : t("Match footage from the meet")}
              </p>
            </div>
            {activeFilters && !isMobile ? (
              <button
                type="button"
                data-testid="videos-reset"
                onClick={() =>
                  setParam({ album: null, day: null, school: null, tag: null })
                }
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Clear filters")}
              </button>
            ) : null}
          </header>

          {q.isLoading ? (
            <div
              aria-busy="true"
              className="h-64 animate-pulse rounded-lg bg-muted/40"
            />
          ) : q.isError || !q.data ? (
            <p
              role="alert"
              className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
            >
              {t("These videos are not available.")}
            </p>
          ) : q.data.albums.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
              <Film aria-hidden="true" className="h-7 w-7 text-muted-foreground" />
              <p className="text-sm font-medium">{t("No videos yet.")}</p>
              <p className="text-xs text-muted-foreground">
                {t("Footage appears here as the host publishes it.")}
              </p>
            </div>
          ) : (
            <>
              {!isMobile ? (
                <div className="flex flex-col gap-2 border-y border-border py-3">
                  {albumChips}
                  <div className="flex flex-wrap items-center gap-2">
                    {daySelect}
                    {schoolSelect}
                  </div>
                  {tagChips}
                </div>
              ) : null}

              {shown.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("No video matches these filters.")}
                </p>
              ) : (
                shown.map((a) => (
                  <section
                    key={a.id}
                    data-testid={`video-album-${a.id}`}
                    className="flex flex-col gap-3"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h2 className="text-sm font-semibold">{a.title}</h2>
                      <span className="font-tabular text-xs text-muted-foreground">
                        {a.videos.length}{" "}
                        {a.videos.length === 1 ? t("video") : t("videos")}
                      </span>
                      {a.description ? (
                        <p className="w-full text-xs text-muted-foreground">
                          {a.description}
                        </p>
                      ) : null}
                    </div>
                    {/* A video grid, not a stack of documents. */}
                    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                      {a.videos.map((v) => (
                        <VideoCard key={v.id} video={v} timeZone={tz} />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </section>

        {isMobile && q.data && q.data.albums.length > 0 ? (
          <FilterFab
            testid="videos-filters-open"
            onClick={() => setSheetOpen(true)}
            label={`${shownCount} ${shownCount === 1 ? t("video") : t("videos")}`}
            count={activeFilters}
            icon={Film}
          />
        ) : null}

        <Dialog
          open={isMobile && sheetOpen}
          onOpenChange={setSheetOpen}
          variant="sheet"
          ariaLabel={t("Filter the videos")}
        >
          <div data-testid="videos-filter-sheet" className="flex flex-col gap-4">
            <span
              aria-hidden="true"
              className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
            />
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{t("Filters")}</h2>
              {activeFilters > 0 ? (
                <button
                  type="button"
                  data-testid="videos-sheet-reset"
                  onClick={() =>
                    setParam({ album: null, day: null, school: null, tag: null })
                  }
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
                >
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Reset")}
                </button>
              ) : null}
            </div>
            <Field label={t("Album")}>{albumChips}</Field>
            <Field label={t("Day")}>{daySelect}</Field>
            <Field label={t("School")}>{schoolSelect}</Field>
            {tagChips ? <Field label={t("Tags")}>{tagChips}</Field> : null}
            <Button
              data-testid="videos-sheet-apply"
              className="h-12 w-full text-base"
              onClick={() => setSheetOpen(false)}
            >
              {t("Show")} {shownCount}{" "}
              {shownCount === 1 ? t("video") : t("videos")}
            </Button>
          </div>
        </Dialog>
      </main>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
