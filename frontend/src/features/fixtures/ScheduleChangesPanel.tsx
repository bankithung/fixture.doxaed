import { useState } from "react";
import { Link } from "react-router-dom";
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
  scheduled: "Scheduled",
  rescheduled: "Moved",
  delayed: "Delayed",
  retimed: "Re-timed",
  swapped: "Swapped",
  day_shifted: "Day shifted",
  engine_rerun: "Re-scheduled",
  locked: "Locked",
  unlocked: "Unlocked",
};

/** Token-only chip palette per kind (no hardcoded hex). */
const KIND_CLASSES: Record<string, string> = {
  scheduled: "bg-success-muted text-success",
  rescheduled: "bg-primary/15 text-primary",
  delayed: "bg-warning-muted text-warning-foreground",
  retimed: "bg-primary/15 text-primary",
  swapped: "bg-accent text-accent-foreground",
  day_shifted: "bg-warning-muted text-warning-foreground",
  engine_rerun: "bg-secondary text-secondary-foreground",
  locked: "bg-muted text-muted-foreground",
  unlocked: "bg-muted text-muted-foreground",
};

/** A move whose "before" was empty is a first placement, not a re-schedule.
 * Fixture publish floods the feed with these; call them what they are. */
function effectiveKind(e: ScheduleChangeEntry): string {
  const placing = ["rescheduled", "retimed", "engine_rerun", "day_shifted"];
  if (placing.includes(e.kind) && !e.old?.scheduled_at && e.new?.scheduled_at) {
    return "scheduled";
  }
  return e.kind;
}

function relTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("just now");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t("m ago")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t("h ago")}`;
  return `${Math.floor(hours / 24)}${t("d ago")}`;
}

/** Short actor handle: display the mailbox name, keep the address on hover. */
function actorName(actor: { email: string } | null): string | null {
  if (!actor) return null;
  return actor.email.split("@")[0] || actor.email;
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

function KindChip({ kind }: { kind: string }): React.ReactElement {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        KIND_CLASSES[kind] ?? "bg-muted text-muted-foreground",
      )}
    >
      {t(KIND_LABELS[kind] ?? kind)}
    </span>
  );
}

/** The new slot leads; the old one trails as a muted "was". No arrows. */
function SlotLine({ e }: { e: ScheduleChangeEntry }): React.ReactElement | null {
  if (e.old === null && e.new === null) return null;
  const moved = Boolean(e.old?.scheduled_at);
  return (
    <p className="min-w-0 font-tabular text-sm text-muted-foreground">
      <span className="text-foreground">{fmtSlot(e.new)}</span>
      {moved ? (
        <span className="ml-2">
          {t("was")} {fmtSlot(e.old)}
        </span>
      ) : null}
    </p>
  );
}

/** One standalone change: chip, match, who and when, then the slot line. */
function Entry({ e }: { e: ScheduleChangeEntry }): React.ReactElement {
  const who = actorName(e.actor);
  return (
    <li
      data-testid={`change-${e.batch_id}-${e.match_id}`}
      className="flex flex-col gap-1 px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={effectiveKind(e)} />
        <span className="min-w-0 truncate text-sm font-medium">{e.match_label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {who ? <span title={e.actor?.email}>{who}</span> : null}
          <span className="font-tabular" title={e.changed_at}>
            {relTime(e.changed_at)}
          </span>
        </span>
      </div>
      <SlotLine e={e} />
      {e.reason ? (
        <p className="text-sm italic text-muted-foreground">{e.reason}</p>
      ) : null}
    </li>
  );
}

interface Burst {
  key: string;
  entries: ScheduleChangeEntry[];
}

/** Collapse bulk operations into one feed item: consecutive entries from the
 * same batch, or from the same person doing the same thing within half an
 * hour, read as ONE action ("Scheduled 102 matches"), not 102 rows. */
function groupBursts(entries: ScheduleChangeEntry[]): Burst[] {
  const bursts: Burst[] = [];
  for (const e of entries) {
    const prev = bursts[bursts.length - 1];
    const last = prev?.entries[prev.entries.length - 1];
    const sameBatch = last && e.batch_id && e.batch_id === last.batch_id;
    const sameSpree =
      last &&
      (last.actor?.email ?? "") === (e.actor?.email ?? "") &&
      effectiveKind(last) === effectiveKind(e) &&
      Math.abs(
        new Date(last.changed_at).getTime() - new Date(e.changed_at).getTime(),
      ) <
        30 * 60_000;
    if (prev && (sameBatch || sameSpree)) {
      prev.entries.push(e);
    } else {
      bursts.push({ key: `${e.batch_id}-${e.match_id}`, entries: [e] });
    }
  }
  return bursts;
}

const PREVIEW = 3;

/** A bulk action: one header (what, how many, who, when), a short preview of
 * the affected matches, and an expander for the rest. The embedded dashboard
 * tail shows the preview only (owner 2026-07-03: no Show-all there; the full
 * page has everything). */
function BurstItem({
  burst,
  expandable = true,
}: {
  burst: Burst;
  expandable?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const head = burst.entries[0];
  const kind = effectiveKind(head);
  const who = actorName(head.actor);
  const shown = open ? burst.entries : burst.entries.slice(0, PREVIEW);
  const hidden = burst.entries.length - shown.length;
  return (
    <li className="flex flex-col px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={kind} />
        <span className="text-sm font-medium">
          <span className="font-tabular">{burst.entries.length}</span>{" "}
          {t("matches")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {who ? <span title={head.actor?.email}>{who}</span> : null}
          <span className="font-tabular" title={head.changed_at}>
            {relTime(head.changed_at)}
          </span>
        </span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-border pl-3">
        {shown.map((e, i) => (
          <li
            key={`${e.batch_id}-${e.match_id}-${i}`}
            data-testid={`change-${e.batch_id}-${e.match_id}`}
            className="flex flex-col gap-x-3 gap-y-0.5 sm:flex-row sm:items-baseline"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {e.match_label}
            </span>
            <SlotLine e={e} />
          </li>
        ))}
      </ul>
      {expandable && (hidden > 0 || open) ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 w-fit pl-3 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open
            ? t("Show fewer")
            : `${t("Show all")} ${burst.entries.length}`}
        </button>
      ) : null}
    </li>
  );
}

/**
 * The change-history feed (trust layer, increment F): reverse-chrono slot
 * changes flattened from the audit log — who moved what, from where to
 * where, when and why. Bulk actions collapse into one expandable item.
 * `embedded` drops the card chrome + title for use inside a host drawer.
 */
export function ScheduleChangesPanel({
  tournamentId,
  competitions,
  embedded = false,
  viewAllTo,
}: {
  tournamentId: string;
  competitions: { leafKey: string; label: string }[];
  embedded?: boolean;
  /** When set: fetch a short tail and link out instead of paging inline. */
  viewAllTo?: string;
}): React.ReactElement {
  const [leaf, setLeaf] = useState("");
  const [limit, setLimit] = useState(viewAllTo ? 15 : PAGE);

  const feed = useQuery({
    queryKey: [...qk.scheduleChanges(tournamentId), leaf, limit],
    queryFn: () =>
      tournamentsApi.scheduleChanges(tournamentId, {
        ...(leaf ? { leafKey: leaf } : {}),
        limit,
      }),
  });
  const entries = feed.data?.results ?? [];
  const bursts = groupBursts(entries);

  const filter =
    competitions.length > 0 ? (
      <Select
        className={embedded ? "w-full" : "ml-auto w-56"}
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
    ) : null;

  return (
    <section
      data-testid="schedule-changes-panel"
      className={
        embedded
          ? undefined
          : "overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      }
    >
      {/* Embedded (dashboard) shows the plain tail — the competition filter
          belongs to the full Change history page only (owner 2026-07-03). */}
      {embedded ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <History
            aria-hidden="true"
            className="h-3.5 w-3.5 text-muted-foreground/70"
          />
          <h3 className="panel-title">
            {t("Change history")}
          </h3>
          {filter}
        </div>
      )}
      {feed.isLoading ? (
        <div className="px-4 py-3" aria-busy="true">
          <div className="h-16 animate-pulse rounded-lg bg-muted/40" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t("No changes yet. Any match you move or delay will show up here.")}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {bursts.map((b) =>
              b.entries.length === 1 ? (
                <Entry key={b.key} e={b.entries[0]} />
              ) : (
                <BurstItem key={b.key} burst={b} expandable={!embedded} />
              ),
            )}
          </ul>
          {viewAllTo ? (
            <div className="border-t border-border px-4 py-2">
              <Link
                to={viewAllTo}
                data-testid="changes-view-all"
                className="text-[13px] font-medium text-primary hover:underline"
              >
                {t("View all changes")}
              </Link>
            </div>
          ) : entries.length >= limit ? (
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
