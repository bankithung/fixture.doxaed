import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Loader2,
  Trash2,
} from "lucide-react";
import { lensApi, type LensOwnPhoto } from "@/api/lens";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { compressImage } from "@/lib/compressImage";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";
import { Centered, PublicShell } from "@/features/registration/PublicShell";

type FileState = "waiting" | "uploading" | "done" | "error";

interface UploadItem {
  key: string;
  name: string;
  state: FileState;
  error?: string;
}

function uploadErr(e: unknown): string {
  const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
  switch (code) {
    case "quota_exceeded":
      return t("Your school reached its photo limit.");
    case "category_quota_exceeded":
      return t("Your school reached this category's photo limit.");
    case "unknown_category":
      return t("This category is no longer on the campaign. Reload the page.");
    case "file_too_large":
      return t("This file is too large (10 MB limit).");
    case "unsupported_type":
      return t("Only JPEG, PNG and WebP photos are accepted.");
    case "invalid_image":
      return t("This file is not a valid photo.");
    case "campaign_closed":
      return t("The campaign has closed.");
    default:
      return t("Upload failed. Check your connection and try again.");
  }
}

function ownStatusChip(status: LensOwnPhoto["status"]): React.ReactElement {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
        status === "approved" && "bg-primary/10 text-primary",
        status === "pending" && "bg-muted text-muted-foreground",
        status === "removed" && "bg-destructive/10 text-destructive",
      )}
    >
      {status === "approved"
        ? t("In album")
        : status === "pending"
          ? t("Pending review")
          : t("Removed")}
    </span>
  );
}

/**
 * The page a Guest Lens QR pass card opens: no login, mobile-first, the
 * teacher in charge uploads the school's photos from their own phone
 * (spec 2026-07-10 §4.3). Uploads run sequentially with a visible per-file
 * state list, never a single busy boolean.
 */
