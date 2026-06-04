import { Link } from "react-router-dom";
import { useAuthStore } from "@/features/auth/authStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

export function OrgChooserPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  if (!user) return <div />;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">
        {t("Choose an organization")}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {t("You're a member of these orgs. Pick one to continue.")}
      </p>
      <div className="grid gap-3">
        {user.memberships.map((m) => (
          <Link key={m.org_id} to={routes.orgDashboard(m.org_slug)}>
            <Card className="transition-colors hover:bg-accent">
              <CardHeader>
                <CardTitle className="text-lg">{m.org_name}</CardTitle>
                <CardDescription>
                  {m.roles.join(", ")} · /o/{m.org_slug}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {t(`${m.effective_modules.length} modules accessible`)}
              </CardContent>
            </Card>
          </Link>
        ))}
        {user.memberships.length === 0 ? (
          <p className="text-sm">
            {t(
              "You don't belong to any organizations yet. Sign up creates a personal one automatically; otherwise wait for an invitation.",
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
