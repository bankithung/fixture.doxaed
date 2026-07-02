import { RoleLandingShell } from "./RoleLandingShell";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Referee landing for `/o/:orgSlug/referee`. Officiating happens in each
 * fixture's Live console (cards, fouls, and match-clock transitions are
 * built) — this page points referees at the tournaments they're assigned to.
 */
export function RefereeLandingPage(): React.ReactElement {
  return (
    <RoleLandingShell
      ariaLabel={t("Referee landing")}
      heroTitle={t("Welcome, Referee")}
      heroSubtitle={t(
        "Open a tournament you're assigned to, then open a fixture's Live console to log cards and fouls and control the match clock as it happens.",
      )}
      availableNow={{
        title: t("Officiate live matches"),
        description: t(
          "Pick a fixture and open its Live console · record cards and fouls per player and run the match through its periods.",
        ),
        href: routes.tournaments(),
        cta: t("Open your tournaments"),
      }}
      tiles={[]}
    />
  );
}
