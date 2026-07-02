import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { ScheduleChangesPanel } from "@/features/fixtures/ScheduleChangesPanel";
import { qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";

/**
 * The full schedule change history (audit feed) as its own page: the Today
 * drawer shows the recent tail; this is where "View all" lands, with the
 * competition filter and paging.
 */
export function ChangeHistoryPage(): React.ReactElement {
  const { id = "" } = useParams();
  // Competitions for the filter come from the same control-room payload the
  // Today page uses (cached when arriving from there).
  const cr = useQuery({
    queryKey: qk.controlRoom(id),
    queryFn: () => tournamentsApi.controlRoom(id),
  });
  const competitions = useMemo(() => {
    const by = new Map<string, string>();
    for (const v of cr.data?.venues ?? []) {
      for (const m of v.matches) {
        if (m.leaf_key && !by.has(m.leaf_key)) by.set(m.leaf_key, m.leaf_label);
      }
    }
    return [...by.entries()].map(([leafKey, label]) => ({
      leafKey,
      label: label || leafKey,
    }));
  }, [cr.data]);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          {t("Change history")}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t("Who changed each time or venue, and why.")}
        </span>
      </div>
      <ScheduleChangesPanel tournamentId={id} competitions={competitions} />
    </div>
  );
}
