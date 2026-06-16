import { api } from "./client";
import type {
  FormResponseRow,
  FormSchema,
  FormSummary,
} from "@/features/forms/types";

/** Public payload returned by the unauthenticated form endpoints. */
export interface PublicFormPayload {
  form?: {
    id: string;
    title: string;
    description: string;
    schema: FormSchema;
    confirmation_message: string;
  };
  tournament_name: string;
  closed?: boolean;
  /** Present on a closed form: id + whether a public directory exists for it. */
  form_id?: string;
  has_directory?: boolean;
  /**
   * Per-institution bound link extras: `prefill` = initial answers (keyed by the
   * form's own field keys), `locked` = field keys the respondent can't change
   * (hidden; server-authoritative), `bound` = the fixed entity for a banner.
   */
  prefill?: Record<string, unknown>;
  locked?: string[];
  bound?: { institution_id: string; label: string };
  /** Keys of choice fields whose options are competition keys — the renderer
   * scopes them to the selected institution's registered leaves. */
  competition_fields?: string[];
  /** Team forms: each repeatable team group + its team-name child field, for
   * inline duplicate-name validation while typing. */
  team_groups?: { group: string; field: string }[];
  /** True when an authenticated manager loaded the form — the access-code
   * gate is skipped (admin entry path). */
  can_manage?: boolean;
}

export interface CopyableItem {
  id: string;
  title: string;
  purpose: string;
  description?: string;
  tournament_name?: string;
  field_count: number;
  is_template: boolean;
}

export interface DirectoryFilter {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}
export interface DirectoryCompetitionRef {
  leaf_key: string;
  label: string;
}
export interface DirectoryEntry {
  name: string;
  region: string;
  kind: string;
  /** Per-option logo for this institution (from a choice field's option image). */
  logo?: string | null;
  /** The competitions (category leaves) this institution entered (W2-E). */
  competitions: DirectoryCompetitionRef[];
  values: Record<string, unknown>;
}
export interface DirectoryCompetition extends DirectoryCompetitionRef {
  count: number;
}
export interface DirectoryPayload {
  tournament_name: string;
  form_title: string;
  filters: DirectoryFilter[];
  entries: DirectoryEntry[];
  /** Every configured competition with its registration count (W2-E). */
  competitions: DirectoryCompetition[];
  count: number;
  /** Admin's headline-KPI choice: total + per-game (default) or total only. */
  kpi_mode?: "games" | "total";
  /** Admin-set custom names per game (sport key → display label); the sport
   *  name is used as the default when a key is absent. */
  kpi_labels?: Record<string, string>;
  /** True while the form still accepts submissions (drives the register CTA). */
  form_open?: boolean;
}

export type FormUpdateBody = Partial<
  Pick<
    FormSummary,
    | "title"
    | "description"
    | "schema"
    | "closes_at"
    | "opens_at"
    | "confirmation_message"
    | "settings"
  >
>;

/**
 * Typed client for all `/api/forms` + `/api/tournaments/<id>/forms/`
 * endpoints (backend Increments 1–5). Mirrors `apps/forms/urls.py` exactly,
 * including the `:action` URL suffixes (publish/close/duplicate/send-stage2).
 */
