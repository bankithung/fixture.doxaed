import { useEffect, useMemo, useReducer, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Award,
  Check,
  Copy,
  EyeOff,
  KeyRound,
  Link2,
  ListOrdered,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { JudgingPanel } from "./judging/JudgingPanel";
import {
  lensApi,
  type LensCampaign,
  type LensCode,
  type LensPhoto,
  type LensSettingsBody,
} from "@/api/lens";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { ApiError } from "@/types/api";
import { AwardRankBoard } from "./AwardRankBoard";
import { ShareCardStrip } from "./PassPrintSheet";

type TabKey = "campaign" | "cards" | "moderate" | "judging" | "awards";

/** A device-cached issued code plus the rotation stamp that keeps it honest:
 * when the pass row's code_set_at moves, this copy stops being shown. */
type CachedCode = LensCode & { set_at: string | null };

const DEFAULT_CATEGORIES = [
  "Best Team Spirit",
  "Best Sportsmanship Moment",
  "Best Action Shot",
  "Best Fun Fair Moment",
  "Best Visiting School POV",
];

const DEFAULT_INSTRUCTIONS =
  "Scan your school's QR card and upload your best photos from the event. The teacher in charge holds the card; everyone's photos count toward one shared album.";
const DEFAULT_CONSENT =
  "Selected photos may be used by the host for event highlights and social media. Please upload only appropriate event photos.";

/** Map backend string-codes to a human toast message. */
function errMsg(e: unknown): string {
  const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
  switch (code) {
    case "fixtures_not_generated":
      return t("Generate the fixtures first, then open the campaign.");
    case "unknown_category":
      return t("That award category is not on this campaign.");
    case "not_approved":
      return t("Only approved photos can win an award.");
    case "campaign_closed":
      return t("The campaign is closed.");
    default:
      return t("Something went wrong. Please try again.");
  }
}

interface SettingsDraft {
  title: string;
  tagline: string;
  instructions: string;
  consent_note: string;
  max_photos_per_institution: number;
  award_categories: string[];
  category_limits: Record<string, number>;
  story_categories: string[];
  story_photos_per_entry: number;
}

function draftFrom(c: LensCampaign | null): SettingsDraft {
  return {
    title: c?.title ?? "Guest Lens",
    tagline: c?.tagline ?? "36 Shots Challenge",
    instructions: c?.instructions ?? DEFAULT_INSTRUCTIONS,
    consent_note: c?.consent_note ?? DEFAULT_CONSENT,
    max_photos_per_institution: c?.max_photos_per_institution ?? 36,
    award_categories: c?.award_categories ?? DEFAULT_CATEGORIES,
    category_limits: c?.category_limits ?? {},
    story_categories: c?.story_categories ?? [],
    story_photos_per_entry: c?.story_photos_per_entry ?? 4,
  };
}

const FIELD =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const AREA =
  "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Compact campaign-settings form (pre-open hero + Campaign tab share it). */
function SettingsFields({
  draft,
  onChange,
}: {
  draft: SettingsDraft;
  onChange: (d: SettingsDraft) => void;
}): React.ReactElement {
  const [newCat, setNewCat] = useState("");
  const addCategory = (): void => {
    const v = newCat.trim();
    if (!v || draft.award_categories.includes(v)) return;
    onChange({ ...draft, award_categories: [...draft.award_categories, v] });
    setNewCat("");
  };
  const removeCategory = (cat: string): void => {
    const limits = { ...draft.category_limits };
    delete limits[cat];
    onChange({
      ...draft,
      award_categories: draft.award_categories.filter((c) => c !== cat),
      category_limits: limits,
      // A removed category cannot remain a story format either.
      story_categories: draft.story_categories.filter((c) => c !== cat),
    });
  };
  const setLimit = (cat: string, raw: string): void => {
    const limits = { ...draft.category_limits };
    if (raw === "") {
      delete limits[cat];
    } else {
      limits[cat] = Math.min(500, Math.max(1, Number(raw) || 1));
    }
    onChange({ ...draft, category_limits: limits });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lens-title">{t("Campaign title")}</Label>
          <Input
            id="lens-title"
            className="h-9"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lens-tagline">{t("Tagline")}</Label>
          <Input
            id="lens-tagline"
            className="h-9"
            value={draft.tagline}
            onChange={(e) => onChange({ ...draft, tagline: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-cap">{t("Photos per school")}</Label>
        <input
          id="lens-cap"
          type="number"
          min={1}
          max={500}
          className={cn(FIELD, "max-w-32 font-tabular")}
          value={draft.max_photos_per_institution}
          onChange={(e) =>
            onChange({
              ...draft,
              max_photos_per_institution: Math.max(
                1,
                Number(e.target.value) || 1,
              ),
            })
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t("Categories")}</span>
        <p className="text-xs text-muted-foreground">
          {t("Schools pick a category for each upload. Set a per school photo limit for a category, or leave it blank for no limit.")}
        </p>
        {draft.story_categories.length > 0 ? (
          <div className="flex items-end gap-2 rounded-md bg-muted px-2.5 py-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="lens-story-cap" className="text-xs">
                {t("Photographs per photo story")}
              </Label>
              <input
                id="lens-story-cap"
                type="number"
                min={1}
                max={12}
                data-testid="story-frame-cap"
                className={cn(FIELD, "w-24 font-tabular")}
                value={draft.story_photos_per_entry}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    story_photos_per_entry: Math.min(
                      12,
                      Math.max(1, Number(e.target.value) || 1),
                    ),
                  })
                }
              />
            </div>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t(
                "Marked categories accept ONE titled photo story per school instead of separate photos.",
              )}
            </p>
          </div>
        ) : null}
        {draft.award_categories.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {draft.award_categories.map((cat) => (
              <li
                key={cat}
                className="flex items-center gap-2 px-2.5 py-1.5"
                data-testid={`category-row-${cat}`}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{cat}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  placeholder={t("No limit")}
                  aria-label={`${t("Photo limit per school for")} ${cat}`}
                  data-testid={`limit-${cat}`}
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right font-tabular text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.category_limits[cat] ?? ""}
                  onChange={(e) => setLimit(cat, e.target.value)}
                />
                <label
                  className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                  title={t(
                    "A photo-story entry: one titled set of photographs per school, judged together",
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                    aria-label={`${t("Photo story entry")} ${cat}`}
                    data-testid={`story-${cat}`}
                    checked={draft.story_categories.includes(cat)}
                    onChange={(e) =>
                      onChange({
                        ...draft,
                        story_categories: e.target.checked
                          ? [...draft.story_categories, cat]
                          : draft.story_categories.filter((c) => c !== cat),
                      })
                    }
                  />
                  {t("Story")}
                </label>
                <button
                  type="button"
                  aria-label={`${t("Remove category")} ${cat}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  onClick={() => removeCategory(cat)}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            className="h-9 max-w-64"
            placeholder={t("Add a category")}
            aria-label={t("New award category")}
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCategory();
              }
            }}
          />
          <Button variant="outline" size="sm" onClick={addCategory}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Add")}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-instructions">{t("Instructions on the card")}</Label>
        <textarea
          id="lens-instructions"
          className={AREA}
          value={draft.instructions}
          onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-consent">{t("Consent note")}</Label>
        <textarea
          id="lens-consent"
          className={AREA}
          value={draft.consent_note}
          onChange={(e) => onChange({ ...draft, consent_note: e.target.value })}
        />
      </div>
    </div>
  );
}

function statusChip(photo: {
  status: LensPhoto["status"];
}): React.ReactElement {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
        photo.status === "approved" && "bg-primary/10 text-primary",
        photo.status === "pending" && "bg-muted text-muted-foreground",
        photo.status === "hidden" && "bg-destructive/10 text-destructive",
      )}
    >
      {photo.status === "approved"
        ? t("In album")
        : photo.status === "pending"
          ? t("Pending")
          : t("Hidden")}
    </span>
  );
}

/** One school's code in the table: the value while this session still holds
 * it, otherwise only whether one exists. Regenerating is how you get a
 * forgotten code back — the server cannot tell you the old one. */
function CodeCell({
  code,
  hasCode,
  onCopy,
}: {
  code: string;
  hasCode: boolean;
  onCopy: (code: string) => void;
}): React.ReactElement {
  if (code) {
    return (
      <button
        type="button"
        onClick={() => onCopy(code)}
        data-testid={`copy-code-${code}`}
        title={t("Copy code")}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 font-tabular text-sm tracking-[0.14em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {code}
        <Copy aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
      </button>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {hasCode ? t("Set") : t("Not set")}
    </span>
  );
}

/**
 * Guest Lens manager console: Campaign settings, the event's one printable
 * QR card and the per-school codes behind it,
 * moderation grid, and award winners (spec 2026-07-10 §4.2). Manager-only
 * route under /tournaments/:id/lens.
 */
export function LensConsolePage(): React.ReactElement {
  const { id = "", campaignId = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const { isMobile } = useBreakpoint();

  // Land on the operational view, not the settings form: a running campaign
  // opens on Moderate (the photos actually needing attention); a fresh one with
  // no cards yet opens on Cards (the setup step). Settings is a tab you visit,
  // not the front page. `null` = "use the derived default"; a click pins it.
  const [tabState, setTab] = useState<TabKey | null>(null);

  // The device cache IS the one code list now; this tick just tells the
  // derived memo to re-read it after a mutation writes to it.
  const [codeCacheTick, bumpCodeCache] = useReducer((x: number) => x + 1, 0);
  const [confirm, setConfirm] = useState<
    | { kind: "close" }
    | { kind: "reopen" }
    | { kind: "rotate"; passId: string; name: string }
    | { kind: "revoke"; passId: string; name: string }
    | { kind: "reissue-all"; count: number }
    | { kind: "new-card" }
    | { kind: "delete-photo"; photoId: string }
    | null
  >(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [instFilter, setInstFilter] = useState<string>("");
  const [catFilter, setCatFilter] = useState<string>("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  // The hide-with-reason dialog serves both surfaces: single photos and whole
  // photo-story entries (a story hides as ONE unit, frames quarantined with it).
  const [hideTarget, setHideTarget] = useState<{
    kind: "photo" | "story";
    id: string;
  } | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [pickCategory, setPickCategory] = useState<string | null>(null);
  /** Judging one prize by ranking; null = the awards overview. */
  const [rankCategory, setRankCategory] = useState<string | null>(null);

  const overviewQ = useQuery({
    queryKey: [...qk.lens(id), campaignId],
    queryFn: () => lensApi.overview(id, campaignId),
    enabled: Boolean(id && campaignId),
  });
  const tournamentQ = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
    enabled: Boolean(id),
  });
  const campaign = overviewQ.data?.campaign ?? null;
  /** When the card in use was minted; null = none has ever been made. */
  const mintedAt = campaign?.share_minted_at ?? null;

  // The card IN USE, from the server (Fernet-encrypted at rest, decrypted
  // only through the manager-gated GET) — so the SAME poster survives any
  // refresh and any device. No more one-time reveal, no local cache.
  const shareCardQ = useQuery({
    queryKey: [...qk.lens(id), "share-card", campaignId],
    queryFn: () => lensApi.currentShareCard(id, campaignId),
    enabled: Boolean(campaignId && mintedAt),
    staleTime: Infinity,
  });
  const shareCard = shareCardQ.data?.card ?? null;
  // Derived default landing tab (see the tabState comment above).
  const defaultTab: TabKey =
    (overviewQ.data?.stats.passes_active ?? 0) > 0 ? "moderate" : "cards";
  const tab = tabState ?? defaultTab;

  const codedCount = (overviewQ.data?.passes ?? []).filter(
    (p) => p.has_code,
  ).length;
  // Schools missing a code are BOTH kinds: invited but not yet coded, AND
  // schools that registered after the last issue and have no card at all
  // (issue_codes creates their pass rows). Counting only existing rows made
  // the very first Generate read as "nothing to do" and locked the button
  // precisely when no school could sign in (owner 2026-08-24).
  const institutionsTotal = overviewQ.data?.stats.institutions_total ?? 0;
  const passRows = (overviewQ.data?.passes ?? []).length;
  const notInvited = Math.max(0, institutionsTotal - passRows);
  const missingCodes =
    notInvited +
    (overviewQ.data?.passes ?? []).filter((p) => !p.has_code).length;
  const copyCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      push({ kind: "success", title: t("Code copied") });
    } catch {
      push({ kind: "error", title: t("Could not copy the code") });
    }
  };

  const photosQ = useQuery({
    queryKey: [...qk.lensPhotos(id), campaignId, statusFilter, instFilter, catFilter],
    queryFn: () =>
      lensApi.photos(id, campaignId, {
        status: statusFilter || undefined,
        institution_id: instFilter || undefined,
        category: catFilter || undefined,
      }),
    enabled: Boolean(id && campaignId) && campaign !== null,
  });
  const approvedQ = useQuery({
    queryKey: [...qk.lensPhotos(id), campaignId, "approved", ""],
    queryFn: () => lensApi.photos(id, campaignId, { status: "approved" }),
    enabled: Boolean(id && campaignId) && campaign !== null && tab === "awards",
  });
  const photos = useMemo(() => photosQ.data?.photos ?? [], [photosQ.data]);
  const approvedPhotos = approvedQ.data?.photos ?? [];
  // Approved photos still carrying an award_category the manager later removed
  // from the campaign: without a panel these prizes are unclearable (and keep
  // showing on the public album), so surface them with a Clear action.
  const orphanAwards = approvedPhotos.filter(
    (p) =>
      p.award_category &&
      !(campaign?.award_categories ?? []).includes(p.award_category),
  );

  // Photo-story entries moderate and award at ENTRY level (one unit), never
  // frame by frame.
  const storiesQ = useQuery({
    queryKey: qk.lensStories(id),
    queryFn: () => lensApi.stories(id, campaignId, { status: statusFilter }),
    enabled: Boolean(campaignId && (campaign?.story_categories ?? []).length > 0),
  });
  const stories = storiesQ.data?.stories ?? [];

  // The settings form starts from the campaign (or the defaults pre-open) and
  // only becomes local state once the manager edits something — no effect
  // needed to sync it after a refetch.
  const [draftEdits, setDraft] = useState<SettingsDraft | null>(null);
  const draft = draftEdits ?? draftFrom(campaign);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: qk.lens(id) });
    void qc.invalidateQueries({ queryKey: qk.lensPhotos(id) });
    void qc.invalidateQueries({ queryKey: qk.lensStories(id) });
    void qc.invalidateQueries({
      queryKey: [...qk.lens(id), "share-card", campaignId],
    });
  };
  const fail = (e: unknown): void => {
    push({ kind: "error", title: errMsg(e) });
  };

  const updateM = useMutation({
    mutationFn: (body: LensSettingsBody) =>
      lensApi.update(id, campaignId, { ...body, event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Settings saved") });
    },
    onError: fail,
  });
  const closeM = useMutation({
    mutationFn: () => lensApi.close(id, campaignId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Campaign closed") });
    },
    onError: fail,
  });
  const reopenM = useMutation({
    mutationFn: () => lensApi.reopen(id, campaignId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Campaign reopened") });
    },
    onError: fail,
  });
  const shareCardM = useMutation({
    mutationFn: () =>
      lensApi.shareCard(id, campaignId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Card ready") });
    },
    onError: fail,
  });
  const issueM = useMutation({
    mutationFn: (institutionIds?: string[]) =>
      lensApi.issueCodes(id, campaignId, {
        event_id: newEventId(),
        ...(institutionIds ? { institution_ids: institutionIds } : {}),
      }),
    onSuccess: (res) => {
      invalidate();
      // Merge, never replace: a manager who issues for newcomers must not lose
      // the codes still on screen from the first run — and this device keeps
      // them readable afterwards (hash at rest server-side; the cache is the
      // one honest copy, dropped automatically when a code is rotated).
      try {
        const key = `lens:codes:${campaignId}`;
        const prev = JSON.parse(localStorage.getItem(key) ?? "[]") as CachedCode[];
        localStorage.setItem(
          key,
          JSON.stringify([
            ...prev.filter((c) => !res.codes.some((n) => n.pass_id === c.pass_id)),
            ...res.codes.map((c) => ({ ...c, set_at: null })),
          ]),
        );
      } catch {
        /* private mode: codes stay on screen for this visit */
      }
      bumpCodeCache();
      push({
        kind: "success",
        title: res.codes.length
          ? t("Codes generated")
          : t("Every school already has a code"),
      });
    },
    onError: fail,
  });
  const rotateM = useMutation({
    mutationFn: (passId: string) =>
      lensApi.rotate(id, passId, { event_id: newEventId() }),
    onSuccess: (res) => {
      invalidate();
      try {
        const key = `lens:codes:${campaignId}`;
        const prev = JSON.parse(localStorage.getItem(key) ?? "[]") as CachedCode[];
        localStorage.setItem(
          key,
          JSON.stringify([
            { ...res.code, set_at: null },
            ...prev.filter((c) => c.pass_id !== res.code.pass_id),
          ]),
        );
      } catch {
        /* ignore */
      }
      bumpCodeCache();
      push({ kind: "success", title: t("Code regenerated") });
    },
    onError: fail,
  });
  const revokeM = useMutation({
    mutationFn: (passId: string) =>
      lensApi.revoke(id, passId, { event_id: newEventId() }),
    onSuccess: (_res, passId) => {
      invalidate();
      try {
        const key = `lens:codes:${campaignId}`;
        const prev = JSON.parse(localStorage.getItem(key) ?? "[]") as CachedCode[];
        localStorage.setItem(
          key,
          JSON.stringify(prev.filter((c) => c.pass_id !== passId)),
        );
      } catch {
        /* ignore */
      }
      bumpCodeCache();
      push({ kind: "success", title: t("School removed from the album") });
    },
    onError: fail,
  });
  const approveM = useMutation({
    mutationFn: (photoId: string) =>
      lensApi.approve(id, photoId, { event_id: newEventId() }),
    onSuccess: (_res, photoId) => {
      // Keep the moderator moving: the approved photo drops out of the Pending
      // grid on refetch, so advance the lightbox to the next item instead of
      // letting it close, so the queue can be cleared without reopening each.
      setLightbox((cur) => {
        if (cur !== photoId) return cur;
        const idx = photos.findIndex((p) => p.id === photoId);
        if (idx < 0) return null;
        const next = photos[idx + 1] ?? photos[idx - 1] ?? null;
        return next ? next.id : null;
      });
      invalidate();
      push({ kind: "success", title: t("Photo approved") });
    },
    onError: fail,
  });
  const hideM = useMutation({
    mutationFn: (vars: { photoId: string; reason: string }) =>
      lensApi.hide(id, vars.photoId, {
        event_id: newEventId(),
        reason: vars.reason || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setHideTarget(null);
      setHideReason("");
      setLightbox(null);
      push({ kind: "success", title: t("Photo hidden") });
    },
    onError: fail,
  });
  const deleteM = useMutation({
    mutationFn: (photoId: string) =>
      lensApi.remove(id, photoId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      setLightbox(null);
      push({ kind: "success", title: t("Photo deleted") });
    },
    onError: fail,
  });
  const awardM = useMutation({
    mutationFn: (vars: { photoId: string; category: string }) =>
      lensApi.award(id, vars.photoId, {
        event_id: newEventId(),
        category: vars.category,
      }),
    onSuccess: (_res, vars) => {
      invalidate();
      setPickCategory(null);
      push({
        kind: "success",
        title: vars.category ? t("Winner chosen") : t("Award cleared"),
      });
    },
    onError: fail,
  });
  const approveStoryM = useMutation({
    mutationFn: (storyId: string) =>
      lensApi.approveStory(id, storyId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Story approved") });
    },
    onError: fail,
  });
  const hideStoryM = useMutation({
    mutationFn: (vars: { storyId: string; reason: string }) =>
      lensApi.hideStory(id, vars.storyId, {
        event_id: newEventId(),
        reason: vars.reason || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setHideTarget(null);
      setHideReason("");
      push({ kind: "success", title: t("Story hidden") });
    },
    onError: fail,
  });
  const awardStoryM = useMutation({
    mutationFn: (vars: { storyId: string; category: string }) =>
      lensApi.awardStory(id, vars.storyId, {
        event_id: newEventId(),
        category: vars.category,
      }),
    onSuccess: () => {
      invalidate();
      push({
        kind: "success",
        title: t("Winner chosen"),
      });
    },
    onError: fail,
  });

  const lightboxIdx = photos.findIndex((p) => p.id === lightbox);
  const lightboxPhoto = lightboxIdx >= 0 ? photos[lightboxIdx] : null;

  // Winner picker: photos filed under the category are the natural entries;
  // when none exist (older uploads carry no category) fall back to all
  // approved photos so a winner can still be chosen.
  const inCategory = pickCategory
    ? approvedPhotos.filter((p) => p.category === pickCategory)
    : [];
  const pickable = inCategory.length > 0 ? inCategory : approvedPhotos;

  // Lightbox prev/next on arrow keys while it is open.
  useEffect(() => {
    if (!lightboxPhoto) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" && lightboxIdx < photos.length - 1) {
        setLightbox(photos[lightboxIdx + 1].id);
      }
      if (e.key === "ArrowLeft" && lightboxIdx > 0) {
        setLightbox(photos[lightboxIdx - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxPhoto, lightboxIdx, photos]);

  
  // The ONE code list: every entry this device has issued or rotated whose
  // stamp still matches the pass row's code_set_at. A regenerated or rotated
  // code changes that timestamp, so its stale twin disappears instead of
  // sending a teacher to a lockout with a dead code.
  const visibleCodes = useMemo(() => {
    void codeCacheTick;
    const byPass = new Map(
      (overviewQ.data?.passes ?? []).map((p) => [p.id, p]),
    );
    let cached: CachedCode[] = [];
    try {
      cached = JSON.parse(
        localStorage.getItem(`lens:codes:${campaignId}`) ?? "[]",
      ) as CachedCode[];
    } catch {
      cached = [];
    }
    const valid: LensCode[] = [];
    for (const c of cached) {
      const pass = byPass.get(c.pass_id);
      if (!pass || !pass.has_code) continue;
      if (c.set_at === null || c.set_at === pass.code_set_at) valid.push(c);
    }
    return valid;
  }, [codeCacheTick, overviewQ.data?.passes, campaignId]);
  const codeFor = (passId: string): string =>
    visibleCodes.find((c) => c.pass_id === passId)?.code ?? "";

  // Stamp fresh entries with their pass's code_set_at and prune anything
  // rotated or revoked (external-system writes only, never setState).
  useEffect(() => {
    // No overview yet = an EMPTY pass list, not a rotated one; pruning now
    // would wipe the cache before the real rows arrive.
    if (!overviewQ.data) return;
    const key = `lens:codes:${campaignId}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const cached = JSON.parse(raw) as CachedCode[];
      const byPass = new Map(
        (overviewQ.data?.passes ?? []).map((p) => [p.id, p]),
      );
      const kept: CachedCode[] = [];
      let changed = false;
      for (const c of cached) {
        const pass = byPass.get(c.pass_id);
        // Revoked or removed school: the copy dies with its pass row.
        if (!pass || !pass.has_code) {
          changed = true;
          continue;
        }
        if (c.set_at === null && pass.code_set_at !== null) {
          kept.push({ ...c, set_at: pass.code_set_at });
          changed = true;
        } else {
          kept.push(c);
        }
      }
      if (changed || kept.length !== cached.length)
        localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      /* ignore */
    }
  }, [overviewQ.data?.passes, campaignId]);

  const slug = tournamentQ.data?.slug ?? "";
  const copyAlbumLink = async (): Promise<void> => {
    if (!slug) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${routes.publicAlbum(slug, id, campaignId)}`,
      );
      push({ kind: "success", title: t("Album link copied") });
    } catch {
      push({ kind: "error", title: t("Could not copy the link") });
    }
  };

  if (overviewQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (overviewQ.isError || !overviewQ.data) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("The Guest Lens overview could not be loaded.")}
        </p>
      </div>
    );
  }
  const overview = overviewQ.data;
  const stats = overview.stats;

  // ---- The campaign in the URL no longer exists (deleted / bad link). ----
  if (!campaign) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="page-title">{t("Guest Lens")}</h1>
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-sm font-medium">{t("This campaign was not found.")}</p>
          <Link
            to={routes.tournamentLens(id)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t("Back to campaigns")}
          </Link>
        </section>
      </div>
    );
  }

  // ---- Open campaign: tabbed console. Operational tabs lead; Settings is
  // last (it's configure-once, not the front page). ----
  const TABS: { key: TabKey; label: string }[] = [
    { key: "moderate", label: t("Moderate") },
    { key: "cards", label: t("Cards") },
    { key: "judging", label: t("Judging") },
    { key: "awards", label: t("Awards") },
    { key: "campaign", label: t("Settings") },
  ];
  const statCells: { label: string; value: number }[] = [
    { label: t("Schools"), value: stats.institutions_total },
    { label: t("Active cards"), value: stats.passes_active },
    { label: t("Photos"), value: stats.photos_total },
    { label: t("Pending"), value: stats.photos_pending },
    { label: t("Approved"), value: stats.photos_approved },
    { label: t("Hidden"), value: stats.photos_hidden },
  ];
  const instOptions = [
    { value: "", label: t("All schools") },
    ...overview.passes.map((p) => ({
      value: p.institution_id,
      label: p.institution_name,
    })),
  ];
  const catOptions = [
    { value: "", label: t("All categories") },
    ...campaign.award_categories.map((c) => ({ value: c, label: c })),
  ];

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* ONE combined panel (owner 2026-08-25): the back button, title, the
          printable card, stats, tabs and every tab's content are sections of
          a single surface — nothing floats between cards any more. Print
          still gets ONLY the poster: every screen-only band is print:hidden
          and PassPrintSheet owns its own ink-safe output. */}
      <section className="panel" data-testid="lens-board">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3 print:hidden sm:px-4">
        <Link
          to={routes.tournamentLens(id)}
          data-testid="lens-back"
          aria-label={t("Back to campaigns")}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="page-title">{campaign.title}</h1>
          <p className="text-xs text-muted-foreground">{campaign.tagline}</p>
        </div>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium",
            campaign.is_open
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
          data-testid="campaign-state"
        >
          {campaign.is_open ? t("Open") : t("Closed")}
        </span>
        {slug ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void copyAlbumLink()}
            data-testid="copy-album-link"
          >
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Copy album link")}
          </Button>
        ) : null}
      </div>

      {/* The card EVERYONE scans — a permanent band, on every tab (owner
          2026-08-25): QR visible at all times, print/copy/replace at hand. */}
      <ShareCardStrip
        card={shareCard}
        // Replacing a card retires the poster already on the wall, so it
        // asks first; the first mint has nothing to lose and just runs.
        onMint={() =>
          campaign.share_minted_at
            ? setConfirm({ kind: "new-card" })
            : shareCardM.mutate()
        }
        minting={shareCardM.isPending}
        mintedAt={campaign.share_minted_at}
        tournamentName={tournamentQ.data?.name ?? ""}
        title={campaign.title}
        tagline={campaign.tagline}
        consentNote={campaign.consent_note}
      />

        <div className="grid grid-cols-3 divide-x divide-border border-b border-border print:hidden sm:grid-cols-6">
          {statCells.map((cell) => (
            <div key={cell.label} className="px-3 py-2.5">
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {cell.label}
              </p>
              <p className="font-tabular text-xl font-semibold">{cell.value}</p>
            </div>
          ))}
        </div>
        <div
          role="tablist"
          aria-label={t("Guest Lens sections")}
          className="flex gap-0.5 overflow-x-auto border-b border-border px-2 print:hidden"
        >
          {TABS.map((tb) => (
            <button
              key={tb.key}
              type="button"
              role="tab"
              data-testid={`lens-tab-${tb.key}`}
              aria-selected={tab === tb.key}
              aria-current={tab === tb.key ? "page" : undefined}
              onClick={() => setTab(tb.key)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                tab === tb.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.label}
              {tb.key === "moderate" && stats.photos_pending > 0 ? (
                <span className="rounded-full bg-primary/10 px-1.5 font-tabular text-xs text-primary">
                  {stats.photos_pending}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "campaign" ? (
          <>
            <div className="flex items-center justify-between border-b border-border p-3">
              <h3 className="panel-title">{t("Settings")}</h3>
              {campaign.is_open ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirm({ kind: "close" })}
                  data-testid="close-campaign-btn"
                >
                  {t("Close campaign")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => setConfirm({ kind: "reopen" })}
                  data-testid="reopen-campaign-btn"
                >
                  {t("Reopen campaign")}
                </Button>
              )}
            </div>
            <div className="p-4">
              <SettingsFields draft={draft} onChange={setDraft} />
              <div className="mt-4">
                <Button
                  data-testid="save-settings-btn"
                  disabled={updateM.isPending}
                  onClick={() => updateM.mutate(draft)}
                >
                  {t("Save settings")}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {tab === "cards" ? (
          <>
            {/* ONE list (owner 2026-08-25): the school table below IS the
                code list — each row shows its readable code while this
                device holds a still-valid copy. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <h3 className="panel-title">{t("School codes")}</h3>
              <span className="font-tabular text-xs text-muted-foreground">
                {codedCount}/{institutionsTotal}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {/* Two actions, because they are two different decisions: fill
                    the gaps (safe, keeps codes already handed out) or start
                    over (shows all of them again, breaks the old ones). */}
                <Button
                  size="sm"
                  variant={missingCodes > 0 ? "default" : "outline"}
                  onClick={() => issueM.mutate(undefined)}
                  disabled={issueM.isPending || missingCodes === 0}
                  title={
                    missingCodes === 0
                      ? t("Every school already has a code")
                      : undefined
                  }
                  data-testid="issue-codes-btn"
                >
                  <KeyRound aria-hidden="true" className="h-4 w-4" />
                  {missingCodes > 0
                    ? `${t("Generate codes")} (${missingCodes})`
                    : t("Generate codes")}
                </Button>
                <Button
                  size="sm"
                  variant={missingCodes > 0 ? "outline" : "default"}
                  onClick={() =>
                    setConfirm({
                      kind: "reissue-all",
                      count: overview.passes.length,
                    })
                  }
                  disabled={issueM.isPending || overview.passes.length === 0}
                  data-testid="reissue-all-btn"
                >
                  <RefreshCw aria-hidden="true" className="h-4 w-4" />
                  {t("New codes for all")}
                </Button>
              </div>
            </div>
            {/* A code is only ever readable once, so say where the list went
                rather than leaving a table of "Set" with no way forward. */}
            <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              {missingCodes > 0
                ? `${missingCodes} ${t("of these schools have no code yet. Generate codes gives one to each of them and leaves the rest alone.")}`
                : t(
                    "Every school has a code. Codes are stored hashed and can never be read back, so a school that lost its code needs Regenerate, and getting the whole list again means new codes for all.",
                  )}
            </p>
            {overview.passes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {notInvited > 0
                  ? `${notInvited} ${t(
                      "schools are waiting for a code. Generate codes creates each school's card and shows its code once.",
                    )}`
                  : t(
                      "No schools yet. Codes appear here once schools register.",
                    )}
              </p>
            ) : isMobile ? (
              <ul className="divide-y divide-border">
                {overview.passes.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1.5 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {p.institution_name}
                      </span>
                      {p.is_active ? null : (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-destructive">
                          {t("Revoked")}
                        </span>
                      )}
                    </div>
                    <p className="font-tabular text-xs text-muted-foreground">
                      {p.photos_used}/{campaign.max_photos_per_institution}{" "}
                      {t("photos")}
                    </p>
                    <CodeCell
                      code={codeFor(p.id)}
                      hasCode={p.has_code}
                      onCopy={copyCode}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "rotate",
                            passId: p.id,
                            name: p.institution_name,
                          })
                        }
                      >
                        {t("Regenerate")}
                      </Button>
                      {p.is_active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() =>
                            setConfirm({
                              kind: "revoke",
                              passId: p.id,
                              name: p.institution_name,
                            })
                          }
                        >
                          {t("Revoke")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="passes-table">
                  <thead className="border-b border-border">
                    <tr>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("School")}
                      </th>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Status")}
                      </th>
                      <th className="px-4 py-2 text-right text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Photos used")}
                      </th>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Code")}
                      </th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overview.passes.map((p) => (
                      <tr key={p.id} data-testid={`pass-row-${p.id}`}>
                        <td className="px-4 py-2 text-sm font-medium">
                          {p.institution_name}
                        </td>
                        <td className="px-4 py-2 text-sm">
                          {p.is_active ? (
                            <span className="text-success">{t("Active")}</span>
                          ) : (
                            <span className="text-destructive">
                              {t("Revoked")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-tabular text-sm">
                          {p.photos_used}/{campaign.max_photos_per_institution}
                        </td>
                        <td className="px-4 py-2 text-sm">
                          <CodeCell
                            code={codeFor(p.id)}
                            hasCode={p.has_code}
                            onCopy={copyCode}
                          />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setConfirm({
                                  kind: "rotate",
                                  passId: p.id,
                                  name: p.institution_name,
                                })
                              }
                              data-testid={`rotate-${p.id}`}
                            >
                              {t("Regenerate")}
                            </Button>
                            {p.is_active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() =>
                                  setConfirm({
                                    kind: "revoke",
                                    passId: p.id,
                                    name: p.institution_name,
                                  })
                                }
                                data-testid={`revoke-${p.id}`}
                              >
                                {t("Revoke")}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {tab === "moderate" ? (
          <>
          {(campaign?.story_categories ?? []).length > 0 && stories.length > 0 ? (
            <section
              className="border-b border-border bg-muted/30"
              data-testid="stories-panel"
            >
              <div className="flex items-center gap-2 px-3 pt-3">
                <h3 className="panel-title">{t("Photo stories")}</h3>
                <span className="font-tabular text-xs text-muted-foreground">
                  {stories.length}
                </span>
                <p className="ml-auto hidden text-xs text-muted-foreground sm:block">
                  {t("Each story is one entry: its photographs are judged together, in order.")}
                </p>
              </div>
              <ul className="flex flex-col gap-2 p-3">
                {stories.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border border-border bg-card p-2.5"
                    data-testid={`story-${s.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold">
                        {s.title || t("Untitled story")}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {s.institution_name} · {s.category}
                      </span>
                      {statusChip(s)}
                      {s.award_category ? (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
                          {s.award_category}
                        </span>
                      ) : null}
                      <div className="ml-auto flex items-center gap-1.5">
                        {s.status === "pending" ? (
                          <Button
                            size="sm"
                            data-testid={`approve-story-${s.id}`}
                            disabled={approveStoryM.isPending}
                            onClick={() => approveStoryM.mutate(s.id)}
                          >
                            {t("Approve")}
                          </Button>
                        ) : null}
                        {s.status !== "hidden" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setHideTarget({ kind: "story", id: s.id })
                            }
                          >
                            {t("Hide")}
                          </Button>
                        ) : null}
                        {s.status === "approved" ? (
                          <Select
                            size="sm"
                            aria-label={`${t("Award category for")} ${s.title || s.institution_name}`}
                            value={s.award_category}
                            onChange={(cat) =>
                              awardStoryM.mutate({ storyId: s.id, category: cat })
                            }
                            options={[
                              { value: "", label: t("No award") },
                              ...(campaign?.award_categories ?? []).map((c) => ({
                                value: c,
                                label: c,
                              })),
                            ]}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                      {[...s.photos]
                        .sort((a, b) => a.position - b.position)
                        .map((f) => (
                          <figure key={f.upload_ref} className="w-20 shrink-0">
                            <img
                              src={f.thumb_url}
                              alt={f.caption || t("Uploaded photo")}
                              loading="lazy"
                              className="aspect-square w-full rounded-md border border-border object-cover"
                            />
                            <figcaption className="mt-0.5 flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                              <span className="font-tabular font-semibold">
                                {f.position}
                              </span>
                              <span className="min-w-0 truncate">
                                {f.caption || t("No caption")}
                              </span>
                            </figcaption>
                          </figure>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5">
              {(
                [
                  { key: "pending", label: t("Pending"), n: stats.photos_pending },
                  { key: "approved", label: t("Approved"), n: stats.photos_approved },
                  { key: "hidden", label: t("Hidden"), n: stats.photos_hidden },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  aria-pressed={statusFilter === chip.key}
                  data-testid={`filter-${chip.key}`}
                  onClick={() => setStatusFilter(chip.key)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    statusFilter === chip.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {chip.label}
                  <span className="font-tabular">{chip.n}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              {campaign.award_categories.length > 0 ? (
                <div className="w-full sm:w-52">
                  <Select
                    size="sm"
                    aria-label={t("Filter by category")}
                    value={catFilter}
                    onChange={setCatFilter}
                    options={catOptions}
                  />
                </div>
              ) : null}
              <div className="w-full sm:w-52">
                <Select
                  size="sm"
                  aria-label={t("Filter by school")}
                  value={instFilter}
                  onChange={setInstFilter}
                  options={instOptions}
                />
              </div>
            </div>
          </div>
          {photosQ.isLoading ? (
            <div className="p-4">
              <div className="h-40 animate-pulse rounded-lg border border-border bg-muted" />
            </div>
          ) : photosQ.isError ? (
            <p role="alert" className="px-4 py-12 text-center text-sm text-destructive">
              {t("These photos could not be loaded. Refresh to try again.")}
            </p>
          ) : photos.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("No photos here yet.")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
              {photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`photo-${p.id}`}
                  onClick={() => setLightbox(p.id)}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={p.thumb_url}
                    alt={p.caption || p.institution_name}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                  <div className="flex flex-col gap-0.5 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {p.institution_name}
                      </span>
                      {statusChip(p)}
                    </div>
                    {p.category ? (
                      <span className="truncate text-[0.625rem] text-muted-foreground">
                        {p.category}
                      </span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
          </>
        ) : null}

        {tab === "judging" && campaignId ? (
          <div className="p-3">
            <JudgingPanel campaignId={campaignId} tournamentId={id} />
          </div>
        ) : null}

        {tab === "awards" ? (
          <>
            <div className="flex items-center gap-2 border-b border-border p-3">
              <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
              <h3 className="panel-title">{t("Award winners")}</h3>
              {campaign.award_categories.length > 0 ? (
                <span className="font-tabular text-xs text-muted-foreground">
                  {campaign.award_categories.length}
                </span>
              ) : null}
            </div>
            {rankCategory ? (
              <AwardRankBoard
                campaignId={campaignId}
                category={rankCategory}
                // Photos the school filed under this category lead the field;
                // with none filed, every approved photo is fair game, or a
                // category nobody tagged could never be judged.
                candidates={(() => {
                  const filed = approvedPhotos.filter(
                    (p) => p.category === rankCategory,
                  );
                  return filed.length > 0 ? filed : approvedPhotos;
                })()}
                winnerId={
                  approvedPhotos.find((p) => p.award_category === rankCategory)
                    ?.id ?? null
                }
                onBack={() => setRankCategory(null)}
                saving={awardM.isPending}
                onAward={(photoId) =>
                  awardM.mutate({ photoId, category: rankCategory })
                }
              />
            ) : approvedQ.isLoading ? (
              <div className="p-4">
                <div className="h-40 animate-pulse rounded-lg border border-border bg-muted" />
              </div>
            ) : approvedQ.isError ? (
              <p role="alert" className="px-4 py-12 text-center text-sm text-destructive">
                {t("The approved photos could not be loaded. Refresh to try again.")}
              </p>
            ) : campaign.award_categories.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {t("No award categories. Add some in Settings.")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {campaign.award_categories.map((cat) => {
                  const winner = approvedPhotos.find(
                    (p) => p.award_category === cat,
                  );
                  return (
                    <div
                      key={cat}
                      data-testid={`award-panel-${cat}`}
                      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-3"
                    >
                      <div className="flex items-center gap-1.5">
                        <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                        <h4 className="text-[13px] font-semibold">{cat}</h4>
                      </div>
                      {winner ? (
                        <>
                          <img
                            src={winner.thumb_url}
                            alt={winner.caption || winner.institution_name}
                            loading="lazy"
                            className="aspect-video w-full rounded-md object-cover"
                          />
                          <p className="text-sm font-medium">
                            {winner.institution_name}
                          </p>
                        </>
                      ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                          {t("No winner yet")}
                        </p>
                      )}
                      <div className="mt-auto flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => setRankCategory(cat)}
                          data-testid={`rank-category-${cat}`}
                        >
                          <ListOrdered aria-hidden="true" className="h-3.5 w-3.5" />
                          {t("Rank")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPickCategory(cat)}
                          data-testid={`choose-winner-${cat}`}
                        >
                          {winner ? t("Change") : t("Pick")}
                        </Button>
                        {winner ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              awardM.mutate({ photoId: winner.id, category: "" })
                            }
                          >
                            {t("Clear")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : null}
      </section>

      {tab === "awards" && orphanAwards.length > 0 ? (
        <section className="panel print:hidden" data-testid="orphan-awards">
          <div className="panel-header">
                <Award
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-muted-foreground"
                />
                <h3 className="panel-title">{t("Removed categories")}</h3>
              </div>
              <div className="flex flex-col gap-2 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("These photos still hold a category you removed. Clear each to take it off the album.")}
                </p>
                <ul className="flex flex-col gap-2">
                  {orphanAwards.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <img
                        src={p.thumb_url}
                        alt={p.caption || p.institution_name}
                        loading="lazy"
                        className="h-10 w-10 rounded object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {p.institution_name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {p.award_category}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`clear-orphan-${p.id}`}
                        onClick={() =>
                          awardM.mutate({ photoId: p.id, category: "" })
                        }
                      >
                        {t("Clear")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

      {/* Close / reopen / rotate / revoke confirmations. */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        ariaLabel={t("Confirm action")}
      >
        {confirm ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {confirm.kind === "close"
                  ? t("Close the campaign?")
                  : confirm.kind === "reopen"
                    ? t("Reopen the campaign?")
                    : confirm.kind === "new-card"
                      ? t("Replace the card on the wall?")
                      : confirm.kind === "reissue-all"
                        ? t("New codes for every school?")
                      : confirm.kind === "rotate"
                          ? t("Regenerate this school's code?")
                          : confirm.kind === "delete-photo"
                            ? t("Delete this photo?")
                            : t("Remove this school from the album?")}
              </DialogTitle>
              <DialogDescription>
                {confirm.kind === "close"
                  ? t("Uploading stops for every school. The album stays public.")
                  : confirm.kind === "reopen"
                    ? t("Schools can upload photos again.")
                    : confirm.kind === "new-card"
                      ? t("The printed poster stops working the moment this is done. Only replace the card if it was lost, and print the new one before the event.")
                      : confirm.kind === "reissue-all"
                        ? `${confirm.count} ${t("schools get a fresh code, shown once. Every code already handed out stops working, so only do this if you need the whole list back.")}`
                      : confirm.kind === "rotate"
                          ? `${confirm.name}. ${t("Its old code stops working. The shared card is unchanged.")}`
                          : confirm.kind === "delete-photo"
                            ? t("The photo and its file are removed for good and cannot be brought back. If you may want it later, hide it instead.")
                            : `${confirm.name}. ${t("The school can no longer upload photos.")}`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                {t("Cancel")}
              </Button>
              <Button
                data-testid="confirm-action-btn"
                disabled={deleteM.isPending}
                variant={
                  confirm.kind === "revoke" ||
                  confirm.kind === "reissue-all" ||
                  confirm.kind === "new-card" ||
                  confirm.kind === "delete-photo"
                    ? "destructive"
                    : "default"
                }
                onClick={() => {
                  if (confirm.kind === "close") closeM.mutate();
                  else if (confirm.kind === "reopen") reopenM.mutate();
                  else if (confirm.kind === "new-card") shareCardM.mutate();
                  else if (confirm.kind === "reissue-all")
                    issueM.mutate(
                      (overviewQ.data?.passes ?? []).map((p) => p.institution_id),
                    );
                  else if (confirm.kind === "rotate")
                    rotateM.mutate(confirm.passId);
                  else if (confirm.kind === "delete-photo") {
                    // Stays open (disabled) until the server answers, so a
                    // failure lands back on the confirm, not a closed lightbox.
                    deleteM.mutate(confirm.photoId);
                    return;
                  } else revokeM.mutate(confirm.passId);
                  setConfirm(null);
                }}
              >
                {t("Confirm")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>

      {/* Moderation lightbox. */}
      <Dialog
        open={
          lightboxPhoto !== null &&
          hideTarget === null &&
          confirm?.kind !== "delete-photo"
        }
        onOpenChange={(o) => {
          if (!o) setLightbox(null);
        }}
        ariaLabel={t("Photo review")}
      >
        {lightboxPhoto ? (
          <div className="flex flex-col gap-3" data-testid="lightbox">
            <img
              src={lightboxPhoto.url}
              alt={lightboxPhoto.caption || lightboxPhoto.institution_name}
              className="max-h-[60vh] w-full rounded-md object-contain"
            />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {lightboxPhoto.institution_name}
                </p>
                {lightboxPhoto.caption ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {lightboxPhoto.caption}
                  </p>
                ) : null}
                {lightboxPhoto.category ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {t("Category")}: {lightboxPhoto.category}
                  </p>
                ) : null}
              </div>
              {statusChip(lightboxPhoto)}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={lightboxIdx <= 0}
                onClick={() => setLightbox(photos[lightboxIdx - 1]?.id ?? null)}
              >
                {t("Previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={lightboxIdx >= photos.length - 1}
                onClick={() => setLightbox(photos[lightboxIdx + 1]?.id ?? null)}
              >
                {t("Next")}
              </Button>
              {/* Delete is the one-way door next to the reversible Hide:
                  for uploads that should never have existed at all. */}
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                data-testid="delete-btn"
                onClick={() =>
                  setConfirm({ kind: "delete-photo", photoId: lightboxPhoto.id })
                }
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Delete")}
              </Button>
              {lightboxPhoto.status !== "hidden" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  data-testid="hide-btn"
                  onClick={() => {
                    setHideTarget({ kind: "photo", id: lightboxPhoto.id });
                    setHideReason("");
                  }}
                >
                  <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Hide")}
                </Button>
              ) : null}
              {lightboxPhoto.status !== "approved" ? (
                <Button
                  size="sm"
                  data-testid="approve-btn"
                  disabled={approveM.isPending}
                  onClick={() => approveM.mutate(lightboxPhoto.id)}
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Approve")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* Hide-with-reason dialog. */}
      <Dialog
        open={hideTarget !== null}
        onOpenChange={(o) => {
          if (!o) setHideTarget(null);
        }}
        ariaLabel={t("Hide photo")}
      >
        {hideTarget ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {hideTarget.kind === "story"
                  ? t("Hide this photo story?")
                  : t("Hide this photo?")}
              </DialogTitle>
              <DialogDescription>
                {hideTarget.kind === "story"
                  ? t("The whole entry leaves the public album and its photographs are quarantined. You can approve it again later.")
                  : t("It leaves the public album and its file is quarantined. You can approve it again later.")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hide-reason">{t("Reason (optional)")}</Label>
              <Input
                id="hide-reason"
                className="h-9"
                value={hideReason}
                onChange={(e) => setHideReason(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setHideTarget(null)}>
                {t("Cancel")}
              </Button>
              <Button
                variant="destructive"
                data-testid="confirm-hide-btn"
                disabled={hideM.isPending}
                onClick={() => {
                  if (hideTarget.kind === "story") {
                    hideStoryM.mutate({
                      storyId: hideTarget.id,
                      reason: hideReason,
                    });
                  } else {
                    hideM.mutate({
                      photoId: hideTarget.id,
                      reason: hideReason,
                    });
                  }
                }}
              >
                {t("Hide photo")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>

      {/* Award winner picker. */}
      <Dialog
        open={pickCategory !== null}
        onOpenChange={(o) => {
          if (!o) setPickCategory(null);
        }}
        ariaLabel={t("Choose a winner")}
      >
        {pickCategory ? (
          <div className="flex flex-col gap-3">
            <DialogHeader>
              <DialogTitle>{pickCategory}</DialogTitle>
              <DialogDescription>
                {pickable.length > 0 && pickable.length < approvedPhotos.length
                  ? t("Pick the winning photo from this category's approved entries.")
                  : t("Pick the winning photo. Only approved photos can win.")}
              </DialogDescription>
            </DialogHeader>
            {approvedQ.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("Loading the approved photos.")}
              </p>
            ) : pickable.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("Approve some photos first.")}
              </p>
            ) : (
              <div className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto">
                {pickable.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`pick-${p.id}`}
                    disabled={awardM.isPending}
                    onClick={() =>
                      awardM.mutate({ photoId: p.id, category: pickCategory })
                    }
                    className={cn(
                      "overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      p.award_category === pickCategory
                        ? "border-primary ring-1 ring-primary"
                        : "border-border",
                    )}
                  >
                    <img
                      src={p.thumb_url}
                      alt={p.caption || p.institution_name}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
