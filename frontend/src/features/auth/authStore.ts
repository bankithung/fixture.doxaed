import { create } from "zustand";
import { authApi, type LoginPayload } from "@/api/auth";
import { ApiError } from "@/types/api";
import type { User } from "@/types/user";

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  /** True when login responds with `requires_2fa: true` and no user yet. */
  requires2FA: boolean;
  /** Last error from a login/bootstrap attempt. */
  error: string | null;
  /** True once we've attempted at least one /me/ hydrate. */
  bootstrapped: boolean;

  bootstrap: () => Promise<void>;
  login: (payload: LoginPayload) => Promise<{ requires_2fa: boolean }>;
  /**
   * Submit a 2FA TOTP code as the second leg of login. Internally re-calls
   * `POST /api/accounts/auth/login/` with `{email, password, totp_code}` —
   * the backend has no separate /challenge endpoint.
   */
  completeTotp: (totp: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Forcibly clear (e.g. on global 401 from queryClient bus). */
  clear: () => void;
  refreshMe: () => Promise<void>;
}

/**
 * Pending login credentials stashed only for the duration of the 2FA
 * challenge. Held in module scope (NOT in zustand state) so they never
 * surface in devtools or persisted state.
 */
let pendingCredentials: { email: string; password: string } | null = null;

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  requires2FA: false,
  error: null,
  bootstrapped: false,

  bootstrap: async () => {
    set({ isLoading: true, error: null });
    try {
      const me = await authApi.me();
      set({ user: me, isLoading: false, bootstrapped: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        set({ user: null, isLoading: false, bootstrapped: true });
        return;
      }
      set({
        user: null,
        isLoading: false,
        bootstrapped: true,
        error: e instanceof Error ? e.message : "Bootstrap failed",
      });
    }
  },

  login: async (payload) => {
    set({ isLoading: true, error: null, requires2FA: false });
    try {
      const res = await authApi.login(payload);
      if (res.requires_2fa) {
        // Stash credentials for the totp re-call. Clearing `user` avoids
        // a stale identity remaining visible while the TOTP gate is open.
        pendingCredentials = {
          email: payload.email,
          password: payload.password,
        };
        set({
          user: null,
          requires2FA: true,
          isLoading: false,
          bootstrapped: true,
        });
        return { requires_2fa: true };
      }
      // Either response carried the user or we re-fetch.
      const user = res.user ?? (await authApi.me());
      pendingCredentials = null;
      set({
        user,
        isLoading: false,
        requires2FA: false,
        bootstrapped: true,
      });
      return { requires_2fa: false };
    } catch (e) {
      set({
        isLoading: false,
        error:
          e instanceof ApiError
            ? (e.payload.detail ?? "Login failed")
            : e instanceof Error
              ? e.message
              : "Login failed",
      });
      throw e;
    }
  },

  completeTotp: async (totp) => {
    if (!pendingCredentials) {
      // No active 2FA challenge. Treat as protocol error.
      set({ error: "Session expired. Sign in again." });
      throw new Error("no_pending_credentials");
    }
    set({ isLoading: true, error: null });
    try {
      const res = await authApi.login({
        email: pendingCredentials.email,
        password: pendingCredentials.password,
        totp_code: totp,
      });
      const user = res.user ?? (await authApi.me());
      pendingCredentials = null;
      set({
        user,
        isLoading: false,
        requires2FA: false,
        bootstrapped: true,
      });
    } catch (e) {
      set({
        isLoading: false,
        error:
          e instanceof ApiError
            ? (e.payload.detail ?? "Invalid code")
            : "Invalid code",
      });
      throw e;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // even on transport failure clear local state
    }
    pendingCredentials = null;
    set({
      user: null,
      requires2FA: false,
      error: null,
      isLoading: false,
    });
  },

  clear: () => {
    pendingCredentials = null;
    set({ user: null, requires2FA: false, error: null, isLoading: false });
  },

  refreshMe: async () => {
    try {
      const me = await authApi.me();
      set({ user: me });
    } catch {
      // swallow; bus will fire on 401
    }
  },
}));
