import * as React from "react";
import { Link, useParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PreviewTile, type PreviewTileProps } from "@/components/ui/PreviewTile";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Shared layout used by the three Phase 1B-only role landing pages
 * (scorer / referee / team-manager). Each page supplies its own hero
 * copy and a list of "what's coming" preview tiles; the shell handles
 * the consistent "What you can do today" footer with profile /
 * notification / feedback links.
 *
 * The pages don't fetch any endpoints — Phase 1A has no real Tournament
 * or Match data to surface. We rely entirely on local user state + the
 * existing /me, /me/notifications, and feedback-modal entry points.
 */

export interface RoleLandingShellProps {
  /** Hero heading. Must already be wrapped in t() by the caller. */
  heroTitle: string;
  /** Hero sub-heading. Must already be wrapped in t() by the caller. */
  heroSubtitle: string;
  /** Preview tiles describing Phase 1B capabilities. */
  tiles: PreviewTileProps[];
  /** Optional "available today" highlighted CTA (e.g. link to live Tournaments). */
  availableNow?: {
    title: string;
    description: string;
    href: string;
    cta: string;
  };
  /** Optional callback to open the feedback modal (Phase 1B handoff). */
  onSendFeedback?: () => void;
  /** ARIA label for the page section root. */
  ariaLabel: string;
}

export function RoleLandingShell({
  heroTitle,
  heroSubtitle,
  tiles,
  availableNow,
  onSendFeedback,
  ariaLabel,
}: RoleLandingShellProps): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();

  return (
    <section
      aria-label={ariaLabel}
      className="flex flex-col gap-6 p-6"
      data-org-slug={orgSlug}
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {heroTitle}
        </h1>
        <p className="text-sm text-muted-foreground">{heroSubtitle}</p>
      </header>

      {availableNow ? (
        <Card className="border-primary/40 bg-accent/40">
          <CardHeader>
            <CardTitle>{availableNow.title}</CardTitle>
            <CardDescription>{availableNow.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              to={availableNow.href}
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {availableNow.cta}
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("More coming soon")}</CardTitle>
          <CardDescription>
            {t("Deeper tools we're still building on top of what works today.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="list"
            aria-label={t("Phase 1B preview tiles")}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {tiles.map((tile) => (
              <div role="listitem" key={tile.title}>
                <PreviewTile {...tile} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("What you can do today")}</CardTitle>
          <CardDescription>
            {t(
              "Phase 1A surfaces available to every authenticated member.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            <li>
              <Link
                to={routes.myProfile()}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("View profile")}
              </Link>
              <span className="ml-2 text-xs text-muted-foreground">
                {t("Edit name, change password, manage 2FA")}
              </span>
            </li>
            <li>
              <Link
                to={routes.myNotifications()}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("Update notification preferences")}
              </Link>
              <span className="ml-2 text-xs text-muted-foreground">
                {t("Choose which events alert you (Phase 1B)")}
              </span>
            </li>
            <li>
              {onSendFeedback ? (
                <button
                  type="button"
                  onClick={onSendFeedback}
                  className="text-primary underline-offset-4 hover:underline"
                  aria-label={t("Send feedback")}
                >
                  {t("Send feedback")}
                </button>
              ) : (
                <Link
                  to={`${routes.orgDashboard(orgSlug)}?feedback=1`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {t("Send feedback")}
                </Link>
              )}
              <span className="ml-2 text-xs text-muted-foreground">
                {t("Tell us what's working and what's not")}
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
