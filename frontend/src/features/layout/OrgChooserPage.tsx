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
    <div className="w-full max-w-2xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("Your tournaments")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Pick a workspace, or start a new tournament.")}
          </p>
        </div>
        <Link
          to={routes.tournamentNew()}
          className="inline-flex shrink-0 items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {t("Start a tournament")}
        </Link>
      </div>
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
          <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t("You haven't started any tournaments yet.")}
            </p>
            <Link
              to={routes.tournamentNew()}
              className="mt-3 inline-flex items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t("Start your first tournament")}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
