import { Link } from "react-router-dom";
import { cn } from "@/lib/tailwind";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { ClickSpark } from "@/components/backdrop/ClickSpark";
import { BrandLogo } from "@/components/ui/BrandLogo";

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
  wide = false,
}: {
  children: React.ReactNode;
  tournamentName?: string;
  /** Match the top bar to a WIDE content column (e.g. the directory's
   * max-w-6xl) instead of the form page's narrow max-w-3xl. */
  wide?: boolean;
}): React.ReactElement {
  return (
    // Same ground as the admin shell: token background + the PixelBlast
    // backdrop (self-disabled on phones / reduced motion), so public pages
    // stop looking like a different product (owner 2026-07-05).
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur">
        <div
          className={cn(
            "mx-auto flex w-full items-center gap-2 px-4 py-3 sm:px-6",
            wide ? "max-w-6xl" : "max-w-3xl",
          )}
        >
          {/* Home link: `/` shows the landing page for anonymous visitors
              and bounces authenticated users to their dashboard. */}
          <Link
            to={routes.landing()}
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("DoxaEd Fixture · home")}
          >
            <BrandLogo className="h-7 w-7" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              {t("DoxaEd Fixture")}
            </span>
          </Link>
          {tournamentName ? (
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {tournamentName}
            </span>
          ) : null}
        </div>
      </header>
      {/* Same click feedback as the admin shell: violet sparks on tap. */}
      <ClickSpark>{children}</ClickSpark>
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
