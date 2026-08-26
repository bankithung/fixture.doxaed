import { useState } from "react";
import { Play } from "lucide-react";
import type { TournamentVideo } from "@/api/videos";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FacebookMark, InstagramMark, YoutubeMark } from "./BrandIcons";

/**
 * One event's footage, sized like a video grid rather than a document.
 *
 * A card is a thumbnail with two lines under it — the shape every viewer
 * already reads on YouTube — so a dozen fit a screen instead of three (owner
 * 2026-08-26). No panel border: the picture is the object, and a frame around
 * every one turns a grid into a stack of documents.
 *
 * **The player loads on click, not on sight.** A dozen live iframes would pull
 * megabytes of YouTube script before a viewer has chosen anything, which a
 * school's phone data pays for.
 *
 * Facebook and Instagram are links, not players: neither embeds without its
 * SDK, and a viewer who follows a school there would rather land in the app.
 */
export function VideoCard({
  video,
  timeZone,
}: {
  video: TournamentVideo;
  timeZone?: string;
}): React.ReactElement {
  const [playing, setPlaying] = useState(false);
  const id = video.youtube_id;
  const poster = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
  const day = video.played_on
    ? new Date(`${video.played_on}T00:00:00Z`).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: timeZone || "UTC",
      })
    : "";
  const meta = [day, video.schools.map((s) => s.name).join(" v ")].filter(Boolean);

  return (
    <article data-testid={`video-${video.id}`} className="flex flex-col gap-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
        {id && playing ? (
          <iframe
            src={`https://www.youtube.com/embed/${id}?autoplay=1&rel=0`}
            title={video.event}
            data-testid={`video-frame-${video.id}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : id ? (
          <button
            type="button"
            data-testid={`video-play-${video.id}`}
            onClick={() => setPlaying(true)}
            aria-label={`${t("Play")} ${video.event}`}
            className="group absolute inset-0 h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <img
              src={poster}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            />
            <span className="absolute inset-0 grid place-items-center bg-stage/20 transition-colors group-hover:bg-stage/35">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-card/95 shadow-md transition-transform group-hover:scale-105">
                <Play
                  aria-hidden="true"
                  className="ml-0.5 h-5 w-5 fill-current text-foreground"
                />
              </span>
            </span>
          </button>
        ) : (
          <span className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-muted-foreground">
            {t("Watch on the links below")}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h3
          title={video.event}
          className="line-clamp-2 text-[0.9rem] font-medium leading-snug"
        >
          {video.event}
        </h3>
        {meta.length ? (
          <p className="truncate text-xs text-muted-foreground">
            {meta.join(" · ")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1">
          {video.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          <span className="ml-auto flex items-center gap-0.5">
            {video.youtube_url ? (
              <PlatformLink
                href={video.youtube_url}
                label={t("Watch on YouTube")}
                testid={`video-yt-${video.id}`}
              >
                <YoutubeMark className="h-3.5 w-3.5" />
              </PlatformLink>
            ) : null}
            {video.facebook_url ? (
              <PlatformLink
                href={video.facebook_url}
                label={t("Watch on Facebook")}
                testid={`video-fb-${video.id}`}
              >
                <FacebookMark className="h-3.5 w-3.5" />
              </PlatformLink>
            ) : null}
            {video.instagram_url ? (
              <PlatformLink
                href={video.instagram_url}
                label={t("Watch on Instagram")}
                testid={`video-ig-${video.id}`}
              >
                <InstagramMark className="h-3.5 w-3.5" />
              </PlatformLink>
            ) : null}
          </span>
        </div>
      </div>
    </article>
  );
}

function PlatformLink({
  href,
  label,
  testid,
  children,
}: {
  href: string;
  label: string;
  testid: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      data-testid={testid}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </a>
  );
}
