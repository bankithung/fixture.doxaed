import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Team-manager landing for `/o/:orgSlug/team`. Teams + players are registered
 * via a tournament's shared registration link; this page points managers at
 * their tournaments to track teams, fixtures, and standings.
 */
export function TeamManagerLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Team manager landing")}
      heroTitle={t("Welcome, Team manager")}
      heroSubtitle={t(
        "Register your teams and players via a tournament's shared link, then track fixtures, results, and standings in your tournaments.",
      )}
      availableNow={{
        title: t("Register & manage teams"),
        description: t(
          "Open your tournaments to view teams, fixtures, and standings.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[]}
    />
  );
}
