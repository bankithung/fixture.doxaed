import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Award, Plus, Trophy, X } from "lucide-react";
import type { LensPhoto } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** A ranking is a judging aid, not a record: only the winner is stored on the
 * photo. Keeping the order in the browser means a refresh, a phone call or a
 * second opinion does not cost the panel its work. */
const storeKey = (campaignId: string, category: string): string =>
  `lens:rank:${campaignId}:${category}`;

function readRanking(campaignId: string, category: string): string[] {
  try {
    const raw = localStorage.getItem(storeKey(campaignId, category));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Judging a photo prize by ranking, not by picking.
 *
 * Choosing a winner from a grid of thumbnails asks the panel to hold every
 * contender in their head at once. Here the shortlist sits in a row at a size
 * you can actually compare — first place beside second beside third — and the
 * decision is made by moving photos past each other. Whatever ends up first
 * is the winner.
 *
 * Only that first place is saved (it is what `award_photo` stores and what the
 * public album shows); the rest of the order stays in this browser, which the
 * panel is told plainly rather than left to discover.
 */
export function AwardRankBoard({
  campaignId,
  category,
  candidates,
  winnerId,
  onBack,
  onAward,
  saving,
}: {
  campaignId: string;
  category: string;
  /** Every approved photo that could win this prize. */
  candidates: LensPhoto[];
  /** The photo already holding this award, if any. */
  winnerId: string | null;
  onBack: () => void;
  onAward: (photoId: string) => void;
  saving: boolean;
}): React.ReactElement {
  // Seed from the browser, then from the standing winner, so reopening the
  // board shows the decision already made rather than an empty row.
  const [ranked, setRanked] = useState<string[]>(() => {
    const stored = readRanking(campaignId, category);
    if (stored.length > 0) return stored;
    return winnerId ? [winnerId] : [];
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        storeKey(campaignId, category),
        JSON.stringify(ranked),
      );
    } catch {
      /* private mode: the order simply is not remembered */
    }
  }, [campaignId, category, ranked]);

  const byId = useMemo(
    () => new Map(candidates.map((p) => [p.id, p])),
    [candidates],
  );
  // A photo can be deleted or hidden between sittings; drop it rather than
  // rendering a hole in the ranking.
  const order = useMemo(
    () => ranked.filter((rid) => byId.has(rid)),
    [ranked, byId],
  );
  const pool = useMemo(
    () => candidates.filter((p) => !order.includes(p.id)),
    [candidates, order],
  );

  const first = order[0] ? byId.get(order[0]) : undefined;
  const dirty = Boolean(first) && first?.id !== winnerId;

  const move = (idx: number, delta: number): void => {
    setRanked((cur) => {
      const next = cur.filter((rid) => byId.has(rid));
      const to = idx + delta;
      if (to < 0 || to >= next.length) return cur;
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  };

  return (
    <div data-testid={`rank-board-${category}`} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="rank-back">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t("Awards")}
        </Button>
        <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
        <h3 className="panel-title">{category}</h3>
        <span className="font-tabular text-xs text-muted-foreground">
          {candidates.length} {t("candidates")}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          data-testid="rank-save"
          disabled={!first || !dirty || saving}
          onClick={() => first && onAward(first.id)}
        >
          <Trophy aria-hidden="true" className="h-4 w-4" />
          {first
            ? `${t("Award to")} ${first.institution_name}`
            : t("Rank a photo first")}
        </Button>
      </div>

      <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        {t(
          "Add photos to the shortlist, then move them past each other until the best is first. Only first place is saved as the winner; the rest of the order stays on this device.",
        )}
      </p>

      {/* The shortlist: big enough to judge, in a row so they compare. */}
      <div className="border-b border-border p-3">
        <div className="flex items-baseline gap-2 pb-2">
          <h4 className="text-sm font-medium">{t("Shortlist")}</h4>
          <span className="font-tabular text-xs text-muted-foreground">
            {order.length}
          </span>
        </div>
        {order.length === 0 ? (
          <p
            data-testid="rank-empty"
            className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
          >
            {t("Nothing shortlisted yet. Add photos from below.")}
          </p>
        ) : (
          <ol className="flex gap-3 overflow-x-auto pb-1">
            {order.map((rid, idx) => {
              const p = byId.get(rid)!;
              const isFirst = idx === 0;
              return (
                <li
                  key={rid}
                  data-testid={`rank-slot-${idx + 1}`}
                  className={cn(
                    "flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border bg-card sm:w-64",
                    isFirst
                      ? "border-primary shadow-sm ring-1 ring-primary/30"
                      : "border-border",
                  )}
                >
                  <div className="relative">
                    <img
                      src={p.thumb_url}
                      alt={p.caption || p.institution_name}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover"
                    />
                    <span
                      className={cn(
                        "absolute left-2 top-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-tabular text-xs font-semibold",
                        isFirst
                          ? "bg-primary text-primary-foreground"
                          : "bg-card/90 text-foreground",
                      )}
                    >
                      {idx + 1}
                    </span>
                    {isFirst ? (
                      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[0.625rem] font-medium text-primary-foreground">
                        <Trophy aria-hidden="true" className="h-3 w-3" />
                        {t("Winner")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 p-2">
                    <p className="truncate text-sm font-medium">
                      {p.institution_name}
                    </p>
                    {p.caption ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {p.caption}
                      </p>
                    ) : null}
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("Move up")}
                        disabled={idx === 0}
                        data-testid={`rank-up-${p.id}`}
                        onClick={() => move(idx, -1)}
                      >
                        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("Move down")}
                        disabled={idx === order.length - 1}
                        data-testid={`rank-down-${p.id}`}
                        onClick={() => move(idx, 1)}
                      >
                        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-muted-foreground"
                        aria-label={t("Remove from shortlist")}
                        data-testid={`rank-remove-${p.id}`}
                        onClick={() =>
                          setRanked((cur) => cur.filter((x) => x !== rid))
                        }
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Everything still in contention. */}
      <div className="p-3">
        <div className="flex items-baseline gap-2 pb-2">
          <h4 className="text-sm font-medium">{t("Candidates")}</h4>
          <span className="font-tabular text-xs text-muted-foreground">
            {pool.length}
          </span>
        </div>
        {pool.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {candidates.length === 0
              ? t("No approved photos in this category yet.")
              : t("Every candidate is on the shortlist.")}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {pool.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  data-testid={`rank-add-${p.id}`}
                  onClick={() => setRanked((cur) => [...cur, p.id])}
                  className="group relative block w-full overflow-hidden rounded-lg border border-border bg-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={p.thumb_url}
                    alt={p.caption || p.institution_name}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                  />
                  <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-card/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  </span>
                  <span className="block truncate px-2 py-1.5 text-xs font-medium">
                    {p.institution_name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
