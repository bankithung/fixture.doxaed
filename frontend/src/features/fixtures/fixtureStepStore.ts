import { create } from "zustand";
import type { JourneyStep } from "./setupJourney";

type VisibleStep = 1 | 2 | 3 | 4;

interface FixtureStepBarState {
  /** True while the Fixture Setup hub wants the AppShell sticky bar shown (it
   * has readiness data and isn't in the focused Step 1 wizard). The bar renders
   * only while this is set, so it never shows an empty strip before the page
   * loads, while the When & Where wizard owns the page, or after you leave. */
  active: boolean;
  step: JourneyStep;
  activeStep?: VisibleStep;
  doneSteps?: Partial<Record<VisibleStep, boolean>>;
  onStepClick?: (step: VisibleStep) => void;
  publish: (s: {
    step: JourneyStep;
    activeStep?: VisibleStep;
    doneSteps?: Partial<Record<VisibleStep, boolean>>;
    onStepClick?: (step: VisibleStep) => void;
  }) => void;
  clear: () => void;
}

/**
 * Bridges the Fixture Setup hub's journey state UP to the AppShell sticky
 * sub-toolbar — the SAME placement as the Sports page's step bar (pinned under
 * the top bar, above the page title, left-aligned). React context flows down,
 * not up, and the hub owns all the state + logic; so it simply publishes the
 * four `SetupJourneyHeader` props here, and `FixtureStepBar` (rendered by
 * AppShell) reads them. The Step 1 "When & Where" wizard is a focused full-page
 * experience with its OWN left stepper, so the hub stops publishing (clears)
 * while it's open. Clearing on unmount hides the bar when you leave Fixtures.
 */
export const useFixtureStepStore = create<FixtureStepBarState>((set) => ({
  active: false,
  step: 1,
  publish: (s) => set({ ...s, active: true }),
  clear: () =>
    set({
      active: false,
      activeStep: undefined,
      doneSteps: undefined,
      onStepClick: undefined,
    }),
}));
