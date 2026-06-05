import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { registrationApi } from "@/api/registration";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

interface PlayerRow {
  full_name: string;
  jersey_no: string;
  position: string;
  dob_year: string;
}
interface TeamRow {
  name: string;
  players: PlayerRow[];
}

const emptyPlayer = (): PlayerRow => ({ full_name: "", jersey_no: "", position: "", dob_year: "" });
const emptyTeam = (): TeamRow => ({ name: "", players: [emptyPlayer()] });

/**
 * Public registration page reached via a shared link (`/register/:token`).
 * A school enters its teams + players (one school can submit multiple teams)
 * and submits — feeding the fixture generator. No account needed.
 */
export function RegistrationFormPage(): React.ReactElement {
  const { token = "" } = useParams();
  const info = useQuery({
    queryKey: ["reglink", token],
    queryFn: () => registrationApi.info(token),
    retry: false,
  });

  const [school, setSchool] = useState("");
  const [teams, setTeams] = useState<TeamRow[]>([emptyTeam()]);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setTeam = (ti: number, patch: Partial<TeamRow>) =>
    setTeams((ts) => ts.map((tm, i) => (i === ti ? { ...tm, ...patch } : tm)));
  const addTeam = () => setTeams((ts) => [...ts, emptyTeam()]);
  const removeTeam = (ti: number) =>
    setTeams((ts) => (ts.length > 1 ? ts.filter((_, i) => i !== ti) : ts));
  const setPlayer = (ti: number, pi: number, patch: Partial<PlayerRow>) =>
    setTeams((ts) =>
      ts.map((tm, i) =>
        i === ti
          ? { ...tm, players: tm.players.map((p, j) => (j === pi ? { ...p, ...patch } : p)) }
          : tm,
      ),
    );
  const addPlayer = (ti: number) =>
    setTeams((ts) =>
      ts.map((tm, i) => (i === ti ? { ...tm, players: [...tm.players, emptyPlayer()] } : tm)),
    );
  const removePlayer = (ti: number, pi: number) =>
    setTeams((ts) =>
      ts.map((tm, i) =>
        i === ti
          ? {
              ...tm,
              players: tm.players.length > 1 ? tm.players.filter((_, j) => j !== pi) : tm.players,
            }
          : tm,
      ),
    );

  const submit = useMutation({
    mutationFn: () =>
      registrationApi.submit(token, {
        school_name: school.trim(),
        event_id: newEventId(),
        teams: teams
          .filter((tm) => tm.name.trim())
          .map((tm) => ({
            name: tm.name.trim(),
            players: tm.players
              .filter((p) => p.full_name.trim())
              .map((p) => ({
                full_name: p.full_name.trim(),
                ...(p.jersey_no ? { jersey_no: Number(p.jersey_no) } : {}),
                ...(p.position ? { position: p.position } : {}),
                ...(p.dob_year ? { dob_year: Number(p.dob_year) } : {}),
              })),
          })),
      }),
    onSuccess: (res) => setDone(res.registered),
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Submission failed"))
          : t("Submission failed"),
      ),
  });

  if (info.isError) {
    return (
      <Centered>
        <CardTitle>{t("Invalid or expired registration link")}</CardTitle>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Ask the organizer for a fresh link.")}
        </p>
      </Centered>
    );
  }

  if (done !== null) {
    return (
      <Centered>
        <CardTitle>{t("Registration received")}</CardTitle>
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {t(`Registered ${done} team(s). Thank you!`)}
        </p>
      </Centered>
    );
  }

  const canSubmit = !!school.trim() && teams.some((tm) => tm.name.trim());

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">
        {t("Register for")} {info.data?.tournament_name ?? "…"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Enter your school's teams and players, then submit.")}
      </p>

      <div className="mt-6 flex flex-col gap-1.5">
        <Label htmlFor="school">{t("School / college name")}</Label>
        <Input id="school" value={school} onChange={(e) => setSchool(e.target.value)} />
      </div>

      {teams.map((tm, ti) => (
        <Card key={ti} className="mt-4">
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">{t("Team")} {ti + 1}</CardTitle>
            {teams.length > 1 ? (
              <button
                type="button"
                onClick={() => removeTeam(ti)}
                aria-label={t("Remove team")}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`team-${ti}`}>{t("Team name")}</Label>
              <Input
                id={`team-${ti}`}
                value={tm.name}
                onChange={(e) => setTeam(ti, { name: e.target.value })}
              />
            </div>
            <div className="text-overline font-medium uppercase text-muted-foreground">
              {t("Players")}
            </div>
            {tm.players.map((p, pi) => (
              <div key={pi} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t("Player name")}
                  placeholder={t("Player name")}
                  value={p.full_name}
                  onChange={(e) => setPlayer(ti, pi, { full_name: e.target.value })}
                  className="min-w-40 flex-1"
                />
                <Input
                  aria-label={t("Jersey")}
                  placeholder="#"
                  inputMode="numeric"
                  value={p.jersey_no}
                  onChange={(e) => setPlayer(ti, pi, { jersey_no: e.target.value })}
                  className="w-16"
                />
                <Input
                  aria-label={t("Position")}
                  placeholder={t("Pos")}
                  value={p.position}
                  onChange={(e) => setPlayer(ti, pi, { position: e.target.value })}
                  className="w-20"
                />
                <Input
                  aria-label={t("Birth year")}
                  placeholder={t("Born")}
                  inputMode="numeric"
                  value={p.dob_year}
                  onChange={(e) => setPlayer(ti, pi, { dob_year: e.target.value })}
                  className="w-20"
                />
                {tm.players.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removePlayer(ti, pi)}
                    aria-label={t("Remove player")}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => addPlayer(ti)}>
              <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
              {t("Add player")}
            </Button>
          </CardContent>
        </Card>
      ))}

      <Button type="button" variant="outline" className="mt-4" onClick={addTeam}>
        <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
        {t("Add another team")}
      </Button>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-6">
        <Button
          type="button"
          size="lg"
          disabled={!canSubmit || submit.isPending}
          onClick={() => {
            setError(null);
            submit.mutate();
          }}
        >
          {submit.isPending ? t("Submitting...") : t("Submit registration")}
        </Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md p-6 text-center">{children}</Card>
    </div>
  );
}
