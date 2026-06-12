import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  tournamentsApi,
  type ScheduleChangeEntry,
  type ScheduleChangeSlot,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const PAGE = 50;

/** Localized chip per feed kind (stable codes from the backend map). */
const KIND_LABELS: Record<string, string> = {
  rescheduled: "Moved",
  delayed: "Delayed",
  swapped: "Swapped",
  day_shifted: "Day shifted",
  engine_rerun: "Re-scheduled",
  locked: "Locked",
  unlocked: "Unlocked",
};

/** Token-only chip palette per kind (no hardcoded hex). */
const KIND_CLASSES: Record<string, string> = {
  rescheduled: "bg-primary/15 text-primary",
  delayed: "bg-warning-muted text-warning-foreground",
  swapped: "bg-accent text-accent-foreground",
  day_shifted: "bg-warning-muted text-warning-foreground",
  engine_rerun: "bg-secondary text-secondary-foreground",
  locked: "bg-muted text-muted-foreground",
  unlocked: "bg-muted text-muted-foreground",
};

function relTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("just now");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t("m ago")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t("h ago")}`;
  return `${Math.floor(hours / 24)}${t("d ago")}`;
}

function fmtSlot(slot: ScheduleChangeSlot | null): string {
  if (!slot || !slot.scheduled_at) return t("unscheduled");
  const when = new Date(slot.scheduled_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return slot.venue ? `${when} · ${slot.venue}` : when;
}

function Entry({ e }: { e: ScheduleChangeEntry }): React.ReactElement {
  return (
    <li
      data-testid={`change-${e.batch_id}-${e.match_id}`}
      className="flex flex-col gap-1 border-t border-border px-4 py-2.5 first:border-t-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
            KIND_CLASSES[e.kind] ?? "bg-muted text-muted-foreground",
          )}
        >
          {t(KIND_LABELS[e.kind] ?? e.kind)}
        </span>
        <span className="text-sm font-medium">{e.match_label}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {e.actor ? <span>{e.actor.email}</span> : null}
          <span className="font-tabular" title={e.changed_at}>
            {relTime(e.changed_at)}
          </span>
        </span>
      </div>
      {e.old !== null || e.new !== null ? (
        <p className="font-tabular text-xs text-muted-foreground">
          {fmtSlot(e.old)} <span aria-hidden="true">&rarr;</span>{" "}
          <span className="text-foreground">{fmtSlot(e.new)}</span>
        </p>
      ) : null}
      {e.reason ? (
        <p className="text-xs italic text-muted-foreground">{e.reason}</p>
      ) : null}
    </li>
  );
}

/**
 * The hub's change-history feed (trust layer, increment F): reverse-chrono
 * per-match slot changes flattened from the audit log — who moved what,
 * from where to where, when and why. Leaf filter + "load more" via limit.
 */
export function ScheduleChangesPanel({
  tournamentId,
  competitions,
}: {
  tournamentId: string;
  competitions: { leafKey: string; label: string }[];
}): React.ReactElement {
  const [leaf, setLeaf] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const feed = useQuery({
    queryKey: [...qk.scheduleChanges(tournamentId), leaf, limit],
    queryFn: () =>
      tournamentsApi.scheduleChanges(tournamentId, {
        ...(leaf ? { leafKey: leaf } : {}),
        limit,
      }),
  });
  const entries = feed.data?.results ?? [];

  return (
    <section
      data-testid="schedule-changes-panel"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <History aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t("Schedule changes")}</h3>
        <p className="hidden text-xs text-muted-foreground sm:block">
          {t("every slot move, audited")}
        </p>
        {competitions.length > 0 ? (
          <Select
            className="ml-auto w-56"
            size="sm"
            aria-label={t("Filter by competition")}
            value={leaf}
            onChange={(v) => {
              setLeaf(v);
              setLimit(PAGE);
            }}
            options={[
              { value: "", label: t("All competitions") },
              ...competitions.map((c) => ({ value: c.leafKey, label: c.label })),
            ]}
          />
        ) : null}
      </div>
      {feed.isLoading ? (
        <div className="px-4 py-3" aria-busy="true">
          <div className="h-16 animate-pulse rounded-lg bg-muted/40" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("No schedule changes yet — repairs and re-runs will appear here.")}
        </p>
      ) : (
        <>
          <ul>
            {entries.map((e, i) => (
              <Entry key={`${e.batch_id}-${e.match_id}-${i}`} e={e} />
            ))}
          </ul>
          {entries.length >= limit ? (
            <div className="border-t border-border px-4 py-2.5">
              <Button
                size="sm"
                variant="outline"
                data-testid="changes-load-more"
                onClick={() => setLimit((l) => l + PAGE)}
              >
                {t("Load more")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
