import { Link } from "react-router-dom";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { ShareButton } from "./ShareButton";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

type Tab = "schedule" | "live" | "bracket";

/** The three public-viewer tabs (Schedule / Live / Bracket). Standalone so the
 * existing schedule page can mount it under its own richer header. */
export function PublicViewerTabs({
  slug,
  id,
  active,
}: {
  slug: string;
  id: string;
  active: Tab;
}): React.ReactElement {
  const tabs: { key: Tab; label: string; to: string }[] = [
    { key: "schedule", label: t("Schedule"), to: routes.publicSchedule(slug, id) },
    { key: "live", label: t("Live"), to: routes.publicLive(slug, id) },
    { key: "bracket", label: t("Bracket"), to: routes.publicBracket(slug, id) },
  ];
  return (
    <nav className="flex gap-1" aria-label={t("Tournament views")}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          aria-current={tab.key === active ? "page" : undefined}
          data-testid={`viewer-tab-${tab.key}`}
          className={cn(
            "rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            tab.key === active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Shared chrome for the public, login-free tournament viewer pages (schedule,
 * live scoreboard, bracket). Brand + tournament name + the three tabs + a
 * "Live" badge that lights when the SSE tick stream is connected. Lives outside
 * the authenticated AppShell, exactly like the /m/ match viewer.
 */
export function PublicViewerHeader({
  slug,
  id,
  tournamentName,
  active,
  connected,
}: {
  slug: string;
  id: string;
  tournamentName: string | undefined;
  active: Tab;
  connected: boolean;
}): React.ReactElement {
  return (
    <header className="sticky top-0 z-10 flex flex-col gap-2 border-b border-border bg-card px-4 pt-3 print:hidden sm:px-6">
      <div className="flex items-center gap-2">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <span className="ml-2 min-w-0 truncate text-sm text-muted-foreground">
          {tournamentName ?? ""}
        </span>
        {connected ? (
          <span
            className="ml-auto flex items-center gap-1.5 text-xs font-medium text-success"
            data-testid="live-connected"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {t("Live updates")}
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        <ShareButton title={tournamentName} />
        <ThemeToggle />
      </div>
      <PublicViewerTabs slug={slug} id={id} active={active} />
    </header>
  );
}
