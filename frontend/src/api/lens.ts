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
  is_open: boolean;
  opened_at: string | null;
  closed_at: string | null;
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
}

/** One printable QR pass card. The plaintext `token` is shown ONCE — it lives
 * only in this mint/rotate response (hash-at-rest, spec D12). */
export interface LensCard {
  pass_id: string;
  institution_id: string;
  institution_name: string;
  upload_url: string;
  token: string;
  qr_data_uri: string;
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
  status: "pending" | "approved" | "removed";
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
  };
  quota: {
    used: number;
    max: number;
    by_category: Record<string, number>;
  };
  photos: LensOwnPhoto[];
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

export interface PublicAlbum {
  campaign: { title: string; tagline: string } | null;
  award_categories: string[];
  institutions: { id: string; name: string; count: number }[];
  photos: PublicAlbumPhoto[];
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
  mint: (tid: string, campaignId: string, body: { event_id: string }) =>
    api.post<{ cards: LensCard[]; skipped: number }>(
      `${base(tid)}/passes/mint/`,
      { ...body, campaign_id: campaignId },
    ),
  rotate: (tid: string, passId: string, body: { event_id: string }) =>
    api.post<{ card: LensCard }>(
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

  /** Public pass surface (no login; the QR card token IS the credential). */
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

  /** Public shared album (approved photos only; slug+UUID pair). One album per
   * campaign — pass the campaignId; omit it for the legacy first-campaign. */
  publicAlbum: (slug: string, tid: string, campaignId?: string) =>
    api.get<PublicAlbum>(
      `/api/public/tournaments/${encodeURIComponent(slug)}/${encodeURIComponent(tid)}/album/${campaignId ? `${encodeURIComponent(campaignId)}/` : ""}`,
    ),
};
