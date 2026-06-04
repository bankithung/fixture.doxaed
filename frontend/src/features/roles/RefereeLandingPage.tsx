import { ClipboardCheck, Timer, Flag, FileWarning } from "lucide-react";
import { RoleLandingShell } from "./RoleLandingShell";
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
      heroSubtitle={t("Your referee console activates in Phase 1B.")}
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
