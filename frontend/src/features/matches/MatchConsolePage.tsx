import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

const STATE_ACTIONS: Record<string, { label: string; to: string }[]> = {
  scheduled: [{ label: "Start match", to: "live" }],
  live: [
    { label: "Half time", to: "half_time" },
    { label: "Complete", to: "completed" },
  ],
  half_time: [
    { label: "Resume", to: "live" },
    { label: "Complete", to: "completed" },
  ],
};

/**
 * Live scorer console: record events (goal/card) that derive the score, drive
 * the match state machine, and watch the event log. Polls the public snapshot;
 * writes go through the scorer-gated event/transition endpoints.
 */
export function MatchConsolePage(): React.ReactElement {
  const { matchId = "" } = useParams();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    refetchInterval: 5000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["live", matchId] });
  const [sel, setSel] = useState<{ home?: string; away?: string }>({});
  const ev = useMutation({
    mutationFn: (p: { event_type: string; side?: string; player_id?: string }) =>
      liveApi.recordEvent(matchId, { ...p, event_id: newEventId() }),
    onSuccess: refresh,
  });
  const tr = useMutation({
    mutationFn: (to: string) => liveApi.transition(matchId, to),
    onSuccess: refresh,
  });

  if (query.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">{t("Loading...")}</p>;
  }
  if (query.isError || !query.data) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {t("Could not load the match.")}
      </p>
    );
  }

  const { match, events } = query.data;
  const live = match.status === "live" || match.status === "half_time";
  const actions = STATE_ACTIONS[match.status] ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Card>
        <CardContent className="py-6 text-center">
          <div className="text-sm text-muted-foreground">
            {match.home_team?.name ?? t("TBD")} {t("vs")}{" "}
            {match.away_team?.name ?? t("TBD")}
          </div>
          <div className="my-2 font-tabular text-5xl font-semibold">
            {match.home_score ?? 0} – {match.away_score ?? 0}
          </div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {t(match.status.replace(/_/g, " "))}
            {match.current_period
              ? ` · ${t(match.current_period.replace(/_/g, " "))}`
              : ""}
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {actions.map((a) => (
              <Button
                key={a.to}
                variant="outline"
                size="sm"
                disabled={tr.isPending}
                onClick={() => tr.mutate(a.to)}
              >
                {t(a.label)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {live ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Record event")}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            {(["home", "away"] as const).map((side) => {
              const team = side === "home" ? match.home_team : match.away_team;
              const players = team?.players ?? [];
              const fire = (event_type: string) =>
                ev.mutate({ event_type, side, player_id: sel[side] });
              return (
                <div key={side} className="flex flex-col gap-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    {team?.name ?? (side === "home" ? t("Home") : t("Away"))}
                  </div>
                  <select
                    aria-label={side === "home" ? t("Home player") : t("Away player")}
                    value={sel[side] ?? ""}
                    onChange={(e) =>
                      setSel((s) => ({ ...s, [side]: e.target.value || undefined }))
                    }
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t("Team (no player)")}</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.jersey_no ? `#${p.jersey_no} ` : ""}
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" disabled={ev.isPending} onClick={() => fire("goal")}>
                    {t("Goal")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ev.isPending}
                    onClick={() => fire("yellow_card")}
                  >
                    {t("Yellow card")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ev.isPending}
                    onClick={() => fire("red_card")}
                  >
                    {t("Red card")}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Event log")}</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No events yet.")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {events.map((e) => (
                <li key={e.sequence_no} className="flex gap-2">
                  <span className="w-10 text-right font-tabular text-muted-foreground">
                    {e.minute != null ? `${e.minute}'` : `#${e.sequence_no}`}
                  </span>
                  <span>
                    {t(e.type.replace(/_/g, " "))}
                    {e.player ? ` — ${e.player}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
