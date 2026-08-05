import { api } from "./client";

/**
 * Per-court / per-day / per-category "Watch live" bindings.
 *
 * Two families of endpoint, deliberately kept apart because they mean different
 * things (see `backend/apps/streaming/models.py`):
 *
 * - `court-streams/` is a court's STANDING default — one permanent row per
 *   court, used on every day the court plays.
 * - `stream-links/` is a hand-pasted override at the scope the organiser
 *   actually works at: one match, one court for one day, or one competition
 *   category.
 *
 * The server resolves them most-specific-first — match link → court+day link →
 * the day's auto broadcast → category link → the court's standing default —
 * and a link with `enabled:false` or an empty URL falls THROUGH to the next
 * level rather than switching the feed off.
 */

/** Which thing a {@link StreamLink} is pinned to. */
export type StreamLinkScope = "match" | "court_day" | "category";

/** One hand-pasted link. Every scope target is present (null where it does not
 * apply), so a client can render one table without branching on `scope`. */
export interface StreamLink {
  id: string;
  scope: StreamLinkScope;
  match_id: string | null;
  court_id: string | null;
  /** LOCAL tournament day ("YYYY-MM-DD") for a `court_day` link. */
  day: string | null;
  /** Competition leaf ("football.u15.girls") for a `category` link. */
  leaf_key: string;
  watch_url: string;
  /** `false` = kept but not applied; the next level down takes over. */
  enabled: boolean;
  updated_at: string | null;
}

/** One court's standing binding plus what it is resolving to TODAY. */
export interface CourtStreamRow {
  court_id: string;
  /** Exactly the `Match.venue` display string ("MP Hall · T2"). */
  court_name: string;
  venue_id: string;
  index: number;
  /** The court's standing default (precedence level 5). */
  watch_url: string;
  enabled: boolean;
  yt_stream_id: string;
  /** The RTMP key is write-only; only its presence ever crosses the API. */
  has_stream_key: boolean;
  /** Server-resolved URL for TODAY (court-day link → broadcast → default). */
  live_watch_url: string | null;
  is_streaming: boolean;
  /** The platform's own stable, printable/QR-able court link. */
  public_link: string;
}

/** Body of a scoped-link upsert. Only the keys the scope needs are read. */
export interface StreamLinkWrite {
  scope: StreamLinkScope;
  watch_url: string;
  event_id: string;
  match_id?: string;
  court_id?: string;
  day?: string;
  leaf_key?: string;
  enabled?: boolean;
}

export const streamingApi = {
  /** Every court in the workspace with its standing binding (manager-only). */
  courtStreams: (tournamentId: string) =>
    api.get<{ court_streams: CourtStreamRow[] }>(
      `/api/tournaments/${tournamentId}/court-streams/`,
    ),
  /** Upsert one court's standing default. 201 on create, 200 on update. */
  saveCourtStream: (
    tournamentId: string,
    body: {
      court_id: string;
      watch_url: string;
      enabled?: boolean;
      event_id: string;
    },
  ) =>
    api.post<CourtStreamRow & { public_link: string }>(
      `/api/tournaments/${tournamentId}/court-streams/`,
      body,
    ),
  /**
   * `<img src>` for the QR code of a court's phone broadcast page — a URL to
   * put in an element, NOT a call to make.
   *
   * It is a plain same-origin GET so the browser carries the session cookie
   * and can cache the image; fetching it as a blob would buy nothing and cost
   * the cache. The QR is generated server-side (`apps/streaming/services/qr.py`)
   * because the point of it is to move the URL onto a *different device* —
   * a phone camera reads it off the screen, which no copy button can do.
   */
  broadcastQrUrl: (tournamentId: string, courtId: string) =>
    `/api/tournaments/${tournamentId}/court-streams/${courtId}/broadcast-qr/`,

  /** Drop a court's standing default (idempotent; 204). */
  deleteCourtStream: (tournamentId: string, courtId: string) =>
    api.delete<void>(
      `/api/tournaments/${tournamentId}/court-streams/${courtId}/`,
    ),

  /** Every active scoped link this tournament's manager owns. */
  links: (tournamentId: string) =>
    api.get<{ stream_links: StreamLink[] }>(
      `/api/tournaments/${tournamentId}/stream-links/`,
    ),
  /** Upsert the link for a target. 201 on create, 200 on update/replay. */
  saveLink: (tournamentId: string, body: StreamLinkWrite) =>
    api.post<StreamLink>(`/api/tournaments/${tournamentId}/stream-links/`, body),
  /** Edit `watch_url` / `enabled` in place without restating the target. */
  updateLink: (
    tournamentId: string,
    linkId: string,
    body: { watch_url?: string; enabled?: boolean; event_id: string },
  ) =>
    api.patch<StreamLink>(
      `/api/tournaments/${tournamentId}/stream-links/${linkId}/`,
      body,
    ),
  /** Clear a link entirely — the level stops applying and the next one down
   * takes over. Idempotent (204 even when it is already gone). */
  deleteLink: (tournamentId: string, linkId: string) =>
    api.delete<void>(
      `/api/tournaments/${tournamentId}/stream-links/${linkId}/`,
    ),
};
