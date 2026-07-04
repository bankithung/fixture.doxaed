import { Link } from "react-router-dom";
import { ArrowLeft, BellRing, Mail, Newspaper, Radio } from "lucide-react";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * `/me/notifications` — Phase 1A placeholder, on the bento language.
 *
 * Real preferences (per-event, per-channel) land in Phase 1B alongside
 * the notification dispatcher. We render a friendly stub so menu links
 * don't dead-end and screen readers get a real document landmark.
 */

const CHANNELS = [
  {
    icon: Radio,
    title: "In-app",
    body: "Live pings in the bell the moment a match kicks off.",
  },
  {
    icon: Mail,
    title: "Email",
    body: "Key moments delivered to your inbox as they happen.",
  },
  {
    icon: Newspaper,
    title: "Digest",
    body: "One quiet summary of everything you missed.",
  },
] as const;

export function NotificationPrefsPage(): React.ReactElement {
  return (
    <section
      aria-label={t("Notification preferences")}
      className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8"
    >
      <header>
        <h1 className="page-title">{t("Notifications")}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t("Choose which events alert you and where.")}
        </p>
      </header>

      <BentoGrid className="flex flex-col gap-3">
        <BentoCard particles className="animate-fade-up">
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <BellRing aria-hidden="true" className="h-6 w-6 text-primary" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                {t("Coming in Phase 1B")}
              </h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {t(
                  "When matches go live, opt in or out of in-app, email, and digest alerts per event.",
                )}
              </p>
            </div>
            <Link
              to={routes.myProfile()}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              {t("Back to profile")}
            </Link>
          </div>
        </BentoCard>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {CHANNELS.map((ch, i) => {
            const Icon = ch.icon;
            return (
              <BentoCard
                key={ch.title}
                className="animate-fade-up"
                style={{ animationDelay: `${(i + 1) * 60}ms` }}
              >
                <div className="flex flex-col gap-2 p-4">
                  <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold tracking-tight">
                    {t(ch.title)}
                  </h3>
                  <p className="text-xs text-muted-foreground">{t(ch.body)}</p>
                </div>
              </BentoCard>
            );
          })}
        </div>
      </BentoGrid>
    </section>
  );
}
