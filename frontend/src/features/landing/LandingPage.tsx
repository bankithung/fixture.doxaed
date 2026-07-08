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
import { StarBorder } from "@/components/ui/StarBorder";
import { BentoGrid, BentoCard } from "@/features/dashboard/BentoCard";
import { useCountUp } from "@/features/dashboard/useCountUp";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import {
  BlurText,
  ShinyText,
  RotatingText,
  Reveal,
  SportsMarquee,
  SPORT_NAMES,
} from "./motion";

/**
 * Public landing page at `/`.
 *
 * - Authenticated user: redirect via `pickLandingPathForUser` (personal
 *   dashboard; roles only matter inside a tournament).
 * - Unauthenticated / not-bootstrapped: render the marketing page. The
 *   pre-bootstrap render is identical to the unauthenticated render so
 *   there is no "Loading..." flash for cold visitors.
 *
 * This is the public marketing surface — it renders OUTSIDE the app shell,
 * so a centered max-width column is intentional here (unlike in-app pages).
 * Colors are token-only (light + dark) so the page tracks the theme. Motion
 * comes from the landing motion kit (./motion) + the reused Bento/StarBorder
 * ports; everything degrades to static under prefers-reduced-motion.
 */
export function LandingPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);

  // Authenticated → bounce into the app.
  if (bootstrapped && user) {
    return <Navigate to={pickLandingPathForUser(user)} replace />;
  }

  return (
    <div className="flex min-h-screen flex-col text-foreground">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <Link
            to={routes.landing()}
            className="inline-flex items-center gap-2.5 rounded-sm text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("Fixture Platform · home")}
          >
            <BrandLogo className="h-8 w-8 shadow-sm" />
            <span>{t("Fixture Platform")}</span>
          </Link>
          <nav
            aria-label={t("Primary")}
            className="flex items-center gap-1.5 text-sm sm:gap-2"
          >
            <Link
              to="/explore"
              className="hidden rounded-md px-3 py-2 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
            >
              {t("Explore")}
            </Link>
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
          className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-primary/10 blur-3xl"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 right-0 h-96 w-96 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative mx-auto w-full max-w-6xl px-6 pb-14 pt-16 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.1fr,0.9fr]">
            {/* Copy column */}
            <div>
              <p className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium">
                <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                <ShinyText text={t("Live now · built in Nagaland")} />
              </p>
              <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
                <BlurText text={t("Sports fixtures, made in Nagaland.")} />
              </h1>
              <p className="mt-4 text-lg font-medium text-muted-foreground sm:text-xl">
                {t("One platform for")}{" "}
                <RotatingText
                  words={SPORT_NAMES}
                  className="font-semibold text-primary"
                />
              </p>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
                {t(
                  "Run tournaments, schedule matches, follow live scores. Built for local sport, football first.",
                )}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/explore">
                  <Button size="lg" className="gap-2">
                    {t("Follow live tournaments")}
                    <ArrowRight aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </Link>
                <Link to={routes.signup()}>
                  <Button size="lg" variant="outline">
                    {t("Organize one")}
                  </Button>
                </Link>
              </div>

              {/* Trust strip */}
              <dl className="mt-12 grid max-w-md grid-cols-3 gap-6">
                <CountStat value={10} label={t("sports on the chassis")} />
                <Stat value="100%" label={t("multi-tenant")} />
                <Stat value="24/7" label={t("live scores")} />
              </dl>
            </div>

            {/* Product showcase column */}
            <HeroShowcase />
          </div>
        </div>

        {/* Sports marquee */}
        <div className="relative border-t border-border/60 bg-background/50 py-4">
          <SportsMarquee className="mx-auto w-full max-w-6xl px-6" />
        </div>
      </section>

      {/* Feature highlights (MagicBento) */}
      <section
        aria-labelledby="features-heading"
        className="mx-auto w-full max-w-6xl px-6 py-16"
      >
        <Reveal>
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Built for the whole tournament")}
          </p>
          <h2
            id="features-heading"
            className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {t("Everything you need to run a competition")}
          </h2>
        </Reveal>
        <BentoGrid className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={<Users aria-hidden="true" className="h-5 w-5" />}
            title={t("Multi-tenant from day one")}
            body={t(
              "Each organization gets its own workspace, members, and roles. No data crosses tenants.",
            )}
            delayMs={0}
          />
          <Feature
            icon={<Calendar aria-hidden="true" className="h-5 w-5" />}
            title={t("Auto-generated schedules")}
            body={t(
              "Brackets and fixtures generated for you, with conflict warnings and manual overrides.",
            )}
            delayMs={60}
          />
          <Feature
            icon={<Radio aria-hidden="true" className="h-5 w-5" />}
            title={t("Live updates, instantly")}
            body={t(
              "Fans follow live scores as they happen. Scorers and referees collaborate without refreshing.",
            )}
            delayMs={120}
            particles
          />
          <Feature
            icon={<Trophy aria-hidden="true" className="h-5 w-5" />}
            title={t("Tournaments & live scoring")}
            body={t(
              "Lineups, events, and standings stay in sync from kickoff to full time.",
            )}
            delayMs={0}
            particles
          />
          <Feature
            icon={<ShieldCheck aria-hidden="true" className="h-5 w-5" />}
            title={t("Role-based access & audit")}
            body={t(
              "Granular roles, module grants, and an append-only audit trail keep everyone accountable.",
            )}
            delayMs={60}
          />
          <Feature
            icon={<Activity aria-hidden="true" className="h-5 w-5" />}
            title={t("A chassis that scales")}
            body={t(
              "Football first; the same engine extends to volleyball, basketball, archery, and more.",
            )}
            delayMs={120}
          />
        </BentoGrid>
      </section>

      {/* How it works */}
      <section
        aria-labelledby="how-heading"
        className="border-t border-border/60 bg-muted/30"
      >
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <Reveal>
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {t("From draft to full time")}
            </p>
            <h2
              id="how-heading"
              className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("Three steps to matchday")}
            </h2>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Step
              n="1"
              title={t("Create your tournament")}
              body={t(
                "Pick the sport, format, venues and rules. Presets get you going, everything stays configurable.",
              )}
              delayMs={0}
            />
            <Step
              n="2"
              title={t("Open registration")}
              body={t(
                "Schools and clubs register teams through public forms with access codes. Rosters map themselves.",
              )}
              delayMs={80}
            />
            <Step
              n="3"
              title={t("Generate fixtures & go live")}
              body={t(
                "One click builds the schedule around your constraints. Score live, fans follow in real time.",
              )}
              delayMs={160}
            />
          </div>
        </div>
      </section>

      {/* Roadmap strip */}
      <section
        aria-labelledby="roadmap-heading"
        className="border-t border-border/60"
      >
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <Reveal>
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {t("Roadmap")}
            </p>
            <h2
              id="roadmap-heading"
              className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("What's coming")}
            </h2>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Reveal delayMs={0}>
              <RoadmapCard
                icon={<Shield aria-hidden="true" className="h-5 w-5" />}
                phase={t("Phase 1A · shipping")}
                title={t("Accounts & organizations")}
                body={t(
                  "Sign up, multi-tenant orgs, role-based access, audit, 2FA.",
                )}
                tone="active"
              />
            </Reveal>
            <Reveal delayMs={80}>
              <RoadmapCard
                icon={<Trophy aria-hidden="true" className="h-5 w-5" />}
                phase={t("Phase 1B · football")}
                title={t("Tournaments & live scoring")}
                body={t(
                  "Brackets, schedules, lineups, real-time scoring, public viewer.",
                )}
                tone="next"
              />
            </Reveal>
            <Reveal delayMs={160}>
              <RoadmapCard
                icon={<Activity aria-hidden="true" className="h-5 w-5" />}
                phase={t("v2 · beyond football")}
                title={t("9 more sports")}
                body={t(
                  "The chassis extends to volleyball, basketball, archery, and more.",
                )}
                tone="future"
              />
            </Reveal>
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <Reveal>
          <StarBorder speed="8s">
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
          </StarBorder>
        </Reveal>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/60 bg-muted/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>{t("© Fixture Platform")}</p>
          <nav aria-label={t("Footer")} className="flex items-center gap-4">
            <Link
              to="/explore"
              className="rounded-sm transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Explore")}
            </Link>
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

