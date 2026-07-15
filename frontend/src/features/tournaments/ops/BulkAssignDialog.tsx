import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, MapPin, Trophy, UserCog } from "lucide-react";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
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
import { OFFICIAL_ROLES, candidatesOf } from "@/features/controlroom/crewRoster";
import { errorDetail } from "@/features/fixtures/repair";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { t } from "@/lib/t";

type Scope = "court" | "category" | "sport";

/** Title-case a key like "table_tennis" → "Table Tennis". */
function prettify(key: string): string {
  return key
    .split(/[._\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

interface Target {
  value: string;
  label: string;
}

/** The distinct courts / categories / sports present in the day's matches. */
function targetsFor(scope: Scope, matches: ControlRoomMatch[]): Target[] {
  const seen = new Map<string, string>();
  for (const m of matches) {
    if (scope === "court") {
      const key = m.venue ?? "";
      if (!seen.has(key)) seen.set(key, m.venue || t("No court"));
    } else if (scope === "category") {
      const key = m.leaf_key ?? "";
      if (!seen.has(key)) seen.set(key, m.leaf_label || t("Tournament"));
    } else {
      const key = m.sport ?? "";
      if (!seen.has(key)) {
        const first = m.leaf_label?.split(/\s+·\s+/)[0]?.trim();
        seen.set(key, first || prettify(m.sport || "football"));
      }
    }
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function inScope(m: ControlRoomMatch, scope: Scope, key: string): boolean {
  if (scope === "court") return (m.venue ?? "") === key;
  if (scope === "category") return (m.leaf_key ?? "") === key;
  return (m.sport ?? "") === key;
}

const SCOPE_META: Record<Scope, { label: string; icon: typeof MapPin }> = {
  court: { label: "By court", icon: MapPin },
  category: { label: "By category", icon: Layers },
  sport: { label: "By sport", icon: Trophy },
};

/**
 * Bulk crew assignment (ops 2026-07-15). Assign one scorer or official to EVERY
 * match in a scope — a court, a competition category, or a sport — in one call,
 * instead of opening the per-match drawer dozens of times. A live preview shows
 * how many matches will be staffed vs skipped before you commit; the write goes
 * through the audited per-match services, so every guard still fires.
 */
export function BulkAssignDialog({
  tournamentId,
  day,
  matches,
  canManage,
  canAssignOfficials,
  initialScope = "court",
  initialKey,
  onClose,
}: {
  tournamentId: string;
  day: string;
  matches: ControlRoomMatch[];
  canManage: boolean;
  canAssignOfficials: boolean;
  initialScope?: Scope;
  initialKey?: string;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();

  const membersQ = useQuery({
    queryKey: ["t-members", tournamentId],
    queryFn: () => tournamentsApi.members(tournamentId),
  });
  const memberOptions = useMemo(
    () =>
      candidatesOf(membersQ.data).map((p) => ({
        value: p.userId,
        label: p.roles.length
          ? `${p.name} · ${p.roles.map((r) => r.replace(/_/g, " ")).join(", ")}`
          : p.name,
      })),
    [membersQ.data],
  );

  const roleOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    if (canManage) out.push({ value: "scorer", label: t("Scorer") });
    if (canAssignOfficials) {
      for (const r of OFFICIAL_ROLES) out.push({ value: r.value, label: t(r.label) });
    }
    return out;
  }, [canManage, canAssignOfficials]);

  const [scope, setScope] = useState<Scope>(initialScope);
  const [role, setRole] = useState(roleOptions[0]?.value ?? "scorer");
  const [pick, setPick] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);

  const targets = useMemo(() => targetsFor(scope, matches), [scope, matches]);
  const [key, setKey] = useState(initialKey ?? targets[0]?.value ?? "");
  // Keep the target valid when the scope switches its option set.
  const effectiveKey = targets.some((x) => x.value === key)
    ? key
    : targets[0]?.value ?? "";

  const isScorer = role === "scorer";
  const scoped = matches.filter((m) => inScope(m, scope, effectiveKey));
  const needing = scoped.filter((m) =>
    isScorer ? !m.scorer : (m.officials ?? []).length === 0,
  );
  const willAssign = onlyUnassigned ? needing.length : scoped.length;
  const willSkip = onlyUnassigned ? scoped.length - needing.length : 0;

  const submit = useMutation({
    mutationFn: () =>
      tournamentsApi.bulkAssignCrew(tournamentId, {
        scope,
        key: effectiveKey,
        day: day || null,
        role,
        user_id: pick,
        only_unassigned: onlyUnassigned,
        event_id: newEventId(),
      }),
    onSuccess: (res) => {
      invalidateTournament(qc, tournamentId);
      const clashes = res.warnings.length;
      toast.push({
        kind: clashes ? "info" : "success",
        title: t("Assigned {n}")
          .replace("{n}", String(res.assigned))
          .concat(res.skipped ? ` · ${t("skipped {n}")}`.replace("{n}", String(res.skipped)) : ""),
        description: clashes
          ? t("{n} possible clashes flagged in the change history").replace(
              "{n}",
              String(clashes),
            )
          : undefined,
      });
      onClose();
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not assign the crew"),
        description: errorDetail(e),
      }),
  });

  const roleWord = isScorer ? t("scorer") : t("official");

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      ariaLabel={t("Bulk assign")}
    >
      <div data-testid="bulk-assign-dialog">
        <DialogHeader>
          <DialogTitle>{t("Bulk assign")}</DialogTitle>
          <DialogDescription>
            {t("Staff every match in a court, category or sport at once.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Scope */}
          <section className="flex flex-col gap-1.5">
            <Label>{t("Assign across")}</Label>
            <div
              role="group"
              aria-label={t("Assign across")}
              className="grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-muted p-0.5"
            >
              {(Object.keys(SCOPE_META) as Scope[]).map((s) => {
                const Icon = SCOPE_META[s].icon;
                const active = scope === s;
                return (
                  <button
                    key={s}
                    type="button"
                    data-testid={`bulk-scope-${s}`}
                    aria-pressed={active}
                    onClick={() => setScope(s)}
                    className={
                      "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                      (active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {t(SCOPE_META[s].label)}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Target */}
          <section className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-target">
              {scope === "court"
                ? t("Court")
                : scope === "category"
                  ? t("Category")
                  : t("Sport")}
            </Label>
            <Select
              id="bulk-target"
              aria-label={t("Target")}
              value={effectiveKey}
              onChange={setKey}
              options={targets}
              placeholder={t("Pick one…")}
            />
          </section>

          {/* Role + person */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-role">
                <span className="inline-flex items-center gap-1.5">
                  <UserCog aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Role")}
                </span>
              </Label>
              <Select
                id="bulk-role"
                aria-label={t("Role")}
                value={role}
                onChange={setRole}
                options={roleOptions}
              />
            </section>
            <section className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-person">{t("Person")}</Label>
              <Select
                id="bulk-person"
                aria-label={t("Person")}
                value={pick}
                onChange={setPick}
                options={memberOptions}
                placeholder={t("Pick a person…")}
              />
            </section>
          </div>

          {/* Only unassigned */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="bulk-only-unassigned"
              checked={onlyUnassigned}
              onChange={(e) => setOnlyUnassigned(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            {t("Only matches without a {role}").replace("{role}", roleWord)}
          </label>

          {/* Preview */}
          <div
            data-testid="bulk-preview"
            className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
          >
            {willAssign > 0 ? (
              <span>
                {t("Will assign")}{" "}
                <span className="font-tabular font-semibold">{willAssign}</span>
                {willSkip > 0 ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("skip {n} already staffed").replace("{n}", String(willSkip))}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("Nothing to assign in this scope.")}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            data-testid="bulk-submit"
            disabled={!pick || willAssign === 0 || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {t("Assign {n} matches").replace("{n}", String(willAssign))}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
