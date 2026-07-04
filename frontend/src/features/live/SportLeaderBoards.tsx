import { Link } from "react-router-dom";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";

/** One row of a leaderboard (player or team). */
export interface LeaderBoardRow {
  player_id?: string;
  team_id?: string;
  name?: string;
  team_name?: string;
  played?: number;
  value: number | string;
  detail?: string;
}

export interface LeaderBoard {
  key: string;
  label: string;
  subject: "player" | "team" | "regu" | "pair";
  fmt: string;
  rows: LeaderBoardRow[];
}

export interface SportLeaders {
  sport: string;
  name: string;
  played: number;
  boards: LeaderBoard[];
}

/**
 * Per-sport leader boards (P1.b) — the shared renderer behind the ops
 * Leaders page/panel and the public leader board. Each sport shows ITS OWN
 * boards from the SportDefinition catalog (sepak ranks by wins/set ratio,
 * football by goals) — sports never pool into one table. A single-sport
 * tournament renders zero sport chrome (single-sport collapse).
 */
export function SportLeaderBoards({
  sports,
  rows = 3,
  teamLink,
  dense = false,
}: {
  sports: SportLeaders[];
  /** Rows shown per board (the full pages pass a higher number). */
  rows?: number;
  /** Optional link builder so public boards deep-link team pages. */
  teamLink?: (teamId: string) => string;
  dense?: boolean;
}): React.ReactElement {
  const multi = sports.length > 1;
  return (
    <div className="flex flex-col">
      {sports.map((s) => (
        <section key={s.sport} aria-label={s.name} className="flex flex-col">
          {multi ? (
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary">
                {s.name}
              </span>
              <span className="font-tabular text-xs text-muted-foreground">
                {s.played} {t("played")}
              </span>
            </div>
          ) : null}
          <div
            className={cn(
              "grid grid-cols-1 divide-y divide-border sm:divide-x sm:divide-y-0",
              s.boards.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
            )}
          >
            {s.boards.map((b) => (
              <div
                key={b.key}
                data-testid={`board-${s.sport}-${b.key}`}
                className={cn("flex flex-col gap-1", dense ? "p-2.5" : "p-3")}
              >
                <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {t(b.label)}
                </p>
                {b.rows.length === 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {Array.from({ length: Math.min(rows, 3) }, (_, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground/60">
                          {i + 1}
                        </span>
                        <span className="h-2 flex-1 rounded-full bg-muted" />
                        <span className="h-2 w-6 rounded-full bg-muted" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <ol className="flex flex-col gap-1">
                    {b.rows.slice(0, rows).map((r, i) => {
                      const label =
                        b.subject === "player"
                          ? (r.name ?? "")
                          : (r.team_name ?? "");
                      const sub =
                        b.subject === "player"
                          ? r.team_name
                          : (r.detail ??
                            (r.played != null
                              ? `${t("in")} ${r.played}`
                              : ""));
                      return (
                        <li
                          key={r.player_id ?? r.team_id ?? i}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground">
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {teamLink && b.subject !== "player" && r.team_id ? (
                              <Link
                                to={teamLink(r.team_id)}
                                className="hover:text-primary hover:underline"
                              >
                                {label}
                              </Link>
                            ) : (
                              label
                            )}
                          </span>
                          {sub ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {sub}
                            </span>
                          ) : null}
                          <span className="font-tabular text-sm font-semibold">
                            {r.value}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
