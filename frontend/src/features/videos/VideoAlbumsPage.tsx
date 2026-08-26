import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Plus, Trash2 } from "lucide-react";
import { ApiError } from "@/types/api";
import { videosApi, type VideoAlbum } from "@/api/videos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { VideoCard } from "./VideoCard";

/**
 * Host page: the video albums a tournament publishes.
 *
 * The platform hosts no video, so this page collects LINKS. A host uploads to
 * YouTube, Facebook or Instagram as they already do, then names the event here
 * and pastes wherever it landed. What they see is exactly what the public tab
 * shows, in the same card, so there is no "preview" to disagree with.
 */
export function VideoAlbumsPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [albumTitle, setAlbumTitle] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["video-albums", id],
    queryFn: () => videosApi.albums(id),
  });
  const canManage = q.data?.can_manage ?? false;
  const albums = q.data?.albums ?? [];

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["video-albums", id] });
    void qc.invalidateQueries({ queryKey: ["public-videos"] });
  };
  const fail = (e: unknown, title: string): void => {
    toast.push({
      kind: "error",
      title,
      description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
    });
  };

  const createAlbum = useMutation({
    mutationFn: () => videosApi.createAlbum(id, { title: albumTitle.trim() }),
    onSuccess: (a) => {
      setAlbumTitle("");
      setOpenId(a.id);
      refresh();
      toast.push({ kind: "success", title: t("Album created") });
    },
    onError: (e) => fail(e, t("Could not create the album")),
  });

  const removeAlbum = useMutation({
    mutationFn: (albumId: string) => videosApi.removeAlbum(id, albumId),
    onSuccess: () => {
      refresh();
      toast.push({ kind: "success", title: t("Album removed") });
    },
    onError: (e) => fail(e, t("Could not remove the album")),
  });

  const removeVideo = useMutation({
    mutationFn: (videoId: string) => videosApi.removeVideo(id, videoId),
    onSuccess: () => {
      refresh();
      toast.push({ kind: "success", title: t("Video removed") });
    },
    onError: (e) => fail(e, t("Could not remove the video")),
  });

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10">
          <Film aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0">
          <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t("Operations")}
          </p>
          <h2 className="text-lg font-semibold tracking-tight">{t("Videos")}</h2>
        </div>
        <p className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1">
          {t(
            "Upload to YouTube, Facebook or Instagram as you already do, then name the event here and paste the links.",
          )}
        </p>
      </div>

      {canManage ? (
        <section className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4 shadow-sm">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <span className="text-xs font-medium">{t("New album")}</span>
            <Input
              value={albumTitle}
              onChange={(e) => setAlbumTitle(e.target.value)}
              placeholder={t("Day 1, Finals, Highlights")}
              data-testid="album-title-input"
            />
          </label>
          <Button
            data-testid="create-album-btn"
            disabled={!albumTitle.trim() || createAlbum.isPending}
            onClick={() => createAlbum.mutate()}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("Create album")}
          </Button>
        </section>
      ) : null}

      {q.isLoading ? (
        <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
      ) : albums.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm font-medium">{t("No albums yet.")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Create one above, then add the events you filmed.")}
          </p>
        </div>
      ) : (
        albums.map((album) => (
          <AlbumPanel
            key={album.id}
            tournamentId={id}
            album={album}
            canManage={canManage}
            open={openId === album.id}
            onToggle={() => setOpenId(openId === album.id ? null : album.id)}
            onChanged={refresh}
            onRemoveAlbum={() => removeAlbum.mutate(album.id)}
            onRemoveVideo={(videoId) => removeVideo.mutate(videoId)}
            onError={fail}
          />
        ))
      )}
    </div>
  );
}

function AlbumPanel({
  tournamentId,
  album,
  canManage,
  open,
  onToggle,
  onChanged,
  onRemoveAlbum,
  onRemoveVideo,
  onError,
}: {
  tournamentId: string;
  album: VideoAlbum;
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onRemoveAlbum: () => void;
  onRemoveVideo: (videoId: string) => void;
  onError: (e: unknown, title: string) => void;
}): React.ReactElement {
  const toast = useToast();
  const [event, setEvent] = useState("");
  const [youtube, setYoutube] = useState("");
  const [facebook, setFacebook] = useState("");
  const [instagram, setInstagram] = useState("");

  const add = useMutation({
    mutationFn: () =>
      videosApi.addVideo(tournamentId, album.id, {
        event: event.trim(),
        youtube_url: youtube.trim(),
        facebook_url: facebook.trim(),
        instagram_url: instagram.trim(),
      }),
    onSuccess: () => {
      setEvent("");
      setYoutube("");
      setFacebook("");
      setInstagram("");
      onChanged();
      toast.push({ kind: "success", title: t("Video added") });
    },
    onError: (e) => onError(e, t("Could not add the video")),
  });

  const ready = event.trim() && (youtube.trim() || facebook.trim() || instagram.trim());

  return (
    <section
      data-testid={`album-${album.id}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{album.title}</h3>
        <span className="font-tabular text-xs text-muted-foreground">
          {album.video_count}{" "}
          {album.video_count === 1 ? t("video") : t("videos")}
        </span>
        {canManage ? (
          <span className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onToggle}
              data-testid={`album-add-toggle-${album.id}`}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t("Add video")}
            </Button>
            <button
              type="button"
              onClick={onRemoveAlbum}
              aria-label={`${t("Remove album")} ${album.title}`}
              data-testid={`album-remove-${album.id}`}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </span>
        ) : null}
      </header>

      {canManage && open ? (
        <div
          data-testid={`album-form-${album.id}`}
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("Event")} *</span>
            <Input
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              placeholder={t("U-14 Boys Final")}
              data-testid={`video-event-${album.id}`}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <LinkField
              label={t("YouTube link")}
              value={youtube}
              onChange={setYoutube}
              testid={`video-yt-input-${album.id}`}
            />
            <LinkField
              label={t("Facebook link")}
              value={facebook}
              onChange={setFacebook}
              testid={`video-fb-input-${album.id}`}
            />
            <LinkField
              label={t("Instagram link")}
              value={instagram}
              onChange={setInstagram}
              testid={`video-ig-input-${album.id}`}
            />
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            {t(
              "At least one link. The YouTube one plays on the page; the others open in their own app.",
            )}
          </p>
          <Button
            className="self-start"
            size="sm"
            disabled={!ready || add.isPending}
            onClick={() => add.mutate()}
            data-testid={`video-save-${album.id}`}
          >
            {add.isPending ? t("Adding") : t("Add video")}
          </Button>
        </div>
      ) : null}

      {album.videos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t("No videos in this album yet.")}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {album.videos.map((v) => (
            <div key={v.id} className="relative">
              <VideoCard video={v} />
              {canManage ? (
                <button
                  type="button"
                  onClick={() => onRemoveVideo(v.id)}
                  aria-label={`${t("Remove")} ${v.event}`}
                  data-testid={`video-remove-${v.id}`}
                  className={cn(
                    "absolute right-2 top-2 z-10 rounded-full bg-background/90 p-1.5",
                    "text-muted-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LinkField({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://"
        inputMode="url"
        data-testid={testid}
      />
    </label>
  );
}
