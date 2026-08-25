import { api } from "./client";

/**
 * Guest Lens ("36 Shots Challenge") API — hand-written types for now; swap to
 * generated types once the backend schema lands (spec 2026-07-10 §4.1).
 * Manager routes gate on `can_manage_tournament`; the `/lens/p/:token/` family
 * is the no-login pass surface a QR card opens.
 */

export interface LensCampaign {
  id: string;
  title: string;
  tagline: string;
  instructions: string;
  consent_note: string;
  max_photos_per_institution: number;
  award_categories: string[];
  /** Optional per-school cap for each category; a missing key means only the
   * overall max_photos_per_institution applies. */
  category_limits: Record<string, number>;
  /** Award categories that accept ONE grouped, titled, ordered photo-story
   * entry per school (judged together), instead of individual photos. */
  story_categories: string[];
  /** How many photographs one story entry holds. */
  story_photos_per_entry: number;
  is_open: boolean;
  opened_at: string | null;
  closed_at: string | null;
  /** When the event's one card was last minted; null = no card yet. The token
   * itself is never in this payload. */
  share_minted_at: string | null;
}

export interface LensStats {
  institutions_total: number;
  passes_active: number;
  photos_total: number;
  photos_pending: number;
  photos_approved: number;
  photos_hidden: number;
}

export interface LensPassRow {
  id: string;
  institution_id: string;
  institution_name: string;
  is_active: boolean;
  /** Whether a code exists — never the code itself, which the server returns
   * only in the response of the call that generated it. */
  has_code: boolean;
  /** When the current code was issued; lets a device-cached copy of a code
   * detect that it was rotated (here or elsewhere) and stop showing it. */
  code_set_at: string | null;
  photos_used: number;
  last_minted_at: string | null;
}

export interface LensOverview {
  campaign: LensCampaign | null;
  fixtures_ready: boolean;
  stats: LensStats;
  passes: LensPassRow[];
}

/** A campaign as it appears in the tournament's campaign list (picker cards):
 * the full campaign plus light per-campaign counts. */
export interface LensCampaignSummary extends LensCampaign {
  photos_total: number;
  photos_pending: number;
  passes_active: number;
}

/** Campaign settings a manager can set at open time or PATCH later. */
export interface LensSettingsBody {
  title?: string;
  tagline?: string;
  instructions?: string;
  consent_note?: string;
  max_photos_per_institution?: number;
  award_categories?: string[];
  category_limits?: Record<string, number>;
  story_categories?: string[];
  story_photos_per_entry?: number;
}

/** One printable QR pass card. The plaintext `token` is shown ONCE — it lives
 * only in this mint/rotate response (hash-at-rest, spec D12). */
/** The event's ONE card: the QR everyone scans. Held in React state only for
 * as long as the poster is on screen — the plaintext token exists nowhere
 * else (hash at rest, spec D12). */
export interface LensShareCard {
  campaign_id: string;
  title: string;
  tagline: string;
  join_url: string;
  token: string;
  qr_data_uri: string;
}

/** One school's code, shown once. */
export interface LensCode {
  pass_id: string;
  institution_id: string;
  institution_name: string;
  code: string;
}

/** The join page behind the shared card. */
export interface LensJoinContext {
  tournament: { id: string; slug: string; name: string };
  campaign: {
    id: string;
    title: string;
    tagline: string;
    instructions: string;
    consent_note: string;
    is_open: boolean;
  };
  institutions: { id: string; name: string }[];
}

export type LensPhotoStatus = "pending" | "approved" | "hidden";

export interface LensPhoto {
  id: string;
  upload_ref: string;
  institution_id: string;
  institution_name: string;
  caption: string;
  category: string;
  url: string;
  thumb_url: string;
  width: number;
  height: number;
  size: number;
  status: LensPhotoStatus;
  hidden_reason: string;
  award_category: string;
  created_at: string;
}

/** A photo as the uploading institution sees it (hidden reads as "removed"). */
export interface LensOwnPhoto {
  upload_ref: string;
  url: string;
  thumb_url: string;
  caption: string;
  category: string;
  /** Set when the photo belongs to one of the school's photo stories. */
  story_id: string | null;
  position: number;
  status: "pending" | "approved" | "removed";
  created_at: string;
}

/** One frame inside a story payload — the uploader's and public view share
 * it; manager payloads add `status`. */
export interface LensStoryFrame {
  upload_ref: string;
  url: string;
  thumb_url: string;
  caption: string;
  position: number;
  created_at: string;
  status?: LensPhotoStatus;
}

/** A photo-story ENTRY as its school sees it (hidden reads as "removed").
 * The public album reuses the shape; the manager list adds status. */
export interface LensOwnStory {
  id: string;
  title: string;
  /** Optional free text; the TITLE is the mandatory part of an entry. */
  description: string;
  category: string;
  photos: LensStoryFrame[];
}

