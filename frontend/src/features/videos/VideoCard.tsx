import { useState } from "react";
import { Play } from "lucide-react";
import type { TournamentVideo } from "@/api/videos";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FacebookMark, InstagramMark, YoutubeMark } from "./BrandIcons";

/**
 * One event's footage.
 *
 * **The YouTube player loads on click, not on sight.** An album is a dozen
 * videos; a dozen live iframes would pull megabytes of YouTube script before a
 * viewer has chosen anything. Until then the card is the poster frame and a
 * play button — which is also what makes it work on a school's phone data.
 *
 * The other platforms are links, not players: Facebook and Instagram cannot be
 * embedded without their SDKs, and a viewer who follows a school there would
 * rather land in the app they already use.
 */
export function VideoCard({
  video,
}: {
  video: TournamentVideo;
}): React.ReactElement {
  const [playing, setPlaying] = useState(false);
  const id = video.youtube_id;
  const poster = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";

  return (
    <article
      data-testid={`video-${video.id}`}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="relative aspect-video w-full bg-muted">
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
              className="h-full w-full object-cover"
            />
            <span className="absolute inset-0 grid place-items-center bg-stage/25 transition-colors group-hover:bg-stage/40">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-card/95 shadow-lg transition-transform group-hover:scale-105">
                <Play
                  aria-hidden="true"
                  className="ml-0.5 h-6 w-6 fill-current text-foreground"
                />
              </span>
            </span>
          </button>
        ) : (
          /* No YouTube link: the entry still stands, it just cannot play here. */
          <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {t("Watch on the links below")}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="text-sm font-semibold leading-snug">{video.event}</h3>
        {video.note ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {video.note}
          </p>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {video.youtube_url ? (
            <PlatformLink
              href={video.youtube_url}
              label={t("Watch on YouTube")}
              testid={`video-yt-${video.id}`}
            >
              <YoutubeMark className="h-4 w-4" />
            </PlatformLink>
          ) : null}
          {video.facebook_url ? (
            <PlatformLink
              href={video.facebook_url}
              label={t("Watch on Facebook")}
              testid={`video-fb-${video.id}`}
            >
              <FacebookMark className="h-4 w-4" />
            </PlatformLink>
          ) : null}
          {video.instagram_url ? (
            <PlatformLink
              href={video.instagram_url}
              label={t("Watch on Instagram")}
              testid={`video-ig-${video.id}`}
            >
              <InstagramMark className="h-4 w-4" />
            </PlatformLink>
          ) : null}
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
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-border",
        "text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </a>
  );
}
