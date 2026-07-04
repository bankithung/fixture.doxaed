import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellRing, Mail, Newspaper, Radio } from "lucide-react";
import {
  notificationsApi,
  type NotificationPrefs,
  type NotificationPrefsUpdate,
} from "@/api/notifications";
import { useToast } from "@/components/ui/toast";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * `/me/notifications` — live notification preferences (Phase 1B, shipped).
 * The kind catalog comes from the server (GET /api/notifications/prefs/);
 * every switch saves immediately with an optimistic flip and rolls back on
 * error. In-app off = the bell stays silent for that event; email on = a
 * branded email the moment it happens; digest = one daily unread summary.
 */

const PREFS_KEY = ["notification-prefs"];

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

  const prefsQuery = useQuery({
    queryKey: PREFS_KEY,
    queryFn: notificationsApi.prefs,
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

  return (
    <section
      aria-label={t("Notification preferences")}
      className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">{t("Notifications")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Choose which events alert you and where. Changes save instantly.")}
          </p>
        </div>
        <Link
          to={routes.myProfile()}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t("Back to profile")}
        </Link>
      </header>

      {prefsQuery.isLoading ? (
        <div
          className="h-56 animate-pulse rounded-xl border border-border bg-card"
          data-testid="prefs-skeleton"
        />
      ) : prefsQuery.isError || !prefs ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load your preferences.")}
        </p>
      ) : (
        <BentoGrid className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <BentoCard className="animate-fade-up lg:col-span-2" testId="prefs-matrix">
            <div className="panel-header gap-2">
              <BellRing aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="panel-title">{t("Alerts by event")}</h2>
            </div>
            <div className="flex items-center gap-6 border-b border-border px-4 py-2 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <span className="flex-1">{t("Event")}</span>
              <span className="flex w-12 items-center justify-center gap-1">
                <Radio aria-hidden="true" className="h-3 w-3" />
                {t("Bell")}
              </span>
              <span className="flex w-12 items-center justify-center gap-1">
                <Mail aria-hidden="true" className="h-3 w-3" />
                {t("Email")}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {prefs.kinds.map((k) => (
                <li key={k.kind} className="flex items-center gap-6 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(k.label)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(k.description)}
                    </p>
                  </div>
                  <span className="flex w-12 justify-center">
                    <Toggle
                      checked={k.in_app}
                      label={`${t(k.label)}: ${t("in-app")}`}
                      testId={`toggle-${k.kind}-in_app`}
                      onChange={(next) =>
                        save.mutate({ kinds: { [k.kind]: { in_app: next } } })
                      }
                    />
                  </span>
                  <span className="flex w-12 justify-center">
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
          </BentoCard>

          <BentoCard
            className="animate-fade-up"
            style={{ animationDelay: "60ms" }}
            testId="prefs-digest"
          >
            <div className="panel-header gap-2">
              <Newspaper aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="panel-title">{t("Daily digest")}</h2>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{t("Send me a daily summary")}</p>
                <Toggle
                  checked={prefs.digest}
                  label={t("Daily digest")}
                  testId="toggle-digest"
                  onChange={(next) => save.mutate({ digest: next })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "One quiet email a day with everything you have not read. Nothing unread, nothing sent.",
                )}
              </p>
            </div>
          </BentoCard>
        </BentoGrid>
      )}
    </section>
  );
}
