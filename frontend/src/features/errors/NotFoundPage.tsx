import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * Catch-all `*` route. Centered card with a friendly 404 message and a
 * "back home" CTA. Wired in App.tsx; replaces the previous behaviour of
 * silently redirecting unknown routes to `/`.
 */
export function NotFoundPage(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <span
            aria-hidden="true"
            className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
          >
            <Compass className="h-7 w-7" />
          </span>
          <CardTitle>{t("404. Page not found")}</CardTitle>
          <CardDescription>
            {t("This page doesn't exist or has moved.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <Link to={routes.landing()}>
            <Button className="bg-emerald-700 hover:bg-emerald-800">
              {t("Back home")}
            </Button>
          </Link>
          <Link
            to={routes.login()}
            className="text-xs text-muted-foreground hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Sign in instead")}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
