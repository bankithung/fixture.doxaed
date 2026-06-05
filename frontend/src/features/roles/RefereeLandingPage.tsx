import { ClipboardCheck, Timer, Flag, FileWarning } from "lucide-react";
import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Phase 1A placeholder for `/o/:orgSlug/referee`.
 *
 * Referees can sign in but Phase 1A has no live matches; this page
 * previews the Phase 1B referee console.
 */
export function RefereeLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Referee landing")}
      heroTitle={t("Welcome, Referee")}
      heroSubtitle={t(
        "You can view fixtures, results, and standings today. The full referee console below arrives in Phase 1B.",
      )}
      availableNow={{
        title: t("Your tournaments"),
        description: t(
          "View fixtures, results, and standings for tournaments you're part of.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[
        {
          icon: ClipboardCheck,
          title: t("Lineup confirmation"),
          description: t(
            "Verify starters and substitutes before kickoff, with eligibility checks.",
          ),
        },
        {
          icon: Timer,
          title: t("Match clock control"),
          description: t(
            "Start, stop, and add stoppage time with audit-logged transitions.",
          ),
        },
        {
          icon: Flag,
          title: t("Card / foul logger"),
          description: t(
            "Issue yellows, reds, and fouls; suspensions cascade automatically.",
          ),
        },
        {
          icon: FileWarning,
          title: t("Match-incident reports"),
          description: t(
            "File post-match incident reports for disputes and disciplinary review.",
          ),
        },
      ]}
    />
  );
}
