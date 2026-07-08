import { Link, Navigate } from "react-router-dom";
import {
  Trophy,
  Calendar,
  Users,
  Activity,
  Shield,
  ArrowRight,
  Radio,
  ShieldCheck,
  School,
  Home,
  GraduationCap,
  CheckCircle2,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { BentoGrid, BentoCard } from "@/features/dashboard/BentoCard";
import { useCountUp } from "@/features/dashboard/useCountUp";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import {
  RotatingText,
  Reveal,
  SportsMarquee,
  SPORT_NAMES,
} from "./motion";
import { useHeroCinema } from "./useHeroCinema";
import { CinemaLine } from "./cinema";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { CinematicBackdrop } from "./CinematicBackdrop";
import { ScorerDemo, BracketDemo, FaqItem } from "./demos";

/**
 * Public landing page at `/`: a cinematic, film-first marketing surface.
 * The scroll-scrubbed footage (CinematicBackdrop) is the page background;
 * the page locks to DARK tokens regardless of app theme so the glass
 * surfaces sit naturally on the dark footage. Hero is a full-viewport
 * title card anchored lower-left; sections ride over the film on glass;
 * two transparent film windows and a transparent closing beat let the
 * footage carry the page between content groups.
 *
 * - Authenticated user: redirect via `pickLandingPathForUser` (personal
 *   dashboard; roles only matter inside a tournament).
 * - Unauthenticated / not-bootstrapped: render the marketing page. The
 *   pre-bootstrap render is identical to the unauthenticated render so
 *   there is no "Loading..." flash for cold visitors.
 *
 * Colors are token-only; motion comes from the landing kit (./motion) and
 * degrades to static under prefers-reduced-motion.
 */
export function LandingPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const heroRef = useHeroCinema();

  // Authenticated → bounce into the app.
  if (bootstrapped && user) {
    return <Navigate to={pickLandingPathForUser(user)} replace />;
  }

  return (
    <div className="dark flex min-h-screen flex-col bg-background text-foreground">
      {/* Backdrops: desktop gets the scroll film (plain page background
          while its frames load); mobile gets ambient drifting blobs. */}
      <AmbientBackdrop />
      <CinematicBackdrop />
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex w-full items-center justify-between px-4 py-3.5 sm:px-6 lg:px-10">
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

      {/* Hero: a full-viewport title card over the opening frame of the
          film, content anchored lower-left like a broadcast lower third.
          Choreographed by useHeroCinema (anime.js timeline + exit scrub). */}
      <section
        ref={heroRef}
        className="relative flex min-h-[calc(100dvh-3.75rem)] flex-col justify-end"
      >
        <div
          data-cine="panel"
          className="w-full px-4 pb-12 pt-16 sm:px-6 sm:pb-16 lg:px-10"
        >
          <div className="max-w-3xl">
            <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              <span data-cine="brand" className="inline-block">
                {t("Doxaed ·")}
              </span>{" "}
              <span
                data-cine="fixture"
                className="inline-block bg-gradient-to-r from-primary to-info bg-clip-text text-transparent"
              >
                {t("Fixture")}
              </span>
            </h1>
            <p
              data-cine="sub"
              className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg"
            >
              {t(
                "Run tournaments, schedule matches, follow live scores. Built for local sport, football first.",
              )}
            </p>
            <p data-cine="line" className="mt-3 text-lg font-medium text-muted-foreground">
              {t("One platform for")}{" "}
              <RotatingText
                words={SPORT_NAMES}
                className="font-semibold text-primary"
              />
            </p>
            <div data-cine="ctas" className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/explore" className="w-full sm:w-auto">
                <Button size="lg" className="w-full gap-2 sm:w-auto">
                  {t("Follow live tournaments")}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Link>
              <Link to={routes.signup()} className="w-full sm:w-auto">
                <Button size="lg" variant="outline" className="w-full sm:w-auto">
                  {t("Organize one")}
                </Button>
              </Link>
            </div>
          </div>

          {/* Trust strip: lower-third stat row */}
          <dl
            data-cine="stats"
            className="mt-12 flex flex-wrap items-center gap-x-10 gap-y-4 border-t border-border/40 pt-6 text-left sm:gap-x-14"
          >
            <CountStat value={10} label={t("sports on the chassis")} />
            <Stat value="100%" label={t("multi-tenant")} />
            <Stat value="24/7" label={t("live scores")} />
          </dl>
        </div>
      </section>

      {/* "Runs every sport" strip (the framework row) */}
      <section
        aria-label={t("Sports covered")}
        className="border-b border-border/60 bg-background/30 py-6"
      >
        <p className="text-center text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {t("Built to run every sport")}
        </p>
        <SportsMarquee className="mt-4 w-full px-4 sm:px-6 lg:px-10" />
      </section>

      {/* Product bento: the visual lives inside each card */}
      <section
        aria-labelledby="features-heading"
        className="w-full px-4 py-16 sm:px-6 sm:py-24 lg:px-10"
      >
        <Reveal>
          <h2
            id="features-heading"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            {t("Everything you need to run a competition")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {t(
              "Scoring, schedules, standings, and access control on one chassis.",
            )}
          </p>
        </Reveal>
        <BentoGrid className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ProductCard
            className="sm:col-span-2"
            icon={<Radio aria-hidden="true" className="h-4 w-4" />}
            title={t("Live scoring, in real time")}
            body={t(
              "Scorers tap, fans see it instantly. Events, lineups, and standings stay in sync from kickoff to full time.",
            )}
            visual={<MatchVisual />}
            particles
            delayMs={0}
          />
          <ProductCard
            icon={<Trophy aria-hidden="true" className="h-4 w-4" />}
            title={t("Standings & brackets")}
            body={t(
              "Points, tiebreakers, and knockout trees computed from your rules, never by hand.",
            )}
            visual={<StandingsVisual />}
            delayMs={80}
          />
          <ProductCard
            icon={<Calendar aria-hidden="true" className="h-4 w-4" />}
            title={t("Auto-generated schedules")}
            body={t(
              "Fixtures built around your venues, breaks, and constraints, with conflict warnings and manual overrides.",
            )}
            visual={<ScheduleVisual />}
            delayMs={0}
          />
          <ProductCard
            icon={<Users aria-hidden="true" className="h-4 w-4" />}
            title={t("Multi-tenant from day one")}
            body={t(
              "Each organization gets its own workspace, members, and roles. No data crosses tenants.",
            )}
            visual={<OrgsVisual />}
            delayMs={80}
          />
          <ProductCard
            icon={<ShieldCheck aria-hidden="true" className="h-4 w-4" />}
            title={t("Role-based access & audit")}
            body={t(
              "Granular roles, module grants, and an append-only audit trail keep everyone accountable.",
            )}
            visual={<AuditVisual />}
            delayMs={160}
          />
          <Reveal className="sm:col-span-2 lg:col-span-3">
            <BentoCard className="glass flex h-full flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="max-w-md">
                <span
                  aria-hidden="true"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"
                >
                  <Activity aria-hidden="true" className="h-4 w-4" />
                </span>
                <h3 className="mt-3 text-base font-semibold tracking-tight text-foreground">
                  {t("A chassis that scales")}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {t(
                    "Football first; the same engine extends to volleyball, basketball, archery, and more.",
                  )}
                </p>
              </div>
              <div
                aria-hidden="true"
                className="flex max-w-md flex-wrap gap-2"
              >
                {SPORT_NAMES.map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </BentoCard>
          </Reveal>
        </BentoGrid>
      </section>

      {/* Film window: the footage alone carries a statement line */}
      <FilmWindow line={t("From kickoff to the final table.")} />

      {/* Demos: sample data, clearly labeled */}
      <section
        aria-labelledby="demos-heading"
        className="border-t border-border/60 bg-background/30"
      >
        <div className="w-full px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
          <Reveal>
            <div className="flex flex-wrap items-center gap-3">
              <h2
                id="demos-heading"
                className="text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                {t("See it in action")}
              </h2>
              <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {t("Sample data")}
              </span>
            </div>
          </Reveal>
          <div className="mt-10 grid gap-4 lg:grid-cols-[0.85fr,1.15fr]">
            <Reveal delayMs={0}>
              <ScorerDemo />
            </Reveal>
            <Reveal delayMs={100}>
              <BracketDemo />
            </Reveal>
          </div>
          <Reveal className="mt-8" delayMs={160}>
            <Link to="/explore" className="inline-block">
              <Button variant="outline" className="gap-2">
                {t("Explore live tournaments")}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </Link>
          </Reveal>
        </div>
      </section>

      {/* For schools & colleges: split layout, headline beside a rows panel */}
      <section
        aria-labelledby="schools-heading"
        className="border-t border-border/60"
      >
        <div className="grid w-full gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr,1.25fr] lg:items-center lg:px-10">
          <Reveal>
            <h2
              id="schools-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("Built for institutions")}
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
              {t(
                "Schools and colleges run the busiest sports calendars anywhere. Fixture is shaped around how they actually work.",
              )}
            </p>
          </Reveal>
          <Reveal delayMs={100}>
            <div className="glass divide-y divide-border/60 rounded-xl border border-border shadow-sm">
              <InstitutionRow
                icon={<School aria-hidden="true" className="h-5 w-5" />}
                title={t("Sports days, sorted")}
                body={t(
                  "Run the annual sports day on one timetable: events, houses, and results in one place.",
                )}
              />
              <InstitutionRow
                icon={<Home aria-hidden="true" className="h-5 w-5" />}
                title={t("House competitions")}
                body={t(
                  "Points tables for houses across every event, updated the moment results land.",
                )}
              />
              <InstitutionRow
                icon={<GraduationCap aria-hidden="true" className="h-5 w-5" />}
                title={t("Roles for staff")}
                body={t(
                  "PE staff score, teachers manage teams, principals watch live. Everyone gets exactly the access they need.",
                )}
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* How it works: numbered rail, no cards */}
      <section
        aria-labelledby="how-heading"
        className="border-t border-border/60 bg-background/30"
      >
        <div className="w-full px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
          <Reveal>
            <h2
              id="how-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("Three steps to matchday")}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {t("From a blank draft to fans following live.")}
            </p>
          </Reveal>
          <div className="relative mt-12">
            <span
              aria-hidden="true"
              className="absolute left-[1.125rem] top-2 h-[calc(100%-1rem)] w-px bg-border/80 sm:left-1 sm:right-1 sm:top-[1.125rem] sm:h-px sm:w-auto"
            />
            <ol className="grid gap-10 sm:grid-cols-3 sm:gap-6">
              <TimelineStep
                n="1"
                title={t("Create your tournament")}
                body={t(
                  "Pick the sport, format, venues and rules. Presets get you going, everything stays configurable.",
                )}
                delayMs={0}
              />
              <TimelineStep
                n="2"
                title={t("Open registration")}
                body={t(
                  "Schools and clubs register teams through public forms with access codes. Rosters map themselves.",
                )}
                delayMs={80}
              />
              <TimelineStep
                n="3"
                title={t("Generate fixtures & go live")}
                body={t(
                  "One click builds the schedule around your constraints. Score live, fans follow in real time.",
                )}
                delayMs={160}
              />
            </ol>
          </div>
        </div>
      </section>

      {/* Why Fixture: differentiators strip */}
      <section
        aria-labelledby="why-heading"
        className="border-t border-border/60"
      >
        <div className="w-full px-4 py-12 sm:px-6 sm:py-14 lg:px-10">
          <Reveal className="text-center">
            <h2
              id="why-heading"
              className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground"
            >
              {t("Why Fixture")}
            </h2>
            <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
              {[
                t("Rules are data, not code"),
                t("Append-only audit trail"),
                t("Live scores without refreshing"),
                t("Public pages for fans"),
                t("One chassis, every sport"),
              ].map((claim) => (
                <li key={claim} className="inline-flex items-center gap-2">
                  <CheckCircle2
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-primary"
                  />
                  <span className="text-muted-foreground">{claim}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* Roadmap strip */}
      <section
        aria-labelledby="roadmap-heading"
        className="border-t border-border/60 bg-background/30"
      >
        <div className="w-full px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
          <Reveal>
            <h2
              id="roadmap-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("What's coming")}
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
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

      {/* Film window: a beat of pure footage before the questions */}
      <FilmWindow line={t("Every ground. Every match. Live.")} />

      {/* FAQ: editorial split, accordion beside the heading */}
      <section aria-labelledby="faq-heading">
        <div className="grid w-full gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[0.8fr,1.2fr] lg:px-10">
          <Reveal>
            <h2
              id="faq-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {t("Questions, answered")}
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground sm:text-base">
              {t("The short version of what organizers and schools ask most.")}
            </p>
          </Reveal>
          <Reveal delayMs={100}>
            <div className="space-y-3">
            <FaqItem q={t("Which sports can it run?")}>
              {t(
                "Football is the reference sport, and the same chassis runs set-based games like table tennis, badminton, and sepak takraw. Formats, scoring, and rules stay configurable per competition.",
              )}
            </FaqItem>
            <FaqItem q={t("Can fans follow without an account?")}>
              {t(
                "Yes. Schedules, standings, brackets, and live match pages are public links. No login, no app install.",
              )}
            </FaqItem>
            <FaqItem q={t("How do teams register?")}>
              {t(
                "Organizers share a public form link. Each school gets an access code, so only they can submit or update their own team lists.",
              )}
            </FaqItem>
            <FaqItem q={t("Does it work on a busy matchday?")}>
              {t(
                "Yes. Scoring is tap-based and built for phones at the ground, and fans' pages update live without refreshing.",
              )}
            </FaqItem>
            <FaqItem q={t("Is our data separate from other organizers?")}>
              {t(
                "Yes. Every organization is its own tenant with separate members, roles, and an append-only audit trail.",
              )}
            </FaqItem>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Closing: a final beat over the film, no card */}
      <section className="relative flex min-h-[55vh] flex-col items-center justify-center px-4 py-20 text-center sm:px-6">
        <Reveal>
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight [text-shadow:0_2px_28px_hsl(var(--background)),0_0_12px_hsl(var(--background))] sm:text-5xl">
            {t("Ready to run your first tournament?")}
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            {t("Create a free account in minutes.")}
          </p>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link to={routes.signup()} className="w-full sm:w-auto">
              <Button size="lg" className="w-full gap-2 sm:w-auto">
                {t("Get started")}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </Link>
            <Link to={routes.login()} className="w-full sm:w-auto">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                {t("Sign in")}
              </Button>
            </Link>
          </div>
        </Reveal>
      </section>

      {/* Footer: columned, Supabase-style */}
      <footer className="mt-auto border-t border-border/60 bg-background/45 backdrop-blur-sm">
        <div className="w-full px-4 py-10 sm:px-6 lg:px-10">
          <div className="grid gap-8 sm:grid-cols-[1.5fr,1fr,1fr]">
            <div>
              <span className="inline-flex items-center gap-2.5 text-base font-semibold tracking-tight text-foreground">
                <BrandLogo className="h-7 w-7" />
                {t("Fixture Platform")}
              </span>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t(
                  "Multi-tenant tournament and fixture management, built for sport in Nagaland.",
                )}
              </p>
            </div>
            <FooterCol
              heading={t("Product")}
              links={[
                { to: "/explore", label: t("Explore") },
                { to: routes.about(), label: t("About") },
              ]}
            />
            <FooterCol
              heading={t("Account")}
              links={[
                { to: routes.login(), label: t("Sign in") },
                { to: routes.signup(), label: t("Create account") },
              ]}
            />
          </div>
          <div className="mt-8 border-t border-border/60 pt-5 text-xs text-muted-foreground">
            <p>{t("© Fixture Platform")}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** One product bento card: the visual sits inside the card above the copy
 * (the Supabase card pattern). Visuals are sample data and aria-hidden. */
function ProductCard({
  icon,
  title,
  body,
  visual,
  className,
  delayMs = 0,
  particles = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  visual: React.ReactNode;
  className?: string;
  delayMs?: number;
  particles?: boolean;
}): React.ReactElement {
  return (
    <Reveal delayMs={delayMs} className={className}>
      <BentoCard particles={particles} className="glass flex h-full flex-col p-5">
        <div
          aria-hidden="true"
          className="select-none rounded-lg border border-border/60 bg-muted/30 p-3.5"
        >
          {visual}
        </div>
        <div className="mt-4 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
          >
            {icon}
          </span>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h3>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </BentoCard>
    </Reveal>
  );
}

/** Live match sample: LIVE chip, score rows, minute. */
function MatchVisual(): React.ReactElement {
  return (
    <div>
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
      <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
        <span className="font-tabular">{t("74'")}</span>
        <span>{t("Local Ground, Kohima")}</span>
      </div>
    </div>
  );
}

/** Mini standings sample. */
function StandingsVisual(): React.ReactElement {
  return (
    <div className="space-y-1.5 text-sm">
      <StandingRow pos="1" team={t("Kohima United")} pts="7" top />
      <StandingRow pos="2" team={t("Dimapur FC")} pts="5" />
      <StandingRow pos="3" team={t("Mokokchung Town")} pts="4" />
    </div>
  );
}

/** Generated fixture list sample. */
function ScheduleVisual(): React.ReactElement {
  return (
    <div className="space-y-1.5 text-xs">
      <FixtureRow time="9:00" pair={t("Wokha FC v Zunheboto")} />
      <FixtureRow time="10:30" pair={t("Kohima United v Peren")} />
      <FixtureRow time="12:00" pair={t("Mon Town v Tuensang")} />
    </div>
  );
}

/** Tenant workspaces sample. */
function OrgsVisual(): React.ReactElement {
  return (
    <div className="space-y-1.5 text-xs">
      {[
        t("Nagaland Schools Cup"),
        t("Kohima District League"),
        t("Inter-College Meet"),
      ].map((name, i) => (
        <div
          key={name}
          className="flex items-center gap-2 rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5"
        >
          <span
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded font-semibold text-[10px]",
              i === 0
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {name.charAt(0)}
          </span>
          <span className="truncate font-medium">{name}</span>
        </div>
      ))}
    </div>
  );
}

/** Append-only audit trail sample. */
function AuditVisual(): React.ReactElement {
  return (
    <div className="space-y-1.5 font-tabular text-xs text-muted-foreground">
      <AuditRow at="14:02" what={t("goal recorded · scorer")} />
      <AuditRow at="14:05" what={t("lineup locked · referee")} />
      <AuditRow at="14:11" what={t("score corrected · organizer")} />
    </div>
  );
}

function AuditRow({ at, what }: { at: string; what: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0">{at}</span>
      <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-primary/60" />
      <span className="truncate">{what}</span>
    </div>
  );
}

function FixtureRow({ time, pair }: { time: string; pair: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="font-tabular w-9 shrink-0 text-muted-foreground">
        {time}
      </span>
      <span className="truncate font-medium text-foreground">{pair}</span>
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

/** A transparent break where the film alone carries the page: one statement
 * line over the footage, no wash, no cards. The text-shadow in background
 * tones keeps the line readable over any frame. */
function FilmWindow({ line }: { line: string }): React.ReactElement {
  return (
    <section className="relative flex min-h-[46vh] items-center justify-center px-4 py-20 sm:min-h-[68vh]">
      <CinemaLine
        text={line}
        className="max-w-4xl text-center text-3xl font-semibold leading-tight tracking-tight text-foreground [text-shadow:0_2px_28px_hsl(var(--background)),0_0_12px_hsl(var(--background))] sm:text-6xl"
      />
    </section>
  );
}

/** One row of the institutions panel: icon beside title + body, rows are
 * separated by the parent's divide-y instead of individual cards. */
function InstitutionRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <div className="flex gap-4 p-5 sm:p-6">
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        {icon}
      </span>
      <div>
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </div>
  );
}

/** One stop on the how-it-works rail: a number chip sitting on the
 * connecting line (vertical on mobile, horizontal from sm up), no card. */
function TimelineStep({
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
    <li className="relative pl-14 sm:pl-0 sm:pt-14">
      <span
        aria-hidden="true"
        className="font-tabular absolute left-0 top-0 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground"
      >
        {n}
      </span>
      <Reveal delayMs={delayMs}>
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </Reveal>
    </li>
  );
}

function FooterCol({
  heading,
  links,
}: {
  heading: string;
  links: { to: string; label: string }[];
}): React.ReactElement {
  return (
    <nav aria-label={heading}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {heading}
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((link) => (
          <li key={link.to}>
            <Link
              to={link.to}
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
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
    <article className="glass flex h-full flex-col rounded-xl border border-border p-6 shadow-sm transition-shadow hover:shadow-md">
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
