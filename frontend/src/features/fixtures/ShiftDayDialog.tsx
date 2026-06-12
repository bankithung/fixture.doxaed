import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  tournamentsApi,
  type MatchRow,
  type RepairViolation,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { t } from "@/lib/t";
import { ConflictsBlock, RepairFooter } from "./MatchRepairControls";
import { MOVABLE_STATUSES, conflictsOf } from "./repair";

/** Stable backend error codes → friendly inline messages (§9 A5). */
const ERROR_MESSAGES: Record<string, string> = {
  reserve_day_unavailable:
    "No free reserve day after that date — pick a target date explicitly.",
  no_matches_to_move: "No movable match is scheduled on that day.",
  invalid_to_date: "The target date must differ from the source day.",
};

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Rain-day wizard (repair seam, increment D): move every movable match of a
 * day onto another date — by default the first stored reserve day. Same
 * conflict semantics as the per-match repairs: a 409 renders the structured
 * violations behind a destructive "Force anyway".
 */
export function ShiftDayDialog({
  tournamentId,
  matches,
  competitions,
  onClose,
}: {
  tournamentId: string;
  matches: MatchRow[];
  competitions: { leafKey: string; label: string }[];
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [leaf, setLeaf] = useState("");
  const [conflicts, setConflicts] = useState<RepairViolation[] | null>(null);
  const [error, setError] = useState("");
  const [eventId] = useState(newEventId);

  /** Days that actually have something to move (mirrors the backend gate:
   * scheduled/postponed, not locked), with per-day counts; leaf-filtered. */
  const dayOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      if (!m.scheduled_at || !MOVABLE_STATUSES.has(m.status) || m.locked_at) {
        continue;
      }
      if (leaf && m.leaf_key !== leaf) continue;
      const day = m.scheduled_at.slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, n]) => ({
        value: day,
        label: `${fmtDay(day)} — ${n} ${n === 1 ? t("match") : t("matches")}`,
      }));
  }, [matches, leaf]);

  const shift = useMutation({
    mutationFn: (force: boolean) =>
      tournamentsApi.shiftDay(tournamentId, {
        from_date: fromDate,
        ...(toDate ? { to_date: toDate } : {}),
        ...(leaf ? { leaf_key: leaf } : {}),
        ...(force ? { force: true } : {}),
        event_id: eventId,
      }),
    onSuccess: (r) => {
      invalidateTournament(qc, tournamentId);
      toast.push({
        kind: "success",
        title: `${r.moved.length} ${
          r.moved.length === 1 ? t("match moved to") : t("matches moved to")
        } ${fmtDay(r.to_date)}`,
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
      const detail =
        e instanceof ApiError ? String(e.payload.detail ?? "") : "";
      setError(t(ERROR_MESSAGES[detail] ?? "The day could not be shifted."));
    },
  });

  const reset = (): void => {
    setConflicts(null);
    setError("");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Shift a day")}>
      <DialogHeader>
        <DialogTitle>{t("Shift a day")}</DialogTitle>
        <DialogDescription>
          {t("Rained off? Move every movable match of a day onto another date, keeping each match's time and venue.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shift-from">{t("Day to move")}</Label>
          <Select
            id="shift-from"
            aria-label={t("Day to move")}
            value={fromDate}
            onChange={(v) => {
              setFromDate(v);
              reset();
            }}
            options={dayOptions}
            placeholder={t("Pick a day…")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shift-to">{t("Move to (optional)")}</Label>
          <Input
            id="shift-to"
            type="date"
            data-testid="shift-to"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              reset();
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("Leave blank to use the first reserve day on or after the moved day.")}
          </p>
        </div>
        {competitions.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shift-leaf">{t("Competition scope")}</Label>
            <Select
              id="shift-leaf"
              aria-label={t("Competition scope")}
              value={leaf}
              onChange={(v) => {
                setLeaf(v);
                reset();
              }}
              options={[
                { value: "", label: t("All competitions") },
                ...competitions.map((c) => ({
                  value: c.leafKey,
                  label: c.label,
                })),
              ]}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ConflictsBlock conflicts={conflicts} />
      </div>
      {fromDate === "" ? (
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled data-testid="shift-submit">
            {t("Shift the day")}
          </Button>
        </DialogFooter>
      ) : (
        <RepairFooter
          conflicts={conflicts}
          busy={shift.isPending}
          submitLabel={t("Shift the day")}
          onCancel={onClose}
          onSubmit={(force) => shift.mutate(force)}
          testid="shift"
        />
      )}
    </Dialog>
  );
}