export interface LensStoryRow extends LensOwnStory {
  institution_id: string;
  institution_name: string;
  award_category: string;
  status: LensPhotoStatus;
  hidden_reason: string;
  created_at: string;
}

export interface LensPassContext {
  tournament: { id: string; slug: string; name: string };
  institution: { id: string; name: string };
  campaign: {
    title: string;
    tagline: string;
    instructions: string;
    consent_note: string;
    is_open: boolean;
    max_photos_per_institution: number;
    award_categories: string[];
    category_limits: Record<string, number>;
    story_categories: string[];
    story_photos_per_entry: number;
  };
  quota: {
    used: number;
    max: number;
    by_category: Record<string, number>;
  };
  photos: LensOwnPhoto[];
  stories: LensOwnStory[];
}

export interface PublicAlbumPhoto {
  upload_ref: string;
  url: string;
  thumb_url: string;
  institution_name: string;
  caption: string;
  category: string;
  award_category: string;
  created_at: string;
}

/** A photo story on the public album: judged as ONE entry, shown as one
 * titled strip of frames in their intended order. */
export interface PublicAlbumStory {
  id: string;
  institution_name: string;
  title: string;
  category: string;
  award_category: string;
  photos: LensStoryFrame[];
}

export interface PublicAlbum {
  campaign: { title: string; tagline: string } | null;
  award_categories: string[];
  story_categories: string[];
  institutions: { id: string; name: string; count: number }[];
  photos: PublicAlbumPhoto[];
  stories: PublicAlbumStory[];
}

const base = (tid: string): string =>
  `/api/tournaments/${encodeURIComponent(tid)}/lens`;

