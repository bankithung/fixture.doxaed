import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Radio } from "lucide-react";
import { liveApi, type LiveTeam, type MiniPlayer } from "@/api/live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
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
// the rest are non-scoring match events. `tone` maps to a token style.
const EVENT_BUTTONS: {
  type: string;
  label: string;
  tone: "primary" | "neutral" | "warn" | "danger";
}[] = [
  { type: "goal", label: "Goal", tone: "primary" },
  { type: "shot", label: "Shot", tone: "neutral" },
  { type: "save", label: "Save", tone: "neutral" },
  { type: "corner", label: "Corner", tone: "neutral" },
  { type: "free_kick", label: "Free kick", tone: "neutral" },
  { type: "foul", label: "Foul", tone: "neutral" },
  { type: "penalty_awarded", label: "Penalty", tone: "warn" },
  { type: "yellow_card", label: "Yellow", tone: "warn" },
  { type: "red_card", label: "Red", tone: "danger" },
];

// Token-only tone classes for the event palette buttons.
const TONE_CLS: Record<string, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover",
  neutral:
    "border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
  warn:
    "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80",
  danger:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

// Status -> badge presentation (tokens only).
function statusMeta(s: string): { label: string; badge: string; dot: string; live: boolean } {
  const live = s === "live" || s === "half_time";
  const map: Record<string, { label: string; badge: string; dot: string }> = {
    scheduled: { label: "Scheduled", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    live: { label: "Live", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    half_time: { label: "Half time", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    completed: { label: "Completed", badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
  };
  const m = map[s] ?? { label: s.replace(/_/g, " "), badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
  return { ...m, live };
}

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
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load the match.")}
        </p>
      </div>
    );
  }

  const { match, events } = query.data;
  const live = match.status === "live" || match.status === "half_time";
  const actions = STATE_ACTIONS[match.status] ?? [];
  const sm = statusMeta(match.status);
  const homeName = match.home_team?.name ?? t("TBD");
  const awayName = match.away_team?.name ?? t("TBD");

  // Build player options for the custom <Select> (jersey prefix preserved).
  const playerOptions = (players: MiniPlayer[]) =>
    players.map((p) => ({
      value: p.id,
      label: `${p.jersey_no ? `#${p.jersey_no} ` : ""}${p.name}`,
    }));

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Page header */}
      <div className="flex flex-col gap-1">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Scoring console")}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {homeName} <span className="text-muted-foreground">{t("vs")}</span> {awayName}
        </h1>
      </div>

      {/* Scoreboard */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative flex flex-col items-center gap-4 px-6 py-8">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
              sm.badge,
            )}
          >
            {sm.live ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            ) : (
              <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
            )}
            {t(sm.label)}
            {match.current_period ? (
              <span className="text-muted-foreground">
                · {t(match.current_period.replace(/_/g, " "))}
              </span>
            ) : null}
          </span>

          <div className="grid w-full max-w-xl grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-medium sm:text-base">{homeName}</div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Home")}
              </div>
            </div>
            <div className="font-tabular text-4xl font-semibold tabular-nums sm:text-6xl">
              {match.home_score ?? 0}
              <span className="px-2 text-muted-foreground">–</span>
              {match.away_score ?? 0}
            </div>
            <div className="min-w-0 text-left">
              <div className="truncate text-sm font-medium sm:text-base">{awayName}</div>
              <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {t("Away")}
              </div>
            </div>
          </div>

          {actions.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {actions.map((a) => (
                <Button
                  key={a.to}
                  variant={a.to === "live" || a.to === "completed" ? "default" : "outline"}
                  size="sm"
                  disabled={tr.isPending}
                  onClick={() => tr.mutate(a.to)}
                >
                  {t(a.label)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Record event */}
      {live ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("Record event")}</h2>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="minute" className="text-xs text-muted-foreground">
                {t("Minute")}
              </Label>
              <Input
                id="minute"
                inputMode="numeric"
                placeholder="—"
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                className="h-9 w-16 text-center font-tabular"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            {(["home", "away"] as Side[]).map((side) => {
              const team: LiveTeam | null = side === "home" ? match.home_team : match.away_team;
              const players = team?.players ?? [];
              const fire = (event_type: string) =>
                ev.mutate({ event_type, side, player_id: sel[side] });
              const playerLabel = side === "home" ? t("Home player") : t("Away player");
              const subLabel = side === "home" ? t("Home sub on") : t("Away sub on");
              return (
                <div key={side} className="flex flex-col gap-3 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {team?.name ?? (side === "home" ? t("Home") : t("Away"))}
                    </span>
                    <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {side === "home" ? t("Home") : t("Away")}
                    </span>
                  </div>

                  <Select
                    aria-label={playerLabel}
                    value={sel[side] ?? ""}
                    onChange={(v) => setSel((s) => ({ ...s, [side]: v || undefined }))}
                    options={[
                      { value: "", label: t("Team (no player)") },
                      ...playerOptions(players),
                    ]}
                    placeholder={t("Team (no player)")}
                  />

                  <div className="grid grid-cols-3 gap-1.5">
                    {EVENT_BUTTONS.map((b) => (
                      <button
                        key={b.type}
                        type="button"
                        disabled={ev.isPending}
                        onClick={() => fire(b.type)}
                        className={cn(
                          "inline-flex h-9 items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
                          TONE_CLS[b.tone],
                        )}
                      >
                        {t(b.label)}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-end gap-2 border-t border-border pt-3">
                    <div className="flex flex-1 flex-col gap-1">
                      <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                        {t("Substitution")}
                      </span>
                      <Select
                        aria-label={subLabel}
                        value={subOn[side] ?? ""}
                        onChange={(v) => setSubOn((s) => ({ ...s, [side]: v || undefined }))}
                        options={[
                          { value: "", label: t("Sub on…") },
                          ...playerOptions(players),
                        ]}
                        placeholder={t("Sub on…")}
                      />
                    </div>
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
          </div>
        </div>
      ) : null}

      {/* Event log / timeline */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">{t("Event log")}</h2>
          <a
            href={liveApi.exportUrl(matchId)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Export timeline (CSV)")}
          </a>
        </div>
        <div className="px-5 py-4">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No events yet.")}</p>
          ) : (
            <ol className="flex flex-col">
              {events.map((e, i) => (
                <li
                  key={e.sequence_no}
                  className={cn(
                    "flex items-baseline gap-3 py-2 text-sm",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <span className="w-12 shrink-0 text-right font-tabular tabular-nums text-muted-foreground">
                    {e.minute != null ? `${e.minute}'` : `#${e.sequence_no}`}
                  </span>
                  <span className="text-foreground">
                    {t(e.type.replace(/_/g, " "))}
                    {e.player ? (
                      <span className="text-muted-foreground"> — {e.player}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
