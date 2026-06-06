import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ChevronRight,
  ListChecks,
  MessageSquarePlus,
  Plus,
  Search,
  Trophy,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { feedbackApi } from "@/api/feedback";
import { ApiError } from "@/types/api";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

// --- status presentation (tokens guaranteed to exist) -----------------------
function statusMeta(s: string): { label: string; badge: string; dot: string } {
  const live = s.startsWith("live");
  const map: Record<string, { label: string; badge: string; dot: string }> = {
    draft: { label: "Draft", badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" },
    published: { label: "Published", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    registration_open: { label: "Registration open", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    scheduled: { label: "Scheduled", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    completed: { label: "Completed", badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
    archived: { label: "Archived", badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" },
  };
  if (live) return { label: "Live", badge: "bg-primary/15 text-primary", dot: "bg-primary" };
  return map[s] ?? { label: s.replace(/_/g, " "), badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return t("just now");
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo` : `${Math.round(mo / 12)}y`;
}

const STATUS_FILTER = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "registration_open", label: "Registration open" },
  { value: "scheduled", label: "Scheduled" },
  { value: "live", label: "Live" },
  { value: "completed", label: "Completed" },
];

function Kpi({
  label,
  value,
  sub,
  live,
}: {
  label: string;
  value: number | string;
  sub?: string;
  live?: boolean;
}): React.ReactElement {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
        ) : null}
        {label}
      </div>
      <div className="mt-1 font-tabular text-3xl font-semibold tracking-tight">
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function OrgDashboardPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === orgSlug) ?? null;
  const orgName = membership?.org_name ?? orgSlug;
  const roles = membership?.roles ?? [];
  const { isMobile } = useBreakpoint();
  const greeting = isMobile
    ? t("Welcome back")
    : `${t("Welcome back")}${user?.name ? `, ${user.name}` : ""}`;

  // --- feedback dialog (preserved) ------------------------------------------
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const toast = useToast();
  const feedbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("feedback") === "1") {
      setFeedbackOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete("feedback");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const closeFeedback = (): void => {
    setFeedbackOpen(false);
    setFeedbackText("");
  };
  const submitFeedback = async (): Promise<void> => {
    const message = feedbackText.trim();
    if (!message) {
      toast.push({ kind: "error", title: t("Cannot send empty feedback"), description: t("Type a short note before sending.") });
      feedbackTextareaRef.current?.focus();
      return;
    }
    setFeedbackSubmitting(true);
    try {
      await feedbackApi.submit({
        message,
        source_url: typeof window !== "undefined" ? window.location.pathname : undefined,
        event_id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : undefined,
      });
      toast.push({ kind: "success", title: t("Feedback sent"), description: t("Thanks — the platform team will read this.") });
      closeFeedback();
    } catch (e) {
      const detail = e instanceof ApiError ? (e.payload.detail ?? t("Could not send feedback")) : e instanceof Error ? e.message : t("Could not send feedback");
      toast.push({ kind: "error", title: t("Could not send feedback"), description: detail });
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  // --- data (single list() call drives the whole page; zero per-row fan-out) -
  const tournamentsQuery = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const all: Tournament[] = tournamentsQuery.data ?? [];

  const kpis = useMemo(() => {
    const live = all.filter((x) => x.status.startsWith("live")).length;
    const completed = all.filter((x) => x.status === "completed").length;
    const draft = all.filter((x) => x.status === "draft").length;
    return { total: all.length, live, completed, draft };
  }, [all]);

  // featured match (one lazy matches() call on a live-or-first tournament)
  const featured = all.find((x) => x.status.startsWith("live")) ?? all[0];
  const matchesQuery = useQuery({
    queryKey: ["t-matches", featured?.id],
    queryFn: () => tournamentsApi.matches(featured!.id),
    enabled: !!featured,
  });
  const featuredMatch = useMemo(() => {
    const ms = matchesQuery.data ?? [];
    return (
      ms.find((m) => m.status.startsWith("live")) ??
      ms.find((m) => m.status === "scheduled") ??
      ms[0] ??
      null
    );
  }, [matchesQuery.data]);

  // table filter + sort (client-side over list())
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortAsc, setSortAsc] = useState(true);
  const rows = useMemo(() => {
    let r = all;
    if (statusFilter !== "all") {
      r = r.filter((x) =>
        statusFilter === "live" ? x.status.startsWith("live") : x.status === statusFilter,
      );
    }
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((x) => x.name.toLowerCase().includes(q));
    return [...r].sort((a, b) =>
      sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
    );
  }, [all, statusFilter, search, sortAsc]);

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {greeting}
          </p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
            {orgName}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="role-pill">
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
        <Link
          to="/tournaments/new"
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("New tournament")}
        </Link>
      </div>

      {/* KPI strip */}
      <div
        className="grid grid-cols-2 divide-x divide-y divide-border rounded-xl border border-border bg-card shadow-sm md:grid-cols-4 md:divide-y-0"
        data-testid="kpi-strip"
      >
        <Kpi label={t("Tournaments")} value={kpis.total} sub={t("in this workspace")} />
        <Kpi label={t("Live now")} value={kpis.live} live={kpis.live > 0} sub={t("matches in progress")} />
        <Kpi label={t("Completed")} value={kpis.completed} sub={kpis.total ? `${Math.round((kpis.completed / kpis.total) * 100)}% ${t("of all")}` : undefined} />
        <Kpi label={t("Drafts")} value={kpis.draft} sub={t("not yet published")} />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Tournaments table (spine) */}
        <section className="lg:col-span-2" aria-label={t("Tournaments")}>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <h2 className="mr-auto text-sm font-semibold">{t("Tournaments")}</h2>
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label={t("Search tournaments")}
                  placeholder={t("Search…")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 w-40 pl-8 sm:w-52"
                />
              </div>
              <Select
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_FILTER}
                aria-label={t("Filter by status")}
                className="w-40"
              />
            </div>

            {tournamentsQuery.isLoading ? (
              <div className="divide-y divide-border">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                    <div className="ml-auto h-5 w-16 animate-pulse rounded-full bg-muted" />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
                <Trophy aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {all.length === 0 ? t("No tournaments yet.") : t("No tournaments match your filters.")}
                </p>
                {all.length === 0 ? (
                  <Link to="/tournaments/new" className="text-sm font-medium text-primary hover:underline">
                    {t("Start a tournament →")}
                  </Link>
                ) : null}
              </div>
            ) : isMobile ? (
              <div className="space-y-2 p-3">
                {rows.map((tn) => {
                  const sm = statusMeta(tn.status);
                  return (
                    <Link
                      key={tn.id}
                      to={routes.tournamentDetail(tn.id)}
                      className="block rounded-lg border border-border p-3 transition-colors hover:bg-accent/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{tn.name}</span>
                        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", sm.badge)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
                          {t(sm.label)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {tn.slug} · {relativeTime(tn.created_at)}
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">
                        <button
                          type="button"
                          onClick={() => setSortAsc((v) => !v)}
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {t("Name")}
                          <ArrowDownUp aria-hidden="true" className="h-3.5 w-3.5 opacity-50" />
                        </button>
                      </th>
                      <th className="px-4 py-2.5 font-medium">{t("Status")}</th>
                      <th className="px-4 py-2.5 font-medium">{t("Created")}</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((tn) => {
                      const sm = statusMeta(tn.status);
                      return (
                        <tr
                          key={tn.id}
                          className="group border-t border-border transition-colors hover:bg-accent/40"
                        >
                          <td className="px-4 py-2.5">
                            <Link to={routes.tournamentDetail(tn.id)} className="flex flex-col">
                              <span className="font-medium text-foreground group-hover:text-primary">
                                {tn.name}
                              </span>
                              <span className="text-xs text-muted-foreground">{tn.slug}</span>
                            </Link>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", sm.badge)}>
                              <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
                              {t(sm.label)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-tabular text-muted-foreground">
                            {relativeTime(tn.created_at)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Link to={routes.tournamentDetail(tn.id)} aria-label={t("Open")}>
                              <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 text-muted-foreground/40 group-hover:text-foreground" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Right rail */}
        <aside className="flex flex-col gap-6" aria-label={t("At a glance")}>
          {/* Featured / live match */}
          <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm">
            <span aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
            <div className="relative">
              <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                {featuredMatch && featuredMatch.status.startsWith("live") ? t("Live match") : t("Next match")}
              </p>
              {featured && featuredMatch ? (
                <>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{featured.name}</p>
                  <div className="mt-3 flex items-center justify-center gap-3 font-tabular text-2xl font-semibold">
                    <span className="flex-1 truncate text-right">{featuredMatch.home_team?.short_name ?? featuredMatch.home_team?.name ?? t("TBD")}</span>
                    <span className="shrink-0 tabular-nums">
                      {featuredMatch.home_score ?? 0}–{featuredMatch.away_score ?? 0}
                    </span>
                    <span className="flex-1 truncate text-left">{featuredMatch.away_team?.short_name ?? featuredMatch.away_team?.name ?? t("TBD")}</span>
                  </div>
                  <Link
                    to={routes.matchConsole(featured.id, featuredMatch.id)}
                    className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    {t("Open scorer")}
                    <ChevronRight aria-hidden="true" className="h-4 w-4" />
                  </Link>
                </>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("No live or upcoming match.")}
                </p>
              )}
            </div>
          </div>

          {/* Quick actions */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold">{t("Quick actions")}</h2>
            <div className="grid grid-cols-1 gap-2">
              <Link to="/tournaments" className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent">
                <ListChecks aria-hidden="true" className="h-4 w-4 text-primary" />
                {t("Browse tournaments")}
              </Link>
              <Link to="/tournaments/new" className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent">
                <Plus aria-hidden="true" className="h-4 w-4 text-primary" />
                {t("New tournament")}
              </Link>
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <MessageSquarePlus aria-hidden="true" className="h-4 w-4 text-primary" />
                {t("Send feedback")}
              </button>
            </div>
          </div>
        </aside>
      </div>

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
            {t("Share a bug, feature idea, or general note. The platform team will see it.")}
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
          <Button type="button" variant="outline" onClick={closeFeedback} disabled={feedbackSubmitting}>
            {t("Cancel")}
          </Button>
          <Button type="button" onClick={(): void => void submitFeedback()} disabled={feedbackSubmitting}>
            {feedbackSubmitting ? t("Sending...") : t("Send")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
