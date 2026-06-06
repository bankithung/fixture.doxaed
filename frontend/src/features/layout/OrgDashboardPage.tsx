import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/features/auth/authStore";
import { DashboardCard } from "@/components/ui/DashboardCard";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  computeDashboardCards,
  PHASE_1B_TEASERS,
  type DashboardCardConfig,
} from "@/features/orgs/dashboardCards";
import { feedbackApi } from "@/api/feedback";
import { ApiError } from "@/types/api";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";

/**
 * Org Dashboard — the landing page after login. Cards are role/module-aware:
 * we read `effective_modules` off the user's active membership and let
 * `computeDashboardCards()` decide what to show. Pure presentation here.
 */
export function OrgDashboardPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership =
    user?.memberships.find((m) => m.org_slug === orgSlug) ?? null;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const toast = useToast();
  const feedbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // Auto-open the feedback modal when arriving with `?feedback=1` (used by
  // Phase 1B role-landing pages whose footer links here for feedback).
  useEffect(() => {
    if (searchParams.get("feedback") === "1") {
      setFeedbackOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete("feedback");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const cards = useMemo<DashboardCardConfig[]>(() => {
    if (!user) return [];
    return computeDashboardCards({
      user,
      membership,
      slug: orgSlug,
    });
  }, [user, membership, orgSlug]);

  const orgName = membership?.org_name ?? orgSlug;
  const roles = membership?.roles ?? [];
  const { isMobile } = useBreakpoint();
  const initials =
    (user?.name || user?.email || "?")
      .trim()
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  const greeting = isMobile
    ? t("Welcome back")
    : `${t("Welcome back")}${user?.name ? `, ${user.name}` : ""}`;

  const closeFeedback = (): void => {
    setFeedbackOpen(false);
    setFeedbackText("");
  };

  const submitFeedback = async (): Promise<void> => {
    const message = feedbackText.trim();
    if (!message) {
      toast.push({
        kind: "error",
        title: t("Cannot send empty feedback"),
        description: t("Type a short note before sending."),
      });
      feedbackTextareaRef.current?.focus();
      return;
    }
    setFeedbackSubmitting(true);
    try {
      await feedbackApi.submit({
        message,
        source_url:
          typeof window !== "undefined" ? window.location.pathname : undefined,
        event_id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : undefined,
      });
      toast.push({
        kind: "success",
        title: t("Feedback sent"),
        description: t("Thanks — the platform team will read this."),
      });
      closeFeedback();
    } catch (e) {
      const detail =
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not send feedback"))
          : e instanceof Error
            ? e.message
            : t("Could not send feedback");
      toast.push({
        kind: "error",
        title: t("Could not send feedback"),
        description: detail,
      });
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:gap-8 sm:p-6 lg:p-8">
      <header className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {greeting}
            </p>
            <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
              {orgName}
            </h1>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="role-pill">
              {roles.length > 0 ? (
                roles.map((role) => (
                  <span
                    key={role}
                    className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-medium capitalize text-primary"
                  >
                    {role.replace(/_/g, " ")}
                  </span>
                ))
              ) : (
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {t("No active role")}
                </span>
              )}
            </div>
          </div>
          <div
            aria-hidden="true"
            className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-lg font-semibold text-primary-foreground shadow-sm sm:flex"
          >
            {initials}
          </div>
        </div>
        <p className="relative mt-4 max-w-2xl text-sm text-muted-foreground">
          {t(
            "Pick a card to jump straight to that surface. Everything is filtered to what you have access to.",
          )}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Quick actions")}
        </h2>
        <section
          aria-label={t("Available actions")}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="dashboard-cards"
        >
          {cards.length === 0 ? (
            <p className="col-span-full text-sm text-muted-foreground">
              {t("Loading your modules...")}
            </p>
          ) : (
            cards.map((card) => (
              <DashboardCard
                key={card.key}
                icon={card.icon}
                title={card.title}
                description={card.description}
                href={card.href}
                badge={card.badge}
                onClick={
                  card.action === "feedback"
                    ? (): void => setFeedbackOpen(true)
                    : undefined
                }
              />
            ))
          )}
        </section>
      </div>

      {PHASE_1B_TEASERS.length > 0 ? (
        <aside
          aria-label={t("Roadmap preview")}
          className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm"
          data-testid="phase1b-teaser"
        >
          <p className="font-medium">{t("More coming soon")}</p>
          <p className="mt-1 text-muted-foreground">
            {PHASE_1B_TEASERS.map((s) => t(s)).join(", ")}
            {"."}
          </p>
        </aside>
      ) : null}

      <Dialog
        open={feedbackOpen}
        onOpenChange={(open): void => {
          if (!open) closeFeedback();
          else setFeedbackOpen(true);
        }}
        ariaLabel={t("Send feedback")}
      >
        <DialogHeader>
          <DialogTitle>{t("Send feedback")}</DialogTitle>
          <DialogDescription>
            {t(
              "Share a bug, feature idea, or general note. The platform team will see it.",
            )}
          </DialogDescription>
        </DialogHeader>
        <textarea
          ref={feedbackTextareaRef}
          aria-label={t("Feedback message")}
          className="min-h-[120px] w-full rounded-md border bg-background p-2 text-sm"
          placeholder={t("What is on your mind?")}
          value={feedbackText}
          onChange={(e): void => setFeedbackText(e.target.value)}
          disabled={feedbackSubmitting}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={closeFeedback}
            disabled={feedbackSubmitting}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            onClick={(): void => {
              void submitFeedback();
            }}
            disabled={feedbackSubmitting}
          >
            {feedbackSubmitting ? t("Sending...") : t("Send")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
