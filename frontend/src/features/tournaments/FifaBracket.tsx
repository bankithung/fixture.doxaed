import { Check, Trophy } from "lucide-react";
import type { MatchRow, MatchSource } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Human label for an unresolved bracket slot from its typed pointer:
 * group_position → "Group A #1"; winner/loser pointers stay TBD (the tree's
 * connector line already shows which match feeds the slot). */
export function sourceLabel(src: MatchSource | null | undefined): string | null {
  if (!src) return null;
  if (src.type === "group_position" && src.position) {
    return src.group_label ? `${src.group_label} #${src.position}` : `#${src.position}`;
  }
  return null;
}

// Deterministic geometry so the connectors line up (shared with the legacy tree).
const CARD_H = 56;
const BASE_GAP = 28;
const SLOT = CARD_H + BASE_GAP;
const STUB = 16;

type Side = "home" | "away";

function winnerSide(m: MatchRow): Side | null {
  if (m.status !== "completed" || m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return "home";
  if (m.away_score > m.home_score) return "away";
  return null;
}

/** Round label by distance from the final (Final / Semi-final / Quarter-final /
 * Round of N) — derived from the data, no hardcoding. */
function roundLabel(distanceFromFinal: number): string {
  if (distanceFromFinal === 0) return t("Final");
  if (distanceFromFinal === 1) return t("Semi-finals");
  if (distanceFromFinal === 2) return t("Quarter-finals");
  return `${t("Round of")} ${2 ** (distanceFromFinal + 1)}`;
}

function MatchCard({ m, mirror }: { m: MatchRow; mirror?: boolean }): React.ReactElement {
  const win = winnerSide(m);
  const homeName = m.home_team?.name ?? sourceLabel(m.home_source) ?? undefined;
  const awayName = m.away_team?.name ?? sourceLabel(m.away_source) ?? undefined;
  const row = (name: string | undefined, score: number | null, side: Side) => (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 py-1",
        mirror && "flex-row-reverse text-right",
        win === side && "bg-accent/60 font-semibold text-foreground",
      )}
    >
      {win === side ? (
        <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-primary" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="flex-1 truncate text-xs">{name ?? t("TBD")}</span>
      <span className="font-tabular text-xs tabular-nums">{score ?? "–"}</span>
    </div>
  );
  return (
    <div className="w-48 overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      {row(homeName, m.home_score, "home")}
      <div className="h-px bg-border" />
      {row(awayName, m.away_score, "away")}
    </div>
  );
}

/** One half of the bracket: columns flowing toward the centre. `mirror` flips
 * the connectors + card layout for the right half. `columns` are ordered
 * OUTERMOST→innermost (Round-1 first). */
function Half({
  columns,
  mirror,
}: {
  columns: MatchRow[][];
  mirror: boolean;
}): React.ReactElement {
  const cols = columns.map((ms, ci) => {
    const gap = 2 ** ci * SLOT - CARD_H;
    const firstTop = ((2 ** ci - 1) * SLOT) / 2;
    const last = ci === columns.length - 1;
    const edge = mirror ? { right: "100%" } : { left: "100%" };
    const elbowEdge = mirror
      ? { right: `calc(100% + ${STUB}px)` }
      : { left: `calc(100% + ${STUB}px)` };
    return (
      <div key={ci} className="flex flex-col" style={{ minWidth: 192 + STUB * 2 }}>
        {ms.map((m, mi) => (
          <div
            key={m.id}
            className="relative"
            style={{ height: CARD_H, marginTop: mi === 0 ? firstTop : gap }}
          >
            <MatchCard m={m} mirror={mirror} />
            {!last ? (
              <>
                <span
                  className="absolute bg-border"
                  style={{ ...edge, top: CARD_H / 2, width: STUB, height: 1 }}
                />
                {mi % 2 === 0 ? (
                  <>
                    <span
                      className="absolute bg-border"
                      style={{ ...elbowEdge, top: CARD_H / 2, width: 1, height: gap + CARD_H }}
                    />
                    <span
                      className="absolute bg-border"
                      style={{ ...elbowEdge, top: CARD_H / 2 + (gap + CARD_H) / 2, width: STUB, height: 1 }}
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
      </div>
    );
  });
  // Right half renders columns innermost→outermost (mirror of the left).
  return <div className="flex">{mirror ? cols.reverse() : cols}</div>;
}

/**
 * FIFA World-Cup-style knockout bracket (owner ask 2026-06-27): two mirrored
 * halves flowing into a centre Final + champion box, drawn from the match data
 * (round_no + resolved teams), using design-system TOKENS (no hardcoded gold).
 * `columns` are [round_no, matches] ascending — the last column is the Final.
 */
export function FifaBracket({
  columns,
}: {
  columns: [number, MatchRow[]][];
}): React.ReactElement {
  if (columns.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No bracket yet.")}</p>;
  }
  const finalCol = columns[columns.length - 1]!;
  const finalMatch = finalCol[1][0] ?? null;
  const inner = columns.slice(0, -1); // R1 … semi-finals
  const left = inner.map(([, ms]) => ms.slice(0, Math.ceil(ms.length / 2)));
  const right = inner.map(([, ms]) => ms.slice(Math.ceil(ms.length / 2)));
  const champion = finalMatch ? (() => {
    const w = winnerSide(finalMatch);
    return w === "home" ? finalMatch.home_team?.name : w === "away" ? finalMatch.away_team?.name : null;
  })() : null;

  // Header labels by distance-from-final (left half, outermost first).
  const headers = inner.map((_, ci) => roundLabel(inner.length - ci));

  return (
    <div className="w-full overflow-x-auto pb-4 pt-1">
      <div className="flex items-start justify-center gap-0">
        {left.length > 0 ? (
          <div className="flex flex-col">
            <div className="flex">
              {headers.map((h, i) => (
                <div
                  key={i}
                  className="text-overline uppercase tracking-wide text-muted-foreground"
                  style={{ minWidth: 192 + STUB * 2 }}
                >
                  {h}
                </div>
              ))}
            </div>
            <Half columns={left} mirror={false} />
          </div>
        ) : null}

        {/* Centre: Final + champion box */}
        <div className="flex flex-col items-center px-2" style={{ minWidth: 200 }}>
          <div className="text-overline uppercase tracking-wide text-muted-foreground">
            {t("Final")}
          </div>
          <div
            className="flex flex-col items-center"
            style={{ marginTop: left.length ? ((2 ** (left.length - 1) - 1) * SLOT) / 2 : 0 }}
          >
            {finalMatch ? <MatchCard m={finalMatch} /> : null}
            <div className="my-2 h-4 w-px bg-primary" />
            <div className="flex flex-col items-center gap-1 rounded-xl border border-primary bg-primary/10 px-4 py-3">
              <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
              <span className="text-overline uppercase tracking-wide text-muted-foreground">
                {t("Champion")}
              </span>
              <span className="max-w-[10rem] truncate text-sm font-semibold">
                {champion ?? t("TBD")}
              </span>
            </div>
          </div>
        </div>

        {right.length > 0 && right.some((c) => c.length) ? (
          <div className="flex flex-col">
            <div className="flex flex-row-reverse">
              {headers.map((h, i) => (
                <div
                  key={i}
                  className="text-right text-overline uppercase tracking-wide text-muted-foreground"
                  style={{ minWidth: 192 + STUB * 2 }}
                >
                  {h}
                </div>
              ))}
            </div>
            <Half columns={right} mirror={true} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
