import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Plus,
  ShieldCheck,
  Trash2,
  Trophy,
  Users,
} from "lucide-react";
import { registrationApi } from "@/api/registration";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
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

const emptyPlayer = (): PlayerRow => ({
  full_name: "",
  jersey_no: "",
  position: "",
  dob_year: "",
});
const emptyTeam = (): TeamRow => ({ name: "", players: [emptyPlayer()] });

/** Common football positions offered in the position dropdown. */
const POSITION_OPTIONS = [
  { value: "", label: t("Position") },
  { value: "GK", label: t("Goalkeeper (GK)") },
  { value: "DF", label: t("Defender (DF)") },
  { value: "MF", label: t("Midfielder (MF)") },
  { value: "FW", label: t("Forward (FW)") },
];

const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

/**
 * Public registration page reached via a shared link (`/register/:token`).
 * A school enters its teams + players (one school can submit multiple teams)
 * and submits — feeding the fixture generator. No account needed.
 *
 * Rendered OUTSIDE the authenticated AppShell, so it carries its own light
 * branded chrome and centers a focused, multi-section data-entry form.
 */
export function RegistrationFormPage(): React.ReactElement {
  const { token = "" } = useParams();
  const { isMobile } = useBreakpoint();
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
      <PublicShell>
        <Centered>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldCheck aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("Invalid or expired registration link")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Ask the organizer for a fresh link.")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  if (done !== null) {
    return (
      <PublicShell>
        <Centered>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("Registration received")}
          </h1>
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {t(`Registered ${done} team(s). Thank you!`)}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  const totalPlayers = teams.reduce(
    (n, tm) => n + tm.players.filter((p) => p.full_name.trim()).length,
    0,
  );
  const namedTeams = teams.filter((tm) => tm.name.trim()).length;
  const canSubmit = !!school.trim() && namedTeams > 0;

  return (
    <PublicShell tournamentName={info.data?.tournament_name}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        {/* Heading */}
        <div>
          <p className={OVERLINE}>{t("Team registration")}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Register for")} {info.data?.tournament_name ?? "…"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Enter your school's teams and players, then submit. No account needed.")}
          </p>
        </div>

        {/* School section */}
        <section
          aria-label={t("School details")}
          className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Trophy aria-hidden="true" className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold">{t("Your school")}</h2>
          </div>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor="school">{t("School / college name")}</Label>
            <Input
              id="school"
              value={school}
              onChange={(e) => setSchool(e.target.value)}
              placeholder={t("e.g. Mount Hermon School")}
              aria-invalid={!!error && !school.trim()}
            />
          </div>
        </section>

        {/* Teams */}
        <section aria-label={t("Teams")} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Users aria-hidden="true" className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold">{t("Teams & players")}</h2>
            </div>
            <span className="font-tabular text-xs text-muted-foreground">
              {namedTeams} {namedTeams === 1 ? t("team") : t("teams")} · {totalPlayers}{" "}
              {totalPlayers === 1 ? t("player") : t("players")}
            </span>
          </div>

          {teams.map((tm, ti) => (
            <div
              key={ti}
              className="rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/10 px-1.5 font-tabular text-xs font-semibold text-primary">
                    {ti + 1}
                  </span>
                  <h3 className="text-sm font-semibold">
                    {tm.name.trim() || `${t("Team")} ${ti + 1}`}
                  </h3>
                </div>
                {teams.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeTeam(ti)}
                    aria-label={t("Remove team")}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                ) : null}
              </div>

              <div className="flex flex-col gap-4 p-5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`team-${ti}`}>{t("Team name")}</Label>
                  <Input
                    id={`team-${ti}`}
                    value={tm.name}
                    onChange={(e) => setTeam(ti, { name: e.target.value })}
                    placeholder={t("e.g. Mount Hermon A")}
                    className="sm:max-w-sm"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <p className={OVERLINE}>{t("Players")}</p>

                  {isMobile ? (
                    <div className="flex flex-col gap-3">
                      {tm.players.map((p, pi) => (
                        <PlayerCard
                          key={pi}
                          player={p}
                          index={pi}
                          removable={tm.players.length > 1}
                          onChange={(patch) => setPlayer(ti, pi, patch)}
                          onRemove={() => removePlayer(ti, pi)}
                        />
                      ))}
                    </div>
                  ) : (
                    <PlayerTable
                      players={tm.players}
                      onChange={(pi, patch) => setPlayer(ti, pi, patch)}
                      onRemove={(pi) => removePlayer(ti, pi)}
                    />
                  )}

                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addPlayer(ti)}
                    >
                      <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
                      {t("Add player")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}

          <div>
            <Button type="button" variant="outline" onClick={addTeam}>
              <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
              {t("Add another team")}
            </Button>
          </div>
        </section>

        {/* Error + submit */}
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t("Double-check names and jersey numbers — these feed the fixtures.")}
          </p>
          <Button
            type="button"
            size="lg"
            className="sm:w-auto"
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
    </PublicShell>
  );
}