export const formsApi = {
  list: (tournamentId: string) =>
    api.get<FormSummary[]>(`/api/tournaments/${tournamentId}/forms/`),
  create: (
    tournamentId: string,
    body: { title: string; purpose: string; stage?: string; source_form_id?: string },
  ) => api.post<FormSummary>(`/api/tournaments/${tournamentId}/forms/`, body),
  /** Auto-generate a draft team-registration form from the org-reg categories. */
  generateTeamForm: (tournamentId: string) =>
    api.post<FormSummary>(`/api/tournaments/${tournamentId}/forms/generate-team/`, {}),
  /** Auto-generate a draft institution form from the tournament's chosen sports. */
  generateInstitutionForm: (tournamentId: string) =>
    api.post<FormSummary>(
      `/api/tournaments/${tournamentId}/forms/generate-institution/`,
      {},
    ),
  /** Built-in templates + every form the user can access, for the copy picker. */
  copyable: () =>
    api.get<{ templates: CopyableItem[]; forms: CopyableItem[] }>(`/api/forms/copyable/`),
  /** Replace a form's schema (+bindings) from a template or another form. */
  copyFrom: (
    formId: string,
    body: { template_id?: string; source_form_id?: string },
  ) => api.post<FormSummary>(`/api/forms/${formId}:copy-from/`, body),
  get: (formId: string) => api.get<FormSummary>(`/api/forms/${formId}/`),
  update: (formId: string, body: FormUpdateBody) =>
    api.patch<FormSummary>(`/api/forms/${formId}/`, body),
  /** Soft-delete a form (DELETE /api/forms/{id}/ → sets deleted_at). */
  remove: (formId: string) => api.delete<void>(`/api/forms/${formId}/`),
  publish: (formId: string) =>
    api.post<FormSummary>(`/api/forms/${formId}:publish/`, {}),
  /** Rebuild a GENERATED form from the tournament's current categories. */
  regenerate: (formId: string) =>
    api.post<FormSummary>(`/api/forms/${formId}:regenerate/`, {}),
  close: (formId: string) =>
    api.post<FormSummary>(`/api/forms/${formId}:close/`, {}),
  duplicate: (formId: string) =>
    api.post<FormSummary>(`/api/forms/${formId}:duplicate/`, {}),
  fieldTypes: () =>
    api.get<{ type: string; has_options: boolean }[]>(
      `/api/forms/field-types/`,
    ),
  responses: (formId: string) =>
    api.get<FormResponseRow[]>(`/api/forms/${formId}/responses/`),
  setResponseStatus: (formId: string, rid: string, status: string) =>
    api.patch<FormResponseRow>(`/api/forms/${formId}/responses/${rid}/`, {
      status,
    }),
  sendStage2: (formId: string, targetFormId: string) =>
    api.post<{
      sent: number;
      links: { response_id: string; email: string; path: string }[];
    }>(`/api/forms/${formId}:send-stage2/`, { target_form_id: targetFormId }),
  /**
   * Mint a bound, prefilled share link per registered institution for this team
   * form (POST /api/forms/{id}:institution-links/). Idempotent; only newly-minted
   * links carry a `path` (tokens are hashed at rest).
   */
  institutionLinks: (formId: string) =>
    api.post<{
      minted: number;
      total: number;
      links: {
        institution_id: string;
        name: string;
        minted: boolean;
        path?: string;
      }[];
    }>(`/api/forms/${formId}:institution-links/`, {}),
  // Public (unauthenticated) endpoints — used by the renderer (Increment 7).
  publicGet: (formId: string) =>
    api.get<PublicFormPayload>(`/api/forms/${formId}/public/`),
  /** Exchange (institution, access code) for a signed token + prior answers. */
  teamAccess: (formId: string, body: { institution_id: string; code: string }) =>
    api.post<{
      access_token: string;
      expires_in: number;
      editing: boolean;
      prefill: Record<string, unknown> | null;
    }>(`/api/forms/${formId}/team-access/`, body),
  publicSubmit: (
    formId: string,
    body: {
      answers: Record<string, unknown>;
      event_id: string;
      upload_refs?: Record<string, string>;
      access_token?: string;
    },
  ) =>
    api.post<{ response_id: string; message: string }>(
      `/api/forms/${formId}/public/`,
      body,
    ),
  /**
   * Stage a file for a public submission. Multipart `file` + `field_key`;
   * returns the `upload_ref` the renderer collects into `upload_refs` and
   * passes on submit (the backend then claims the unattached upload row).
   */
  publicUpload: (formId: string, fieldKey: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("field_key", fieldKey);
    return api.post<{ upload_ref: string }>(
      `/api/forms/${formId}/uploads/`,
      fd,
    );
  },
  /** Public visitor sends a message to the tournament organisers. */
  contactAdmin: (
    formId: string,
    body: { name: string; email: string; message: string },
  ) => api.post<{ sent: boolean }>(`/api/forms/${formId}/contact/`, body),
  /** Public directory of institutions registered through an org-reg form. */
  directory: (formId: string) =>
    api.get<DirectoryPayload>(`/api/forms/${formId}/directory/`),
  publicGetByToken: (token: string) =>
    api.get<PublicFormPayload>(`/api/forms/r/${token}/`),
  publicSubmitByToken: (
    token: string,
    body: {
      answers: Record<string, unknown>;
      event_id: string;
      upload_refs?: Record<string, string>;
    },
  ) =>
    api.post<{ response_id: string; message: string }>(
      `/api/forms/r/${token}/`,
      body,
    ),
  csvUrl: (formId: string) => `/api/forms/${formId}/responses/?export=csv`,
};
