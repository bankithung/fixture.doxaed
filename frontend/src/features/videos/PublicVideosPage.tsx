import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { videosApi } from "@/api/videos";
import { PublicViewerHeader } from "@/features/live/PublicViewerHeader";
import { Chip } from "@/features/fixtures/publicTournamentViews";
import { t } from "@/lib/t";
import { VideoCard } from "./VideoCard";

/**
 * Public VIDEOS tab — the footage, wherever it was published.
 *
 * The platform hosts no video. A meet's footage is already on YouTube,
 * Facebook and Instagram by the evening, so this is the host's running order
 * over those links: the YouTube one plays in place, the other two are one tap
 * away in the app the viewer already uses.
 *
 * Albums ride the URL (`?album=`) so a school can share "Day 2" rather than
 * "scroll down".
 */
export function PublicVideosPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const q = useQuery({
    queryKey: ["public-videos", slug, id],
    queryFn: () => videosApi.publicVideos(slug, id),
    staleTime: 5 * 60_000,
  });

  const name = q.data?.tournament.name;
  useEffect(() => {
    if (name) document.title = `${name} · ${t("Videos")}`;
  }, [name]);

  const albums = useMemo(() => q.data?.albums ?? [], [q.data]);
  const picked = params.get("album") ?? "";
  const shown = albums.some((a) => a.id === picked)
    ? albums.filter((a) => a.id === picked)
    : albums;

  const setAlbum = (value: string | null): void => {
    const p = new URLSearchParams(params);
    if (value) p.set("album", value);
    else p.delete("album");
    setParams(p, { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={name}
        active="videos"
        connected={false}
      />
      <main className="flex w-full flex-1 flex-col px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
        <section className="flex w-full min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
                {t("Videos")}
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {q.data
                  ? `${q.data.totals.videos} ${
                      q.data.totals.videos === 1 ? t("video") : t("videos")
                    } · ${q.data.totals.albums} ${
                      q.data.totals.albums === 1 ? t("album") : t("albums")
                    }`
                  : t("Match footage from the meet")}
              </p>
            </div>
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
          ) : albums.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
              <Film aria-hidden="true" className="h-7 w-7 text-muted-foreground" />
              <p className="text-sm font-medium">{t("No videos yet.")}</p>
              <p className="text-xs text-muted-foreground">
                {t("Footage appears here as the host publishes it.")}
              </p>
            </div>
          ) : (
            <>
              {albums.length > 1 ? (
                <div
                  role="tablist"
                  aria-label={t("Albums")}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <Chip
                    testid="videos-album-all"
                    active={!picked}
                    onClick={() => setAlbum(null)}
                    label={t("All")}
                    count={q.data.totals.videos}
                  />
                  {albums.map((a) => (
                    <Chip
                      key={a.id}
                      testid={`videos-album-${a.id}`}
                      active={picked === a.id}
                      onClick={() => setAlbum(a.id)}
                      label={a.title}
                      count={a.video_count}
                    />
                  ))}
                </div>
              ) : null}

              {shown.map((album) => (
                <section
                  key={album.id}
                  data-testid={`video-album-${album.id}`}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2 border-b border-border pb-2">
                    <h2 className="text-sm font-semibold">{album.title}</h2>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {album.video_count}{" "}
                      {album.video_count === 1 ? t("video") : t("videos")}
                    </span>
                    {album.description ? (
                      <p className="w-full text-xs text-muted-foreground">
                        {album.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {album.videos.map((v) => (
                      <VideoCard key={v.id} video={v} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
