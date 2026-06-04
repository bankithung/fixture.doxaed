/**
 * DRF response shapes shared across feature folders.
 */

export interface ApiErrorPayload {
  detail?: string;
  code?: string;
  /** DRF field-level errors: `{ field: [msg, ...] }`. */
  [field: string]: unknown;
}

export class ApiError extends Error {
  status: number;
  payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload, message?: string) {
    super(message ?? payload.detail ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }

  /** Backend signals "we accept this user, but verb requires fresh password". */
  get isPasswordReauthRequired(): boolean {
    return (
      this.status === 403 &&
      (this.payload.detail === "password_reauth_required" ||
        this.payload.code === "password_reauth_required")
    );
  }

  get isUnauthenticated(): boolean {
    if (this.status === 401) return true;
    if (this.status === 403) {
      const detail =
        typeof this.payload.detail === "string"
          ? this.payload.detail.toLowerCase()
          : "";
      return (
        detail.includes("authentication credentials") ||
        detail.includes("not authenticated")
      );
    }
    return false;
  }
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