export const lensApi = {
  /** All Guest Lens campaigns for a tournament (the picker landing). */
  campaigns: (tid: string) =>
    api.get<{ campaigns: LensCampaignSummary[] }>(`${base(tid)}/campaigns/`),
  /** Create a NEW campaign (title/settings in the body). */
  create: (tid: string, body: LensSettingsBody & { event_id: string }) =>
    api.post<{ campaign: LensCampaign }>(`${base(tid)}/campaigns/`, body),
  /** Overview for ONE campaign (omit campaignId for the legacy first-campaign). */
  overview: (tid: string, campaignId?: string) =>
    api.get<LensOverview>(
      `${base(tid)}/${campaignId ? `?campaign=${encodeURIComponent(campaignId)}` : ""}`,
    ),
  open: (tid: string, body: LensSettingsBody & { event_id: string }) =>
    api.post<{ campaign: LensCampaign }>(`${base(tid)}/open/`, body),
  update: (
    tid: string,
    campaignId: string,
    body: LensSettingsBody & { event_id: string },
  ) =>
    api.patch<{ campaign: LensCampaign }>(`${base(tid)}/`, {
      ...body,
      campaign_id: campaignId,
    }),
  close: (tid: string, campaignId: string, body: { event_id: string }) =>
    api.post<{ campaign: LensCampaign }>(`${base(tid)}/close/`, {
      ...body,
      campaign_id: campaignId,
    }),
  reopen: (tid: string, campaignId: string, body: { event_id: string }) =>
    api.post<{ campaign: LensCampaign }>(`${base(tid)}/reopen/`, {
      ...body,
      campaign_id: campaignId,
    }),
  /** Mint (or re-mint) the campaign's single card. Re-minting retires the
   * poster already on the wall, so the console confirms first. */
  /** The card IN USE, decrypted for the manager — the same poster after any
   * refresh, on any device. `{card: null}` when nothing has been minted. */
  currentShareCard: (tid: string, campaignId: string) =>
    api.get<{ card: LensShareCard | null }>(
      `${base(tid)}/share-card/?campaign=${encodeURIComponent(campaignId)}`,
    ),
  shareCard: (tid: string, campaignId: string, body: { event_id: string }) =>
    api.post<{ card: LensShareCard }>(`${base(tid)}/share-card/`, {
      ...body,
      campaign_id: campaignId,
    }),
  /** Give schools a code. Without `institution_ids`, schools that already hold
   * one keep it; with it, those schools get a fresh code. */
  issueCodes: (
    tid: string,
    campaignId: string,
    body: { event_id: string; institution_ids?: string[] },
  ) =>
    api.post<{ codes: LensCode[]; skipped: number }>(`${base(tid)}/passes/codes/`, {
      ...body,
      campaign_id: campaignId,
    }),
  rotate: (tid: string, passId: string, body: { event_id: string }) =>
    api.post<{ code: LensCode }>(
      `${base(tid)}/passes/${encodeURIComponent(passId)}/rotate/`,
      body,
    ),
  revoke: (tid: string, passId: string, body: { event_id: string }) =>
    api.post<{ pass: LensPassRow }>(
      `${base(tid)}/passes/${encodeURIComponent(passId)}/revoke/`,
      body,
    ),
  photos: (
    tid: string,
    campaignId: string,
    params: { status?: string; institution_id?: string; category?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (campaignId) qs.set("campaign", campaignId);
    if (params.status) qs.set("status", params.status);
    if (params.institution_id) qs.set("institution_id", params.institution_id);
    if (params.category) qs.set("category", params.category);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return api.get<{ photos: LensPhoto[] }>(`${base(tid)}/photos/${suffix}`);
  },
  approve: (tid: string, photoId: string, body: { event_id: string }) =>
    api.post<{ photo: LensPhoto }>(
      `${base(tid)}/photos/${encodeURIComponent(photoId)}/approve/`,
      body,
    ),
  hide: (
    tid: string,
    photoId: string,
    body: { event_id: string; reason?: string },
  ) =>
    api.post<{ photo: LensPhoto }>(
      `${base(tid)}/photos/${encodeURIComponent(photoId)}/hide/`,
      body,
    ),
  award: (
    tid: string,
    photoId: string,
    body: { event_id: string; category: string },
  ) =>
    api.post<{ photo: LensPhoto }>(
      `${base(tid)}/photos/${encodeURIComponent(photoId)}/award/`,
      body,
    ),

  /** Photo-story entries: list + moderate + award at ENTRY level. */
  stories: (
    tid: string,
    campaignId: string,
    params: { status?: string; institution_id?: string; category?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (campaignId) qs.set("campaign", campaignId);
    if (params.status) qs.set("status", params.status);
    if (params.institution_id)
      qs.set("institution_id", params.institution_id);
    if (params.category) qs.set("category", params.category);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return api.get<{ stories: LensStoryRow[] }>(
      `${base(tid)}/stories/${suffix}`,
    );
  },
  approveStory: (tid: string, storyId: string, body: { event_id: string }) =>
    api.post<{ story: LensStoryRow }>(
      `${base(tid)}/stories/${encodeURIComponent(storyId)}/approve/`,
      body,
    ),
  hideStory: (
    tid: string,
    storyId: string,
    body: { event_id: string; reason?: string },
  ) =>
    api.post<{ story: LensStoryRow }>(
      `${base(tid)}/stories/${encodeURIComponent(storyId)}/hide/`,
      body,
    ),
  awardStory: (
    tid: string,
    storyId: string,
    body: { event_id: string; category: string },
  ) =>
    api.post<{ story: LensStoryRow }>(
      `${base(tid)}/stories/${encodeURIComponent(storyId)}/award/`,
      body,
    ),

  /** The door behind the shared card: what album this is, and which schools
   * can sign in. */
  joinContext: (token: string) =>
    api.get<LensJoinContext>(`/api/lens/join/${encodeURIComponent(token)}/`),
  /** Exchange (school, code) for the upload session token. */
  join: (token: string, body: { institution_id: string; code: string }) =>
    api.post<{ token: string; institution: { id: string; name: string } }>(
      `/api/lens/join/${encodeURIComponent(token)}/`,
      body,
    ),

  /** Public pass surface (no login; the session token IS the credential). */
  passContext: (token: string) =>
    api.get<LensPassContext>(`/api/lens/p/${encodeURIComponent(token)}/`),
  /** Multipart upload; a photo from a school phone can be slow on 2G, so the
   * default 20s fetch timeout is raised (spec §4.1). */
  upload: (token: string, formData: FormData) =>
    api.post<{ photo: LensOwnPhoto }>(
      `/api/lens/p/${encodeURIComponent(token)}/photos/`,
      formData,
      { timeoutMs: 60_000 },
    ),
  removeOwn: (token: string, uploadRef: string) =>
    api.delete<{ removed: boolean }>(
      `/api/lens/p/${encodeURIComponent(token)}/photos/${encodeURIComponent(uploadRef)}/`,
    ),
  /** Name the school's photo-story entry (title mandatory at submit time)
   * and optionally give it a description. Locked once moderated. */
  setStoryTitle: (
    token: string,
    storyId: string,
    body: { title: string; description?: string },
  ) =>
    api.post<{ story: LensOwnStory }>(
      `/api/lens/p/${encodeURIComponent(token)}/stories/${encodeURIComponent(storyId)}/title/`,
      body,
    ),
  /** Move one of the entry's frames to 1-based `position` — the intended
   * reading order of a photo story. */
  reorderStory: (
    token: string,
    storyId: string,
    body: { upload_ref: string; position: number },
  ) =>
    api.post<{ story: LensOwnStory }>(
      `/api/lens/p/${encodeURIComponent(token)}/stories/${encodeURIComponent(storyId)}/order/`,
      body,
    ),

  /** Public shared album (approved photos only; slug+UUID pair). One album per
   * campaign — pass the campaignId; omit it for the legacy first-campaign. */
  publicAlbum: (slug: string, tid: string, campaignId?: string) =>
    api.get<PublicAlbum>(
      `/api/public/tournaments/${encodeURIComponent(slug)}/${encodeURIComponent(tid)}/album/${campaignId ? `${encodeURIComponent(campaignId)}/` : ""}`,
    ),
};
