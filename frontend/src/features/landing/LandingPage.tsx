import { Link, Navigate } from "react-router-dom";
import {
  Trophy,
  Calendar,
  Users,
  Activity,
  Radio,
  ShieldCheck,
  School,
  Home,
  GraduationCap,
  ArrowRight,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { RotatingText, SportsMarquee, SPORT_NAMES } from "./motion";
import { useHeroCinema } from "./useHeroCinema";
import { CinemaLine, ScrollFade } from "./cinema";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { CinematicBackdrop } from "./CinematicBackdrop";
import { ScorerDemo, BracketDemo, FaqItem } from "./demos";

/**
 * Public landing page at `/`: a cinematic, film-first marketing surface in
 * the animejs.com idiom. The scroll-scrubbed footage (CinematicBackdrop) is
 * the page background, and the content is a sequence of sparse typographic
 * CHAPTERS: one oversized statement per screen, a short line under it, and
 * at most one visual. No stacked card grids, no section washes; type sits
 * directly on the film with a soft text shadow. The page locks to DARK
 * tokens so the glass and type suit the footage in either app theme.
 *
 * - Authenticated user: redirect via `pickLandingPathForUser` (personal
 *   dashboard; roles only matter inside a tournament).
 * - Unauthenticated / not-bootstrapped: render the marketing page (the
 *   pre-bootstrap render is identical, so no "Loading..." flash).
 */

/** Soft readability shadow used by type sitting directly on the footage. */
const FILM_TEXT =
  "[text-shadow:0_2px_28px_hsl(var(--background)),0_0_12px_hsl(var(--background))]";

export function LandingPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  const heroRef = useHeroCinema();

  // Authenticated → bounce into the app.
  if (bootstrapped && user) {
    return <Navigate to={pickLandingPathForUser(user)} replace />;
  }

  return (
    <div className="dark flex min-h-screen flex-col text-foreground">
      {/* Base coat: the page's dark background as its own fixed layer, BELOW
          the film canvas. It cannot live on this root div: an opaque root
          background paints over negative-z fixed children and hides the
          film entirely. */}
      <span aria-hidden="true" className="fixed inset-0 -z-10 bg-background" />
      {/* Backdrops: desktop gets the scroll film (plain page background
          while its frames load); mobile gets ambient drifting blobs. */}
      <AmbientBackdrop />
      <CinematicBackdrop />

      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-border/40 bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/50">
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

      {/* Hero: a full-viewport CENTERED title card over the opening frame,
          choreographed by useHeroCinema (anime.js timeline + exit scrub). */}
      <section
        ref={heroRef}
        className="relative flex min-h-[calc(100dvh-3.75rem)] flex-col items-center justify-center"
      >
        <div
          data-cine="panel"
          className="flex w-full max-w-4xl flex-col items-center px-4 py-16 text-center sm:px-6"
        >
          <h1
            className={cn(
              "text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-7xl lg:text-8xl",
              FILM_TEXT,
            )}
          >
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
            className={cn(
              "mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg",
              FILM_TEXT,
            )}
          >
            {t(
              "Run tournaments, schedule matches, follow live scores. Built for local sport, football first.",
            )}
          </p>
          <p
            data-cine="line"
            className={cn(
              "mt-3 text-lg font-medium text-muted-foreground",
              FILM_TEXT,
            )}
          >
            {t("One platform for")}{" "}
            <RotatingText
              words={SPORT_NAMES}
              className="font-semibold text-primary"
            />
          </p>
          <div
            data-cine="ctas"
            className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row"
          >
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
      </section>

      {/* Kinetic strip: the only moving band on the page */}
      <section aria-label={t("Sports covered")} className="py-10">
        <SportsMarquee className="w-full px-4 sm:px-6 lg:px-10" />
      </section>

      {/* Chapter: what it is */}
      <Chapter>
        <ChapterHeading id="features-heading">
          {t("Everything you need")}{" "}
          <br className="hidden sm:block" />
          {t("to run a competition.")}
        </ChapterHeading>
        <ChapterBody>
          {t(
            "Scoring, schedules, standings, and access control on one chassis.",
          )}
        </ChapterBody>
        <div className="mt-14 grid w-full max-w-4xl gap-x-12 gap-y-8 text-left sm:grid-cols-2">
          <FeatureLine
            icon={<Radio aria-hidden="true" className="h-4 w-4" />}
            title={t("Live scoring, in real time")}
            body={t("Scorers tap, fans see it instantly.")}
          />
          <FeatureLine
            icon={<Trophy aria-hidden="true" className="h-4 w-4" />}
            title={t("Standings & brackets")}
            body={t("Computed from your rules, never by hand.")}
          />
          <FeatureLine
            icon={<Calendar aria-hidden="true" className="h-4 w-4" />}
            title={t("Auto-generated schedules")}
            body={t("Built around venues, breaks, and constraints.")}
          />
          <FeatureLine
            icon={<Users aria-hidden="true" className="h-4 w-4" />}
            title={t("Multi-tenant from day one")}
            body={t("Every organization in its own workspace.")}
          />
          <FeatureLine
            icon={<ShieldCheck aria-hidden="true" className="h-4 w-4" />}
            title={t("Roles & audit")}
            body={t("Granular access with an append-only trail.")}
          />
          <FeatureLine
            icon={<Activity aria-hidden="true" className="h-4 w-4" />}
            title={t("A chassis that scales")}
            body={t("Football first; nine more sports on the same engine.")}
          />
        </div>
      </Chapter>

      {/* Film beat */}
      <FilmWindow line={t("From kickoff to the final table.")} />

      {/* Chapter: demos (the page's only panels) */}
      <Chapter>
        <ChapterHeading id="demos-heading">
          {t("See it in action.")}
        </ChapterHeading>
        <ChapterBody>{t("Sample data. Tap around.")}</ChapterBody>
        <div className="mt-14 grid w-full max-w-6xl gap-4 text-left lg:grid-cols-[0.85fr,1.15fr]">
          <ScrollFade>
            <ScorerDemo />
          </ScrollFade>
          <ScrollFade>
            <BracketDemo />
          </ScrollFade>
        </div>
        <ScrollFade className="mt-10">
          <Link to="/explore" className="inline-block">
            <Button variant="outline" className="gap-2">
              {t("Explore live tournaments")}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Button>
          </Link>
        </ScrollFade>
      </Chapter>

      {/* Chapter: institutions */}
      <Chapter>
        <ChapterHeading id="schools-heading">
          {t("Built for institutions.")}
        </ChapterHeading>
        <ChapterBody>
          {t(
            "Schools and colleges run the busiest sports calendars anywhere.",
          )}
        </ChapterBody>
        <div className="mt-14 grid w-full max-w-5xl gap-10 text-left sm:grid-cols-3">
          <PlainPoint
            icon={<School aria-hidden="true" className="h-5 w-5" />}
            title={t("Sports days, sorted")}
            body={t("Events, houses, and results on one timetable.")}
          />
          <PlainPoint
            icon={<Home aria-hidden="true" className="h-5 w-5" />}
            title={t("House competitions")}
            body={t("Points tables updated the moment results land.")}
          />
          <PlainPoint
            icon={<GraduationCap aria-hidden="true" className="h-5 w-5" />}
            title={t("Roles for staff")}
            body={t("PE staff score, teachers manage, principals watch.")}
          />
        </div>
      </Chapter>

      {/* Chapter: how it works, giant numerals */}
      <Chapter>
        <ChapterHeading id="how-heading">
          {t("Three steps to matchday.")}
        </ChapterHeading>
        <div className="mt-14 grid w-full max-w-5xl gap-12 text-left sm:grid-cols-3 sm:gap-8">
          <GiantStep
            n="01"
            title={t("Create your tournament")}
            body={t("Pick the sport, format, venues and rules.")}
          />
          <GiantStep
            n="02"
            title={t("Open registration")}
            body={t("Schools register through forms with access codes.")}
          />
          <GiantStep
            n="03"
            title={t("Generate fixtures & go live")}
            body={t("One click builds the schedule. Fans follow live.")}
          />
        </div>
      </Chapter>

      {/* Chapter: why, as an oversized manifesto list */}
      <Chapter>
        <ChapterHeading id="why-heading">{t("Why Fixture")}</ChapterHeading>
        <ul className="mt-12 w-full max-w-3xl space-y-5 text-left">
          {[
            t("Rules are data, not code."),
            t("The audit trail is append-only."),
            t("Live scores never need a refresh."),
            t("Fans get public pages, no login."),
            t("One chassis runs every sport."),
          ].map((claim) => (
            <ScrollFade key={claim}>
              <li
                className={cn(
                  "border-l-2 border-primary/70 pl-5 text-xl font-medium leading-snug text-foreground sm:text-2xl",
                  FILM_TEXT,
                )}
              >
                {claim}
              </li>
            </ScrollFade>
          ))}
        </ul>
      </Chapter>

      {/* Chapter: roadmap, plain rows */}
      <Chapter>
        <ChapterHeading id="roadmap-heading">
          {t("What's coming.")}
        </ChapterHeading>
        <div className="mt-12 w-full max-w-3xl divide-y divide-border/50 text-left">
          <RoadmapRow
            phase={t("Phase 1A · shipping")}
            title={t("Accounts & organizations")}
            body={t("Multi-tenant orgs, role-based access, audit, 2FA.")}
            active
          />
          <RoadmapRow
            phase={t("Phase 1B · football")}
            title={t("Tournaments & live scoring")}
            body={t("Brackets, schedules, lineups, public live viewer.")}
          />
          <RoadmapRow
            phase={t("v2 · beyond football")}
            title={t("9 more sports")}
            body={t("Volleyball, basketball, archery, and more.")}
          />
        </div>
      </Chapter>

      {/* Film beat */}
      <FilmWindow line={t("Every ground. Every match. Live.")} />

      {/* Chapter: FAQ, borderless */}
      <Chapter>
        <ChapterHeading id="faq-heading">
          {t("Questions, answered.")}
        </ChapterHeading>
        <div className="mt-12 w-full max-w-2xl text-left">
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
      </Chapter>

      {/* Closing: a final beat over the film */}
      <section className="relative flex min-h-[60vh] flex-col items-center justify-center px-4 py-24 text-center sm:px-6">
        <ScrollFade>
          <h2
            className={cn(
              "mx-auto max-w-3xl text-3xl font-semibold leading-[1.1] tracking-tight sm:text-6xl",
              FILM_TEXT,
            )}
          >
            {t("Ready to run your")}{" "}
            <br className="hidden sm:block" />
            {t("first tournament?")}
          </h2>
          <p
            className={cn(
              "mx-auto mt-5 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base",
              FILM_TEXT,
            )}
          >
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
        </ScrollFade>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/40 bg-background/45 backdrop-blur-sm">
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
          <div className="mt-8 border-t border-border/40 pt-5 text-xs text-muted-foreground">
            <p>{t("© Fixture Platform")}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chapter primitives (the animejs.com idiom: one statement per screen) */
/* ------------------------------------------------------------------ */

/** A sparse full-height-ish chapter: everything centered, type on film. */
function Chapter({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="relative flex min-h-[70vh] flex-col items-center justify-center px-4 py-24 text-center sm:px-6 sm:py-32">
      {children}
    </section>
  );
}

/** Oversized chapter statement. */
function ChapterHeading({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ScrollFade>
      <h2
        id={id}
        className={cn(
          "max-w-4xl text-3xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-6xl",
          FILM_TEXT,
        )}
      >
        {children}
      </h2>
    </ScrollFade>
  );
}

/** One short line under a chapter heading. */
function ChapterBody({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ScrollFade>
      <p
        className={cn(
          "mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg",
          FILM_TEXT,
        )}
      >
        {children}
      </p>
    </ScrollFade>
  );
}

/** A transparent break where the film alone carries the page: one statement
 * line over the footage, scrubbed word by word by the scroll. */
function FilmWindow({ line }: { line: string }): React.ReactElement {
  return (
    <section className="relative flex min-h-[46vh] items-center justify-center px-4 py-20 sm:min-h-[68vh]">
      <CinemaLine
        text={line}
        className={cn(
          "max-w-4xl text-center text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-6xl",
          FILM_TEXT,
        )}
      />
    </section>
  );
}

/** One feature as a plain hairline row: icon, name, a few words. No card. */
function FeatureLine({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <ScrollFade>
      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="text-primary">
            {icon}
          </span>
          <h3
            className={cn(
              "text-base font-semibold tracking-tight text-foreground",
              FILM_TEXT,
            )}
          >
            {title}
          </h3>
        </div>
        <p
          className={cn(
            "mt-1.5 text-sm leading-relaxed text-muted-foreground",
            FILM_TEXT,
          )}
        >
          {body}
        </p>
      </div>
    </ScrollFade>
  );
}

/** A plain icon + title + line point, no container. */
function PlainPoint({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <ScrollFade>
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary"
      >
        {icon}
      </span>
      <h3
        className={cn(
          "mt-4 text-lg font-semibold tracking-tight text-foreground",
          FILM_TEXT,
        )}
      >
        {title}
      </h3>
      <p
        className={cn(
          "mt-1.5 text-sm leading-relaxed text-muted-foreground",
          FILM_TEXT,
        )}
      >
        {body}
      </p>
    </ScrollFade>
  );
}

/** A step with an oversized ghost numeral, no card. */
function GiantStep({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <ScrollFade>
      <span
        aria-hidden="true"
        className="font-tabular block bg-gradient-to-b from-primary/80 to-primary/20 bg-clip-text text-6xl font-semibold leading-none text-transparent sm:text-7xl"
      >
        {n}
      </span>
      <h3
        className={cn(
          "mt-4 text-lg font-semibold tracking-tight text-foreground",
          FILM_TEXT,
        )}
      >
        {title}
      </h3>
      <p
        className={cn(
          "mt-1.5 text-sm leading-relaxed text-muted-foreground",
          FILM_TEXT,
        )}
      >
        {body}
      </p>
    </ScrollFade>
  );
}

/** One roadmap row: phase label, title, a line. Hairlines, no cards. */
function RoadmapRow({
  phase,
  title,
  body,
  active = false,
}: {
  phase: string;
  title: string;
  body: string;
  active?: boolean;
}): React.ReactElement {
  return (
    <ScrollFade>
      <div className="flex flex-col gap-1.5 py-5 sm:flex-row sm:items-baseline sm:gap-6">
        <span
          className={cn(
            "shrink-0 text-xs font-medium sm:w-44",
            active ? "text-primary" : "text-muted-foreground",
            FILM_TEXT,
          )}
        >
          {phase}
        </span>
        <div>
          <h3
            className={cn(
              "text-lg font-semibold tracking-tight text-foreground",
              FILM_TEXT,
            )}
          >
            {title}
          </h3>
          <p
            className={cn(
              "mt-1 text-sm leading-relaxed text-muted-foreground",
              FILM_TEXT,
            )}
          >
            {body}
          </p>
        </div>
      </div>
    </ScrollFade>
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
