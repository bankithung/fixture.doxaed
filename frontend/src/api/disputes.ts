import { api } from "./client";

export interface DisputeItem {
  id: string;
  kind: string;
  description: string;
  status: string;
  resolution: string;
  match: string | null;
  match_label?: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export const disputesApi = {
  list: (tournamentId: string) =>
    api.get<DisputeItem[]>(`/api/tournaments/${tournamentId}/disputes/`),
  raise: (
    tournamentId: string,
    payload: {
      kind: string;
      description: string;
      event_id: string;
      match_id?: string;
    },
  ) => api.post<DisputeItem>(`/api/tournaments/${tournamentId}/disputes/`, payload),
  resolve: (id: string, resolution: string) =>
    api.post<DisputeItem>(`/api/disputes/${id}/resolve/`, { resolution }),
  reject: (id: string, resolution: string) =>
    api.post<DisputeItem>(`/api/disputes/${id}/reject/`, { resolution }),
  withdraw: (id: string) =>
    api.post<DisputeItem>(`/api/disputes/${id}/withdraw/`, {}),
};
