import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../authStore";
import { authApi } from "@/api/auth";
import type { User } from "@/types/user";

const mockUser: User = {
  id: "u1",
  email: "owner@example.com",
  name: "Org Owner",
  is_superuser: false,
  has_2fa_enrolled: false,
  twofa_enrolled_at: null,
  email_verified_at: "2025-01-01T00:00:00Z",
  last_active_org_id: "o1",
  last_active_org_slug: "acme",
  deleted_at: null,
  memberships: [
    {
      org_id: "o1",
      org_slug: "acme",
      org_name: "Acme",
      roles: ["admin"],
      is_org_owner: true,
      effective_modules: ["org.settings"],
    },
  ],
};

beforeEach(() => {
  // Reset Zustand store between tests.
  useAuthStore.getState().clear();
  useAuthStore.setState({ bootstrapped: false, error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("authStore.login", () => {
  it("sets user on direct (non-2FA) login success", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({ user: mockUser });
    const res = await useAuthStore
      .getState()
      .login({ email: "x", password: "y" });
    expect(res.requires_2fa).toBe(false);
    expect(useAuthStore.getState().user).toEqual(mockUser);
    expect(useAuthStore.getState().requires2FA).toBe(false);
  });

  it("falls back to /me/ when login response omits user", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({});
    vi.spyOn(authApi, "me").mockResolvedValue(mockUser);
    await useAuthStore.getState().login({ email: "x", password: "y" });
    expect(useAuthStore.getState().user).toEqual(mockUser);
  });

  it("flags requires2FA without setting user when backend asks", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({ requires_2fa: true });
    const res = await useAuthStore
      .getState()
      .login({ email: "x", password: "y" });
    expect(res.requires_2fa).toBe(true);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().requires2FA).toBe(true);
  });

  it("logout clears state even if server call fails", async () => {
    useAuthStore.setState({ user: mockUser, requires2FA: false });
    vi.spyOn(authApi, "logout").mockRejectedValue(new Error("net"));
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("completeTotp re-calls login with totp_code and sets user", async () => {
    // First leg: requires_2fa true (stashes credentials).
    const loginSpy = vi
      .spyOn(authApi, "login")
      .mockResolvedValueOnce({ requires_2fa: true })
      .mockResolvedValueOnce({ user: mockUser });
    await useAuthStore
      .getState()
      .login({ email: "x@example.com", password: "y" });
    expect(useAuthStore.getState().requires2FA).toBe(true);

    // Second leg: completeTotp should re-call /login/ with totp_code.
    await useAuthStore.getState().completeTotp("123456");
    expect(loginSpy).toHaveBeenLastCalledWith({
      email: "x@example.com",
      password: "y",
      totp_code: "123456",
    });
    expect(useAuthStore.getState().user).toEqual(mockUser);
    expect(useAuthStore.getState().requires2FA).toBe(false);
  });
});
