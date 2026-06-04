import { Link, Navigate } from "react-router-dom";
import {
  Trophy,
  Calendar,
  Users,
  Activity,
  Shield,
  Sparkles,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

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
 */
export function LandingPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);

  // Authenticated → bounce into the app via role-aware helper.
  if (bootstrapped && user) {
    return <Navigate to={pickLandingPathForUser(user)} replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link
            to={routes.landing()}
            className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            aria-label={t("Fixture Platform — home")}
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-700 text-white font-bold"
            >
              F
            </span>
            <span>{t("Fixture Platform")}</span>
          </Link>
          <nav
            aria-label={t("Primary")}
            className="flex items-center gap-2 text-sm"
          >
            <Link
              to={routes.login()}
              className="rounded-md px-3 py-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Sign in")}
            </Link>
            <Link to={routes.signup()}>
              <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800">
                {t("Sign up")}
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60 bg-gradient-to-br from-emerald-50 via-white to-slate-50">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(circle at 15% 20%, rgba(5,150,105,0.12), transparent 50%), radial-gradient(circle at 85% 80%, rgba(15,23,42,0.08), transparent 55%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
              <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
              {t("v1 — Football, Nagaland-first")}
            </p>
            <h1 className="mt-6 text-4xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-5xl">
              {t("Sports fixtures, made in Nagaland.")}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
              {t(
                "Run tournaments, schedule matches, follow live scores. A multi-tenant platform built for local sport — football first, more to come.",
              )}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={routes.login()}>
                <Button
                  size="lg"
                  className="bg-emerald-700 hover:bg-emerald-800"
                >
                  {t("Sign in")}
                </Button>
              </Link>
              <Link to={routes.signup()}>
                <Button size="lg" variant="outline">
                  {t("Create an account")}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Roadmap strip */}
      <section
        aria-labelledby="roadmap-heading"
        className="mx-auto w-full max-w-6xl px-6 py-16"
      >
        <h2
          id="roadmap-heading"
          className="text-sm font-semibold uppercase tracking-widest text-emerald-700"
        >
          {t("What's coming")}
        </h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
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

        {/* Secondary callouts */}
        <div className="mt-12 grid gap-6 sm:grid-cols-3 text-sm">
          <Feature
            icon={<Users aria-hidden="true" className="h-4 w-4" />}
            label={t("Multi-tenant from day one")}
          />
          <Feature
            icon={<Calendar aria-hidden="true" className="h-4 w-4" />}
            label={t("Auto-generated schedules")}
          />
          <Feature
            icon={<Activity aria-hidden="true" className="h-4 w-4" />}
            label={t("Live updates over SSE")}
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/60 bg-muted/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>{t("© Fixture Platform")}</p>
          <nav aria-label={t("Footer")} className="flex items-center gap-4">
            <Link
              to={routes.about()}
              className="hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {t("About")}
            </Link>
            <Link
              to={routes.login()}
              className="hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {t("Sign in")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
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
  const toneClasses: Record<RoadmapCardProps["tone"], string> = {
    active: "border-emerald-200 bg-emerald-50/60",
    next: "border-slate-200 bg-white",
    future: "border-slate-200 bg-slate-50/60",
  };
  const badgeTone: Record<RoadmapCardProps["tone"], string> = {
    active: "bg-emerald-700 text-white",
    next: "bg-slate-200 text-slate-700",
    future: "bg-slate-100 text-slate-500",
  };
  return (
    <article
      className={`rounded-lg border p-6 shadow-sm ${toneClasses[tone]}`}
    >
      <div className="flex items-center gap-2 text-emerald-800">
        <span
          aria-hidden="true"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${badgeTone[tone]}`}
        >
          {icon}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide">
          {phase}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{body}</p>
    </article>
  );
}

function Feature({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-2 text-slate-600">
      <span
        aria-hidden="true"
        className="inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-100 text-emerald-700"
      >
        {icon}
      </span>
      {label}
    </div>
  );
}
