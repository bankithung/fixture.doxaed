import type { PublicResultGroup } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MedalCount } from "./MedalChip";

/**
 * The champion of each authored category group.
 *
 * "Who won U-14 table tennis" is not a question the category tree can answer —
 * it is a question the HOST asks of it, so a group is an authored list of
 * competitions and nothing in this file knows what an age band or a gender is.
 * A group with an empty list is every competition, which is how "Overall" is
 * expressed without a special case.
 *
 * A tie has more than one champion, and the board says so rather than picking
 * one: two schools level on points and on every medal count ARE level.
 */

const STATUS: Record<string, { label: string; cls: string }> = {
  final: { label: "Final", cls: "bg-success-muted text-success" },
  provisional: { label: "Still playing", cls: "bg-warning-muted text-warning" },
  pending: { label: "Not decided", cls: "bg-muted text-muted-foreground" },
};

function Podium({
  rows,
  places,
  labelOf,
}: {
  rows: PublicResultGroup["table"];
  places: number[];
  labelOf: (p: number) => string;
}): React.ReactElement {
  const top = rows.slice(0, 3);
  return (
    <ol className="flex flex-col gap-2">
      {top.map((row) => (
        <li
          key={row.id}
          data-testid={`podium-${row.rank}`}
          className={cn(
            "flex items-center gap-3 rounded-lg border px-3 py-2",
            row.rank === 1
              ? "border-medal-1/40 bg-medal-1-muted"
              : "border-border bg-card",
          )}
        >
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-tabular text-xs font-semibold",
              row.rank === 1
                ? "bg-medal-1 text-card"
                : row.rank === 2
                  ? "bg-medal-2 text-card"
                  : "bg-medal-3 text-card",
            )}
          >
            {row.rank}
          </span>
          <TeamCrest
            src={row.crest}
            name={row.name}
            size={row.rank === 1 ? "lg" : "md"}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate font-medium",
                row.rank === 1 ? "text-base" : "text-sm",
              )}
              title={row.name}
            >
              {row.name}
            </span>
            <span className="mt-0.5 flex items-center gap-2">
              {places.map((p) => (
                <MedalCount
                  key={p}
                  place={p}
                  count={row.medals[String(p)] ?? 0}
                  label={labelOf(p)}
                />
              ))}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block font-tabular text-lg font-semibold">
              {row.points}
            </span>
            <span className="block text-[0.6875rem] text-muted-foreground">
              {t("points")}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ChampionsView({
  groups,
  places,
  labelOf,
  competitionLabel,
}: {
  groups: PublicResultGroup[];
  places: number[];
  labelOf: (p: number) => string;
  competitionLabel: (leafKey: string) => string;
}): React.ReactElement {
  if (!groups.length) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm font-medium">{t("No category groups yet.")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "The host names the groups a champion is awarded for, in Settings.",
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => {
        const status = STATUS[g.status] ?? STATUS.pending!;
        return (
          <section
            key={g.key}
            data-testid={`champion-group-${g.key}`}
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
          >
            <header className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{g.label}</h3>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                  status.cls,
                )}
              >
                {t(status.label)}
              </span>
              <span className="ml-auto font-tabular text-xs text-muted-foreground">
                {g.leaf_keys.length}{" "}
                {g.leaf_keys.length === 1
                  ? t("competition")
                  : t("competitions")}
              </span>
            </header>

            {g.table.length ? (
              <Podium rows={g.table} places={places} labelOf={labelOf} />
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                {t("Nothing decided in this group yet.")}
              </p>
            )}

            {g.table.length > 3 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {t("Everyone else")} ({g.table.length - 3})
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {g.table.slice(3).map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 px-1 py-0.5"
                    >
                      <span className="w-5 text-right font-tabular text-muted-foreground">
                        {row.rank}
                      </span>
                      <TeamCrest src={row.crest} name={row.name} size="xs" />
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      <span className="font-tabular font-medium">
                        {row.points}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <p className="border-t border-border pt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
              {g.leaf_keys.map(competitionLabel).join(" · ") ||
                t("No competition matches this group.")}
            </p>
          </section>
        );
      })}
    </div>
  );
}