export function LensUploadPage(): React.ReactElement {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [deleteRef, setDeleteRef] = useState<string | null>(null);
  // "" = no category picked yet (campaigns without categories stay on "").
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  const q = useQuery({
    queryKey: qk.lensPass(token),
    queryFn: () => lensApi.passContext(token),
    enabled: Boolean(token),
    retry: false,
  });

  if (q.isLoading) {
    return (
      <PublicShell>
        <div className="mx-auto w-full max-w-3xl px-4 py-8">
          <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
        </div>
      </PublicShell>
    );
  }
  if (q.isError || !q.data) {
    return (
      <PublicShell>
        <Centered>
          <Camera aria-hidden="true" className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="mt-3 text-lg font-semibold">
            {t("This link is not valid")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("The QR card may have been replaced. Ask the organizers for a new one.")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  const ctx = q.data;
  const used = ctx.quota.used;
  const max = ctx.quota.max;
  const remaining = Math.max(0, max - used);
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;

  const categories = ctx.campaign.award_categories ?? [];
  const limits = ctx.campaign.category_limits ?? {};
  const byCategory = ctx.quota.by_category ?? {};
  const category = selectedCat ?? categories[0] ?? "";
  const catLimit = category ? limits[category] : undefined;
  const catUsed = category ? (byCategory[category] ?? 0) : 0;
  const catRemaining =
    catLimit === undefined ? Infinity : Math.max(0, catLimit - catUsed);
  // What the picker can actually accept right now: the overall cap and, when
  // the selected category has its own limit, that category's cap too.
  const effectiveRemaining = Math.min(remaining, catRemaining);

  const setItem = (key: string, patch: Partial<UploadItem>): void => {
    setItems((cur) =>
      cur.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );
  };

  const startUpload = async (selected: File[]): Promise<void> => {
    let files = selected;
    if (files.length > effectiveRemaining) {
      files = files.slice(0, effectiveRemaining);
      push({
        kind: "info",
        title: t("Some photos were skipped"),
        description:
          effectiveRemaining === catRemaining && catRemaining < remaining
            ? t("This category's photo limit allows fewer photos than you picked.")
            : t("Your school's photo limit allows fewer photos than you picked."),
      });
    }
    if (files.length === 0) return;
    const batch: UploadItem[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      name: f.name,
      state: "waiting",
    }));
    setItems(batch);
    setRunning(true);
    // Sequential on purpose: school connections choke on parallel uploads,
    // and the per-file list stays honest about what is actually in flight.
    for (let i = 0; i < files.length; i += 1) {
      const key = batch[i].key;
      setItem(key, { state: "uploading" });
      try {
        const compact = await compressImage(files[i], { preferJpeg: true });
        const fd = new FormData();
        fd.append("file", compact, compact.name);
        if (category) fd.append("category", category);
        fd.append("event_id", newEventId());
        await lensApi.upload(token, fd);
        setItem(key, { state: "done" });
      } catch (e) {
        setItem(key, { state: "error", error: uploadErr(e) });
      }
    }
    setRunning(false);
    if (inputRef.current) inputRef.current.value = "";
    void qc.invalidateQueries({ queryKey: qk.lensPass(token) });
  };

  const removePhoto = async (uploadRef: string): Promise<void> => {
    try {
      await lensApi.removeOwn(token, uploadRef);
      push({ kind: "success", title: t("Photo removed") });
      void qc.invalidateQueries({ queryKey: qk.lensPass(token) });
    } catch (e) {
      const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
      push({
        kind: "error",
        title:
          code === "photo_locked"
            ? t("This photo is already in review and cannot be removed.")
            : t("Could not remove the photo."),
      });
    } finally {
      setDeleteRef(null);
    }
  };

  return (
    <PublicShell tournamentName={ctx.tournament.name}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">{ctx.campaign.title}</h1>
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {ctx.institution.name}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {ctx.campaign.tagline} · {ctx.tournament.name}
          </p>
        </header>

        {/* Quota band. */}
        <section className="panel p-3" data-testid="quota-band">
          <p className="font-tabular text-sm font-semibold">
            {used} {t("of")} {max} {t("photos used")}
          </p>
          <div
            role="progressbar"
            aria-valuenow={used}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-label={t("Photos used")}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${pct}%` }}
            />
          </div>
        </section>

        <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-snug text-muted-foreground">
          {ctx.campaign.consent_note}
        </p>

        {ctx.campaign.is_open ? (
          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">{t("Upload photos")}</h2>
            </div>
            <div className="flex flex-col gap-3 p-3">
              <p className="text-xs text-muted-foreground">
                {ctx.campaign.instructions}
              </p>
              {categories.length > 0 ? (
                <div
                  className="flex flex-col gap-1.5"
                  data-testid="category-picker"
                >
                  <span className="text-xs font-medium">
                    {t("Uploading to")}
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={t("Photo category")}
                    className="flex flex-wrap gap-1.5"
                  >
                    {categories.map((cat) => {
                      const capN = limits[cat];
                      const usedN = byCategory[cat] ?? 0;
                      const full = capN !== undefined && usedN >= capN;
                      return (
                        <button
                          key={cat}
                          type="button"
                          role="radio"
                          aria-checked={category === cat}
                          data-testid={`category-${cat}`}
                          disabled={running}
                          onClick={() => setSelectedCat(cat)}
                          className={cn(
                            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                            category === cat
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:text-foreground",
                            full && "opacity-60",
                          )}
                        >
                          {cat}
                          {capN !== undefined ? (
                            <span className="font-tabular">
                              {usedN}/{capN}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  {catLimit !== undefined && catRemaining === 0 ? (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="category-full-hint"
                    >
                      {t("This category is full for your school. Pick another one.")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <input
                ref={inputRef}
                id="lens-file-input"
                data-testid="file-input"
                type="file"
                accept="image/*"
                multiple
                disabled={running || effectiveRemaining === 0}
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) void startUpload(files);
                }}
              />
              <label htmlFor="lens-file-input">
                <span
                  className={cn(
                    "inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover",
                    (running || effectiveRemaining === 0) &&
                      "pointer-events-none opacity-50",
                  )}
                >
                  <Camera aria-hidden="true" className="h-4 w-4" />
                  {remaining === 0
                    ? t("Photo limit reached")
                    : effectiveRemaining === 0
                      ? t("Category limit reached")
                      : running
                        ? t("Uploading")
                        : t("Choose photos")}
                </span>
              </label>
              {items.length > 0 ? (
                <ul className="flex flex-col gap-1" data-testid="upload-list">
                  {items.map((it) => (
                    <li
                      key={it.key}
                      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      {it.state === "uploading" ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                        />
                      ) : it.state === "done" ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-success"
                        />
                      ) : it.state === "error" ? (
                        <AlertTriangle
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-destructive"
                        />
                      ) : (
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{it.name}</span>
                      <span
                        className={cn(
                          "shrink-0",
                          it.state === "error"
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {it.state === "done"
                          ? t("Uploaded")
                          : it.state === "uploading"
                            ? t("Uploading")
                            : it.state === "error"
                              ? it.error
                              : t("Waiting")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        ) : (
          <section
            className="panel p-4 text-center"
            data-testid="closed-state"
          >
            <h2 className="text-base font-semibold">
              {t("Uploads have closed")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("Thanks for taking part. Your photos below stay with the organizers.")}
            </p>
          </section>
        )}

        {/* My photos. */}
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">{t("Your photos")}</h2>
            <span className="font-tabular text-xs text-muted-foreground">
              {ctx.photos.length}
            </span>
          </div>
          {ctx.photos.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("Nothing uploaded yet. Your photos will show here.")}
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-4">
              {ctx.photos.map((p) => (
                <li
                  key={p.upload_ref}
                  className="relative flex flex-col gap-1"
                  data-testid={`own-photo-${p.upload_ref}`}
                >
                  <img
                    src={p.thumb_url}
                    alt={p.caption || t("Uploaded photo")}
                    loading="lazy"
                    className="aspect-square w-full rounded-md border border-border object-cover"
                  />
                  {p.category ? (
                    <p className="truncate text-[0.625rem] text-muted-foreground">
                      {p.category}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between gap-1">
                    {ownStatusChip(p.status)}
                    {ctx.campaign.is_open && p.status === "pending" ? (
                      <button
                        type="button"
                        aria-label={t("Remove this photo")}
                        data-testid={`delete-${p.upload_ref}`}
                        onClick={() => setDeleteRef(p.upload_ref)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog
        open={deleteRef !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteRef(null);
        }}
        ariaLabel={t("Remove photo")}
        variant="sheet"
      >
        <DialogHeader>
          <DialogTitle>{t("Remove this photo?")}</DialogTitle>
          <DialogDescription>
            {t("It frees one slot of your school's photo limit.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteRef(null)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-btn"
            onClick={() => {
              if (deleteRef) void removePhoto(deleteRef);
            }}
          >
            {t("Remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </PublicShell>
  );
}
