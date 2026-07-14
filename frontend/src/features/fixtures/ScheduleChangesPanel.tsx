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
import "@/components/ui/star-border.css";

/** The full page walks the feed 20 at a time, Prev/Next (owner 2026-07-14). */
const PAGE = 20;
/** The embedded tail on the Today board: the latest 15, then "View all". */
const TAIL = 15;
const PREVIEW = 3;

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
  delayed: "bg-warning-muted text-warning",
  retimed: "bg-primary/15 text-primary",
  swapped: "bg-accent text-accent-foreground",
  day_shifted: "bg-warning-muted text-warning",
  engine_rerun: "bg-secondary text-secondary-foreground",
  locked: "bg-muted text-muted-foreground",
  unlocked: "bg-muted text-muted-foreground",
};

/** The timeline dot, colour-matched to the kind chip. */
const DOT_CLASSES: Record<string, string> = {
  scheduled: "bg-success",
  rescheduled: "bg-primary",
  delayed: "bg-warning",
  retimed: "bg-primary",
  swapped: "bg-accent-foreground",
  day_shifted: "bg-warning",
  engine_rerun: "bg-secondary-foreground",
  locked: "bg-muted-foreground",
  unlocked: "bg-muted-foreground",
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

/** "Today" / "Yesterday" / "Mon, Jul 2" for a day separator. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  if (days === 0) return t("Today");
  if (days === 1) return t("Yesterday");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
        "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium leading-4",
        KIND_CLASSES[kind] ?? "bg-muted text-muted-foreground",
      )}
    >
      {t(KIND_LABELS[kind] ?? kind)}
    </span>
  );
}

/** Who did it and when: an initial disc plus the handle, so the eye can scan
 * the actor column without reading it. */
function Actor({
  actor,
  at,
}: {
  actor: { email: string } | null;
  at: string;
}): React.ReactElement {
  const who = actorName(actor);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {who ? (
        <>
          <span
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[0.5625rem] font-semibold uppercase text-muted-foreground"
          >
            {who.slice(0, 1)}
          </span>
          <span title={actor?.email}>{who}</span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
        </>
      ) : null}
      <span className="font-tabular" title={at}>
        {relTime(at)}
      </span>
    </span>
  );
}

/** The new slot leads; the old one trails as a muted "was". No arrows. */
function SlotLine({ e }: { e: ScheduleChangeEntry }): React.ReactElement | null {
  if (e.old === null && e.new === null) return null;
  const moved = Boolean(e.old?.scheduled_at);
  return (
    <p className="min-w-0 font-tabular text-[13px] text-muted-foreground">
      <span className="text-foreground">{fmtSlot(e.new)}</span>
      {moved ? (
        <span className="ml-2">
          {t("was")} {fmtSlot(e.old)}
        </span>
      ) : null}
    </p>
  );
}

/** The dot every timeline item hangs off; the ring punches the rail line. */
function Dot({ kind }: { kind: string }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute left-4 top-[1.1875rem] h-2 w-2 shrink-0 rounded-full ring-4 ring-card",
        DOT_CLASSES[kind] ?? "bg-muted-foreground",
      )}
    />
  );
}

