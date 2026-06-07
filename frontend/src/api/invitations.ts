import { api } from "./client";

/**
 * A pending invitation addressed to the *current* user, as returned by
 * `GET /api/invitations/` (Increment 13). The list is the signed-in user's
 * PENDING invites only; `tournament_id`/`tournament_name` are null for
 * org-level invites.
 */
export interface MyInvitation {
  id: string;
  email: string;
  /** One of the 6 tournament roles (snake_case). */
  role: string;
  status: string;
  organization_name: string;
  /** Null for org-level invites. */
  tournament_id: string | null;
  /** Null for org-level invites. */
  tournament_name: string | null;
  invited_by_email: string;
  expires_at: string;
  created_at: string;
}

/** Response of `POST /api/invitations/{id}:accept/`. */
export interface AcceptInvitationResponse {
  membership_id: string;
  tournament_id?: string | null;
  role: string;
  status: "accepted";
}

/** Response of `POST /api/invitations/{id}:decline/`. */
export interface DeclineInvitationResponse {
  status: "declined";
}

export const invitationsApi = {
  /** The current user's pending invitations (email-scoped on the server). */
  myInvitations: () => api.get<MyInvitation[]>("/api/invitations/"),
  /**
   * Accept an invitation (email-verified server-side). Returns the created
   * membership; `tournament_id` is present for tournament-scoped invites.
   */
  acceptInvitation: (id: string) =>
    api.post<AcceptInvitationResponse>(
      `/api/invitations/${encodeURIComponent(id)}:accept/`,
    ),
  /** Decline an invitation. */
  declineInvitation: (id: string) =>
    api.post<DeclineInvitationResponse>(
      `/api/invitations/${encodeURIComponent(id)}:decline/`,
    ),
};
