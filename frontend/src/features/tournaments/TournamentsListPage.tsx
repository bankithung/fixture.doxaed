import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { routes } from "@/lib/routes";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Tournament-scoped roles an organizer can assign at invite time. */
const INVITE_ROLES = [
  "co_organizer",
  "game_coordinator",
  "match_scorer",
  "referee",
  "team_manager",
] as const;

function statusBadge(status: string): { label: string; cls: string } {
  if (status.startsWith("live")) return { label: "Live", cls: "bg-primary/15 text-primary" };
  const m: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    published: { label: "Published", cls: "bg-secondary text-secondary-foreground" },
    registration_open: { label: "Registration open", cls: "bg-secondary text-secondary-foreground" },
    scheduled: { label: "Scheduled", cls: "bg-secondary text-secondary-foreground" },
    completed: { label: "Completed", cls: "bg-accent text-accent-foreground" },
    archived: { label: "Archived", cls: "bg-muted text-muted-foreground" },
  };
  return m[status] ?? { label: status.replace(/_/g, " "), cls: "bg-muted text-muted-foreground" };
}

function InviteByEmail({ tournamentId }: { tournamentId: string }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("match_scorer");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      tournamentsApi.invite(tournamentId, { email, role, event_id: newEventId() }),
    onSuccess: () => {
      setNotice({ kind: "ok", text: t("Invitation sent.") });
      setEmail("");
    },
    onError: (e) =>
      setNotice({
        kind: "err",
        text:
          e instanceof ApiError
            ? (e.payload.detail ?? t("Could not send invitation"))
            : t("Could not send invitation"),
      }),
  });

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (email) invite.mutate();
      }}
    >
      <div className="flex flex-1 flex-col gap-1">
        <Label htmlFor={`email-${tournamentId}`} className="text-xs text-muted-foreground">
          {t("Invite by email")}
        </Label>
        <Input
          id={`email-${tournamentId}`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("person@example.com")}
          className="min-w-[12rem]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("Role")}</span>
        <Select
          value={role}
          onChange={setRole}
          options={INVITE_ROLES.map((r) => ({ value: r, label: t(r.replace(/_/g, " ")) }))}
          aria-label={t("Role")}
          className="w-40"
        />
      </div>
      <Button type="submit" size="sm" disabled={!email || invite.isPending}>
        {invite.isPending ? t("Sending...") : t("Send invite")}
      </Button>
      {notice ? (
        <span
          role={notice.kind === "err" ? "alert" : "status"}
          className={cn(
            "w-full text-xs",
            notice.kind === "err" ? "text-destructive" : "text-primary",
          )}
        >
          {notice.text}
        </span>
      ) : null}
    </form>
  );
}

/**
 * The primary post-login surface: tournaments the user runs OR was invited
 * into (server isolation-scoped). Organizers can invite by email inline.
 */
export function TournamentsListPage(): React.ReactElement {
  const query = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const tournaments = query.data ?? [];

  const startCta = (
    <Link
      to={routes.tournamentNew()}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus aria-hidden="true" className="h-4 w-4" />
      {t("Start a tournament")}
    </Link>
  );

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Your tournaments")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Tournaments you run or were invited into.")}
          </p>
        </div>
        {startCta}
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load tournaments.")}
        </p>
      ) : tournaments.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("You haven't started any tournaments yet.")}
          </p>
          {startCta}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tournaments.map((tn) => {
            const badge = statusBadge(tn.status);
            return (
              <div
                key={tn.id}
                className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={routes.tournamentDetail(tn.id)}
                    className="min-w-0 font-semibold tracking-tight hover:text-primary focus-visible:underline focus-visible:outline-none"
                  >
                    <span className="block truncate">{tn.name}</span>
                  </Link>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", badge.cls)}>
                    {t(badge.label)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tn.slug}
                  {tn.sport_code ? ` · ${tn.sport_code}` : ""}
                </p>
                <Link
                  to={routes.tournamentDetail(tn.id)}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t("Manage teams, fixtures & scores")}
                  <ChevronRight aria-hidden="true" className="h-4 w-4" />
                </Link>
                <InviteByEmail tournamentId={tn.id} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
