import { api } from "./client";
import type {
  GrantState,
  ModuleDef,
  ModuleMatrixResponse,
} from "@/types/user";

export const permissionsApi = {
  /** All 22 modules (Appendix A.2 catalog). Standalone catalog endpoint. */
  modules: () => api.get<ModuleDef[]>("/api/permissions/modules/"),

  /** Effective module set for the current user in `slug`. */
  myModules: (slug: string) =>
    api.get<{ modules: string[] }>(`/api/permissions/orgs/${slug}/me/modules/`),

  /**
   * Full per-user override matrix (Appendix B.16). Aggregate response:
   *   { modules: ModuleDef[], members: ModuleMatrixRow[] }
   * — backend returns both halves to avoid a client-side join.
   */
  matrix: (slug: string) =>
    api.get<ModuleMatrixResponse>(
      `/api/permissions/orgs/${slug}/grants/matrix/`,
    ),

  /** Replace all grants for a single user. PUT shape locked by spec. */
  setGrants: (
    slug: string,
    userId: string,
    payload: {
      cells: Record<string, GrantState>;
      reason?: string;
      event_id: string;
    },
  ) =>
    api.put<{ ok: true }>(
      `/api/permissions/orgs/${slug}/users/${userId}/grants/`,
      payload,
    ),
};
