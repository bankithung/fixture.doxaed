import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Power,
  ScrollText,
  Trophy,
  Wrench,
} from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { DeleteTournamentButton } from "@/features/tournaments/DeleteTournamentButton";
import { RenameTournamentButton } from "@/features/tournaments/RenameTournamentButton";
import { DisputesPanel } from "@/features/disputes/DisputesPanel";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { ScoringPresetsPanel } from "@/features/tournaments/ops/ScoringPresetsPanel";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const STATUS_CLS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-info-muted text-info-foreground",
  registration_open: "bg-warning-muted text-warning-foreground",
  scheduled: "bg-primary/15 text-primary",
  live: "bg-destructive/15 text-destructive",
  completed: "bg-success-muted text-success-foreground",
  archived: "bg-muted text-muted-foreground",
};

/** A public link with open + copy-to-clipboard (operations sharing). */
function PublicLink({
  label,
  path,
}: {
  label: string;
  path: string;
}): React.ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const href =
    typeof window !== "undefined" ? window.location.origin + path : path;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      toast.push({ kind: "success", title: t("Link copied") });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push({ kind: "error", title: t("Could not copy the link") });
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {href}
        </span>
      </span>
      <button
        type="button"
        aria-label={t("Copy link")}
        onClick={() => void copy()}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check aria-hidden="true" className="h-4 w-4 text-primary" />
        ) : (
          <Copy aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        aria-label={`${t("Open")} ${label}`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    </div>
  );
}

/** One row in the "Setup & configuration" hatch (links back to a setup page). */
function ToolLink({
  to,
  icon: Icon,
  label,
  hint,
}: {
  to: string;
  icon: typeof Trophy;
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-accent/30"
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {hint}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

/**
 * Operations Settings (ops 2026-06-26) — what a manager needs once the event is
 * RUNNING, deliberately different from the setup-era rules editor (scoring rules
 * are frozen by now). Identity (rename, status, time zone), public sharing
 * links, the audit log + disputes, a demoted "Setup & configuration" hatch back
 * to the setup pages for late changes/regeneration, and the organizer danger
 * zone. The rules editor stays at the setup pages, reachable from the hatch.
 */
export function OpsSettingsPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();

  const tournamentQ = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
  });
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });

  const tour = tournamentQ.data;
  const name = tour?.name ?? t("Tournament");
  const status = tour?.status ?? "scheduled";
  const slug = tour?.slug ?? "";
  const tz = tour?.time_zone ?? "UTC";
  const canManage = stageQ.data?.can_manage ?? false;
  const canDelete = stageQ.data?.can_delete ?? false;
  const archived = status === "archived";

  const setActive = useMutation({
    mutationFn: (active: boolean) => tournamentsApi.setActive(id, active),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tournament", id] });
      qc.invalidateQueries({ queryKey: ["tournaments"] });
      toast.push({
        kind: "success",
        title:
          data.status === "archived"
            ? t("Tournament deactivated")
            : t("Tournament reactivated"),
      });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update the tournament"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10">
          <Wrench aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div>
          <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {t("Operations")}
          </p>
          <h2 className="text-lg font-semibold tracking-tight">{t("Settings")}</h2>
        </div>
      </div>

      {/* Identity */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">{t("Tournament")}</h3>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10">
            <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-base font-semibold">{name}</span>
              {canManage ? (
                <RenameTournamentButton tournamentId={id} currentName={name} />
              ) : null}
            </div>
            <span
              className={cn(
                "mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                STATUS_CLS[status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {t(status.replace(/_/g, " "))}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
          <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>
            {t("Time zone")}:{" "}
            <span className="font-medium text-foreground">{tz}</span>
          </span>
          <span className="text-xs">
            {t("(locked while the schedule is live)")}
          </span>
        </div>
      </section>

      {/* Scoring regimes (P2): one-click official presets per sport. */}
      {canManage ? <ScoringPresetsPanel tournamentId={id} /> : null}

      {/* Public pages */}
      {slug ? (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div>
            <h3 className="text-sm font-semibold">{t("Public pages")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("Read-only links for schools and spectators.")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <PublicLink
              label={t("Schedule")}
              path={routes.publicSchedule(slug, id)}
            />
            <PublicLink label={t("Live scores")} path={routes.publicLive(slug, id)} />
            <PublicLink label={t("Bracket")} path={routes.publicBracket(slug, id)} />
          </div>
        </section>
      ) : null}

      {/* Audit log */}
      <Link
        to={routes.tournamentAudit(id)}
        className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
          <ScrollText aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("Audit log")}</div>
          <div className="text-xs text-muted-foreground">
            {t("Every stage change, score and admin action. Append-only.")}
          </div>
        </div>
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </Link>

      <DisputesPanel tournamentId={id} />

      {/* Setup & configuration hatch — demoted, for late changes / regeneration. */}
      {canManage ? (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div>
            <h3 className="text-sm font-semibold">{t("Setup & configuration")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("For late registrations, rule changes and regenerating fixtures.")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ToolLink
              to={routes.tournamentSports(id)}
              icon={Trophy}
              label={t("Sports & rules")}
              hint={t("Competitions, scoring rules, format")}
            />
            <ToolLink
              to={routes.tournamentForms(id)}
              icon={FileText}
              label={t("Registration forms")}
              hint={t("The institution & team forms")}
            />
            <ToolLink
              to={routes.tournamentInstitutions(id)}
              icon={Building2}
              label={t("Institutions")}
              hint={t("Registered schools")}
            />
            <ToolLink
              to={routes.tournamentFixtures(id)}
              icon={CalendarClock}
              label={t("Fixtures")}
              hint={t("Re-run or regenerate the schedule")}
            />
          </div>
        </section>
      ) : null}

      {/* Danger zone — organizer only. */}
      {canDelete ? (
        <section className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card p-4 shadow-sm">
          <div>
            <h3 className="text-sm font-semibold">{t("Status & danger zone")}</h3>
            <p className="text-xs text-muted-foreground">
              {archived
                ? t("Inactive (archived). Reactivate it to resume.")
                : t("Deactivate to hide it, or delete it permanently.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(archived ? true : false)}
              data-testid="toggle-active"
            >
              <Power aria-hidden="true" className="h-4 w-4" />
              {archived ? t("Reactivate") : t("Deactivate")}
            </Button>
            <DeleteTournamentButton tournamentId={id} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
