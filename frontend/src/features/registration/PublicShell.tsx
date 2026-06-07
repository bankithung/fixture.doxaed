import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Lightweight public chrome for standalone, unauthenticated pages (they live
 * OUTSIDE the authenticated AppShell). A trustworthy branded top bar over a
 * muted backdrop so respondents know who they're registering with.
 *
 * Shared by the team-registration link page (`/register/:token`) and the
 * data-driven form renderer (`/f/:formId`, `/r/:token`).
 */
export function PublicShell({
  children,
  tournamentName,
}: {
  children: React.ReactNode;
  tournamentName?: string;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground"
          >
            F
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {t("Fixture Platform")}
          </span>
          {tournamentName ? (
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {tournamentName}
            </span>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}

/** Centered focal card for terminal states (success / closed / invalid link). */
export function Centered({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div
        className={cn(
          "w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm",
        )}
      >
        {children}
      </div>
    </div>
  );
}