/** The hero product mock: a live match card, mini standings and the next
 * fixture, composed from real app chrome (panel, chips, tabular numerals).
 * Sample data, aria-hidden: it is an illustration, not content. */
function HeroShowcase(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative hidden select-none lg:block">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-8 rounded-full bg-primary/5 blur-2xl"
      />
      <div className="relative space-y-3">
        {/* Live match card */}
        <Reveal>
          <StarBorder speed="7s">
            <div className="panel p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-2 font-medium text-destructive">
                  <span className="live-dot" />
                  {t("LIVE")}
                </span>
                <span>{t("Boys U17 · Group A")}</span>
              </div>
              <div className="mt-3 space-y-2">
                <ShowcaseRow team={t("Kohima United")} score="2" leading />
                <ShowcaseRow team={t("Dimapur FC")} score="1" />
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs text-muted-foreground">
                <span className="font-tabular">{t("74'")}</span>
                <span>{t("Local Ground, Kohima")}</span>
              </div>
            </div>
          </StarBorder>
        </Reveal>

        {/* Mini standings */}
        <Reveal delayMs={120}>
          <div className="panel p-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {t("Standings · Group A")}
            </p>
            <div className="mt-2.5 space-y-1.5 text-sm">
              <StandingRow pos="1" team={t("Kohima United")} pts="7" top />
              <StandingRow pos="2" team={t("Dimapur FC")} pts="5" />
              <StandingRow pos="3" team={t("Mokokchung Town")} pts="4" />
            </div>
          </div>
        </Reveal>

        {/* Next fixture */}
        <Reveal delayMs={240}>
          <div className="panel flex items-center justify-between p-4 text-sm">
            <div>
              <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {t("Up next")}
              </p>
              <p className="mt-1 font-medium">
                {t("Semifinal · Sat 3:00 PM")}
              </p>
            </div>
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Calendar aria-hidden="true" className="h-5 w-5" />
            </span>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

function ShowcaseRow({
  team,
  score,
  leading = false,
}: {
  team: string;
  score: string;
  leading?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          "text-sm",
          leading ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {team}
      </span>
      <span
        className={cn(
          "font-tabular text-lg font-semibold",
          leading ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {score}
      </span>
    </div>
  );
}

function StandingRow({
  pos,
  team,
  pts,
  top = false,
}: {
  pos: string;
  team: string;
  pts: string;
  top?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "font-tabular inline-flex h-5 w-5 items-center justify-center rounded text-xs",
          top ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {pos}
      </span>
      <span className={cn("flex-1 truncate", top && "font-medium")}>{team}</span>
      <span className="font-tabular text-muted-foreground">{pts}</span>
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

/** Numeric stat that counts up on load (static under reduced motion). */
function CountStat({
  value,
  label,
}: {
  value: number;
  label: string;
}): React.ReactElement {
  const shown = useCountUp(value);
  return <Stat value={String(shown)} label={label} />;
}

function Feature({
  icon,
  title,
  body,
  delayMs = 0,
  particles = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  delayMs?: number;
  particles?: boolean;
}): React.ReactElement {
  return (
    <Reveal delayMs={delayMs}>
      <BentoCard particles={particles} className="h-full p-6">
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
      </BentoCard>
    </Reveal>
  );
}

function Step({
  n,
  title,
  body,
  delayMs = 0,
}: {
  n: string;
  title: string;
  body: string;
  delayMs?: number;
}): React.ReactElement {
  return (
    <Reveal delayMs={delayMs}>
      <article className="h-full rounded-xl border border-border bg-card p-6 shadow-sm">
        <span
          aria-hidden="true"
          className="font-tabular inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground"
        >
          {n}
        </span>
        <h3 className="mt-4 text-base font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </article>
    </Reveal>
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
    <article className="flex h-full flex-col rounded-xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md">
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
