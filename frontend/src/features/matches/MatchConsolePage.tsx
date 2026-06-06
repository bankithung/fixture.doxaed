import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
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

// Event palette (live scorebox + set-piece logger). Goal counts toward score;
// the rest are non-scoring match events.
const EVENT_BUTTONS: { type: string; label: string; primary?: boolean }[] = [
  { type: "goal", label: "Goal", primary: true },
  { type: "shot", label: "Shot" },
  { type: "save", label: "Save" },
  { type: "corner", label: "Corner" },
  { type: "free_kick", label: "Free kick" },
  { type: "foul", label: "Foul" },
  { type: "penalty_awarded", label: "Penalty" },
  { type: "yellow_card", label: "Yellow" },
  { type: "red_card", label: "Red" },
];

type Side = "home" | "away";

export function MatchConsolePage(): React.ReactElement {
  const { matchId = "" } = useParams();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    refetchInterval: 5000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["live", matchId] });

  const [minute, setMinute] = useState("");
  const [sel, setSel] = useState<{ home?: string; away?: string }>({});
  const [subOn, setSubOn] = useState<{ home?: string; away?: string }>({});

  const ev = useMutation({
    mutationFn: (p: {
      event_type: string;
      side?: string;
      player_id?: string;
      related_player_id?: string;
    }) =>
      liveApi.recordEvent(matchId, {
        ...p,
        minute: minute ? Number(minute) : undefined,
        event_id: newEventId(),
      }),
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
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">{t("Record event")}</CardTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="minute" className="text-xs">{t("Minute")}</Label>
              <Input
                id="minute"
                inputMode="numeric"
                placeholder="—"
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                className="h-8 w-14 text-center"
              />
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {(["home", "away"] as Side[]).map((side) => {
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
                  <div className="flex flex-wrap gap-1.5">
                    {EVENT_BUTTONS.map((b) => (
                      <Button
                        key={b.type}
                        size="sm"
                        variant={b.primary ? "default" : "outline"}
                        disabled={ev.isPending}
                        onClick={() => fire(b.type)}
                      >
                        {t(b.label)}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <select
                      aria-label={side === "home" ? t("Home sub on") : t("Away sub on")}
                      value={subOn[side] ?? ""}
                      onChange={(e) =>
                        setSubOn((s) => ({ ...s, [side]: e.target.value || undefined }))
                      }
                      className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">{t("Sub on…")}</option>
                      {players.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.jersey_no ? `#${p.jersey_no} ` : ""}
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={ev.isPending || !sel[side] || !subOn[side]}
                      onClick={() =>
                        ev.mutate({
                          event_type: "substitution",
                          side,
                          player_id: sel[side],
                          related_player_id: subOn[side],
                        })
                      }
                    >
                      {t("Sub")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">{t("Event log")}</CardTitle>
          <a
            href={liveApi.exportUrl(matchId)}
            className="text-xs font-medium text-primary hover:underline"
          >
            {t("Export timeline (CSV)")}
          </a>
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
