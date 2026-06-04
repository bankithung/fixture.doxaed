import { api } from "./client";
import type { components } from "@/types/api.generated";

export type AuditEvent = components["schemas"]["AuditEvent"];
export type AuditEventListResponse =
  components["schemas"]["AuditEventListResponse"];

export interface AuditListParams {
  cursor?: string;
  actor_id?: string;
  event_type?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function buildQuery(params: AuditListParams): string {
  const usp = new URLSearchParams();
  if (params.cursor) usp.set("cursor", params.cursor);
  if (params.actor_id) usp.set("actor_id", params.actor_id);
  if (params.event_type) usp.set("event_type", params.event_type);
  if (params.from) usp.set("from", params.from);
  if (params.to) usp.set("to", params.to);
  if (params.limit) usp.set("limit", String(params.limit));
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export const auditApi = {
  list: (slug: string, params: AuditListParams = {}) =>
    api.get<AuditEventListResponse>(
      `/api/audit/orgs/${encodeURIComponent(slug)}/${buildQuery(params)}`,
    ),
};
