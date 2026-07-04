import * as React from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Medal, Plus, X } from "lucide-react";
import {
  housesApi,
  type GroupKind,
  type HouseGroup,
  type HouseTableResponse,
  type Season,
} from "@/api/houses";
import { ApiError } from "@/types/api";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Institution-operator surface (P4): seasons, houses, the live house table,
 * judged awards, and meet-mode result entry. Org-scoped at
 * `/o/:orgSlug/houses`; the org UUID resolves from the auth-store membership
 * (`MeSerializer.memberships[].org_id`), the same slug-keyed lookup
 * OrgSettingsPage uses. Members read; org admins / co-organizers (and the
 * org owner) get the write panels — mirroring the backend `_MANAGE_ROLES`.
 */

const KIND_OPTIONS: { value: GroupKind; label: string }[] = [
  { value: "house", label: t("House") },
  { value: "class", label: t("Class") },
  { value: "form", label: t("Form") },
  { value: "department", label: t("Department") },
];

/**
 * Colour swatch safety: `TeamGroup.colour` is free text, so it must never be
 * injected into a class name. We inline `backgroundColor` ONLY when the value
 * is a plain-lowercase word on this CSS named-colour allowlist; anything else
 * (hex, spaces, unknown words) falls back to a neutral token dot.
 */
const SAFE_CSS_COLOURS = new Set([
  "red", "blue", "green", "yellow", "orange", "purple", "pink", "teal",
  "cyan", "aqua", "magenta", "fuchsia", "maroon", "navy", "gold", "silver",
  "crimson", "indigo", "violet", "lime", "olive", "brown", "black", "white",
  "gray", "grey", "salmon", "coral", "turquoise", "khaki", "plum", "orchid",
  "tomato", "chocolate", "sienna", "skyblue", "lavender",
]);

function dotStyle(colour: string): React.CSSProperties | undefined {
  const c = colour.trim().toLowerCase();
  if (/^[a-z]+$/.test(c) && SAFE_CSS_COLOURS.has(c)) {
    return { backgroundColor: c };
  }
  return undefined;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", n -> "nth" (max 12 placements). */
function ordinal(n: number): string {
  if (n === 1) return t("1st");
  if (n === 2) return t("2nd");
  if (n === 3) return t("3rd");
  return `${n}${t("th")}`;
}

function errorDetail(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.payload.detail;
    if (typeof d === "string") return d;
  }
  return fallback;
}

function ColourDot({ colour }: { colour: string }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid="colour-dot"
      className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30"
      style={dotStyle(colour)}
    />
  );
}

// ---------------------------------------------------------------------------
// New-season dialog (label + is_current) — also the day-zero CTA target.
// ---------------------------------------------------------------------------

function NewSeasonDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (label: string, isCurrent: boolean) => void;
  pending: boolean;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [isCurrent, setIsCurrent] = React.useState(true);
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setIsCurrent(true);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabel={t("New season")}>
      <DialogHeader>
        <DialogTitle>{t("New season")}</DialogTitle>
        <DialogDescription>
          {t("A school year of house points, e.g. 2026-27.")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) onCreate(label.trim(), isCurrent);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="season-label">{t("Label")}</Label>
          <Input
            id="season-label"
            data-testid="season-label"
            value={label}
            maxLength={32}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("2026-27")}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="season-current"
            checked={isCurrent}
            onChange={(e) => setIsCurrent(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-current"
          />
          {t("Make this the current season")}
        </label>
        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            data-testid="season-submit"
            disabled={pending || !label.trim()}
          >
            {pending ? t("Creating...") : t("Create season")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function HousePointsPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === orgSlug);
  const orgId = membership?.org_id ?? "";

  // Manager = org admin / co-organizer (backend `_MANAGE_ROLES`) or the org
  // owner; membership resolution mirrors OrgSettingsPage (auth-store lookup
  // by org_slug, legacy "owner" role string accepted defensively).
  const isManager =
    Boolean(membership?.is_org_owner) ||
    (membership?.roles ?? []).some(
      (r): boolean =>
        r === "admin" || r === "co_organizer" || (r as string) === "owner",
    );

  const qc = useQueryClient();
  const toast = useToast();

  // --- seasons ---------------------------------------------------------------
  const seasonsQuery = useQuery({
    queryKey: ["org", orgSlug, "seasons"],
    queryFn: () => housesApi.seasons(orgId),
    enabled: Boolean(orgId),
  });
  const seasons: Season[] = seasonsQuery.data?.seasons ?? [];

  const [seasonId, setSeasonId] = React.useState("");
  React.useEffect(() => {
    if (!seasonId && seasons.length > 0) {
      setSeasonId((seasons.find((s) => s.is_current) ?? seasons[0]).id);
    }
  }, [seasons, seasonId]);

  const [seasonDialogOpen, setSeasonDialogOpen] = React.useState(false);
  const createSeason = useMutation({
    mutationFn: (v: { label: string; isCurrent: boolean }) =>
      housesApi.createSeason(orgId, { label: v.label, is_current: v.isCurrent }),
    onSuccess: (s) => {
      toast.push({ kind: "success", title: t("Season created") });
      setSeasonDialogOpen(false);
      setSeasonId(s.id);
      void qc.invalidateQueries({ queryKey: ["org", orgSlug, "seasons"] });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: errorDetail(e, t("Could not create the season")),
      }),
  });

  // --- table + groups for the selected season --------------------------------
  const tableQuery = useQuery({
    queryKey: ["org", orgSlug, "season", seasonId, "house-table"],
    queryFn: () => housesApi.houseTable(orgId, seasonId),
    enabled: Boolean(orgId && seasonId),
  });
  const groupsQuery = useQuery({
    queryKey: ["org", orgSlug, "season", seasonId, "groups"],
    queryFn: () => housesApi.groups(orgId, seasonId),
    enabled: Boolean(orgId && seasonId),
  });
  const table = tableQuery.data?.table ?? [];
  const groups: HouseGroup[] = groupsQuery.data?.groups ?? [];

  const refetchBoard = (): void => {
    void qc.invalidateQueries({
      queryKey: ["org", orgSlug, "season", seasonId, "house-table"],
    });
    void qc.invalidateQueries({
      queryKey: ["org", orgSlug, "season", seasonId, "groups"],
    });
  };

  // --- add house -------------------------------------------------------------
  const [houseName, setHouseName] = React.useState("");
  const [houseKind, setHouseKind] = React.useState<GroupKind>("house");
  const [houseColour, setHouseColour] = React.useState("");
  const createGroup = useMutation({
    mutationFn: () =>
      housesApi.createGroup(orgId, seasonId, {
        name: houseName.trim(),
        kind: houseKind,
        colour: houseColour.trim(),
      }),
    onSuccess: (g) => {
      toast.push({ kind: "success", title: `${g.name} ${t("added")}` });
      setHouseName("");
      setHouseColour("");
      refetchBoard();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: errorDetail(e, t("Could not add the house")),
      }),
  });

  // --- award points ----------------------------------------------------------
  const [awardGroupId, setAwardGroupId] = React.useState("");
  const [awardPoints, setAwardPoints] = React.useState("");
  const [awardReason, setAwardReason] = React.useState("");
  const award = useMutation({
    mutationFn: () =>
      housesApi.awardPoints(orgId, seasonId, {
        group_id: awardGroupId,
        points: Number(awardPoints),
        reason: awardReason.trim(),
      }),
    onSuccess: () => {
      toast.push({ kind: "success", title: t("Points recorded") });
      setAwardPoints("");
      setAwardReason("");
      refetchBoard();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: errorDetail(e, t("Could not record the points")),
      }),
  });
  const awardValid =
    Boolean(awardGroupId) &&
    awardReason.trim().length > 0 &&
    awardPoints.trim() !== "" &&
    Number.isFinite(Number(awardPoints)) &&
    Number(awardPoints) >= -999 &&
    Number(awardPoints) <= 999;

  // --- meet result -----------------------------------------------------------
  const [eventLabel, setEventLabel] = React.useState("");
  const [relay, setRelay] = React.useState(false);
  const [placements, setPlacements] = React.useState<string[]>([]);
  const groupName = (id: string): string =>
    groups.find((g) => g.id === id)?.name ?? t("Unknown");
  const meet = useMutation({
    mutationFn: () =>
      housesApi.recordMeetResult(orgId, seasonId, {
        event_label: eventLabel.trim(),
        placements,
        relay,
      }),
    onSuccess: (res) => {
      toast.push({
        kind: "success",
        title: t("Result recorded"),
        description: `${res.entries} ${t("point entries landed on the table.")}`,
      });
      // The response carries the refreshed table; paint it immediately.
      qc.setQueryData<HouseTableResponse>(
        ["org", orgSlug, "season", seasonId, "house-table"],
        (prev) =>
          prev ? { ...prev, table: res.table } : prev,
      );
      setEventLabel("");
      setRelay(false);
      setPlacements([]);
      refetchBoard();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: errorDetail(e, t("Could not record the result")),
      }),
  });
  const unplaced = groups.filter((g) => !placements.includes(g.id));

  // --- guards ----------------------------------------------------------------
  if (!membership) {
    return (
      <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <div className="panel p-6">
          <p
            role="status"
            data-testid="no-membership"
            className="text-sm text-muted-foreground"
          >
            {t("Organization not found.")}
          </p>
        </div>
      </div>
    );
  }

  const noSeasons = !seasonsQuery.isLoading && seasons.length === 0;

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header row: title + season picker + new season */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <h1 className="page-title">{t("Houses & points")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("The season's house table, judged awards, and meet results.")}
          </p>
        </div>
        {seasons.length > 0 ? (
          <Select
            value={seasonId}
            onChange={setSeasonId}
            options={seasons.map((s) => ({
              value: s.id,
              label: s.is_current ? `${s.label} · ${t("current")}` : s.label,
            }))}
            size="sm"
            className="w-44"
            aria-label={t("Season")}
          />
        ) : null}
        {isManager ? (
          <Button
            type="button"
            variant="outline"
            data-testid="new-season"
            onClick={() => setSeasonDialogOpen(true)}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("New season")}
          </Button>
        ) : null}
      </div>

      {seasonsQuery.isLoading ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-3">
          <span className="sr-only">{t("Loading seasons...")}</span>
          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          <div className="h-40 w-full animate-pulse rounded-md bg-muted/70" />
        </div>
      ) : noSeasons ? (
        /* Day-zero empty state: no seasons yet. */
        <div className="panel flex flex-col items-center gap-3 px-4 py-14 text-center">
          <Medal
            aria-hidden="true"
            className="h-8 w-8 text-muted-foreground/40"
          />
          <div>
            <p className="text-sm font-medium">{t("No seasons yet")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("A season holds your houses and their points ledger.")}
            </p>
          </div>
          {isManager ? (
            <Button
              type="button"
              data-testid="create-first-season"
              onClick={() => setSeasonDialogOpen(true)}
            >
              {t("Create your first season")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("An organization admin can create one.")}
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          {/* THE HOUSE TABLE */}
          <section className="panel lg:col-span-2" aria-label={t("House table")}>
            <div className="panel-header justify-between">
              <h2 className="panel-title">{t("House table")}</h2>
              <span className="text-xs text-muted-foreground">
                {seasons.find((s) => s.id === seasonId)?.label ?? ""}
              </span>
            </div>
            {tableQuery.isLoading ? (
              <div className="flex flex-col gap-2 p-3">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-9 w-full animate-pulse rounded-md bg-muted"
                  />
                ))}
              </div>
            ) : table.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {isManager
                  ? t("No houses yet. Add the first one below.")
                  : t("No houses yet.")}
              </p>
            ) : (
              <ol data-testid="house-table">
                {table.map((row, i) => (
                  <li
                    key={row.group_id}
                    data-testid={`house-row-${i}`}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2",
                      i > 0 && "border-t border-border",
                    )}
                  >
                    <span className="w-5 shrink-0 text-right font-tabular text-xs font-medium text-muted-foreground">
                      {i + 1}
                    </span>
                    <ColourDot colour={row.colour} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {row.name}
                    </span>
                    <span className="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] capitalize text-muted-foreground sm:inline">
                      {t(row.kind)}
                    </span>
                    <span className="hidden shrink-0 font-tabular text-xs text-muted-foreground sm:inline">
                      {row.entries} {row.entries === 1 ? t("entry") : t("entries")}
                    </span>
                    <span
                      className="w-14 shrink-0 text-right font-tabular text-xl font-semibold"
                      data-testid={`house-points-${i}`}
                    >
                      {row.points}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {/* Add house (managers) */}
            {isManager ? (
              <form
                data-testid="add-house-form"
                className="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (houseName.trim() && !createGroup.isPending) {
                    createGroup.mutate();
                  }
                }}
              >
                <div className="flex min-w-36 flex-1 flex-col gap-1">
                  <Label htmlFor="house-name" className="text-xs">
                    {t("Add house")}
                  </Label>
                  <Input
                    id="house-name"
                    data-testid="house-name"
                    value={houseName}
                    maxLength={120}
                    onChange={(e) => setHouseName(e.target.value)}
                    placeholder={t("Red House")}
                  />
                </div>
                <div className="flex w-32 flex-col gap-1">
                  <Label htmlFor="house-kind" className="text-xs">
                    {t("Kind")}
                  </Label>
                  <Select
                    id="house-kind"
                    value={houseKind}
                    onChange={(v) => setHouseKind(v as GroupKind)}
                    options={KIND_OPTIONS}
                    size="sm"
                    aria-label={t("Kind")}
                  />
                </div>
                <div className="flex w-28 flex-col gap-1">
                  <Label htmlFor="house-colour" className="text-xs">
                    {t("Colour")}
                  </Label>
                  <Input
                    id="house-colour"
                    data-testid="house-colour"
                    value={houseColour}
                    maxLength={16}
                    onChange={(e) => setHouseColour(e.target.value)}
                    placeholder={t("red")}
                  />
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  data-testid="house-submit"
                  disabled={!houseName.trim() || createGroup.isPending}
                >
                  {createGroup.isPending ? t("Adding...") : t("Add")}
                </Button>
              </form>
            ) : null}
          </section>

          {/* Write panels (managers only) */}
          {isManager ? (
            <div className="flex flex-col gap-4">
              {/* AWARD POINTS */}
              <section className="panel" aria-label={t("Award points")}>
                <div className="panel-header">
                  <h2 className="panel-title">{t("Award points")}</h2>
                </div>
                <form
                  data-testid="award-form"
                  className="flex flex-col gap-3 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (awardValid && !award.isPending) award.mutate();
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="award-house" className="text-xs">
                      {t("House")}
                    </Label>
                    <Select
                      id="award-house"
                      value={awardGroupId}
                      onChange={setAwardGroupId}
                      options={groups.map((g) => ({
                        value: g.id,
                        label: g.name,
                      }))}
                      placeholder={t("Pick a house")}
                      size="sm"
                      aria-label={t("House")}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="award-points" className="text-xs">
                      {t("Points")}
                    </Label>
                    <Input
                      id="award-points"
                      data-testid="award-points"
                      type="number"
                      min={-999}
                      max={999}
                      value={awardPoints}
                      onChange={(e) => setAwardPoints(e.target.value)}
                      placeholder="10"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "Negative points correct a mistake. Corrections append a new entry, history is never edited.",
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="award-reason" className="text-xs">
                      {t("Reason")}
                    </Label>
                    <Input
                      id="award-reason"
                      data-testid="award-reason"
                      value={awardReason}
                      maxLength={200}
                      onChange={(e) => setAwardReason(e.target.value)}
                      placeholder={t("March past winners")}
                    />
                  </div>
                  <Button
                    type="submit"
                    data-testid="award-submit"
                    disabled={!awardValid || award.isPending}
                  >
                    {award.isPending ? t("Recording...") : t("Award points")}
                  </Button>
                </form>
              </section>

              {/* MEET RESULT */}
              <section className="panel" aria-label={t("Meet result")}>
                <div className="panel-header">
                  <h2 className="panel-title">{t("Meet result")}</h2>
                </div>
                <form
                  data-testid="meet-form"
                  className="flex flex-col gap-3 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (
                      eventLabel.trim() &&
                      placements.length > 0 &&
                      !meet.isPending
                    ) {
                      meet.mutate();
                    }
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="meet-event" className="text-xs">
                      {t("Event")}
                    </Label>
                    <Input
                      id="meet-event"
                      data-testid="meet-event"
                      value={eventLabel}
                      maxLength={150}
                      onChange={(e) => setEventLabel(e.target.value)}
                      placeholder={t("100m boys U14")}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid="meet-relay"
                      checked={relay}
                      onChange={(e) => setRelay(e.target.checked)}
                      className="h-4 w-4 rounded border-input accent-current"
                    />
                    {t("Relay event")}
                  </label>

                  {/* Ordered placements, winner first */}
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium">{t("Placements")}</p>
                    {placements.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("Add houses in finishing order, winner first.")}
                      </p>
                    ) : (
                      <ol
                        data-testid="placements-list"
                        className="flex flex-col gap-1"
                      >
                        {placements.map((id, i) => (
                          <li
                            key={id}
                            className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm"
                          >
                            <span className="w-7 shrink-0 font-tabular text-xs font-medium text-muted-foreground">
                              {ordinal(i + 1)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {groupName(id)}
                            </span>
                            {i > 0 ? (
                              <button
                                type="button"
                                aria-label={`${t("Move up")} ${groupName(id)}`}
                                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() =>
                                  setPlacements((cur) => {
                                    const next = [...cur];
                                    [next[i - 1], next[i]] = [
                                      next[i],
                                      next[i - 1],
                                    ];
                                    return next;
                                  })
                                }
                              >
                                <ArrowUp
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              aria-label={`${t("Remove")} ${groupName(id)}`}
                              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                              onClick={() =>
                                setPlacements((cur) =>
                                  cur.filter((x) => x !== id),
                                )
                              }
                            >
                              <X aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                    {unplaced.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {unplaced.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            data-testid={`place-add-${g.id}`}
                            aria-label={`${t("Add to placements")}: ${g.name}`}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-accent"
                            onClick={() =>
                              setPlacements((cur) => [...cur, g.id])
                            }
                          >
                            <Plus aria-hidden="true" className="h-3 w-3" />
                            {g.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {t("Scores 7-5-4-3-2-1 by place, doubled for relays.")}
                    </p>
                  </div>

                  <Button
                    type="submit"
                    data-testid="meet-submit"
                    disabled={
                      !eventLabel.trim() ||
                      placements.length === 0 ||
                      meet.isPending
                    }
                  >
                    {meet.isPending ? t("Recording...") : t("Record result")}
                  </Button>
                </form>
              </section>
            </div>
          ) : null}
        </div>
      )}

      <NewSeasonDialog
        open={seasonDialogOpen}
        onOpenChange={setSeasonDialogOpen}
        pending={createSeason.isPending}
        onCreate={(label, isCurrent) =>
          createSeason.mutate({ label, isCurrent })
        }
      />
    </div>
  );
}
