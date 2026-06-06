import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Match-scorer landing for `/o/:orgSlug/scoring`. The live console (goals,
 * cards, set-pieces, substitutions, timeline export) is built — this page
 * points scorers at their tournaments, where each fixture opens a Live console.
 */
export function ScorerLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Match scorer landing")}
      heroTitle={t("Welcome, Match scorer")}
      heroSubtitle={t(
        "Open a tournament you're assigned to, then open a fixture's Live console to log goals, cards, set-pieces, and substitutions.",
      )}
      availableNow={{
        title: t("Score matches now"),
        description: t(
          "Pick a fixture and open its Live console — record events per player and export the timeline.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[]}
    />
  );
}
