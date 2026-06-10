import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { t } from "@/lib/t";

interface AuthLayoutProps {
  children: ReactNode;
  title: string;
  subtitle?: string;
}

/**
 * Branded two-column shell used across the auth surface (login / signup /
 * password-reset). Stacks on mobile; brand panel hidden below `lg`.
 *
 * - Left: gradient brand panel with wordmark + tagline.
 * - Right: form column.
 *
 * Keeps visual consistency across every unauthenticated page.
 */
export function AuthLayout({
  children,
  title,
  subtitle,
}: AuthLayoutProps): React.ReactElement {
  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <aside
        className="hidden lg:flex flex-col justify-between bg-primary p-12 text-primary-foreground relative overflow-hidden"
        aria-hidden="true"
      >
        <div className="relative z-10">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded-sm"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/15 backdrop-blur-sm font-bold"
            >
              F
            </span>
            <span>{t("Fixture Platform")}</span>
          </Link>
        </div>
        <div className="relative z-10 max-w-sm space-y-4">
          <h2 className="text-3xl font-semibold leading-tight">
            {t("Sports fixtures, made in Nagaland.")}
          </h2>
          <p className="text-sm text-white/80 leading-relaxed">
            {t(
              "Run tournaments, schedule matches, and follow live scores — built for local sport, on a chassis that scales.",
            )}
          </p>
        </div>
        <p className="relative z-10 text-xs text-white/60">
          {t("© Fixture Platform")}
        </p>
      </aside>
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-700 text-white font-bold"
            >
              F
            </span>
            <span>{t("Fixture Platform")}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
