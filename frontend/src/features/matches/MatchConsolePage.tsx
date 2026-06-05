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
  const ev = useMutation({
    mutationFn: (p: { event_type: string; side?: string }) =>
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
            {(["home", "away"] as const).map((side) => (
              <div key={side} className="flex flex-col gap-2">
                <div className="text-xs font-medium text-muted-foreground">
                  {side === "home"
                    ? (match.home_team?.name ?? t("Home"))
                    : (match.away_team?.name ?? t("Away"))}
                </div>
                <Button
                  size="sm"
                  disabled={ev.isPending}
                  onClick={() => ev.mutate({ event_type: "goal", side })}
                >
                  {t("Goal")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ev.isPending}
                  onClick={() => ev.mutate({ event_type: "yellow_card", side })}
                >
                  {t("Yellow card")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ev.isPending}
                  onClick={() => ev.mutate({ event_type: "red_card", side })}
                >
                  {t("Red card")}
                </Button>
              </div>
            ))}
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
                  <span>{t(e.type.replace(/_/g, " "))}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
