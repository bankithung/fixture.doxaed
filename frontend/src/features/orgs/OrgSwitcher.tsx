import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useAuthStore } from "@/features/auth/authStore";
import { useOrgSwitcher } from "./OrgSwitcherStore";
import { authApi } from "@/api/auth";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";
import type { OrgMembership, Role } from "@/types/user";

/**
 * Org + role switcher (Appendix B.20 + §2.7).
 *
 * Switching org → navigate to /o/{newSlug}/dashboard, then PATCH /me/
 * with `last_active_org_id` so the next reload (no slug in URL) lands
 * on the correct org. Failures are non-blocking — server-side persistence
 * is best-effort.
 */
export function OrgSwitcher(): React.ReactElement | null {
  const user = useAuthStore((s) => s.user);
  const currentSlug = useOrgSwitcher((s) => s.currentSlug);
  const activeRole = useOrgSwitcher((s) => s.activeRole);
  const setActiveRole = useOrgSwitcher((s) => s.setActiveRole);
  const navigate = useNavigate();

  const persistLastActive = useMutation({
    mutationFn: (orgId: string) =>
      authApi.patchMe({ last_active_org_id: orgId }),
  });

  const memberships = user?.memberships ?? [];
  if (!user || memberships.length === 0) return null;

  const current =
    memberships.find((m) => m.org_slug === currentSlug) ?? memberships[0];
  const currentRoles = current.roles ?? [];

  const onPickOrg = (m: OrgMembership): void => {
    if (m.org_slug === current.org_slug) return;
    navigate(routes.orgDashboard(m.org_slug));
    persistLastActive.mutate(m.org_id);
  };

  const onPickRole = (r: Role): void => {
    setActiveRole(r);
  };

  return (
    <div className="flex items-center gap-3">
      <label htmlFor="org-switcher" className="sr-only">
        {t("Active organization")}
      </label>
      <select
        id="org-switcher"
        value={current.org_slug}
        onChange={(e) => {
          const next = memberships.find(
            (m) => m.org_slug === e.target.value,
          );
          if (next) onPickOrg(next);
        }}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        {memberships.map((m) => (
          <option key={m.org_id} value={m.org_slug}>
            {m.org_name}
          </option>
        ))}
      </select>
      {currentRoles.length > 1 ? (
        <div
          role="radiogroup"
          aria-label={t("Active role view")}
          className="flex items-center gap-1 rounded-md border bg-muted p-0.5 text-xs"
        >
          {currentRoles.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={(activeRole ?? currentRoles[0]) === r}
              onClick={() => onPickRole(r)}
              className={cn(
                "rounded px-2 py-1",
                (activeRole ?? currentRoles[0]) === r
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
