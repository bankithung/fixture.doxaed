import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellRing,
  Inbox,
  Mail,
  Newspaper,
  Radio,
  SlidersHorizontal,
} from "lucide-react";
import {
  notificationsApi,
  type NotificationPrefs,
  type NotificationPrefsUpdate,
} from "@/api/notifications";
import { useToast } from "@/components/ui/toast";
import { StaggeredDrawer } from "@/components/ui/StaggeredDrawer";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { RangePills } from "@/features/dashboard/RangePills";
import { relativeTime } from "@/features/layout/OrgDashboardPage";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * `/me/notifications` — the notifications center: a full-screen inbox with
 * read/unread filtering, and ALL delivery preferences tucked into a
 * right-side StaggeredMenu drawer behind the Settings button (owner
 * 2026-07-04: keep the options out of the reading surface). Preferences
 * save instantly with optimistic flips; in-app off = the bell stays silent
 * for that event; email on = a branded email the moment it happens; digest
 * = one daily unread summary.
 */

const PREFS_KEY = ["notification-prefs"];

const FILTERS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
];

function Toggle({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked ? "bg-primary" : "bg-muted-foreground/25",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function NotificationPrefsPage(): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState("all");

  const prefsQuery = useQuery({
    queryKey: PREFS_KEY,
    queryFn: notificationsApi.prefs,
  });
  // Shares the bell's cache: read/mark states stay in lockstep.
  const listQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: notificationsApi.list,
  });
  const invalidateList = () =>
    qc.invalidateQueries({ queryKey: ["notifications"] });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: invalidateList,
  });
  const markOne = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: invalidateList,
  });

  const save = useMutation({
    mutationFn: (payload: NotificationPrefsUpdate) =>
      notificationsApi.updatePrefs(payload),
    // Optimistic: flip in the cache immediately, roll back on error.
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY });
      const prev = qc.getQueryData<NotificationPrefs>(PREFS_KEY);
      if (prev) {
        qc.setQueryData<NotificationPrefs>(PREFS_KEY, {
          digest: payload.digest ?? prev.digest,
          kinds: prev.kinds.map((k) =>
            payload.kinds?.[k.kind]
              ? { ...k, ...payload.kinds[k.kind] }
              : k,
          ),
        });
      }
      return { prev };
    },
    onError: (_e, _payload, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
      toast.push({ kind: "error", title: t("Could not save preferences") });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: PREFS_KEY });
    },
  });

  const prefs = prefsQuery.data;
  const allItems = listQuery.data?.results ?? [];
  const unread = listQuery.data?.unread_count ?? 0;
  const items =
    filter === "unread"
      ? allItems.filter((n) => n.read_at === null)
      : filter === "read"
        ? allItems.filter((n) => n.read_at !== null)
        : allItems;

  return (
    <section
      aria-label={t("Notifications")}
      className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">{t("Notifications")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Everything that needs your attention, in one place.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={routes.myProfile()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            {t("Profile")}
          </Link>
          <button
            type="button"
            data-testid="open-notification-settings"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4 text-primary" />
            {t("Settings")}
          </button>
        </div>
      </header>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3">
        <RangePills
          label={t("Filter notifications")}
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f.value, label: t(f.label) }))}
        />
        {unread > 0 ? (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-tabular text-[11px] font-medium text-primary">
            {unread} {t("unread")}
          </span>
        ) : null}
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => markAll.mutate()}
            className="ml-auto text-xs font-medium text-primary hover:underline"
          >
            {t("Mark all read")}
          </button>
        ) : null}
      </div>

      {/* Full-screen inbox */}
      <BentoGrid className="flex flex-col">
        <BentoCard className="animate-fade-up" testId="notifications-inbox">
          {listQuery.isLoading ? (
            <div className="h-40 animate-pulse" data-testid="inbox-skeleton" />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
              <Inbox aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {allItems.length === 0
                  ? t("No notifications yet. New alerts will land here.")
                  : t("Nothing matches this filter.")}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => {
                const row = (
                  <>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        n.read_at ? "bg-transparent" : "bg-primary",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-sm",
                          n.read_at
                            ? "text-muted-foreground"
                            : "font-medium text-foreground",
                        )}
                      >
                        {n.title}
                      </span>
                      {n.body ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {n.body}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                      {relativeTime(n.created_at)}
                    </span>
                  </>
                );
                const cls = cn(
                  "flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent/40",
                  !n.read_at && "bg-primary/[0.03]",
                );
                return (
                  <li key={n.id}>
                    {n.url ? (
                      <Link
                        to={n.url}
                        className={cls}
                        onClick={() => {
                          if (!n.read_at) markOne.mutate(n.id);
                        }}
                      >
                        {row}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className={cls}
                        onClick={() => {
                          if (!n.read_at) markOne.mutate(n.id);
                        }}
                      >
                        {row}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>

      {/* All delivery options live in the staggered settings drawer. */}
      <StaggeredDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t("Notification settings")}
        testId="notification-settings-drawer"
      >
        {prefsQuery.isLoading ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted/50" />
        ) : prefsQuery.isError || !prefs ? (
          <p role="alert" className="text-sm text-destructive">
            {t("Could not load your preferences.")}
          </p>
        ) : (
          <>
            <div className="sdrawer-itemwrap">
              <div className="sdrawer-item" data-testid="prefs-matrix">
                <div className="flex items-center gap-2 pb-1">
                  <BellRing aria-hidden="true" className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold tracking-tight">
                    {t("Alerts by event")}
                  </h3>
                </div>
                <p className="pb-2 text-xs text-muted-foreground">
                  {t("Choose which events alert you and where. Changes save instantly.")}
                </p>
                <div className="flex items-center gap-4 border-b border-border py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  <span className="flex-1">{t("Event")}</span>
                  <span className="flex w-10 items-center justify-center gap-1">
                    <Radio aria-hidden="true" className="h-3 w-3" />
                    {t("Bell")}
                  </span>
                  <span className="flex w-10 items-center justify-center gap-1">
                    <Mail aria-hidden="true" className="h-3 w-3" />
                    {t("Email")}
                  </span>
                </div>
                <ul className="divide-y divide-border">
                  {prefs.kinds.map((k) => (
                    <li key={k.kind} className="flex items-center gap-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t(k.label)}</p>
                        <p className="text-xs text-muted-foreground">
                          {t(k.description)}
                        </p>
                      </div>
                      <span className="flex w-10 justify-center">
                        <Toggle
                          checked={k.in_app}
                          label={`${t(k.label)}: ${t("in-app")}`}
                          testId={`toggle-${k.kind}-in_app`}
                          onChange={(next) =>
                            save.mutate({ kinds: { [k.kind]: { in_app: next } } })
                          }
                        />
                      </span>
                      <span className="flex w-10 justify-center">
                        <Toggle
                          checked={k.email}
                          label={`${t(k.label)}: ${t("email")}`}
                          testId={`toggle-${k.kind}-email`}
                          onChange={(next) =>
                            save.mutate({ kinds: { [k.kind]: { email: next } } })
                          }
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="sdrawer-itemwrap">
              <div
                className="sdrawer-item border-t border-border pt-4"
                data-testid="prefs-digest"
              >
                <div className="flex items-center gap-2 pb-1">
                  <Newspaper aria-hidden="true" className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold tracking-tight">
                    {t("Daily digest")}
                  </h3>
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <p className="text-sm font-medium">
                    {t("Send me a daily summary")}
                  </p>
                  <Toggle
                    checked={prefs.digest}
                    label={t("Daily digest")}
                    testId="toggle-digest"
                    onChange={(next) => save.mutate({ digest: next })}
                  />
                </div>
                <p className="pt-2 text-xs text-muted-foreground">
                  {t(
                    "One quiet email a day with everything you have not read. Nothing unread, nothing sent.",
                  )}
                </p>
              </div>
            </div>
          </>
        )}
      </StaggeredDrawer>
    </section>
  );
}
