import { api } from "./client";
import type { User } from "@/types/user";

/**
 * `GET /api/accounts/me/` response shape — identical to the hand-written
 * `User` (which now mirrors `MeSerializer` exactly, including
 * `is_superuser`, `memberships[]`, `last_active_org_slug`,
 * `email_verified_at`, `has_2fa_enrolled`, `deleted_at`).
 */
export type GetMeResponse = User;

/** Body of `POST /api/accounts/auth/login/` (see `LoginSerializer`). */
export interface LoginPayload {
  email: string;
  password: string;
  /**
   * Required only when the user has 2FA enrolled. The backend folds the
   * 2FA "challenge" step into the standard login endpoint — re-call
   * `/login/` with `{email, password, totp_code}` after `requires_2fa`.
   */
  totp_code?: string;
}

export interface LoginResponse {
  /** When true the SPA should prompt for `totp_code` and re-call login. */
  requires_2fa?: boolean;
  user?: User;
}

/** Body of `POST /api/accounts/auth/signup/` (see `SignupSerializer`). */
export interface SignupPayload {
  email: string;
  password: string;
  /** Optional. Backend serializer field is `name`. */
  name: string;
}

/** Body of `PATCH /api/accounts/me/`. Only `name` and `last_active_org_id`
 * are writeable per `MeSerializer.read_only_fields`. */
export type PatchMePayload = Partial<Pick<User, "name" | "last_active_org_id">>;

/** Response of `POST /api/accounts/auth/2fa/enroll/`
 * (see `TwoFAEnrollResponseSerializer`). */
export interface TwoFAEnrollResponse {
  otpauth_uri: string;
  qr_data_uri: string;
  device_id: string;
}

export const authApi = {
  me: () => api.get<GetMeResponse>("/api/accounts/me/"),
  login: (payload: LoginPayload) =>
    api.post<LoginResponse>("/api/accounts/auth/login/", payload),
  logout: () => api.post<void>("/api/accounts/auth/logout/"),
  signup: (payload: SignupPayload) =>
    api.post<{ user: User }>("/api/accounts/auth/signup/", payload),
  verifyEmail: (token: string) =>
    api.post<{ ok: true }>("/api/accounts/auth/verify-email/", { token }),
  passwordResetRequest: (email: string) =>
    api.post<{ ok: true }>("/api/accounts/auth/password-reset-request/", {
      email,
    }),
  passwordResetComplete: (token: string, new_password: string) =>
    api.post<{ ok: true }>("/api/accounts/auth/password-reset-complete/", {
      token,
      new_password,
    }),
  /**
   * Begin TOTP enrolment. Returns the otpauth URI + a QR data-URI
   * (PNG-encoded, ready to drop into <img src=...>) and the device id
   * the subsequent confirm call references implicitly via the session.
   * See `TwoFAEnrollResponseSerializer`.
   */
  totpEnrollBegin: () =>
    api.post<TwoFAEnrollResponse>("/api/accounts/auth/2fa/enroll/"),
  /**
   * Confirm TOTP enrolment with the 6-digit code. Backend serializer
   * (`TwoFAConfirmSerializer`) reads `code` (NOT `totp`) and returns
   * one-time recovery codes.
   */
  totpEnrollConfirm: (code: string) =>
    api.post<{ recovery_codes: string[] }>(
      "/api/accounts/auth/2fa/confirm/",
      { code },
    ),
  /** Re-prompt re-auth (B.18). Returns 200 on success. */
  reauth: (password: string) =>
    api.post<{ ok: true }>("/api/accounts/auth/reauth/", { password }),
  /** PATCH /api/accounts/me/ — used to persist last_active_org_id (B.20). */
  patchMe: (patch: PatchMePayload) =>
    api.patch<User>("/api/accounts/me/", patch),
};
