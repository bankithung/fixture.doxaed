import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { t } from "@/lib/t";

interface ErrorPageProps {
  /** The error caught by the boundary (or any caller). */
  error?: Error | null;
  /** Optional handler to retry — defaults to `location.reload()`. */
  onRetry?: () => void;
}

/**
 * Generic "something went wrong" surface. NOT wired to a React error
 * boundary in this slice (B6 owns that); exported so a future boundary
 * (or a route-level catch) can render it.
 *
 * Shows a collapsed `<details>` with the error message + stack so the
 * page is friendly by default but inspectable in development.
 */
export function ErrorPage({
  error,
  onRetry,
}: ErrorPageProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const handleRetry = onRetry ?? (() => window.location.reload());

  return (
    <main
      role="alert"
      className="flex min-h-screen items-center justify-center bg-muted/30 p-6"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <span
            aria-hidden="true"
            className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-warning-muted text-warning"
          >
            <AlertTriangle className="h-7 w-7" />
          </span>
          <CardTitle>{t("Something went wrong")}</CardTitle>
          <CardDescription>
            {t("Try refreshing. If it keeps happening, let us know.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <Button
            onClick={handleRetry}
            className="bg-primary hover:bg-primary"
          >
            {t("Try refreshing")}
          </Button>
          {error ? (
            <details
              open={expanded}
              onToggle={(e) => setExpanded(e.currentTarget.open)}
              className="w-full rounded-md border border-border bg-muted/50 p-3 text-left text-xs text-muted-foreground"
            >
              <summary className="cursor-pointer select-none font-medium text-foreground">
                {t("Error details")}
              </summary>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                {error.message}
                {error.stack ? `\n\n${error.stack}` : ""}
              </pre>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
