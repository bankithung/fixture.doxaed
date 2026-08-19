import { useState } from "react";
import { useParams } from "react-router-dom";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopySetupDialog } from "@/features/fixtures/CopySetupDialog";
import { useFixtureStepStore } from "@/features/fixtures/fixtureStepStore";
import { SetupJourneyHeader } from "@/features/fixtures/SetupJourneyHeader";
import { t } from "@/lib/t";

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
  const { id = "" } = useParams();
  const [copying, setCopying] = useState(false);

  if (!active) return null;

  return (
    <div className="sticky top-14 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="px-4 py-2 sm:px-6 lg:px-8">
        <SetupJourneyHeader
          step={step}
          activeStep={activeStep}
          doneSteps={doneSteps}
          onStepClick={onStepClick}
          actions={
            id ? (
              // Top right of every setup page, because a host looking for it
              // should not have to know which step it lives under (owner
              // 2026-08-19).
              <Button
                size="sm"
                variant="outline"
                data-testid="open-copy-setup"
                onClick={() => setCopying(true)}
                title={t("Take the rules and timings from another tournament")}
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("Copy rules")}</span>
              </Button>
            ) : null
          }
        />
        {id ? (
          <CopySetupDialog
            tournamentId={id}
            open={copying}
            onClose={() => setCopying(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
