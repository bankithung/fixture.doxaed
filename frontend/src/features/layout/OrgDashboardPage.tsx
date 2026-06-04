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
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{orgName}</h1>
          {roles.length > 0 ? (
            <span
              className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground"
              data-testid="role-pill"
            >
              {t("You are:")} {roles.join(", ")}
            </span>
          ) : (
            <span
              className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
              data-testid="role-pill"
            >
              {t("No active role")}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t(
            "Pick a card to jump straight to that surface. Cards are filtered to what you have access to.",
          )}
        </p>
      </header>

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

      <aside
        aria-label={t("Phase 1B preview")}
        className="rounded-lg border border-dashed bg-muted/40 p-4 text-sm"
        data-testid="phase1b-teaser"
      >
        <p className="font-medium">{t("Coming in Phase 1B")}</p>
        <p className="mt-1 text-muted-foreground">
          {PHASE_1B_TEASERS.map((s) => t(s)).join(", ")}
          {"."}
        </p>
      </aside>

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
