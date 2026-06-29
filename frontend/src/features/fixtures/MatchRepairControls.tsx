import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarClock,
  Lock,
  LockOpen,
  MoreHorizontal,
  TimerReset,
} from "lucide-react";
import {
  tournamentsApi,
  type MatchRow,
  type RepairViolation,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { venueCourtOptions } from "@/lib/courts";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MOVABLE_STATUSES, conflictsOf, errorDetail } from "./repair";

/** Plain titles per stable repair-violation code (§7.9 — the FE renders
 * from the code, never string-matches server messages). */
const VIOLATION_TITLES: Record<string, string> = {
  venue_double_booked: "Two matches would share this court at the same time",
  court_capacity_exceeded: "No free court at this venue at that time",
  insufficient_rest: "A team would get too short a break between matches",
  exceeds_max_per_day: "A team would play more matches in one day than you allow",
  team_blackout: "A team is not available on that date",
  shared_player_conflict: "Two linked teams (shared player) would play at the same time",
  venue_unavailable: "This venue is closed on that date",
  pinned_round_venue: "This round is pinned to a different venue",
  concurrent_competitions: "Two competitions that must not clash would run at the same time",
};

function violationDetail(v: RepairViolation): string {
  const parts: string[] = [];
  if (v.venue) parts.push(String(v.venue));
  const at = v.at ?? v.date;
  if (at) parts.push(String(at).replace("T", " ").slice(0, 16));
  return parts.join(", ");
}

/** Compact list of raw scheduler violations (shared by every repair dialog
 * and the rain-day wizard). Hard rows in destructive framing, soft in warning. */
