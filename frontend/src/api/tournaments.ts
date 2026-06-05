import { api } from "./client";

/** Tournament row as returned by `GET /api/tournaments/` and create (201). */
export interface Tournament {
  id: string;
  slug: string;
  name: string;
  status: string;
  organization_slug: string;
  sport_code: string | null;
  time_zone: string;
  created_at: string;
}

export interface TournamentInvitation {
  id: string;
  email: string;
  role: string;
  tournament_id: string;
  status: string;
}

export const tournamentsApi = {
  /** Tournaments the user can access (isolation-scoped on the server). */
  list: () => api.get<Tournament[]>("/api/tournaments/"),
  /**
   * Self-serve create. Auto-provisions a hidden personal workspace if the user
   * has none and makes them the tournament admin. `event_id` is a client UUID
   * for idempotency (invariant 3).
   */
  create: (payload: { name: string; sport_code?: string; event_id: string }) =>
    api.post<Tournament>("/api/tournaments/", payload),
  /** Invite anyone by email to this tournament with a tournament role. */
  invite: (
    tournamentId: string,
    payload: { email: string; role: string; event_id: string },
  ) =>
    api.post<TournamentInvitation>(
      `/api/tournaments/${tournamentId}/invitations/`,
      payload,
    ),
};
