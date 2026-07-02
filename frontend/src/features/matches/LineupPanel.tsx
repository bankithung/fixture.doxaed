import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Users } from "lucide-react";
import { liveApi, type LiveTeam } from "@/api/live";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";

type Role = "" | "starter" | "substitute";

/** Tap to cycle a player: Out -> Starter -> Bench -> Out. */
function nextRole(r: Role): Role {
  return r === "" ? "starter" : r === "starter" ? "substitute" : "";
}

/**
 * Pre-kickoff team sheets (the backend was complete with zero UI): declare
 * starters and bench per side, save, then confirm to lock the official
 * lineup. Frozen once the match starts (server guard). Suspended players are
 * rejected server-side with a named error.
 */
export function LineupPanel({
  matchId,
  homeTeam,
  awayTeam,
}: {
  matchId: string;
  homeTeam: LiveTeam | null;
  awayTeam: LiveTeam | null;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["lineups", matchId],
    queryFn: () => liveApi.getLineups(matchId),
  });

  // Local role map per team, seeded from the server sheet once loaded.
  const [roles, setRoles] = useState<Record<string, Record<string, Role>>>({});
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !q.data) return;
    const next: Record<string, Record<string, Role>> = {};
    for (const lu of q.data.lineups) {
      if (!lu.team) continue;
      next[lu.team.id] = Object.fromEntries(
        lu.entries.map((e) => [e.player_id, e.role as Role]),
      );
    }
    setRoles(next);
    setSeeded(true);
  }, [q.data, seeded]);

  const save = useMutation({
    mutationFn: (teamId: string) =>
      liveApi.setLineup(matchId, {
        team_id: teamId,
        entries: Object.entries(roles[teamId] ?? {})
          .filter(([, r]) => r !== "")
          .map(([player_id, role]) => ({ player_id, role })),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineups", matchId] });
      toast.push({ kind: "success", title: t("Lineup saved") });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      toast.push({
        kind: "error",
        title: detail.startsWith("player_suspended")
          ? `${t("Suspended player cannot be named")}: ${detail.split(":")[1] ?? ""}`
          : detail || t("Could not save the lineup"),
      });
    },
  });

  const confirm = useMutation({
    mutationFn: (teamId: string) =>
      liveApi.confirmLineup(matchId, { team_id: teamId, event_id: newEventId() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lineups", matchId] });
      toast.push({ kind: "success", title: t("Lineup confirmed") });
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      toast.push({ kind: "error", title: detail || t("Could not confirm the lineup") });
    },
  });

  if (!homeTeam && !awayTeam) return null;

  const confirmedFor = (teamId: string): boolean =>
    Boolean(
      q.data?.lineups.find((lu) => lu.team?.id === teamId)?.confirmed_at,
    );

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Users aria-hidden="true" className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{t("Team sheets")}</h2>
        <span className="text-xs text-muted-foreground">
          {t("Tap a player: start, bench, out. Confirm locks the sheet.")}
        </span>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        {[homeTeam, awayTeam].map((team, idx) => {
          if (!team) return <div key={idx} className="p-5" />;
          const teamRoles = roles[team.id] ?? {};
          const starters = Object.values(teamRoles).filter((r) => r === "starter").length;
          const bench = Object.values(teamRoles).filter((r) => r === "substitute").length;
          const locked = confirmedFor(team.id);
          return (
            <div key={team.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{team.name}</span>
                <span className="font-tabular text-xs text-muted-foreground">
                  {starters} {t("start")} · {bench} {t("bench")}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {team.players.map((p) => {
                  const r = teamRoles[p.id] ?? "";
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={locked}
                      aria-label={`${p.name}: ${r || t("out")}`}
                      onClick={() =>
                        setRoles((all) => ({
                          ...all,
                          [team.id]: { ...teamRoles, [p.id]: nextRole(r) },
                        }))
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                        r === "starter"
                          ? "border-primary bg-primary text-primary-foreground"
                          : r === "substitute"
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {p.jersey_no ? `#${p.jersey_no} ` : ""}
                      {p.name}
                    </button>
                  );
                })}
                {team.players.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("No registered players on this team.")}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 border-t border-border pt-3">
                {locked ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                    <ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5" />
                    {t("Confirmed team sheet")}
                  </span>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={save.isPending}
                      data-testid={`save-lineup-${team.id}`}
                      onClick={() => save.mutate(team.id)}
                    >
                      {t("Save lineup")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={confirm.isPending || starters === 0}
                      data-testid={`confirm-lineup-${team.id}`}
                      onClick={() => confirm.mutate(team.id)}
                    >
                      {t("Confirm")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
