import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useAuthStore } from "@/features/auth/authStore";
import { useOrgSwitcher } from "./OrgSwitcherStore";
import { Select } from "@/components/ui/Select";
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
 * on the correct org. Uses the custom <Select> (no native dropdowns).
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
    <div className="flex items-center gap-2">
      <Select
        value={current.org_slug}
        onChange={(slug) => {
          const next = memberships.find((m) => m.org_slug === slug);
          if (next) onPickOrg(next);
        }}
        options={memberships.map((m) => ({
          value: m.org_slug,
          label: m.org_name,
        }))}
        aria-label={t("Active organization")}
        className="w-36 sm:w-48"
      />
      {currentRoles.length > 1 ? (
        <div
          role="radiogroup"
          aria-label={t("Active role view")}
          className="hidden items-center gap-0.5 rounded-lg border bg-muted p-0.5 text-xs lg:flex"
        >
          {currentRoles.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={(activeRole ?? currentRoles[0]) === r}
              onClick={() => onPickRole(r)}
              className={cn(
                "rounded-md px-2 py-1 capitalize transition-colors",
                (activeRole ?? currentRoles[0]) === r
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