/** Desktop players grid: aligned columns with an overline header row. */
function PlayerTable({
  players,
  onChange,
  onRemove,
}: {
  players: PlayerRow[];
  onChange: (pi: number, patch: Partial<PlayerRow>) => void;
  onRemove: (pi: number) => void;
}): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
            <th className="pb-1.5 pr-2 font-medium">{t("Player name")}</th>
            <th className="pb-1.5 pr-2 font-medium">{t("Jersey")}</th>
            <th className="pb-1.5 pr-2 font-medium">{t("Position")}</th>
            <th className="pb-1.5 pr-2 font-medium">{t("Birth year")}</th>
            <th className="pb-1.5" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {players.map((p, pi) => (
            <tr key={pi} className="align-top">
              <td className="py-1 pr-2">
                <Input
                  aria-label={t("Player name")}
                  placeholder={t("Full name")}
                  value={p.full_name}
                  onChange={(e) => onChange(pi, { full_name: e.target.value })}
                  className="min-w-44"
                />
              </td>
              <td className="py-1 pr-2">
                <Input
                  aria-label={t("Jersey")}
                  placeholder="#"
                  inputMode="numeric"
                  value={p.jersey_no}
                  onChange={(e) => onChange(pi, { jersey_no: e.target.value })}
                  className="w-16 text-center font-tabular"
                />
              </td>
              <td className="py-1 pr-2">
                <Select
                  value={p.position}
                  onChange={(v) => onChange(pi, { position: v })}
                  options={POSITION_OPTIONS}
                  aria-label={t("Position")}
                  placeholder={t("Position")}
                  className="w-36"
                />
              </td>
              <td className="py-1 pr-2">
                <Input
                  aria-label={t("Birth year")}
                  placeholder={t("YYYY")}
                  inputMode="numeric"
                  value={p.dob_year}
                  onChange={(e) => onChange(pi, { dob_year: e.target.value })}
                  className="w-24 font-tabular"
                />
              </td>
              <td className="py-1 align-middle">
                {players.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => onRemove(pi)}
                    aria-label={t("Remove player")}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mobile player entry: a stacked, labeled card per player. */
function PlayerCard({
  player,
  index,
  removable,
  onChange,
  onRemove,
}: {
  player: PlayerRow;
  index: number;
  removable: boolean;
  onChange: (patch: Partial<PlayerRow>) => void;
  onRemove: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className={OVERLINE}>
          {t("Player")} {index + 1}
        </span>
        {removable ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t("Remove player")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Input
          aria-label={t("Player name")}
          placeholder={t("Full name")}
          value={player.full_name}
          onChange={(e) => onChange({ full_name: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-2">
          <Input
            aria-label={t("Jersey")}
            placeholder={t("Jersey #")}
            inputMode="numeric"
            value={player.jersey_no}
            onChange={(e) => onChange({ jersey_no: e.target.value })}
            className="font-tabular"
          />
          <Input
            aria-label={t("Birth year")}
            placeholder={t("Birth year")}
            inputMode="numeric"
            value={player.dob_year}
            onChange={(e) => onChange({ dob_year: e.target.value })}
            className="font-tabular"
          />
        </div>
        <Select
          value={player.position}
          onChange={(v) => onChange({ position: v })}
          options={POSITION_OPTIONS}
          aria-label={t("Position")}
          placeholder={t("Position")}
        />
      </div>
    </div>
  );
}

/**
 * Lightweight public chrome for the standalone registration page (it lives
 * outside the authenticated AppShell). A trustworthy branded top bar over a
 * muted backdrop so schools know who they're registering with.
 */
function PublicShell({
  children,
  tournamentName,
}: {
  children: React.ReactNode;
  tournamentName?: string;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary font-bold text-primary-foreground"
          >
            F
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">
            {t("Fixture Platform")}
          </span>
          {tournamentName ? (
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {tournamentName}
            </span>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div
        className={cn(
          "w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm",
        )}
      >
        {children}
      </div>
    </div>
  );
}
