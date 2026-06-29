import { useFixtureStepStore } from "@/features/fixtures/fixtureStepStore";
import { SetupJourneyHeader } from "@/features/fixtures/SetupJourneyHeader";

/**
 * Sticky sub-toolbar pinned just under the global top bar while you're on the
 * Fixtures setup page (AppShell renders it only there) — the SAME placement and
 * left-aligned layout as the Sports page's SportsStepBar. It renders the hub's
 * four-step journey (When & where -> Clashes & sessions -> How each competition
 * plays -> Preview & publish), which the FixtureSetupHub publishes into
 * `useFixtureStepStore`. Frosted to match the top bar; returns null until the
 * hub publishes (so it never flashes an empty bar, and stays hidden while the
 * focused Step 1 wizard owns the page).
 */
export function FixtureStepBar(): React.ReactElement | null {
  const active = useFixtureStepStore((s) => s.active);
  const step = useFixtureStepStore((s) => s.step);
  const activeStep = useFixtureStepStore((s) => s.activeStep);
  const doneSteps = useFixtureStepStore((s) => s.doneSteps);
  const onStepClick = useFixtureStepStore((s) => s.onStepClick);

  if (!active) return null;

  return (
    <div className="sticky top-14 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="px-4 py-2.5 sm:px-6 lg:px-8">
        <SetupJourneyHeader
          step={step}
          activeStep={activeStep}
          doneSteps={doneSteps}
          onStepClick={onStepClick}
        />
      </div>
    </div>
  );
}
