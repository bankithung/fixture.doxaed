import { ListOrdered } from "lucide-react";
import type { ControlRoomMatch } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  IN_PLAY,
  type SlotDelay,
  delayFor,
  fmtKickoff,
  isCalled,
} from "./format";

/**
 * Cross-venue "Up next" strip (spec §1.1): the day's unfinished matches in
 * kick-off order, with venue, called/live state and delay visibility — a
 * horizontal scroll rail on every breakpoint.
 */
export function QueueRail({
  queue,
  timeZone,
  delays,
}: {
  queue: ControlRoomMatch[];
  timeZone: string;
  delays: Map<string, SlotDelay>;
}): React.ReactElement | null {
  if (queue.length === 0) return null;
  return (
    <section data-testid="queue-rail" className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ListOrdered aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        {t("Up next")}
      </h2>
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {queue.map((m) => {
          const live = IN_PLAY.has(m.status);
          const delay = delayFor(delays, m);
          return (
            <li
              key={m.id}
              data-testid={`queue-${m.id}`}
              className={cn(
                "flex w-60 shrink-0 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2 shadow-sm",
                live && "border-primary/50",
              )}
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-tabular font-semibold text-foreground">
                  {fmtKickoff(m.scheduled_at, timeZone)}
                </span>
                <span className="truncate">
                  {m.venue || t("Unassigned venue")}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {delay ? (
                    <span
                      data-testid={`queue-delay-${m.id}`}
                      className="rounded-full bg-warning-muted px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium text-warning-foreground"
                    >
                      +{delay} {t("min")}
                    </span>
                  ) : null}
                  {live ? (
                    <span className="text-[0.6875rem] font-medium text-primary">
                      {t("Live")}
                    </span>
                  ) : isCalled(m) ? (
                    <span
                      data-testid={`queue-called-${m.id}`}
                      className="rounded-full bg-warning-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning-foreground"
                    >
                      {t("Called")}
                    </span>
                  ) : null}
                </span>
              </div>
              <p className="truncate text-sm font-medium">
                {m.home_team?.name ?? t("TBD")}{" "}
                <span className="text-muted-foreground">{t("vs")}</span>{" "}
                {m.away_team?.name ?? t("TBD")}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
