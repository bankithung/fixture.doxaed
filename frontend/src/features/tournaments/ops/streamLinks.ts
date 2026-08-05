import type { CourtStreamRow, StreamLink } from "@/api/streaming";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Pure helpers behind the Live streams panel: which level a court's link is
 * coming from, and a client-side sanity check on a pasted URL.
 *
 * The precedence rule lives on the server
 * (`backend/apps/streaming/services/links.py`) and IS the authority. What is
 * mirrored here is only the part a manager screen can answer from the manager
 * payloads — enough to tell an organiser at a glance whether a court is running
 * on a link they pasted for today or on something further down the list.
 */

/** Which level a court's currently-applicable link came from. */
export type LinkSource =
  /** A link pasted for this court on this day (level 2). */
  | "day"
  /** The day's auto-created YouTube broadcast (level 3). */
  | "broadcast"
  /** The court's standing default (level 5). */
  | "court_default"
  /** Nothing resolves — a spectator sees no Watch live button. */
  | "none";

export interface EffectiveCourtLink {
  url: string | null;
  source: LinkSource;
  /** The court-day row, whether or not it is currently applying (a row that is
   * switched off or emptied is still there to be edited). */
  dayLink: StreamLink | null;
  /** True when a court-day row exists but is not applying. */
  overridden: boolean;
}

/** A link's URL, or null when it is switched off / emptied (both of which mean
 * "this level is not set" — mirrors `StreamLink.resolves`). */
export function resolvedUrl(link: StreamLink | null | undefined): string | null {
  if (!link || !link.enabled || !link.watch_url) return null;
  return link.watch_url;
}

export function findCourtDayLink(
  links: StreamLink[],
  courtId: string,
  day: string,
): StreamLink | null {
  if (!courtId || !day) return null;
  return (
    links.find(
      (l) => l.scope === "court_day" && l.court_id === courtId && l.day === day,
    ) ?? null
  );
}

export function findCategoryLink(
  links: StreamLink[],
  leafKey: string,
): StreamLink | null {
  if (!leafKey) return null;
  return links.find((l) => l.scope === "category" && l.leaf_key === leafKey) ?? null;
}

export function findMatchLink(
  links: StreamLink[],
  matchId: string,
): StreamLink | null {
  if (!matchId) return null;
  return links.find((l) => l.scope === "match" && l.match_id === matchId) ?? null;
}

/**
 * What a court is showing on `day`, and which level it came from.
 *
 * The auto-broadcast level is only *knowable* for today: the manager payload
 * carries `live_watch_url`, which the server resolved for today and today
 * only. So a broadcast is reported when today's resolved URL is something
 * neither the day link nor the standing default explains — on any other day the
 * row falls back to the standing default, which is what the resolver does
 * whenever no broadcast exists. (A day-specific resolve endpoint would remove
 * the guess; there isn't one.)
 */
export function effectiveCourtLink(
  court: CourtStreamRow,
  dayLink: StreamLink | null,
  isToday: boolean,
): EffectiveCourtLink {
  const fromDay = resolvedUrl(dayLink);
  if (fromDay) {
    return { url: fromDay, source: "day", dayLink, overridden: false };
  }
  const overridden = dayLink !== null;
  const standing = court.watch_url || null;
  if (isToday && court.live_watch_url && court.live_watch_url !== standing) {
    return {
      url: court.live_watch_url,
      source: "broadcast",
      dayLink,
      overridden,
    };
  }
  if (standing) {
    return { url: standing, source: "court_default", dayLink, overridden };
  }
  return { url: null, source: "none", dayLink, overridden };
}

/** Short chip label for a level. */
export function sourceLabel(source: LinkSource): string {
  if (source === "day") return t("This day");
  if (source === "broadcast") return t("Auto broadcast");
  if (source === "court_default") return t("Court default");
  return t("No link");
}

