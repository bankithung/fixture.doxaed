import { api } from "./client";

/** One event, and the places its footage was published. */
export interface TournamentVideo {
  id: string;
  event: string;
  note: string;
  youtube_url: string;
  facebook_url: string;
  instagram_url: string;
  /** Parsed on the server from whatever shape the host pasted. "" = no embed. */
  youtube_id: string;
  /** The day the footage is OF, not the day it was uploaded. */
  played_on: string | null;
  tags: string[];
  schools: { id: string; name: string; crest: string }[];
  position: number;
}

export interface VideoAlbum {
  id: string;
  title: string;
  description: string;
  position: number;
  videos: TournamentVideo[];
  video_count: number;
}

export interface VideoAlbumsPayload {
  albums: VideoAlbum[];
  /** Every registered school, for the picker. */
  schools: { id: string; name: string; crest: string }[];
  /** Tag suggestions read off the tournament's own category tree. */
  suggested_tags: string[];
  can_manage: boolean;
}

export interface PublicVideosPayload {
  tournament: {
    id: string;
    slug: string;
    name: string;
    status: string;
    time_zone?: string;
  };
  albums: VideoAlbum[];
  /** Counted from the videos ON THE PAGE, so a filter never offers an empty
   * choice. */
  facets: {
    days: { day: string; count: number }[];
    tags: { tag: string; count: number }[];
    schools: { id: string; name: string; crest: string; count: number }[];
  };
  totals: { albums: number; videos: number };
}

export interface VideoInput {
  event?: string;
  note?: string;
  youtube_url?: string;
  facebook_url?: string;
  instagram_url?: string;
  played_on?: string | null;
  tags?: string[];
  /** Institution ids of the schools in the footage. */
  schools?: string[];
  position?: number;
}

export const videosApi = {
  /** The host's albums for one tournament (any member may read). */
  albums: (tournamentId: string) =>
    api.get<VideoAlbumsPayload>(`/api/tournaments/${tournamentId}/video-albums/`),
  createAlbum: (tournamentId: string, body: { title: string; description?: string }) =>
    api.post<VideoAlbum>(`/api/tournaments/${tournamentId}/video-albums/`, body),
  updateAlbum: (
    tournamentId: string,
    albumId: string,
    body: { title?: string; description?: string; position?: number },
  ) =>
    api.patch<VideoAlbum>(
      `/api/tournaments/${tournamentId}/video-albums/${albumId}/`,
      body,
    ),
  removeAlbum: (tournamentId: string, albumId: string) =>
    api.delete<{ removed: boolean }>(
      `/api/tournaments/${tournamentId}/video-albums/${albumId}/`,
    ),
  addVideo: (tournamentId: string, albumId: string, body: VideoInput) =>
    api.post<TournamentVideo>(
      `/api/tournaments/${tournamentId}/video-albums/${albumId}/videos/`,
      body,
    ),
  updateVideo: (tournamentId: string, videoId: string, body: VideoInput) =>
    api.patch<TournamentVideo>(
      `/api/tournaments/${tournamentId}/videos/${videoId}/`,
      body,
    ),
  removeVideo: (tournamentId: string, videoId: string) =>
    api.delete<{ removed: boolean }>(
      `/api/tournaments/${tournamentId}/videos/${videoId}/`,
    ),
  /** The public Videos tab (no login). */
  publicVideos: (slug: string, id: string) =>
    api.get<PublicVideosPayload>(
      `/api/public/tournaments/${encodeURIComponent(slug)}/${id}/videos/`,
    ),
};
