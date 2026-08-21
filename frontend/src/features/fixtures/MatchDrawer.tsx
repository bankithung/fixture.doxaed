import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { ShareButton } from "@/features/live/ShareButton";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import {
  MatchPanel,
  MatchScoreline,
  MatchTabs,
  useMatchSnapshot,
  visibleMatchTabs,
  type TabKey,
} from "@/features/live/MatchDetail";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * ONE match, opened over the sheet that lists it (owner 2026-08-21): a
 * right-hand drawer across 70% of a desk, a bottom drawer on a phone.
 *
 * The list is the thing a viewer is working through — which court, which time,
 * who is next — so opening a match must not throw it away. The drawer keeps
 * the sheet on screen behind it and closes back onto the same scroll position,
 * where a full page navigation loses the lot.
 *
 * It renders the SAME `MatchDetail` the /m/:id hub does, so the drawer is
 * never a cut-down second version of a match: scoreline, match info,
 * participants, timeline, stats and head to head, live on the same snapshot.
 */
export function MatchDrawer({
  matchId,
  matchNo,
  watchUrl,
  tab,
  onTab,
  onClose,
}: {
  matchId: string;
  /** The fixture number of this match, for the drawer's own heading. */
  matchNo?: number;
  /** Resolved from the schedule row that opened this drawer — the snapshot
   * does not carry one, and re-fetching the schedule here would be a second
   * copy of a list the page behind already holds. */
  watchUrl?: string | null;
  tab: string;
  onTab: (key: TabKey) => void;
  onClose: () => void;
}): React.ReactElement {
  const { query, snap } = useMatchSnapshot(matchId);
  const visible = snap ? visibleMatchTabs(snap) : [];
  const active: TabKey = visible.some((v) => v.key === tab)
    ? (tab as TabKey)
    : "overview";
  const match = snap?.match;
  const title = match
    ? `${match.home_team?.name ?? t("To be decided")} ${t("vs")} ${match.away_team?.name ?? t("To be decided")}`
    : t("Match");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      ariaLabel={title}
      variant="drawer"
    >
      {/* The grab handle is a normal flex child: the drawer panel is not a
          positioning context, so an absolute one would escape to the overlay. */}
      <div className="flex shrink-0 justify-center py-2 md:hidden">
        <span
          aria-hidden
          className="h-1.5 w-10 rounded-full bg-muted-foreground/30"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 pb-3 md:pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {matchNo != null ? `${t("Match")} ${matchNo}` : t("Match")}
        </h2>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <WatchLiveLink
            url={watchUrl}
            testid={`drawer-watch-${matchId}`}
            label={t("Watch this match live on YouTube")}
          />
          <ShareButton title={title} />
          {/* The drawer is the whole match, but a full page is what gets
              pasted into a message — and it is where Back leads from. */}
          <Link
            to={routes.liveViewer(matchId)}
            data-testid="drawer-full-page"
            className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("Open full page")}
          </Link>
          <button
            type="button"
            onClick={onClose}
            data-testid="drawer-close"
            aria-label={t("Close")}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </span>
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-3 p-4" aria-busy="true">
          <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
          <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        </div>
      ) : query.isError || !snap ? (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p role="alert" className="text-sm text-destructive">
            {t("This match could not be loaded.")}
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="min-h-[44px] rounded-md border border-border px-4 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("Retry")}
          </button>
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border px-4 pt-3">
            <MatchScoreline snap={snap} dense />
            <MatchTabs
              snap={snap}
              active={active}
              onTab={onTab}
              className="-mx-4 mt-1.5 px-4"
            />
          </div>
          {/* Only the panel scrolls: the scoreline stays put while a long team
              sheet or timeline runs past it. */}
          <div
            role="tabpanel"
            id={`hub-panel-${active}`}
            aria-labelledby={`hub-tab-${active}`}
            data-testid={`drawer-panel-${active}`}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          >
            <MatchPanel snap={snap} tab={active} onTab={onTab} />
          </div>
        </>
      )}
    </Dialog>
  );
}