/** One line explaining where the link came from (and what changing it does). */
export function sourceHint(source: LinkSource): string {
  if (source === "day") return t("Pasted for this court, on this day.");
  if (source === "broadcast") {
    return t("Opened automatically for this court today. A link you paste wins.");
  }
  if (source === "court_default") {
    return t("This court's standing link, used on every day with nothing of its own.");
  }
  return t("Nothing resolves — spectators see no Watch live button.");
}

// ------------------------------------------------------- OBS overlay address

/**
 * The absolute OBS Browser Source URL for ONE court.
 *
 * The overlay addresses a court by the fixture's **venue display string**, not
 * by the court's UUID — `matchesOnCourt` compares `normalizeCourt(m.venue)`
 * against the `:court` segment. That string routinely contains spaces and a
 * middle dot (`Court2 · T3` → `Court2%20%C2%B7%20T3`), so the app encodes it:
 * asking an operator to hand-encode `%C2%B7` is a bug factory, and a wrong
 * encoding silently produces an overlay that never finds a match.
 *
 * `origin` is passed in rather than read here so the helper stays pure (and so
 * a server-rendered/empty origin degrades to a path instead of throwing).
 */
export function overlayCourtUrl(
  origin: string,
  slug: string,
  tournamentId: string,
  courtName: string,
): string {
  return `${origin}${routes.overlayCourt(slug, tournamentId, courtName)}`;
}

/**
 * The absolute phone camera + scoreboard URL for ONE court.
 *
 * Same court addressing and the same encoding argument as `overlayCourtUrl`
 * above — and it matters more here, because this URL gets sent to a volunteer
 * over WhatsApp and typed by nobody.
 */
export function cameraBroadcastUrl(
  origin: string,
  slug: string,
  tournamentId: string,
  courtName: string,
): string {
  return `${origin}${routes.broadcastCourt(slug, tournamentId, courtName)}`;
}

/** The browser's origin, or "" where there is no window (tests, SSR). */
export function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

// ---------------------------------------------------------- URL sanity check
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const YT_SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
/** 11-char YouTube video ids — the only length YouTube has ever issued. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function parse(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/** `youtube.com/@handle/live`, `/channel/UC…/live`, … — the URLs that resolve to
 * "whatever this channel happens to be streaming". NOT `youtube.com/live/<id>`,
 * which addresses one broadcast and is fine. */
export function isChannelLiveUrl(raw: string): boolean {
  const url = parse(raw);
  if (!url || !YT_HOSTS.has(url.hostname.toLowerCase())) return false;
  const parts = segments(url);
  if (parts[0] === "live") return false;
  return parts.length >= 2 && parts[parts.length - 1].toLowerCase() === "live";
}

/** The 11-char video id inside a YouTube watch/short/live URL, else null. */
export function videoIdFromUrl(raw: string): string | null {
  const url = parse(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = segments(url);
  const ok = (id: string | undefined): string | null =>
    id && VIDEO_ID.test(id) ? id : null;
  if (YT_SHORT_HOSTS.has(host)) return ok(parts[0]);
  if (!YT_HOSTS.has(host)) return null;
  if (parts[0] === "watch") return ok(url.searchParams.get("v") ?? undefined);
  if (parts.length === 2 && ["live", "embed", "shorts", "v"].includes(parts[0])) {
    return ok(parts[1]);
  }
  return null;
}

/**
 * A warning for an obviously-wrong paste, or null.
 *
 * Advisory ONLY — the save is never blocked on it. `validate_watch_url` on the
 * server is the authority and its message is what gets shown when a write is
 * refused; this exists so the two most common mistakes are caught before a
 * round trip, not so the client can invent rules of its own.
 */
export function watchUrlWarning(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (isChannelLiveUrl(url)) {
    return t(
      "That is a channel-level “/live” link — it cannot say which court. Open the broadcast itself and paste its video link.",
    );
  }
  if (videoIdFromUrl(url) === null) {
    return t(
      "That does not look like a YouTube video link (youtube.com/watch?v=…, youtu.be/… or youtube.com/live/…).",
    );
  }
  return null;
}
