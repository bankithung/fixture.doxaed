import { Link } from "react-router-dom";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Stub /about page. Real content (mission, team, contact, terms) is
 * out-of-scope for the auth-polish slice; this exists so the footer + the
 * signup terms link have a destination instead of 404'ing.
 */
export function AboutPage(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-4">
          <Link
            to={routes.landing()}
            className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-700 text-white font-bold"
            >
              F
            </span>
            <span>{t("Fixture Platform")}</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {t("About Fixture Platform")}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          {t(
            "Fixture is a multi-tenant tournament and fixture management platform built for sport in Nagaland. v1 is a vertical slice for football, with the chassis designed to extend to nine more sports.",
          )}
        </p>
        <p className="mt-3 text-base leading-relaxed text-slate-600">
          {t(
            "Detailed terms and a public roadmap are coming soon. Until then, get in touch via your organization administrator.",
          )}
        </p>
        <div className="mt-8">
          <Link
            to={routes.landing()}
            className="text-sm font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Back home")}
          </Link>
        </div>
      </main>
    </div>
  );
}
