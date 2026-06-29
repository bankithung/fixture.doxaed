import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Radio, UserCog, X } from "lucide-react";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type RepairViolation,
  type TournamentMember,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { RepairViolationsList } from "@/features/fixtures/MatchRepairControls";
import { MOVABLE_STATUSES, conflictsOf, errorDetail } from "@/features/fixtures/repair";
import { venueCourtOptions } from "@/lib/courts";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament, qk } from "@/lib/queryKeys";
import { t } from "@/lib/t";

const OFFICIAL_ROLES: { value: string; label: string }[] = [
  { value: "referee", label: "Referee" },
  { value: "assistant", label: "Assistant referee" },
  { value: "fourth", label: "Fourth official" },
  { value: "umpire", label: "Umpire" },
  { value: "commissioner", label: "Match commissioner" },
];

function officialRoleLabel(role: string): string {
  return OFFICIAL_ROLES.find((r) => r.value === role)?.label ?? role;
}

interface Candidate {
  userId: string;
  name: string;
  roles: string[];
}

/** Active members deduped by person (one row per role in the API). */
function candidatesOf(members: TournamentMember[] | undefined): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const m of members ?? []) {
    if (m.status !== "active") continue;
    const c = by.get(m.user_id) ?? {
      userId: m.user_id,
      name: m.full_name || m.email,
      roles: [],
    };
    if (!c.roles.includes(m.role)) c.roles.push(m.role);
    by.set(m.user_id, c);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Per-match assignment drawer (ops 2026-06-26): set the scorer seat and add /
 * remove officials (referee, assistants, fourth, umpire). Writes through the
 * audited assign endpoints; a soft warning surfaces when an official clashes
 * with another match. The match's officials/scorer refresh live off the
 * control-room invalidation, so the drawer reflects the latest on each change.
 */
export function AssignDrawer({
  tournamentId,
  match,
  onClose,
}: {
  tournamentId: string;
  match: ControlRoomMatch;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();

  const membersQ = useQuery({
    queryKey: ["t-members", tournamentId],
    queryFn: () => tournamentsApi.members(tournamentId),
  });
  const people = useMemo(() => candidatesOf(membersQ.data), [membersQ.data]);
  const memberOptions = people.map((p) => ({
    value: p.userId,
    label: p.roles.length
      ? `${p.name} · ${p.roles.map((r) => r.replace(/_/g, " ")).join(", ")}`
      : p.name,
  }));

  const [role, setRole] = useState("referee");
  const [pick, setPick] = useState("");

  const refresh = (): void => invalidateTournament(qc, tournamentId);

  // --- Court assignment (the court is encoded in Match.venue; assigning one is
  // a venue change through the same audited repair path, so it inherits the
  // 409 conflict / force flow). Only movable matches can be reslotted.
  const courtMovable = MOVABLE_STATUSES.has(match.status);
  const venuesQ = useQuery({
    queryKey: qk.venues(tournamentId),
    queryFn: () => tournamentsApi.venues(tournamentId),
    enabled: courtMovable,
  });
  const courtPool = (venuesQ.data?.venues ?? []).flatMap(venueCourtOptions);
  const courtOptions = (
    courtPool.includes(match.venue) || !match.venue
      ? courtPool
      : [match.venue, ...courtPool]
  ).map((name) => ({ value: name, label: name }));
  const [pendingCourt, setPendingCourt] = useState("");
  const [courtEventId, setCourtEventId] = useState("");
  const [courtConflicts, setCourtConflicts] = useState<RepairViolation[] | null>(
    null,
  );

  const assignCourt = useMutation({
    mutationFn: (vars: { venue: string; force: boolean; eventId: string }) =>
      tournamentsApi.rescheduleMatch(match.id, {
        venue: vars.venue,
        ...(vars.force ? { force: true } : {}),
        event_id: vars.eventId,
      }),
    onSuccess: (r) => {
      refresh();
      setCourtConflicts(null);
      setPendingCourt("");
      toast.push({
        kind: "success",
        title: t("Court assigned"),
        description: r.violations.length
          ? `${r.violations.length} ${t("warning(s) recorded in the change history")}`
          : undefined,
      });
    },
    onError: (e) => {
      const v = conflictsOf(e);
      if (v) {
        setCourtConflicts(v);
        return;
      }
      toast.push({
        kind: "error",
        title: t("Could not assign the court"),
        description: errorDetail(e),
      });
    },
  });

  const chooseCourt = (venue: string): void => {
    if (!venue || venue === match.venue) return;
    // Fresh idempotency key per court attempt; the force retry reuses it (the
    // 409 path persisted nothing, so the same key safely replays — invariant 3).
    const eventId = newEventId();
    setPendingCourt(venue);
    setCourtEventId(eventId);
    setCourtConflicts(null);
    assignCourt.mutate({ venue, force: false, eventId });
  };

  const setScorer = useMutation({
    mutationFn: (userId: string) => tournamentsApi.assignScorer(match.id, userId),
    onSuccess: () => {
      refresh();
      toast.push({ kind: "success", title: t("Scorer assigned") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not assign the scorer"),
        description: errorDetail(e),
      }),
  });

  const addOfficial = useMutation({
    mutationFn: () =>
      tournamentsApi.assignOfficial(match.id, {
        user_id: pick,
        role,
        event_id: newEventId(),
      }),
    onSuccess: (res) => {
      refresh();
      setPick("");
      if (res.warning?.code === "official_double_booked") {
        toast.push({
          kind: "info",
          title: t("Assigned — heads up, they have another match around then"),
        });
      } else {
        toast.push({ kind: "success", title: t("Official assigned") });
      }
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not assign the official"),
        description: errorDetail(e),
      }),
  });

  const removeOfficial = useMutation({
    mutationFn: (officialId: string) =>
      tournamentsApi.removeOfficial(match.id, officialId),
    onSuccess: () => refresh(),
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not remove the official"),
        description: errorDetail(e),
      }),
  });

  const officials = match.officials ?? [];
  const teamLine =
    (match.home_team?.name ?? t("TBD")) +
    " v " +
    (match.away_team?.name ?? t("TBD"));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} ariaLabel={t("Assign")}>
      <DialogHeader>
        <DialogTitle>{t("Assign")}</DialogTitle>
        <DialogDescription>{teamLine}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        {/* Court (where the match plays) */}
        {courtMovable && courtOptions.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <Label htmlFor={`court-${match.id}`}>
              <span className="inline-flex items-center gap-1.5">
                <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Court")}
              </span>
            </Label>
            <Select
              id={`court-${match.id}`}
              aria-label={t("Court")}
              value={match.venue}
              onChange={chooseCourt}
              options={courtOptions}
              placeholder={t("Pick a court…")}
            />
            {courtConflicts ? (
              <div className="flex flex-col gap-1.5 pt-1">
                <p className="text-xs font-medium text-destructive">
                  {t("That court clashes with the schedule. Assign anyway and we'll log the warning.")}
                </p>
                <RepairViolationsList violations={courtConflicts} />
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="court-force"
                  disabled={assignCourt.isPending}
                  onClick={() =>
                    assignCourt.mutate({
                      venue: pendingCourt,
                      force: true,
                      eventId: courtEventId,
                    })
                  }
                >
                  {t("Assign anyway")}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Scorer seat */}
        <section className="flex flex-col gap-1.5">
          <Label htmlFor={`scorer-${match.id}`}>
            <span className="inline-flex items-center gap-1.5">
              <Radio aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Scorer")}
            </span>
          </Label>
          <Select
            id={`scorer-${match.id}`}
            aria-label={t("Scorer")}
            value={match.scorer?.id ?? ""}
            onChange={(v) => v && setScorer.mutate(v)}
            options={memberOptions}
            placeholder={match.scorer?.name ?? t("Pick a scorer…")}
          />
        </section>

        {/* Officials */}
        <section className="flex flex-col gap-2">
          <Label>
            <span className="inline-flex items-center gap-1.5">
              <UserCog aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Officials")}
            </span>
          </Label>

          {officials.length > 0 ? (
            <div className="flex flex-col gap-1.5" data-testid="official-list">
              {officials.map((o) => (
                <div
                  key={o.id}
                  data-testid={`official-${o.id}`}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                >
                  <UserCog
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {t(officialRoleLabel(o.role))}
                  </span>
                  <button
                    type="button"
                    aria-label={t("Remove")}
                    onClick={() => removeOfficial.mutate(o.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("No officials assigned yet.")}
            </p>
          )}

          {/* Add an official */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-44">
              <Select
                aria-label={t("Role")}
                value={role}
                onChange={setRole}
                options={OFFICIAL_ROLES.map((r) => ({
                  value: r.value,
                  label: t(r.label),
                }))}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Select
                aria-label={t("Person")}
                value={pick}
                onChange={setPick}
                options={memberOptions}
                placeholder={t("Pick a person…")}
              />
            </div>
            <Button
              size="sm"
              data-testid="add-official"
              disabled={!pick || addOfficial.isPending}
              onClick={() => addOfficial.mutate()}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add")}
            </Button>
          </div>
        </section>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("Done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
