import { Link } from "react-router-dom";
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
 * `/me/notifications` — Phase 1A placeholder.
 *
 * Real preferences (per-event, per-channel) land in Phase 1B alongside
 * the notification dispatcher. We render a friendly stub so menu links
 * don't dead-end and screen readers get a real document landmark.
 */
export function NotificationPrefsPage(): React.ReactElement {
  return (
    <section
      aria-label={t("Notification preferences")}
      className="flex flex-col gap-4 p-6"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Notifications")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("Choose which events alert you and on which channel.")}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("Coming in Phase 1B")}</CardTitle>
          <CardDescription>
            {t("Notification preferences land in Phase 1B.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            {t(
              "Once tournaments and matches go live, you will be able to opt in or out of in-app, email, and digest notifications per event type.",
            )}
          </p>
          <p className="mt-3">
            <Link
              to={routes.myProfile()}
              className="text-primary underline-offset-4 hover:underline"
            >
              {t("Back to profile")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
