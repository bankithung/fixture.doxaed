import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Users } from "lucide-react";
import { liveApi, type LiveTeam } from "@/api/live";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { sideView } from "@/features/live/lineups/adapter";
import { resolveLineupView } from "@/features/live/lineups/registry";
import type { LineupSideView } from "@/features/live/lineups/types";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";

type Role = "" | "starter" | "substitute";
type ViewMode = "list" | "court";

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
  sportKey,
  family,
  playersPerSide = null,
}: {
  matchId: string;
  homeTeam: LiveTeam | null;
  awayTeam: LiveTeam | null;
  /** Picks the per-sport court visual (same registry as the public hub). */
  sportKey: string;
  family: string;
  /** On-court cap from the category's NvN format; null = not defined. */
  playersPerSide?: number | null;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState<ViewMode>("list");
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

  // Court view: the SAME per-sport visual the public hub renders (registry +
  // shared adapter), fed the local role map so it previews unsaved edits too.
  // No declared players falls back to the roster, exactly like the hub.
  const CourtLineups = resolveLineupView(sportKey, family).Lineups;
  const courtSide = (team: LiveTeam | null): LineupSideView | null => {
    if (!team) return null;
    const teamRoles = roles[team.id] ?? {};
    // The saved sheet's positional_role (sepak regu slot, football line) wins
    // over the player's registered position text.
    const saved = new Map(
      (q.data?.lineups.find((lu) => lu.team?.id === team.id)?.entries ?? []).map(
        (e) => [e.player_id, e.positional_role ?? ""],
      ),
    );
    return sideView(team, {
      confirmed: confirmedFor(team.id),
      entries: team.players
        .filter((p) => (teamRoles[p.id] ?? "") !== "")
        .map((p) => ({
          player_id: p.id,
          name: p.name,
          role: teamRoles[p.id],
          shirt_no: p.jersey_no,
          positional_role: saved.get(p.id) || p.position,
        })),
    });
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Users aria-hidden="true" className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{t("Team sheets")}</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {view === "list"
            ? t("Set each player to Start, Bench or Out. Confirm locks the sheet.")
            : t("Read only preview of the sheets.")}
        </span>
        <div
          role="radiogroup"
          aria-label={t("Team sheet view")}
          className="ml-auto inline-flex shrink-0 rounded-lg border border-border bg-muted/20 p-0.5"
        >
          {(
            [
              ["list", t("List")],
              ["court", t("Court view")],
            ] as const
          ).map(([mode, lbl]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={view === mode}
              data-testid={`lineup-view-${mode}`}
              onClick={() => setView(mode)}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === mode
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>
      {view === "court" ? (
        <CourtLineups home={courtSide(homeTeam)} away={courtSide(awayTeam)} />
      ) : (
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
                <span
                  className={cn(
                    "font-tabular text-xs",
                    playersPerSide != null && starters > playersPerSide
                      ? "font-medium text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {starters} {t("start")} · {bench} {t("bench")}
                  {playersPerSide != null
                    ? ` · ${playersPerSide} ${t("on court")}`
                    : ""}
                </span>
              </div>
              {playersPerSide != null && starters > playersPerSide ? (
                <p
                  data-testid={`lineup-cap-warning-${team.id}`}
                  className="text-xs font-medium text-destructive"
                >
                  {t(
                    `This category plays ${playersPerSide} at a time. Move ${starters - playersPerSide} starter(s) to the bench.`,
                  )}
                </p>
              ) : null}
              {team.players.length > 0 ? (
                <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                  {team.players.map((p, i) => {
                    const r = teamRoles[p.id] ?? "";
                    return (
                      <div
                        key={p.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2",
                          i > 0 && "border-t border-border",
                          r === "starter" && "bg-primary/5",
                        )}
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary font-tabular text-xs font-semibold text-secondary-foreground">
                          {p.jersey_no != null
                            ? p.jersey_no
                            : (p.name.charAt(0) || "?").toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{p.name}</p>
                          {p.position ? (
                            <p className="truncate text-[0.6875rem] text-muted-foreground">
                              {p.position}
                            </p>
                          ) : null}
                        </div>
                        <div
                          role="radiogroup"
                          aria-label={`${p.name} ${t("role")}`}
                          className="inline-flex shrink-0 rounded-lg border border-border bg-muted/20 p-0.5"
                        >
                          {(
                            [
                              ["starter", t("Start")],
                              ["substitute", t("Bench")],
                              ["", t("Out")],
                            ] as const
                          ).map(([value, lbl]) => (
                            <button
                              key={value || "out"}
                              type="button"
                              role="radio"
                              aria-checked={r === value}
                              disabled={locked}
                              onClick={() =>
                                setRoles((all) => ({
                                  ...all,
                                  [team.id]: { ...teamRoles, [p.id]: value },
                                }))
                              }
                              className={cn(
                                "h-6 rounded-md px-2 text-[0.6875rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                                r === value
                                  ? value === "starter"
                                    ? "bg-primary text-primary-foreground"
                                    : value === "substitute"
                                      ? "bg-primary/15 text-primary"
                                      : "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {lbl}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("No registered players on this team.")}
                </p>
              )}
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
      )}
    </div>
  );
}
