import { api } from "./client";

export interface RegLinkInfo {
  tournament_name: string;
  tournament_id: string;
}
export interface RegPlayer {
  full_name: string;
  jersey_no?: number;
  position?: string;
  dob_year?: number;
  is_goalkeeper?: boolean;
  captain?: boolean;
}
export interface RegTeam {
  name: string;
  short_name?: string;
  players: RegPlayer[];
}
export interface RegSubmission {
  school_name: string;
  teams: RegTeam[];
  event_id?: string;
}

export const registrationApi = {
  /** Public: resolve a shareable registration link to its tournament. */
  info: (token: string) => api.get<RegLinkInfo>(`/api/register/${token}/`),
  /** Public: a school submits its teams + players via the link. */
  submit: (token: string, payload: RegSubmission) =>
    api.post<{ registered: number; teams: string[] }>(
      `/api/register/${token}/`,
      payload,
    ),
  /** Organizer: mint a shareable registration link for a tournament. */
  createLink: (tournamentId: string, label?: string) =>
    api.post<{ token: string; path: string; tournament_id: string }>(
      `/api/tournaments/${tournamentId}/registration-link/`,
      { label: label ?? "" },
    ),
};
