import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trophy, Wand2 } from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type StandingsGroup,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

function ScoreRow({
  match,
  tournamentId,
}: {
  match: MatchRow;
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const save = useMutation({
    mutationFn: () =>
      tournamentsApi.score(match.id, {
        home_score: Number(home),
        away_score: Number(away),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-matches", tournamentId] });
      qc.invalidateQueries({ queryKey: ["t-standings", tournamentId] });
    },
  });
  const done = match.status === "completed";

  return (
    <div className="flex items-center gap-2 border-b py-1.5 text-sm last:border-0">
      <span className="flex-1 truncate text-right">
        {match.home_team?.name ?? t("TBD")}
      </span>
      {done ? (
        <span className="w-16 text-center font-tabular font-semibold">
          {match.home_score} – {match.away_score}
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <Input
            aria-label={t("Home score")}
            inputMode="numeric"
            value={home}
            onChange={(e) => setHome(e.target.value)}
            className="h-8 w-12 text-center"
          />
          <span>–</span>
          <Input
            aria-label={t("Away score")}
            inputMode="numeric"
            value={away}
            onChange={(e) => setAway(e.target.value)}
            className="h-8 w-12 text-center"
          />
          <Button
            size="sm"
            disabled={home === "" || away === "" || save.isPending}
            onClick={() => save.mutate()}
          >
            {t("Save")}
          </Button>
        </span>
      )}
      <span className="flex-1 truncate">{match.away_team?.name ?? t("TBD")}</span>
    </div>
  );
}

function StandingsTable({ group }: { group: StandingsGroup }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{group.group_label}</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm font-tabular">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{t("Team")}</th>
              {["P", "W", "D", "L", "GF", "GA", "GD", "Pts"].map((h) => (
                <th key={h} className="px-1 py-1 text-right font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr key={r.team_id} className="border-t">
                <td className="py-1 pr-2">{r.name}</td>
                {[r.P, r.W, r.D, r.L, r.GF, r.GA, r.GD, r.Pts].map((v, i) => (
                  <td
                    key={i}
                    className={`px-1 py-1 text-right ${i === 7 ? "font-semibold" : ""}`}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function TournamentDetailPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: ["t-matches", id], queryFn: () => tournamentsApi.matches(id) });
  const standings = useQuery({ queryKey: ["t-standings", id], queryFn: () => tournamentsApi.standings(id) });

  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const createLink = useMutation({
    mutationFn: () => tournamentsApi.createRegistrationLink(id),
    onSuccess: (r) =>
      setLinkUrl(`${window.location.origin}/register/${r.token}`),
  });
  const generate = useMutation({
    mutationFn: () => tournamentsApi.generateFixtures(id, 5),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-matches", id] });
      qc.invalidateQueries({ queryKey: ["t-standings", id] });
    },
  });

  const grouped = useMemo(() => {
    const g: Record<string, MatchRow[]> = {};
    for (const m of matches.data ?? []) {
      (g[m.group_label || "—"] ||= []).push(m);
    }
    return g;
  }, [matches.data]);

  const teamCount = teams.data?.length ?? 0;
  const matchCount = matches.data?.length ?? 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Trophy aria-hidden="true" className="h-6 w-6 text-primary" />
          {t("Tournament")}
        </h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => createLink.mutate()}
            disabled={createLink.isPending}
          >
            <Link2 aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {t("Share registration link")}
          </Button>
          <Button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || teamCount < 2 || matchCount > 0}
          >
            <Wand2 aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {matchCount > 0 ? t("Fixtures generated") : t("Generate fixtures")}
          </Button>
        </div>
      </div>

      {linkUrl ? (
        <div className="rounded-md border bg-accent/40 p-3 text-sm">
          <p className="mb-1 font-medium">{t("Share this link with schools:")}</p>
          <code className="block break-all rounded bg-background px-2 py-1 text-xs">
            {linkUrl}
          </code>
        </div>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold">
          {t("Teams")} ({teamCount})
        </h2>
        {teams.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
        ) : teamCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No teams yet — share the registration link so schools can enter.")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {teams.data!.map((tm) => (
              <div key={tm.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="truncate font-medium">{tm.name}</div>
                <div className="text-xs text-muted-foreground">
                  {tm.pool || t("Unseeded")} · {tm.player_count} {t("players")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {matchCount > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t("Fixtures & scores")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(grouped).map(([label, ms]) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="text-base">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  {ms.map((m) => (
                    <ScoreRow key={m.id} match={m} tournamentId={id} />
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {(standings.data?.groups.length ?? 0) > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t("Standings")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {standings.data!.groups.map((g) => (
              <StandingsTable key={g.group_label} group={g} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
