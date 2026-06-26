import { Link, useParams } from "react-router-dom";
import { BarChart3, ListChecks, Radio, UserCog } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Operations-surface scaffold. The post-generation workspace exposes five
 * operations surfaces; the live control room (Today) ships first, and the
 * matches board, standings/bracket and crew cockpit arrive in the following
 * operations slices. Until each lands, its nav route resolves here — an honest,
 * on-brand panel (not a dead link) that explains what is coming and points back
 * to the live board. Replace each with its real page as the slice ships.
 */
function OpsPlaceholder({
  icon: Icon,
  title,
  blurb,
  bullets,
}: {
  icon: LucideIcon;
  title: string;
  blurb: string;
  bullets: string[];
}): React.ReactElement {
  const { id = "" } = useParams();
  return (
    <section className="flex w-full flex-col items-center gap-4 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary/10">
        <Icon aria-hidden="true" className="h-6 w-6 text-primary" />
      </span>
      <div className="max-w-md space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{blurb}</p>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        {bullets.map((b) => (
          <li key={b} className="flex items-center justify-center gap-2">
            <span aria-hidden="true" className="h-1 w-1 rounded-full bg-primary" />
            {b}
          </li>
        ))}
      </ul>
      <Link
        to={routes.tournamentControl(id)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Radio aria-hidden="true" className="h-4 w-4" />
        {t("Go to today's control room")}
      </Link>
    </section>
  );
}

/** Operations: tournament-wide matches board (slice 4). */
export function MatchesBoardPage(): React.ReactElement {
  return (
    <OpsPlaceholder
      icon={ListChecks}
      title={t("Matches board")}
      blurb={t(
        "One filterable board for every match in the tournament — find and act in bulk.",
      )}
      bullets={[
        t("Filter by day, competition, venue and status"),
        t("Spot matches missing a scorer, official or court"),
        t("Assign and enter results inline"),
      ]}
    />
  );
}

/** Operations: admin-context live standings & bracket (slice 6). */
export function OpsStandingsPage(): React.ReactElement {
  return (
    <OpsPlaceholder
      icon={BarChart3}
      title={t("Standings & bracket")}
      blurb={t(
        "Live tables and knockout brackets for every competition, updating as results land.",
      )}
      bullets={[
        t("Group tables ranked by your tiebreakers"),
        t("Brackets fill as winners advance"),
        t("Jump from any slot back to its match"),
      ]}
    />
  );
}

/** Operations: officials, scorer & task assignment cockpit (slice 3). */
export function CrewPage(): React.ReactElement {
  return (
    <OpsPlaceholder
      icon={UserCog}
      title={t("Officials & assignments")}
      blurb={t(
        "Assign referees, scorers and courts to matches, with double-booking warnings.",
      )}
      bullets={[
        t("Assign officials and scorers per match"),
        t("Place matches onto courts"),
        t("Track match-day tasks to done"),
      ]}
    />
  );
}
