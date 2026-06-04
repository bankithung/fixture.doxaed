import { api } from "./client";

/**
 * Personal feedback widget submission (v1Users.md Appendix A.2 module
 * `personal.feedback_widget`). The backend exposes the inbox in the
 * super-admin Django+HTMX surface; this is the SPA-side write path.
 */
export interface FeedbackSubmitPayload {
  /** Free-text body (required). */
  message: string;
  /** Optional category — left open as a string for forward-compat. */
  category?: string;
  /** Optional URL of the page where feedback was triggered. */
  source_url?: string;
  /** Client-generated UUID for idempotent retries (CLAUDE.md invariant 3). */
  event_id?: string;
}

export interface FeedbackSubmitResponse {
  /** Server-assigned id for the persisted feedback row. */
  id?: string;
  ok?: true;
}

export const feedbackApi = {
  /**
   * `POST /api/feedback/submit/` — submit a feedback note.
   *
   * Note: the backend endpoint is being created in parallel; if it is not
   * reachable yet at call time, the underlying `apiFetch` will throw an
   * `ApiError` that the caller surfaces to the user.
   */
  submit: (payload: FeedbackSubmitPayload) =>
    api.post<FeedbackSubmitResponse>("/api/feedback/submit/", payload),
};
