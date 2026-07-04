import { api } from "./client";
import { newEventId } from "@/lib/eventId";

/**
 * Institution-operator seasons / houses / house-points API (P4).
 *
 * All endpoints are org-UUID routed (`/api/orgs/{uuid}/seasons/...`; see
 * `backend/apps/teams/views_houses.py`). Reads are member-visible; writes
 * require an org admin or co-organizer. The two ledger writes (judged awards
 * and meet results) mint a client `event_id` at call time (invariant 3:
 * idempotent writes) via `newEventId`.
 */

export interface Season {
  id: string;
  label: string;
  starts_on: string | null;
  ends_on: string | null;
  is_current: boolean;
}

export interface SeasonInput {
  label: string;
  starts_on?: string | null;
  ends_on?: string | null;
  is_current?: boolean;
}

/** `TeamGroupKind` on the backend. */
export type GroupKind = "house" | "class" | "form" | "department";

export interface HouseGroup {
  id: string;
  name: string;
  kind: GroupKind;
  colour: string;
}

export interface GroupInput {
  name: string;
  kind: GroupKind;
  colour?: string;
}

/** One ranked row of `season_house_table` (groups with no entries are 0). */
export interface HouseTableRow {
  group_id: string;
  name: string;
  kind: GroupKind;
  colour: string;
  points: number;
  entries: number;
}

export interface HouseTableResponse {
  season: Season;
  table: HouseTableRow[];
}

export interface AwardPointsInput {
  group_id: string;
  /** -999..999; negatives append corrections (the ledger never edits). */
  points: number;
  reason: string;
  source?: "judged" | "result";
}

export interface MeetResultInput {
  event_label: string;
  /** Ordered group ids, WINNER FIRST. */
  placements: string[];
  relay?: boolean;
  /** Custom points ladder by place; default 7-5-4-3-2-1 (x2 for relays). */
  place_points?: number[];
}

export interface MeetResultResponse {
  entries: number;
  table: HouseTableRow[];
}

export const housesApi = {
  /** `GET /api/orgs/{uuid}/seasons/` */
  seasons: (orgId: string) =>
    api.get<{ seasons: Season[] }>(`/api/orgs/${orgId}/seasons/`),
  /** `POST /api/orgs/{uuid}/seasons/` (manager only). */
  createSeason: (orgId: string, body: SeasonInput) =>
    api.post<Season>(`/api/orgs/${orgId}/seasons/`, body),
  /** `GET /api/orgs/{uuid}/seasons/{sid}/groups/` */
  groups: (orgId: string, seasonId: string) =>
    api.get<{ groups: HouseGroup[] }>(
      `/api/orgs/${orgId}/seasons/${seasonId}/groups/`,
    ),
  /** `POST /api/orgs/{uuid}/seasons/{sid}/groups/` (manager only). */
  createGroup: (orgId: string, seasonId: string, body: GroupInput) =>
    api.post<HouseGroup>(
      `/api/orgs/${orgId}/seasons/${seasonId}/groups/`,
      body,
    ),
  /** `GET /api/orgs/{uuid}/seasons/{sid}/house-table/` — the live board. */
  houseTable: (orgId: string, seasonId: string) =>
    api.get<HouseTableResponse>(
      `/api/orgs/${orgId}/seasons/${seasonId}/house-table/`,
    ),
  /** `POST .../house-points/` — append one judged award (idempotent). */
  awardPoints: (orgId: string, seasonId: string, body: AwardPointsInput) =>
    api.post<{ id: string; points: number; group_id: string }>(
      `/api/orgs/${orgId}/seasons/${seasonId}/house-points/`,
      { ...body, event_id: newEventId() },
    ),
  /** `POST .../meet-results/` — one event's placement ladder (idempotent). */
  recordMeetResult: (orgId: string, seasonId: string, body: MeetResultInput) =>
    api.post<MeetResultResponse>(
      `/api/orgs/${orgId}/seasons/${seasonId}/meet-results/`,
      { ...body, event_id: newEventId() },
    ),
};
