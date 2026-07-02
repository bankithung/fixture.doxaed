import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuthStore } from "@/features/auth/authStore";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

interface ComingSoonPageProps {
  /**
   * Name of the surface that's "coming soon" — e.g. "Audit log",
   * "Org settings", "Tournaments". Already user-visible: callers should
   * pass an English string; we translate where needed via `t()`.
   */
  feature: string;
  /** Optional explanatory copy override. */
  description?: string;
}

/**
 * Reusable Phase 1A placeholder for surfaces that ship in Phase 1B.
 * Rendered for routes such as `/o/:orgSlug/audit`, `/settings`,
 * `/branding`, and `/tournaments-coming-soon` so the AppShell nav links
 * always lead somewhere intentional rather than 404'ing.
 */
export function ComingSoonPage({
  feature,
  description,
}: ComingSoonPageProps): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const slug = user?.last_active_org_slug ?? user?.memberships[0]?.org_slug;

  const dashboardHref = slug
    ? routes.orgDashboard(slug)
    : routes.orgChooser();

  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <span
            aria-hidden="true"
            className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-success-muted text-primary"
          >
            <Sparkles className="h-7 w-7" />
          </span>
          <CardTitle>{t(`${feature} · coming soon`)}</CardTitle>
          <CardDescription>
            {description ??
              t(
                "This area is part of Phase 1B. Phase 1A ships authentication, organizations, members, and the module override matrix.",
              )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <Link to={dashboardHref}>
            <Button>{t("Back to dashboard")}</Button>
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
