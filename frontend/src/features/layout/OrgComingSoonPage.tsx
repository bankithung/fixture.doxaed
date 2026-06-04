import { Link, useParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Phase 1B placeholder used for tournaments / branding / audit / settings /
 * notifications until those features land. Keeps deep links from 404'ing.
 */
export function OrgComingSoonPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  return (
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Coming soon")}</CardTitle>
          <CardDescription>
            {t(
              "This area is part of Phase 1B. The chassis is in place, but the feature has not shipped yet.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <Link
            to={routes.orgDashboard(orgSlug)}
            className="text-primary underline"
          >
            {t("Back to dashboard")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
