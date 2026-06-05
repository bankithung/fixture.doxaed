import { Users, UserPlus, ListChecks, ShieldAlert } from "lucide-react";
import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Phase 1A placeholder for `/o/:orgSlug/team`.
 *
 * Team managers can sign in but Phase 1A has no Tournament / Player
 * registrations to surface; this page previews the Phase 1B team console.
 */
export function TeamManagerLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Team manager landing")}
      heroTitle={t("Welcome, Team manager")}
      heroSubtitle={t(
        "You can register your teams and players today via a tournament's shared link. The full team console below arrives in Phase 1B.",
      )}
      availableNow={{
        title: t("Register & manage teams"),
        description: t(
          "Open your tournaments to view teams, fixtures, and standings.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[
        {
          icon: Users,
          title: t("Roster management"),
          description: t(
            "Maintain your squad list and roles across the season.",
          ),
        },
        {
          icon: UserPlus,
          title: t("Player registration"),
          description: t(
            "Register Persons as Players for each tournament with eligibility checks.",
          ),
        },
        {
          icon: ListChecks,
          title: t("Lineup submission"),
          description: t(
            "Submit starting XI and substitutes ahead of kickoff deadlines.",
          ),
        },
        {
          icon: ShieldAlert,
          title: t("Suspension tracking"),
          description: t(
            "See active and upcoming suspensions auto-derived from match cards.",
          ),
        },
      ]}
    />
  );
}
