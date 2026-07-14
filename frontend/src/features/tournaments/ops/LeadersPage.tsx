import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { Bookmark } from "@/features/fixtures/publicTournamentViews";
import type { LeaderBoard } from "@/features/live/SportLeaderBoards";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Shared table shell: slim header, hairline rows, tabular numbers. */
function StatCard({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        {count != null ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const TH =
  "px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground";
const TD = "px-4 py-2 text-sm";

/** One full board as a table (the panel shows top 3; this page shows all).
 * Rank 1 is the WINNER of this board and reads like it. `detail` gets its own
 * column: it used to sit against the value, so a point difference rendered as
 * "10" immediately followed by "33:23". */
function BoardTable({ board }: { board: LeaderBoard }): React.ReactElement {
  const isPlayer = board.subject === "player";
  const hasDetail = board.rows.some((r) => r.detail);
  return (
    <StatCard title={t(board.label)} count={board.rows.length}>
      {board.rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t("Fills automatically as results land.")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" data-testid={`board-table-${board.key}`}>
            <thead className="border-b border-border">
              <tr>
                <th className={TH}>#</th>
                <th className={TH}>{isPlayer ? t("Player") : t("Team")}</th>
                {isPlayer ? <th className={TH}>{t("Team")}</th> : null}
                {!isPlayer ? (
                  <th className={`${TH} text-right`}>{t("Played")}</th>
                ) : null}
                <th className={`${TH} text-right`}>{t(board.label)}</th>
                {hasDetail ? (
                  <th className={`${TH} text-right`}>{t("Detail")}</th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.rows.map((r, i) => {
                const won = i === 0;
                return (
                  <tr
                    key={r.player_id ?? r.team_id ?? i}
                    className={cn(won && "bg-success-muted/40")}
                  >
                    <td className={`${TD} w-10`}>
                      {won ? (
                        <Trophy
                          aria-label={t("Leader")}
                          className="h-3.5 w-3.5 text-success"
                        />
                      ) : (
                        <span className="font-tabular text-muted-foreground">
                          {i + 1}
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(TD, won ? "font-semibold" : "font-medium")}
                    >
                      {isPlayer ? r.name : r.team_name}
                    </td>
                    {isPlayer ? (
                      <td className={`${TD} text-muted-foreground`}>
                        {r.team_name}
                      </td>
                    ) : null}
                    {!isPlayer ? (
                      <td
                        className={`${TD} text-right font-tabular text-muted-foreground`}
                      >
                        {r.played}
                      </td>
                    ) : null}
                    <td
                      className={`${TD} text-right font-tabular font-semibold`}
                    >
                      {r.value}
                    </td>
                    {hasDetail ? (
                      <td
                        className={`${TD} text-right font-tabular text-xs text-muted-foreground`}
                      >
                        {r.detail}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </StatCard>
  );
}

/**
 * The full leader board (owner ask: the dashboard shows the top 5, this page
 * shows EVERYONE) — PER SPORT (P1.b): each sport renders its own boards from
 * the SportDefinition catalog; a single-sport tournament shows no sport
 * chrome. Live: refetches on a 60s cadence; the Today page's SSE tick also
 * invalidates ["t-leaders"].
 */
export function LeadersPage(): React.ReactElement {
  const { id = "" } = useParams();
  const [sportKey, setSportKey] = useState<string | null>(null);
  const [leaf, setLeaf] = useState<string>("");
  const q = useQuery({
    queryKey: ["t-leaders", id, "full"],
    queryFn: () => tournamentsApi.leaders(id, { full: true }),
    refetchInterval: 60_000,
  });
  const d = q.data;

  if (q.isLoading) {
    return (
      <div className="flex w-full flex-col gap-3" aria-busy="true">
        <div className="h-7 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }

  const sports = d?.sports ?? [];
  const sport = sports.find((s) => s.sport === sportKey) ?? sports[0] ?? null;
  const categories = sport?.categories ?? [];
  // "" = the sport-wide roll-up; otherwise one competition leaf.
  const category = categories.find((c) => c.leaf_key === leaf) ?? null;
  const boards = category?.boards ?? sport?.boards ?? [];
  const played = category?.played ?? sport?.played ?? 0;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="page-title">{t("Leaders")}</h2>
        {d ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {d.played} {t("matches played")}
          </span>
        ) : null}
      </div>

      {!d || d.played === 0 ? (
        <section className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
          <Trophy
            aria-hidden="true"
            className="h-6 w-6 text-muted-foreground/40"
          />
          <p className="text-sm font-medium">{t("No results yet")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t(
              "Every sport's boards, team stats and badges appear here automatically once play starts.",
            )}
          </p>
        </section>
      ) : (
        <>
          {/* One sheet, same shape as the standings page: sport bookmarks on
              the card, category bookmarks inside it. */}
          <div data-testid="leaders-board" className="flex flex-col">
            {sports.length > 1 ? (
              <div
                role="tablist"
                aria-label={t("Sports")}
                className="flex flex-wrap items-end gap-1 px-2"
              >
                {sports.map((s) => (
                  <Bookmark
                    key={s.sport}
                    testid={`leaders-sport-${s.sport}`}
                    active={s.sport === sport?.sport}
                    onClick={() => {
                      setSportKey(s.sport);
                      setLeaf("");
                    }}
                    label={s.name}
                    count={s.played}
                  />
                ))}
              </div>
            ) : null}

            <div
              className={cn(
                "flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5",
                sports.length > 1 && "rounded-tl-none",
              )}
            >
              {/* Per CATEGORY (owner 2026-07-14). The sport-wide table ranked a
                  school's boys team against its own girls team, so the same
                  school appeared twice and nobody was really winning anything.
                  Each category now has its own winner; the sport roll-up stays
                  as the first bookmark. */}
              {categories.length > 1 ? (
                <div
                  role="tablist"
                  aria-label={t("Categories")}
                  className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3"
                >
                  <Bookmark
                    testid="leaders-cat-all"
                    active={!category}
                    onClick={() => setLeaf("")}
                    label={t("All categories")}
                    count={sport?.played}
                  />
                  {categories.map((c) => (
                    <Bookmark
                      key={c.leaf_key}
                      testid={`leaders-cat-${c.leaf_key}`}
                      active={category?.leaf_key === c.leaf_key}
                      onClick={() => setLeaf(c.leaf_key)}
                      label={c.label}
                      count={c.played}
                    />
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="text-sm font-semibold">
                  {category ? category.label : (sport?.name ?? "")}
                </h3>
                <span className="font-tabular text-xs text-muted-foreground">
                  {played} {t("played")}
                </span>
                {!category && categories.length > 1 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("Across every category. Pick one for its own winner.")}
                  </span>
                ) : null}
              </div>

              {played === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("Nothing played here yet.")}
                </p>
              ) : (
                <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                  {boards.map((b) => (
                    <BoardTable key={b.key} board={b} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <StatCard title={t("Badges")} count={d.latest_badges.length}>
            {d.latest_badges.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {t("Badges are awarded automatically for standout results.")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
                {d.latest_badges.map((b) => (
                  <Link
                    key={b.id}
                    to={`/cert/${b.id}`}
                    className="flex items-start gap-2.5 bg-card p-3 transition-colors hover:bg-accent"
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/10">
                      <Award
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-primary"
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {b.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {b.subject}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </StatCard>
        </>
      )}
    </div>
  );
}
