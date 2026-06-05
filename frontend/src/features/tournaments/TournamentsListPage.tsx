import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

/** Tournament-scoped roles an organizer can assign at invite time. */
const INVITE_ROLES = [
  "co_organizer",
  "game_coordinator",
  "match_scorer",
  "referee",
  "team_manager",
] as const;

function InviteByEmail({ tournamentId }: { tournamentId: string }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("match_scorer");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

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
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (email) invite.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`email-${tournamentId}`} className="text-xs">
          {t("Invite by email")}
        </Label>
        <Input
          id={`email-${tournamentId}`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("person@example.com")}
          className="w-56"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`role-${tournamentId}`} className="text-xs">
          {t("Role")}
        </Label>
        <select
          id={`role-${tournamentId}`}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {INVITE_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(r.replace(/_/g, " "))}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" disabled={!email || invite.isPending}>
        {invite.isPending ? t("Sending...") : t("Send invite")}
      </Button>
      {notice ? (
        <span
          role={notice.kind === "err" ? "alert" : "status"}
          className={`w-full text-xs ${
            notice.kind === "err" ? "text-destructive" : "text-emerald-700"
          }`}
        >
          {notice.text}
        </span>
      ) : null}
    </form>
  );
}

/**
 * The primary post-login surface: tournaments the user runs OR was invited
 * into (server isolation-scoped). The "Organization" concept stays hidden —
 * users see tournaments. Organizers can invite by email inline.
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
      className="inline-flex shrink-0 items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {t("Start a tournament")}
    </Link>
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("Your tournaments")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Tournaments you run or were invited into.")}
          </p>
        </div>
        {startCta}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load tournaments.")}
        </p>
      ) : tournaments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("You haven't started any tournaments yet.")}
          </p>
          <div className="mt-3 flex justify-center">{startCta}</div>
        </div>
      ) : (
        <div className="grid gap-3">
          {tournaments.map((tn) => (
            <Card key={tn.id}>
              <CardHeader>
                <CardTitle className="text-lg">{tn.name}</CardTitle>
                <CardDescription>
                  {t("Status")}: {t(tn.status.replace(/_/g, " "))}
                  {tn.sport_code ? ` · ${tn.sport_code}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InviteByEmail tournamentId={tn.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
