import { useParams } from "react-router-dom";
import { FixtureSetupHub } from "@/features/fixtures/FixtureSetupHub";

/**
 * The Fixtures tab is a thin shell around the Fixture Setup hub (fixture-
 * engine redesign §6 screen 1): global setup card, per-competition readiness
 * checklists and the draw/schedule wizards all live in
 * `features/fixtures/FixtureSetupHub`.
 */
export function FixturesTab(): React.ReactElement {
  const { id = "" } = useParams();
  return <FixtureSetupHub tournamentId={id} />;
}
