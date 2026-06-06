import { Activity, ClipboardList, RefreshCw, Download } from "lucide-react";
import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Phase 1A placeholder for `/o/:orgSlug/scoring`.
 *
 * Match-scorers can sign in but Phase 1A has no Tournament / Match data,
 * so we render a "what's coming" preview rather than an empty console.
 * The route activates with real functionality in Phase 1B.
 */
export function ScorerLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Match scorer landing")}
      heroTitle={t("Welcome, Match scorer")}
      heroSubtitle={t(
        "You can record match scores today — open a match's Live console to log goals and cards as they happen.",
      )}
      availableNow={{
        title: t("Score matches now"),
        description: t(
          "Open a tournament you're assigned to, then enter scores on its fixtures.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[
        {
          icon: Activity,
          title: t("Live scorebox"),
          description: t(
            "Tap-fast goal, shot, and save logger with optimistic offline queue.",
          ),
        },
        {
          icon: ClipboardList,
          title: t("Set-piece logger"),
          description: t(
            "Record corners, free kicks, and penalties tied to the match clock.",
          ),
        },
        {
          icon: RefreshCw,
          title: t("Substitution tracker"),
          description: t(
            "Manage on/off changes with squad cap warnings and conflict checks.",
          ),
        },
        {
          icon: Download,
          title: t("Timeline export"),
          description: t(
            "One-click export of the match event timeline for review and sharing.",
          ),
        },
      ]}
    />
  );
}
