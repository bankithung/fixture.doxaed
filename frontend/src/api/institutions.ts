import { api } from "./client";

export interface Institution {
  id: string;
  name: string;
  short_name: string;
  kind: string;
  region: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  status: string;
  team_count: number;
  /** The registration-form answers that created this row (empty for direct add). */
  answers: Record<string, unknown>;
  /** The competitions (labelled category leaves) the institution entered. */
  competitions?: { leaf_key: string; label: string }[];
}

export interface InstitutionInput {
  name: string;
  kind?: string;
  region?: string;
  short_name?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
}

export const institutionsApi = {
  list: (tournamentId: string) =>
    api.get<Institution[]>(`/api/tournaments/${tournamentId}/institutions/`),
  create: (tournamentId: string, body: InstitutionInput) =>
    api.post<Institution>(`/api/tournaments/${tournamentId}/institutions/`, body),
  update: (tournamentId: string, id: string, body: Partial<Institution>) =>
    api.patch<Institution>(
      `/api/tournaments/${tournamentId}/institutions/${id}/`,
      body,
    ),
  /** Admin direct-add of a team under an institution (Stage-2). */
  addTeam: (
    tournamentId: string,
    body: { institution_id: string; name: string; event_id: string },
  ) =>
    api.post<{ registered: number; teams: string[] }>(
      `/api/tournaments/${tournamentId}/teams/`,
      body,
    ),
};

export const INSTITUTION_KINDS = [
  { value: "school", label: "School" },
  { value: "college", label: "College" },
  { value: "university", label: "University" },
  { value: "club", label: "Club" },
  { value: "academy", label: "Academy" },
  { value: "other", label: "Other" },
] as const;