export function RepairViolationsList({
  violations,
}: {
  violations: RepairViolation[];
}): React.ReactElement | null {
  if (violations.length === 0) return null;
  return (
    <ul
      data-testid="repair-violations"
      className="flex max-h-48 flex-col gap-1.5 overflow-y-auto"
    >
      {violations.map((v, i) => (
        <li
          key={`${v.code}-${i}`}
          data-testid={`repair-violation-${v.code}`}
          className={cn(
            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs",
            v.hard !== false
              ? "border-destructive/50 bg-destructive-muted"
              : "border-warning/50 bg-warning-muted",
          )}
        >
          <AlertTriangle
            aria-hidden="true"
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              v.hard !== false ? "text-destructive" : "text-warning",
            )}
          />
          <span>
            <span className="font-medium">
              {t(VIOLATION_TITLES[v.code] ?? v.code)}
            </span>
            {violationDetail(v) ? (
              <span className="text-muted-foreground"> · {violationDetail(v)}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Footer shared by the repair dialogs: Cancel + the primary action, which
 * flips to a destructive "Move it anyway" once hard conflicts came back. */
export function RepairFooter({
  conflicts,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
  testid,
}: {
  conflicts: RepairViolation[] | null;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (force: boolean) => void;
  testid: string;
}): React.ReactElement {
  const blocked = conflicts !== null && conflicts.some((v) => v.hard !== false);
  return (
    <DialogFooter>
      <Button variant="ghost" disabled={busy} onClick={onCancel}>
        {t("Cancel")}
      </Button>
      {blocked ? (
        <Button
          variant="destructive"
          disabled={busy}
          data-testid={`${testid}-force`}
          onClick={() => onSubmit(true)}
        >
          {t("Move it anyway")}
        </Button>
      ) : (
        <Button
          disabled={busy}
          data-testid={`${testid}-submit`}
          onClick={() => onSubmit(false)}
        >
          {busy ? t("Saving…") : submitLabel}
        </Button>
      )}
    </DialogFooter>
  );
}

export function ConflictsBlock({
  conflicts,
}: {
  conflicts: RepairViolation[] | null;
}): React.ReactElement | null {
  if (conflicts === null) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-2">
      <p className="text-xs font-medium text-destructive">
        {t("This breaks the rules below. You can still force it; warnings are logged in the change history.")}
      </p>
      <RepairViolationsList violations={conflicts} />
    </div>
  );
}

/** "2026-06-20T09:00:00+05:30" → "2026-06-20T09:00" for datetime-local. */
function toLocalInput(iso: string | null): string {
  return iso ? iso.slice(0, 16) : "";
}

function MoveMatchDialog({
  tournamentId,
  match,
  onClose,
}: {
  tournamentId: string;
  match: MatchRow;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [when, setWhen] = useState(() => toLocalInput(match.scheduled_at));
  const [venue, setVenue] = useState(match.venue);
  const [conflicts, setConflicts] = useState<RepairViolation[] | null>(null);
  // One event_id per dialog open: the 409 path persisted nothing, so the
  // force retry may safely replay the same idempotency key (invariant 3).
  const [eventId] = useState(newEventId);

  const venues = useQuery({
    queryKey: qk.venues(tournamentId),
    queryFn: () => tournamentsApi.venues(tournamentId),
  });
  // Expand each venue into its parallel courts so the editor assigns a SPECIFIC
  // court ("Hall · T2"), not just the base hall. The current slot is prepended
  // when it isn't in the pool (covers legacy/bare or now-removed court strings).
  const pool = (venues.data?.venues ?? []).flatMap(venueCourtOptions);
  const options = (pool.includes(match.venue) || !match.venue
    ? pool
    : [match.venue, ...pool]
  ).map((name) => ({ value: name, label: name }));

  const move = useMutation({
    mutationFn: (force: boolean) =>
      tournamentsApi.rescheduleMatch(match.id, {
        ...(when ? { scheduled_at: when } : {}),
        venue,
        ...(force ? { force: true } : {}),
        event_id: eventId,
      }),
    onSuccess: (r) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t("Match moved"),
        description: r.violations.length
          ? `${r.violations.length} ${t("warning(s) recorded in the change history")}`
          : undefined,
      });
      onClose();
    },
    onError: (e) => {
      const v = conflictsOf(e);
      if (v) {
        setConflicts(v);
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not move the match"),
        description: errorDetail(e),
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Move match")}>
      <DialogHeader>
        <DialogTitle>{t("Move match")}</DialogTitle>
        <DialogDescription>
          {t("Pick a new time or venue. Checked against the live schedule.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`move-when-${match.id}`}>{t("New time")}</Label>
          <Input
            id={`move-when-${match.id}`}
            type="datetime-local"
            data-testid="move-when"
            value={when}
            onChange={(e) => {
              setWhen(e.target.value);
              setConflicts(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`move-venue-${match.id}`}>{t("Venue")}</Label>
          <Select
            id={`move-venue-${match.id}`}
            aria-label={t("Venue")}
            value={venue}
            onChange={(v) => {
              setVenue(v);
              setConflicts(null);
            }}
            options={options}
            placeholder={t("Pick a venue…")}
          />
        </div>
        <ConflictsBlock conflicts={conflicts} />
      </div>
      <RepairFooter
        conflicts={conflicts}
        busy={move.isPending}
        submitLabel={t("Move")}
        onCancel={onClose}
        onSubmit={(force) => move.mutate(force)}
        testid="move"
      />
    </Dialog>
  );
}

const QUICK_DELAYS = [15, 30, 60] as const;

function DelayMatchDialog({
  tournamentId,
  match,
  onClose,
}: {
  tournamentId: string;
  match: MatchRow;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [minutes, setMinutes] = useState("30");
  const [cascade, setCascade] = useState(true);
  const [conflicts, setConflicts] = useState<RepairViolation[] | null>(null);
  const [eventId] = useState(newEventId);

  const delay = useMutation({
    mutationFn: (force: boolean) =>
      tournamentsApi.delayMatch(match.id, {
        minutes: Number(minutes),
        cascade,
        ...(force ? { force: true } : {}),
        event_id: eventId,
      }),
    onSuccess: (r) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: `${r.moved.length} ${r.moved.length === 1 ? t("match moved") : t("matches moved")}`,
        description: r.violations.length
          ? `${r.violations.length} ${t("warning(s) recorded in the change history")}`
          : undefined,
      });
      onClose();
    },
    onError: (e) => {
      const v = conflictsOf(e);
      if (v) {
        setConflicts(v);
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not delay the match"),
        description: errorDetail(e),
      });
    },
  });

  const valid = Number.isFinite(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 480;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Delay match")}>
      <DialogHeader>
        <DialogTitle>{t("Delay match")}</DialogTitle>
        <DialogDescription>
          {t("Push the kick-off back. Optionally move later matches at this venue too, keeping rest gaps.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {QUICK_DELAYS.map((q) => (
            <Button
              key={q}
              size="sm"
              variant={minutes === String(q) ? "secondary" : "outline"}
              data-testid={`delay-quick-${q}`}
              onClick={() => {
                setMinutes(String(q));
                setConflicts(null);
              }}
            >
              +{q} {t("min")}
            </Button>
          ))}
          <Input
            type="number"
            min={1}
            max={480}
            data-testid="delay-minutes"
            aria-label={t("Custom minutes")}
            className="w-24"
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
              setConflicts(null);
            }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cascade}
            data-testid="delay-cascade"
            onChange={(e) => setCascade(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          {t("Also push the later matches at this venue")}
        </label>
        <ConflictsBlock conflicts={conflicts} />
      </div>
      <RepairFooter
        conflicts={conflicts}
        busy={delay.isPending || !valid}
        submitLabel={t("Delay")}
        onCancel={onClose}
        onSubmit={(force) => delay.mutate(force)}
        testid="delay"
      />
    </Dialog>
  );
}

function swapLabel(m: MatchRow): string {
  const sides = `${m.home_team?.name ?? t("TBD")} ${t("vs")} ${m.away_team?.name ?? t("TBD")}`;
  const when = m.scheduled_at
    ? `${m.scheduled_at.slice(0, 10)} ${m.scheduled_at.slice(11, 16)}`
    : t("unscheduled");
  return `${sides} - ${when}${m.venue ? ` · ${m.venue}` : ""}`;
}

function SwapMatchDialog({
  tournamentId,
  match,
  siblings,
  onClose,
}: {
  tournamentId: string;
  match: MatchRow;
  /** Same-competition matches (the card's list); self is filtered here. */
  siblings: MatchRow[];
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [other, setOther] = useState("");
  const [conflicts, setConflicts] = useState<RepairViolation[] | null>(null);
  const [eventId] = useState(newEventId);

  const options = siblings
    .filter(
      (m) =>
        m.id !== match.id &&
        MOVABLE_STATUSES.has(m.status) &&
        m.scheduled_at !== null,
    )
    .map((m) => ({ value: m.id, label: swapLabel(m) }));

  const swap = useMutation({
    mutationFn: (force: boolean) =>
      tournamentsApi.swapSlots(tournamentId, {
        match_a: match.id,
        match_b: other,
        ...(force ? { force: true } : {}),
        event_id: eventId,
      }),
    onSuccess: (r) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: t("Slots swapped"),
        description: r.violations.length
          ? `${r.violations.length} ${t("warning(s) recorded in the change history")}`
          : undefined,
      });
      onClose();
    },
    onError: (e) => {
      const v = conflictsOf(e);
      if (v) {
        setConflicts(v);
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not swap the slots"),
        description: errorDetail(e),
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Swap slots")}>
      <DialogHeader>
        <DialogTitle>{t("Swap slots")}</DialogTitle>
        <DialogDescription>
          {t("Swap slots with another match in this competition.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`swap-with-${match.id}`}>{t("Swap with")}</Label>
          <Select
            id={`swap-with-${match.id}`}
            aria-label={t("Swap with")}
            value={other}
            onChange={(v) => {
              setOther(v);
              setConflicts(null);
            }}
            options={options}
            placeholder={t("Pick a match…")}
          />
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("No other movable match in this competition.")}
            </p>
          ) : null}
        </div>
        <ConflictsBlock conflicts={conflicts} />
      </div>
      <RepairFooter
        conflicts={conflicts}
        busy={swap.isPending || other === ""}
        submitLabel={t("Swap")}
        onCancel={onClose}
        onSubmit={(force) => swap.mutate(force)}
        testid="swap"
      />
    </Dialog>
  );
}

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testid: string;
}

function MenuItem({ icon: Icon, label, onClick, disabled, testid }: MenuItemProps): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {label}
    </button>
  );
}

/**
 * Per-match repair affordance (spec §7 — the control-room seam): an overflow
 * menu with Move / Delay / Swap / Lock for schedule editors. Renders nothing
 * for matches past the movable statuses (in-flight or finished slots never
 * move). Hard conflicts come back as a structured 409 and gate behind a
 * destructive "Force anyway".
 */
export function MatchRepairMenu({
  tournamentId,
  match,
  siblings,
}: {
  tournamentId: string;
  match: MatchRow;
  /** Matches of the same competition (swap candidates). */
  siblings: MatchRow[];
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"move" | "delay" | "swap" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const locked = Boolean(match.locked_at);
  const lockToggle = useMutation({
    mutationFn: () =>
      locked
        ? tournamentsApi.unlockMatch(match.id)
        : tournamentsApi.lockMatch(match.id),
    onSuccess: () => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: locked
          ? t("Slot unlocked")
          : t("Slot locked. Re-runs and delays will not move it."),
      });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not update the lock") }),
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!MOVABLE_STATUSES.has(match.status)) return null;

  const pick = (d: "move" | "delay" | "swap"): void => {
    setDialog(d);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Match actions")}
        data-testid={`repair-menu-${match.id}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t("Match actions")}
          className="absolute right-0 top-full z-30 mt-1 w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <MenuItem
            icon={CalendarClock}
            label={t("Move…")}
            testid={`repair-move-${match.id}`}
            onClick={() => pick("move")}
          />
          <MenuItem
            icon={TimerReset}
            label={t("Delay…")}
            testid={`repair-delay-${match.id}`}
            disabled={match.scheduled_at === null || locked}
            onClick={() => pick("delay")}
          />
          <MenuItem
            icon={ArrowLeftRight}
            label={t("Swap…")}
            testid={`repair-swap-${match.id}`}
            disabled={match.scheduled_at === null}
            onClick={() => pick("swap")}
          />
          <MenuItem
            icon={locked ? LockOpen : Lock}
            label={locked ? t("Unlock slot") : t("Lock slot")}
            testid={`repair-lock-${match.id}`}
            disabled={lockToggle.isPending}
            onClick={() => {
              lockToggle.mutate();
              setOpen(false);
            }}
          />
        </div>
      ) : null}
      {dialog === "move" ? (
        <MoveMatchDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "delay" ? (
        <DelayMatchDialog
          tournamentId={tournamentId}
          match={match}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "swap" ? (
        <SwapMatchDialog
          tournamentId={tournamentId}
          match={match}
          siblings={siblings}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
