import { Link, Navigate } from "react-router-dom";
import {
  Trophy,
  Calendar,
  Users,
  Activity,
  Shield,
  Sparkles,
  ArrowRight,
  Radio,
  ShieldCheck,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";

/**
 * Public landing page at `/`.
 *
 * - Authenticated user: redirect via `pickLandingPathForUser`, which picks
 *   role-aware destinations (admin/co_organizer/game_coordinator → org
 *   dashboard; match_scorer → /scoring; referee → /referee; team_manager
 *   → /team). This is what makes a `match_scorer` land on the scoring
 *   console instead of a permission-denied dashboard view.
 * - Unauthenticated / not-bootstrapped: render hero + CTAs + roadmap strip.
 *
 * Replaces the previous `RootRedirect` which immediately bounced to /login.
 * The pre-bootstrap render is identical to the unauthenticated render so
 * there is no "Loading..." flash for cold visitors.
 *
 * This is the public marketing surface — it renders OUTSIDE the app shell,
 * so a centered max-width column is intentional here (unlike in-app pages).
 * Colors are token-only (light + dark) so the page tracks the theme.
 */
export function LandingPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);

  // Authenticated → bounce into the app via role-aware helper.
  if (bootstrapped && user) {
    return <Navigate to={pickLandingPathForUser(user)} replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link
            to={routes.landing()}
            className="inline-flex items-center gap-2.5 rounded-sm text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("Fixture Platform — home")}
          >
            <BrandLogo className="h-8 w-8 shadow-sm" />
            <span>{t("Fixture Platform")}</span>
          </Link>
          <nav
            aria-label={t("Primary")}
            className="flex items-center gap-1.5 text-sm sm:gap-2"
          >
            <Link
              to={routes.login()}
              className="rounded-md px-3 py-2 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Sign in")}
            </Link>
            <Link to={routes.signup()}>
              <Button size="sm">{t("Sign up")}</Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60 bg-muted/30">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 right-0 h-72 w-72 rounded-full bg-primary/5 blur-3xl"
        />
        <div className="relative mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
              {t("v1 — Football, Nagaland-first")}
            </p>
            <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
              {t("Sports fixtures, made in Nagaland.")}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              {t(
                "Run tournaments, schedule matches, follow live scores. Built for local sport, football first.",
              )}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={routes.signup()}>
                <Button size="lg" className="gap-2">
                  {t("Create an account")}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Link>
              <Link to={routes.login()}>
                <Button size="lg" variant="outline">
                  {t("Sign in")}
                </Button>
              </Link>
            </div>

            {/* Trust strip */}
            <dl className="mt-12 grid max-w-md grid-cols-3 gap-6">
              <Stat value="10" label={t("sports planned")} />
              <Stat value="100%" label={t("multi-tenant")} />
              <Stat value="24/7" label={t("live scores")} />
            </dl>
          </div>
        </div>
      </section>

      {/* Feature highlights */}
      <section
        aria-labelledby="features-heading"
        className="mx-auto w-full max-w-6xl px-6 py-16"
      >
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Built for the whole tournament")}
        </p>
        <h2
          id="features-heading"
          className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {t("Everything you need to run a competition")}
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={<Users aria-hidden="true" className="h-5 w-5" />}
            title={t("Multi-tenant from day one")}
            body={t(
              "Each organization gets its own workspace, members, and roles. No data crosses tenants.",
            )}
          />
          <Feature
            icon={<Calendar aria-hidden="true" className="h-5 w-5" />}
            title={t("Auto-generated schedules")}
            body={t(
              "Brackets and fixtures generated for you, with conflict warnings and manual overrides.",
            )}
          />
          <Feature
            icon={<Radio aria-hidden="true" className="h-5 w-5" />}
            title={t("Live updates over SSE")}
            body={t(
              "Fans follow live scores instantly. Scorers and referees collaborate without refreshing.",
            )}
          />
          <Feature
            icon={<Trophy aria-hidden="true" className="h-5 w-5" />}
            title={t("Tournaments & live scoring")}
            body={t(
              "Lineups, events, and standings stay in sync from kickoff to full time.",
            )}
          />
          <Feature
            icon={<ShieldCheck aria-hidden="true" className="h-5 w-5" />}
            title={t("Role-based access & audit")}
            body={t(
              "Granular roles, module grants, and an append-only audit trail keep everyone accountable.",
            )}
          />
          <Feature
            icon={<Activity aria-hidden="true" className="h-5 w-5" />}
            title={t("A chassis that scales")}
            body={t(
              "Football first; the same engine extends to volleyball, basketball, archery, and more.",
            )}
          />
        </div>
      </section>

      {/* Roadmap strip */}
      <section
        aria-labelledby="roadmap-heading"
        className="border-t border-border/60 bg-muted/30"
      >
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Roadmap")}
          </p>
          <h2
            id="roadmap-heading"
            className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {t("What's coming")}
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <RoadmapCard
              icon={<Shield aria-hidden="true" className="h-5 w-5" />}
              phase={t("Phase 1A — shipping")}
              title={t("Accounts & organizations")}
              body={t(
                "Sign up, multi-tenant orgs, role-based access, audit, 2FA.",
              )}
              tone="active"
            />
            <RoadmapCard
              icon={<Trophy aria-hidden="true" className="h-5 w-5" />}
              phase={t("Phase 1B — football")}
              title={t("Tournaments & live scoring")}
              body={t(
                "Brackets, schedules, lineups, real-time scoring, public viewer.",
              )}
              tone="next"
            />
            <RoadmapCard
              icon={<Activity aria-hidden="true" className="h-5 w-5" />}
              phase={t("v2 — beyond football")}
              title={t("9 more sports")}
              body={t(
                "The chassis extends to volleyball, basketball, archery, and more.",
              )}
              tone="future"
            />
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <div className="relative overflow-hidden rounded-xl border border-border bg-card p-8 shadow-sm sm:p-12">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
          />
          <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {t("Ready to run your first tournament?")}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {t("Create a free account in minutes.")}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-3">
              <Link to={routes.signup()}>
                <Button size="lg" className="gap-2">
                  {t("Get started")}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Link>
              <Link to={routes.login()}>
                <Button size="lg" variant="outline">
                  {t("Sign in")}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/60 bg-muted/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>{t("© Fixture Platform")}</p>
          <nav aria-label={t("Footer")} className="flex items-center gap-4">
            <Link
              to={routes.about()}
              className="rounded-sm transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("About")}
            </Link>
            <Link
              to={routes.login()}
              className="rounded-sm transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Sign in")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Stat({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.ReactElement {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd className="font-tabular text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </dd>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <article className="rounded-xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md">
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        {icon}
      </span>
      <h3 className="mt-4 text-base font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
    </article>
  );
}

interface RoadmapCardProps {
  icon: React.ReactNode;
  phase: string;
  title: string;
  body: string;
  tone: "active" | "next" | "future";
}

function RoadmapCard({
  icon,
  phase,
  title,
  body,
  tone,
}: RoadmapCardProps): React.ReactElement {
  // Token-only tone map. "active" leads with primary; the rest stay neutral.
  const iconTone: Record<RoadmapCardProps["tone"], string> = {
    active: "bg-primary text-primary-foreground",
    next: "bg-secondary text-secondary-foreground",
    future: "bg-muted text-muted-foreground",
  };
  const phaseTone: Record<RoadmapCardProps["tone"], string> = {
    active: "text-primary",
    next: "text-foreground",
    future: "text-muted-foreground",
  };
  return (
    <article className="flex flex-col rounded-xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-lg",
            iconTone[tone],
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "text-[0.6875rem] font-medium uppercase tracking-[0.1em]",
            phaseTone[tone],
          )}
        >
          {phase}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
    </article>
  );
}
