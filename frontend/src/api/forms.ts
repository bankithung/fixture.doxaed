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
  create: (tournamentId: string, body: { title: string; purpose: string }) =>
    api.post<FormSummary>(`/api/tournaments/${tournamentId}/forms/`, body),
  get: (formId: string) => api.get<FormSummary>(`/api/forms/${formId}/`),
  update: (formId: string, body: FormUpdateBody) =>
    api.patch<FormSummary>(`/api/forms/${formId}/`, body),
  publish: (formId: string) =>
    api.post<FormSummary>(`/api/forms/${formId}:publish/`, {}),
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
  // Public (unauthenticated) endpoints — used by the renderer (Increment 7).
  publicGet: (formId: string) =>
    api.get<PublicFormPayload>(`/api/forms/${formId}/public/`),
  publicSubmit: (
    formId: string,
    body: {
      answers: Record<string, unknown>;
      event_id: string;
      upload_refs?: Record<string, string>;
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
  publicGetByToken: (token: string) =>
    api.get<PublicFormPayload>(`/api/forms/r/${token}/`),
  publicSubmitByToken: (
    token: string,
    body: { answers: Record<string, unknown>; event_id: string },
  ) =>
    api.post<{ response_id: string; message: string }>(
      `/api/forms/r/${token}/`,
      body,
    ),
  csvUrl: (formId: string) => `/api/forms/${formId}/responses/?export=csv`,
};