/** One standalone change: chip, match, who and when, then the slot line. */
function Entry({ e }: { e: ScheduleChangeEntry }): React.ReactElement {
  const kind = effectiveKind(e);
  return (
    <li
      data-testid={`change-${e.batch_id}-${e.match_id}`}
      className="relative flex flex-col gap-1 py-2.5 pl-10 pr-4"
    >
      <Dot kind={kind} />
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={kind} />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {e.match_label}
        </span>
        <Actor actor={e.actor} at={e.changed_at} />
      </div>
      <SlotLine e={e} />
      {e.reason ? (
        <p className="text-[13px] italic text-muted-foreground">{e.reason}</p>
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

/** A bulk action: one header (what, how many, who, when), a short preview of
 * the affected matches, and an expander for the rest. */
function BurstItem({ burst }: { burst: Burst }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const head = burst.entries[0];
  const kind = effectiveKind(head);
  const shown = open ? burst.entries : burst.entries.slice(0, PREVIEW);
  const hidden = burst.entries.length - shown.length;
  return (
    <li className="relative flex flex-col py-2.5 pl-10 pr-4">
      <Dot kind={kind} />
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={kind} />
        <span className="text-[13px] font-medium">
          <span className="font-tabular">{burst.entries.length}</span>{" "}
          {t("matches")}
        </span>
        <Actor actor={head.actor} at={head.changed_at} />
      </div>
      <ul className="mt-1.5 flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-muted/30">
        {shown.map((e, i) => (
          <li
            key={`${e.batch_id}-${e.match_id}-${i}`}
            data-testid={`change-${e.batch_id}-${e.match_id}`}
            className="flex flex-col gap-x-3 gap-y-0.5 px-2.5 py-1.5 sm:flex-row sm:items-baseline"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {e.match_label}
            </span>
            <SlotLine e={e} />
          </li>
        ))}
      </ul>
      {hidden > 0 || open ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 w-fit text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? t("Show fewer") : `${t("Show all")} ${burst.entries.length}`}
        </button>
      ) : null}
    </li>
  );
}

/** Bursts split into calendar days, newest first (the feed arrives sorted). */
function groupDays(bursts: Burst[]): { label: string; bursts: Burst[] }[] {
  const days: { label: string; bursts: Burst[] }[] = [];
  for (const b of bursts) {
    const label = dayLabel(b.entries[0].changed_at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.bursts.push(b);
    else days.push({ label, bursts: [b] });
  }
  return days;
}

/**
 * The change-history feed (trust layer, increment F): reverse-chrono slot
 * changes flattened from the audit log — who moved what, from where to where,
 * when and why. Rendered as a day-grouped timeline (redesign 2026-07-14): a
 * rail with a colour-coded dot per action, bulk operations collapsed into one
 * expandable item. `embedded` drops the card chrome for the Today board's tab,
 * where it shows the latest 20 and links out to the full page.
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
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(0);
  const limit = viewAllTo ? TAIL : PAGE;
  const offset = viewAllTo ? 0 : page * PAGE;

  const feed = useQuery({
    queryKey: [...qk.scheduleChanges(tournamentId), leaf, limit, offset],
    queryFn: () =>
      tournamentsApi.scheduleChanges(tournamentId, {
        ...(leaf ? { leafKey: leaf } : {}),
        limit,
        ...(offset ? { offset } : {}),
      }),
    placeholderData: (prev) => prev,
  });
  const entries = feed.data?.results ?? [];
  const total = feed.data?.total ?? entries.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);
  // Kind is a client-side lens over what was fetched — the API filters by
  // competition only, and the feed is small enough that a second round trip
  // would cost more than it saves.
  const visible = kind
    ? entries.filter((e) => effectiveKind(e) === kind)
    : entries;
  const days = groupDays(groupBursts(visible));
  const kinds = [...new Set(entries.map(effectiveKind))].sort();

  const timeline = (
    <div className="flex flex-col">
      {days.map((d) => (
        <div key={d.label} className="flex flex-col">
          <div className="flex items-center gap-2 border-y border-border bg-muted/40 px-4 py-1.5 first:border-t-0">
            <p className="text-xs font-semibold">{d.label}</p>
            <span className="font-tabular text-xs text-muted-foreground">
              {d.bursts.reduce((n, b) => n + b.entries.length, 0)}
            </span>
          </div>
          {/* The rail: one continuous hairline the dots punch through. */}
          <ul className="relative flex flex-col before:absolute before:bottom-2 before:left-[1.1875rem] before:top-2 before:w-px before:bg-border">
            {d.bursts.map((b) =>
              b.entries.length === 1 ? (
                <Entry key={b.key} e={b.entries[0]} />
              ) : (
                <BurstItem key={b.key} burst={b} />
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <section
      data-testid="schedule-changes-panel"
      className={
        embedded
          ? undefined
          : "overflow-hidden bento-card star-rim rounded-xl border border-border bg-card shadow-sm"
      }
    >
      {/* The full page carries the toolbar: filter by competition, then narrow
          to one kind of change. The embedded tab is a plain tail. */}
      {embedded ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <History
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
          />
          <h3 className="panel-title">{t("Change history")}</h3>
          <span className="font-tabular text-xs text-muted-foreground">
            {total}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {kinds.length > 1 ? (
              <Select
                className="w-44"
                size="sm"
                aria-label={t("Filter by change kind")}
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setPage(0);
                }}
                options={[
                  { value: "", label: t("Every change") },
                  ...kinds.map((k) => ({
                    value: k,
                    label: t(KIND_LABELS[k] ?? k),
                  })),
                ]}
              />
            ) : null}
            {competitions.length > 0 ? (
              <Select
                className="w-56"
                size="sm"
                aria-label={t("Filter by competition")}
                value={leaf}
                onChange={(v) => {
                  setLeaf(v);
                  setPage(0);
                }}
                options={[
                  { value: "", label: t("All competitions") },
                  ...competitions.map((c) => ({
                    value: c.leafKey,
                    label: c.label,
                  })),
                ]}
              />
            ) : null}
          </div>
        </div>
      )}

      {feed.isLoading ? (
        <div className="flex flex-col gap-2 px-4 py-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {kind
            ? t("No changes of that kind on this page.")
            : t("No changes yet. Any match you move or delay will show up here.")}
        </p>
      ) : (
        timeline
      )}

      {/* The tab links out; the full page walks the feed 20 at a time. The
          pager stays mounted even on an empty page, or a kind filter that
          clears one page would strand you with no way forward. */}
      {viewAllTo ? (
        visible.length > 0 ? (
          <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
            <span className="text-xs text-muted-foreground">
              {t("Showing the latest")}{" "}
              <span className="font-tabular">{visible.length}</span>
            </span>
            <Link
              to={viewAllTo}
              data-testid="changes-view-all"
              className="ml-auto text-[13px] font-medium text-primary hover:underline"
            >
              {t("View all changes")}
            </Link>
          </div>
        ) : null
      ) : total > 0 ? (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <span
            data-testid="changes-page-status"
            className="text-xs text-muted-foreground"
          >
            <span className="font-tabular">{offset + 1}</span>
            {t(" to ")}
            <span className="font-tabular">{offset + entries.length}</span>{" "}
            {t("of")} <span className="font-tabular">{total}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="changes-prev"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t("Previous")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="changes-next"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            >
              {t("Next")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
