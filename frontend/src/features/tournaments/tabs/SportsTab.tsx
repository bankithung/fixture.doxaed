import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Copy as CopyIcon,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import {
  tournamentsApi,
  type SportNode,
  type SportNodeAge,
  type SportNodeFormat,
  type TournamentSport,
} from "@/api/tournaments";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { burstFrom } from "@/lib/burst";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Coerce server data to the recursive node shape, tolerating the legacy
 * 2-level `{name, subcategories}` and plain-string forms. Server-minted node
 * `key`s are preserved — they are the stable identity registered teams hang
 * off, so renames must round-trip them. */
function normNodes(raw: unknown): SportNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n): SportNode | null => {
      if (typeof n === "string") return n.trim() ? { name: n.trim() } : null;
      if (typeof n !== "object" || n === null) return null;
      const o = n as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) return null;
      const children = Array.isArray(o.children)
        ? normNodes(o.children)
        : Array.isArray(o.subcategories)
          ? normNodes(o.subcategories)
          : [];
      return {
        ...(typeof o.key === "string" && o.key ? { key: o.key } : {}),
        name,
        // kind/format/age carry the category's rules (W2) — round-trip them
        // or every save would wipe what the server stored.
        ...(typeof o.kind === "string" && o.kind
          ? { kind: o.kind as SportNode["kind"] }
          : {}),
        ...(o.format && typeof o.format === "object"
          ? { format: o.format as SportNode["format"] }
          : {}),
        ...(o.age && typeof o.age === "object"
          ? { age: o.age as SportNode["age"] }
          : {}),
        children,
      };
    })
    .filter((n): n is SportNode => n !== null);
}

function sportNodes(s: TournamentSport): SportNode[] {
  return normNodes(s.nodes ?? s.categories ?? []);
}

/** Every competition (leaf path) under a node list — "U15 — Girls — 5v5". */
function leafLabels(nodes: SportNode[], prefix: string[] = []): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const path = [...prefix, n.name];
    if (n.children?.length) out.push(...leafLabels(n.children, path));
    else out.push(path.join(" · "));
  }
  return out;
}

/** Like leafLabels, but each competition as its path segments — so the live
 * preview can structure them (group by top-level category) instead of showing
 * one hard-to-scan dashed string per competition. */
function leafPaths(nodes: SportNode[], prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const n of nodes) {
    const path = [...prefix, n.name];
    if (n.children?.length) out.push(...leafPaths(n.children, path));
    else out.push(path);
  }
  return out;
}

/** Group competition paths by their first segment for the preview panel:
 * `{ head: "U-14", subs: ["Girls · 1v1", "Boys · 1v1"] }`. A top-level leaf
 * (no nesting) yields an empty `subs` — it IS the competition. */
function groupLeaves(paths: string[][]): { head: string; subs: string[] }[] {
  const map = new Map<string, string[]>();
  for (const path of paths) {
    const head = path[0] ?? "";
    const rest = path.slice(1).join(" · ");
    const arr = map.get(head);
    if (arr) arr.push(rest);
    else map.set(head, [rest]);
  }
  return [...map].map(([head, rests]) => ({
    head,
    subs: rests.filter((r) => r !== ""),
  }));
}

/** Immutable node-tree ops addressed by index path. */
function withChildAdded(
  nodes: SportNode[],
  path: number[],
  node: SportNode,
): SportNode[] {
  if (path.length === 0) return [...nodes, node];
  const [head, ...rest] = path;
  return nodes.map((n, i) =>
    i === head
      ? { ...n, children: withChildAdded(n.children ?? [], rest, node) }
      : n,
  );
}

/** "5v5" / "3 vs 3" style names ⇒ players-per-side (mirrors the server). */
function detectPerSide(name: string): number | undefined {
  const m = /^\s*(\d{1,2})\s*[vV][sS]?\s*(\d{1,2})\s*$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** "U15"/"Under 15" → under, "16+" → over, "12-14" → between (mirrors the
 * server's name auto-detection). */
function detectAge(name: string): SportNodeAge | undefined {
  let m = /^\s*(?:u\s*-?\s*|under\s+)(\d{1,2})\s*$/i.exec(name);
  if (m) return { op: "under", age: Number(m[1]) };
  m = /^\s*(?:over\s+)?(\d{1,2})\s*\+\s*$/i.exec(name);
  if (m) return { op: "over", age: Number(m[1]) };
  m = /^\s*(\d{1,2})\s*[--]\s*(\d{1,2})\s*$/.exec(name);
  if (m && Number(m[1]) <= Number(m[2])) {
    return { op: "between", min: Number(m[1]), max: Number(m[2]) };
  }
  return undefined;
}

function ageLabel(age: SportNodeAge | undefined): string {
  if (!age) return "";
  if (age.op === "under" && age.age) return `${t("under")} ${age.age}`;
  if (age.op === "over" && age.age) return `${age.age}+`;
  if (age.op === "between" && age.min && age.max) return `${age.min}-${age.max}`;
  return "";
}

const AGE_OP_OPTIONS = [
  { value: "under", label: t("Under (younger than)") },
  { value: "over", label: t("And above (N+)") },
  { value: "between", label: t("Between (range)") },
];

/** Operator + number inputs for an age rule — strict numbers (W2). */
function AgeRuleFields({
  value,
  onChange,
}: {
  value: SportNodeAge | undefined;
  onChange: (age: SportNodeAge | undefined) => void;
}): React.ReactElement {
  const op = value?.op ?? "under";
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex w-44 flex-col gap-1">
        <Label className="text-xs">{t("Age rule")}</Label>
        <Select
          aria-label={t("Age operator")}
          value={op}
          options={AGE_OP_OPTIONS}
          onChange={(v) =>
            onChange({ op: v as SportNodeAge["op"] })
          }
        />
      </div>
      {op === "between" ? (
        <>
          <div className="flex w-24 flex-col gap-1">
            <Label className="text-xs">{t("From age")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={value?.min ?? ""}
              onChange={(e) =>
                onChange({ op: "between", min: num(e.target.value), max: value?.max })
              }
              className="h-9 font-tabular"
              aria-label={t("From age")}
            />
          </div>
          <div className="flex w-24 flex-col gap-1">
            <Label className="text-xs">{t("To age")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={value?.max ?? ""}
              onChange={(e) =>
                onChange({ op: "between", min: value?.min, max: num(e.target.value) })
              }
              className="h-9 font-tabular"
              aria-label={t("To age")}
            />
          </div>
        </>
      ) : (
        <div className="flex w-24 flex-col gap-1">
          <Label className="text-xs">{t("Age")}</Label>
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={value?.age ?? ""}
            onChange={(e) =>
              onChange({ op: op as SportNodeAge["op"], age: num(e.target.value) })
            }
            className="h-9 font-tabular"
            aria-label={t("Age")}
          />
        </div>
      )}
    </div>
  );
}

function withNodeRemoved(nodes: SportNode[], path: number[]): SportNode[] {
  if (path.length === 1) return nodes.filter((_n, i) => i !== path[0]);
  const [head, ...rest] = path;
  return nodes.map((n, i) =>
    i === head ? { ...n, children: withNodeRemoved(n.children ?? [], rest) } : n,
  );
}

function withNodePatched(
  nodes: SportNode[],
  path: number[],
  patch: Partial<SportNode>,
): SportNode[] {
  const [head, ...rest] = path;
  return nodes.map((n, i) =>
    i === head
      ? rest.length === 0
        ? { ...n, ...patch }
        : { ...n, children: withNodePatched(n.children ?? [], rest, patch) }
      : n,
  );
}

const NODE_KIND_OPTIONS = [
  { value: "", label: t("Category type…") },
  { value: "age_group", label: t("Age group") },
  { value: "gender", label: t("Gender") },
  { value: "format", label: t("Format (team size)") },
  { value: "level", label: t("Level") },
  { value: "custom", label: t("Custom") },
];

/**
 * Add-category form (W2 refinement, owner 2026-06-10): name, TYPE and team
 * size are captured together at add time — the type chooser shows on every
 * add instead of hiding behind a per-node button, and team-size fields are
 * strict numbers (a "5 v 5" free-text size could never be compared; sizes
 * are integers, "5v5" belongs in the NAME, where it auto-fills the numbers).
 */
function AddNodeForm({
  onAdd,
  onCancel,
}: {
  onAdd: (node: SportNode) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("");
  const [pps, setPps] = useState<string>("");
  const [squadMax, setSquadMax] = useState<string>("");
  const [age, setAge] = useState<SportNodeAge | undefined>(undefined);

  const detected = detectPerSide(name);
  const detectedAge = detectAge(name);
  const effectiveKind =
    kind ||
    (detected != null ? "format" : "") ||
    (detectedAge ? "age_group" : "");
  const showSize = effectiveKind === "format";
  const showAge = effectiveKind === "age_group";
  const ppsValue = pps !== "" ? Number(pps) : detected;
  const effectiveAge = age ?? detectedAge;

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const node: SportNode = { name: trimmed };
    if (effectiveKind) node.kind = effectiveKind as SportNode["kind"];
    const fmt: SportNodeFormat = {};
    if (ppsValue != null && Number.isInteger(ppsValue) && ppsValue > 0) {
      fmt.players_per_side = ppsValue;
    }
    const sq = squadMax !== "" ? Number(squadMax) : undefined;
    if (sq != null && Number.isInteger(sq) && sq > 0) {
      fmt.squad_max = Math.max(sq, fmt.players_per_side ?? 1);
    }
    if (Object.keys(fmt).length) node.format = fmt;
    if (
      showAge &&
      effectiveAge &&
      (effectiveAge.op === "between"
        ? effectiveAge.min != null &&
          effectiveAge.max != null &&
          effectiveAge.min <= effectiveAge.max
        : effectiveAge.age != null)
    ) {
      node.age = effectiveAge;
    }
    onAdd(node);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <Label className="text-xs">{t("Name")}</Label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("e.g. U-14, Girls, 5v5")}
            className="h-9"
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <Label className="text-xs">{t("Type")}</Label>
          <Select
            aria-label={t("Category type")}
            value={effectiveKind}
            options={NODE_KIND_OPTIONS}
            onChange={setKind}
            placeholder={t("Category type…")}
          />
        </div>
      </div>
      {showSize ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex w-28 flex-col gap-1">
            <Label className="text-xs">{t("Players on field")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={pps !== "" ? pps : (detected ?? "")}
              onChange={(e) => setPps(e.target.value)}
              className="h-9 font-tabular"
              aria-label={t("Players on field")}
            />
          </div>
          <div className="flex w-28 flex-col gap-1">
            <Label className="text-xs">{t("Squad max")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={squadMax}
              onChange={(e) => setSquadMax(e.target.value)}
              placeholder={ppsValue != null ? String(ppsValue) : ""}
              className="h-9 font-tabular"
              aria-label={t("Squad max")}
            />
          </div>
          <p className="flex-1 pb-1 text-xs text-muted-foreground">
            {t("Raise the max for substitutes.")}
          </p>
        </div>
      ) : null}
      {showAge ? (
        <AgeRuleFields value={effectiveAge} onChange={setAge} />
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!name.trim()}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("Add category")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Inline node editor (W2-B): name, type & team size. Text/numbers commit on
 * blur so the auto-saving PUT doesn't fire per keystroke. Renaming round-trips
 * the node's server-minted `key` (via `withNodePatched` spreading the existing
 * node), so a competition's `leaf_key` — and the teams registered under it —
 * stays stable across renames (owner report 2026-06-15: names were locked once
 * added). A "format" node's team-size rules become the generated team form's
 * roster bounds (1v1 → exactly 1 player; widen squad max for substitutes).
 */
function NodeKindEditor({
  node,
  onPatch,
}: {
  node: SportNode;
  onPatch: (patch: Partial<SportNode>) => void;
}): React.ReactElement {
  const fmt = node.format ?? {};
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const patchFormat = (k: keyof SportNodeFormat, v: string): void => {
    const next = { ...fmt, [k]: num(v) };
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, val]) => val !== undefined),
    ) as SportNodeFormat;
    onPatch({ format: Object.keys(clean).length ? clean : undefined });
  };
  const showSize = node.kind === "format" || fmt.players_per_side != null;
  const showAge = node.kind === "age_group" || node.age != null;
  return (
    <div className="flex flex-col gap-3">
      {/* Name — commits on blur (changed + non-blank only); keeps the node's
          key, so the rename doesn't orphan registered teams. */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t("Name")}</Label>
        <Input
          defaultValue={node.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== node.name) onPatch({ name: v });
          }}
          className="h-9"
          aria-label={t("Category name")}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
      <div className="flex w-40 flex-col gap-1">
        <Label className="text-xs">{t("Type")}</Label>
        <Select
          aria-label={t(`Category type for ${node.name}`)}
          value={node.kind ?? ""}
          options={NODE_KIND_OPTIONS}
          onChange={(v) =>
            onPatch({ kind: (v || undefined) as SportNode["kind"] })
          }
          placeholder={t("Category type…")}
        />
      </div>
      {showSize ? (
        <>
          {(
            [
              ["players_per_side", t("On field")],
              ["squad_min", t("Squad min")],
              ["squad_max", t("Squad max")],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="flex w-24 flex-col gap-1">
              <Label className="text-xs">{label}</Label>
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                defaultValue={fmt[k] ?? ""}
                onBlur={(e) => patchFormat(k, e.target.value)}
                className="h-9 font-tabular"
                aria-label={`${label} · ${node.name}`}
              />
            </div>
          ))}
        </>
      ) : null}
      </div>
      {showAge ? (
        <AgeRuleFields
          value={node.age}
          onChange={(a) => onPatch({ age: a })}
        />
      ) : null}
    </div>
  );
}

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * SETUP step — choose the sport(s) this tournament runs and build each one's
 * category tree (any depth: U15 → Girls → 5v5). Every LEAF of the tree is one
 * competition: it appears on the auto-generated registration form, teams
 * register into it, and it gets its own draw. Auto-saves; per-sport match
 * settings (duration, venue type) feed the scheduler.
 */
export function SportsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  // Add-category modal target: which sport + parent path it adds under
  // (owner 2026-06-10: adding must be a popup carrying name/type/size).
  const [addTarget, setAddTarget] = useState<{
    sportKey: string;
    path: number[];
    label: string;
  } | null>(null);
  // Type & team-size modal target for an EXISTING node.
  const [kindTarget, setKindTarget] = useState<{
    sportKey: string;
    path: number[];
  } | null>(null);
  // "Copy categories to other sports" modal (owner 2026-06-10: set one sport
  // up, then apply the same tree to all/selected others).
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<Set<string>>(new Set());
  // Two-step sub-flow: pick sports → configure each one (focused, via tabs).
  // Three-step sub-flow (owner 2026-06-10): pick sports → configure each
  // one's categories in turn → REVIEW everything before generating.
  const [searchParams, setSearchParams] = useSearchParams();
  // The active sub-step lives in the URL (?step=) so the left sidebar's "Set up
  // sports" section can read it and drive navigation. Invalid/missing → "pick".
  const stepParam = searchParams.get("step");
  const step: "pick" | "configure" | "review" =
    stepParam === "configure" || stepParam === "review" ? stepParam : "pick";
  const setStep = (next: "pick" | "configure" | "review"): void => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === "pick") sp.delete("step");
        else sp.set("step", next);
        return sp;
      },
      { replace: true },
    );
  };
  const [activeKey, setActiveKey] = useState<string>("");

  const catalog = useQuery({
    queryKey: ["sports-catalog"],
    queryFn: () => tournamentsApi.sportsCatalog(),
    staleTime: 60 * 60 * 1000,
  });
  const chosen = useQuery({
    queryKey: ["tournament-sports", id],
    queryFn: () => tournamentsApi.sports(id),
    enabled: Boolean(id),
  });
  const forms = useQuery({
    queryKey: ["forms", id],
    queryFn: () => formsApi.list(id),
    enabled: Boolean(id),
  });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
    enabled: Boolean(id),
  });
  const orgForm =
    (forms.data ?? []).find((f) => f.stage === "org_registration") ??
    (forms.data ?? []).find((f) => f.purpose === "organization_registration");

  const selected = useMemo<TournamentSport[]>(
    () =>
      (chosen.data?.sports ?? []).map((s) => ({ ...s, nodes: sportNodes(s) })),
    [chosen.data],
  );
  const selectedKeys = useMemo(
    () => new Set(selected.map((s) => s.key)),
    [selected],
  );

  const save = useMutation({
    mutationFn: (next: TournamentSport[]) => tournamentsApi.setSports(id, next),
    // Optimistic: edits (category type, team size, add/remove) reflect
    // immediately — waiting for PUT + refetch made the type Select feel dead
    // (owner report 2026-06-10). Server response then reconciles.
    onMutate: async (next: TournamentSport[]) => {
      await qc.cancelQueries({ queryKey: ["tournament-sports", id] });
      const prev = qc.getQueryData(["tournament-sports", id]);
      qc.setQueryData(["tournament-sports", id], { sports: next });
      return { prev };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tournament-sports", id] });
      qc.invalidateQueries({ queryKey: ["tournament", id] });
    },
    onError: (e, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(["tournament-sports", id], ctx.prev);
      }
      toast.push({
        kind: "error",
        title:
          e instanceof ApiError && e.payload.detail === "not_tournament_manager"
            ? t("Only managers can change sports")
            : t("Could not save sports"),
      });
    },
  });

  // Generate the institution form (reusing an existing one) AND move the
  // tournament from SETUP into the institute-registration stage, so the form
  // becomes that stage's registration form — the proper end-to-end flow.
  const generate = useMutation({
    mutationFn: async () => {
      // A reused form generated from an OLDER category set is refreshed
      // first, so the published form always matches what was configured here.
      const form = orgForm
        ? orgForm.stale
          ? await formsApi.regenerate(orgForm.id)
          : orgForm
        : await formsApi.generateInstitutionForm(id);
      if (stage.data?.stage === "setup") {
        await tournamentsApi.transitionStage(id, {
          to_stage: "org_registration",
          ack_warnings: true,
          event_id: newEventId(),
        });
      }
      return form;
    },
    onSuccess: () => {
      invalidateTournament(qc, id);
      qc.invalidateQueries({ queryKey: ["forms", id] });
      toast.push({
        kind: "success",
        title: t("Registration is set up · review and open it"),
      });
      navigate(routes.tournamentInstitutions(id));
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not start registration"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const add = (sport: TournamentSport): void => {
    if (selectedKeys.has(sport.key)) return;
    save.mutate([...selected, sport]);
  };
  const remove = (key: string): void =>
    save.mutate(selected.filter((s) => s.key !== key));
  const updateSport = (key: string, patch: Partial<TournamentSport>): void =>
    save.mutate(selected.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const addNode = (sportKey: string, path: number[], node: SportNode): void => {
    const sport = selected.find((s) => s.key === sportKey);
    if (!node.name.trim() || !sport) return;
    updateSport(sportKey, {
      nodes: withChildAdded(sport.nodes ?? [], path, node),
    });
    setAddTarget(null);
  };

  /** Apply the active sport's category tree to the chosen sports (deep copy
   * — kinds, team sizes and age rules travel with it). Replaces the targets'
   * existing categories; one PUT covers every target. */
  const applyCopy = (): void => {
    const src = activeSport?.nodes ?? [];
    if (!activeSport || src.length === 0 || copyTargets.size === 0) return;
    save.mutate(
      selected.map((s) =>
        copyTargets.has(s.key)
          ? { ...s, nodes: JSON.parse(JSON.stringify(src)) as SportNode[] }
          : s,
      ),
    );
    setCopyOpen(false);
    toast.push({
      kind: "success",
      title: t(`Categories copied to ${copyTargets.size} sport(s)`),
    });
  };

  /** The node a dialog target points at (live — optimistic edits included). */
  const nodeAt = (sportKey: string, path: number[]): SportNode | null => {
    let nodes = selected.find((s) => s.key === sportKey)?.nodes ?? [];
    let node: SportNode | null = null;
    for (const i of path) {
      node = nodes[i] ?? null;
      if (!node) return null;
      nodes = node.children ?? [];
    }
    return node;
  };
  const removeNode = (sportKey: string, path: number[]): void => {
    const sport = selected.find((s) => s.key === sportKey);
    if (!sport) return;
    updateSport(sportKey, { nodes: withNodeRemoved(sport.nodes ?? [], path) });
  };
  const patchNode = (
    sportKey: string,
    path: number[],
    patch: Partial<SportNode>,
  ): void => {
    const sport = selected.find((s) => s.key === sportKey);
    if (!sport) return;
    updateSport(sportKey, {
      nodes: withNodePatched(sport.nodes ?? [], path, patch),
    });
  };

  const q = search.trim().toLowerCase();
  // The server re-keys catalog codes ("sepak-takraw" → "sepak_takraw"), so
  // selected-state must compare NORMALIZED keys — the raw-code comparison let
  // already-added sports look addable (owner report 2026-06-10). Selected
  // entries stay in the list with an explicit "Added ✓" state.
  const isAdded = (code: string): boolean =>
    selectedKeys.has(code) || selectedKeys.has(slugKey(code));
  const matches = useMemo(() => {
    const all = catalog.data ?? [];
    return all
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q),
      )
      .slice(0, 24);
  }, [catalog.data, q]);

  const customName = search.trim();
  const customExists =
    !!customName &&
    [...(catalog.data ?? []).map((c) => c.name), ...selected.map((s) => s.name)]
      .map((n) => n.toLowerCase())
      .includes(customName.toLowerCase());

  const effectiveStep = selected.length === 0 ? "pick" : step;
  const activeSport = selected.find((s) => s.key === activeKey) ?? selected[0];
  const activeLeaves = activeSport ? leafLabels(activeSport.nodes ?? []) : [];
  // Grouped competitions for the live preview panel (right of the editor).
  const activeLeafGroups = groupLeaves(
    activeSport ? leafPaths(activeSport.nodes ?? []) : [],
  );

  /** One node row + its children, recursively. */
  const renderNode = (
    sport: TournamentSport,
    node: SportNode,
    path: number[],
  ): React.ReactElement => {
    const hasChildren = !!node.children?.length;
    // One quiet descriptor line instead of a row of badges: the age rule
    // and/or the team size — the only details that aren't obvious from the name.
    const bits: string[] = [];
    if (node.age) bits.push(ageLabel(node.age));
    if (node.format?.players_per_side) {
      const pps = node.format.players_per_side;
      let f = `${pps}${t("-a-side")}`;
      if (node.format.squad_max && node.format.squad_max !== pps) {
        f += ` · ${t("squad")} ${node.format.squad_min ?? pps}-${node.format.squad_max}`;
      }
      bits.push(f);
    }
    const descriptor = bits.join(" · ");
    const actionCls =
      "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground";
    return (
      <li key={node.key ?? `${path.join(".")}-${node.name}`} className="min-w-0">
        <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/50">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              hasChildren ? "bg-muted-foreground/40" : "bg-primary",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-sm",
                  hasChildren ? "font-semibold" : "font-medium",
                )}
                title={node.name}
              >
                {node.name}
              </span>
              {hasChildren ? null : (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary">
                  {t("competition")}
                </span>
              )}
            </div>
            {descriptor ? (
              <div className="truncate text-xs text-muted-foreground">
                {descriptor}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setKindTarget({ sportKey: sport.key, path })}
              aria-label={t(`Edit ${node.name} · name, type and team size`)}
              aria-haspopup="dialog"
              title={t("Edit")}
              className={actionCls}
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() =>
                setAddTarget({ sportKey: sport.key, path, label: node.name })
              }
              aria-label={t(`Add a level under ${node.name}`)}
              aria-haspopup="dialog"
              title={t("Add level")}
              className={actionCls}
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {hasChildren ? (
          <ul className="ml-3.5 border-l border-border pl-2.5">
            {(node.children ?? []).map((c, i) =>
              renderNode(sport, c, [...path, i]),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  // One node of the Review org-chart tree (CSS in index.css draws the
  // connectors). A branch is a plain box with its name + age rule; a leaf is a
  // competition — trophy marker, matchup name, and the format/squad beneath.
  const renderOrgNode = (
    node: SportNode,
    path: number[],
  ): React.ReactElement => {
    const hasChildren = !!node.children?.length;
    const age = node.age ? ageLabel(node.age) : "";
    const pps = node.format?.players_per_side;
    const fmt = pps ? `${pps}${t("-a-side")}` : "";
    const squad =
      node.format?.squad_max && node.format.squad_max !== pps
        ? `${t("squad")} ${node.format.squad_min ?? pps}-${node.format.squad_max}`
        : "";
    const meta = [age, fmt, squad].filter(Boolean).join(" · ");
    return (
      <li key={node.key ?? `${path.join(".")}-${node.name}`}>
        <div
          className={cn(
            "inline-flex flex-col items-center rounded-lg border px-3 py-1.5 text-center shadow-sm",
            hasChildren ? "border-border bg-card" : "border-primary/30 bg-card",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {hasChildren ? null : (
              <Trophy
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-primary"
              />
            )}
            <span className="whitespace-nowrap">{node.name}</span>
          </span>
          {meta ? (
            <span className="mt-0.5 whitespace-nowrap text-[0.6875rem] text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </div>
        {hasChildren ? (
          <ul>
            {(node.children ?? []).map((c, i) =>
              renderOrgNode(c, [...path, i]),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  const kindNode = kindTarget
    ? nodeAt(kindTarget.sportKey, kindTarget.path)
    : null;

  return (
    <div className="flex w-full flex-col gap-6">
      {/* No page heading on any step: the stage stepper above already places
          you (owner 2026-07-04). */}
      {effectiveStep === "pick" ? (
        <section className="panel" aria-label={t("Choose sports")}>
          {/* One toolbar: selected count, search, and Next in a single row. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <h3 className="text-sm font-semibold">
              {t("Selected")}{" "}
              <span className="font-tabular text-muted-foreground">
                ({selected.length})
              </span>
            </h3>
            <label className="relative ml-auto w-full sm:w-72">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("Search sports…")}
                className="h-9 w-full pl-9"
                aria-label={t("Search sports")}
              />
            </label>
            {selected.length > 0 ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setActiveKey(selected[0].key);
                  setStep("configure");
                }}
              >
                {t("Next: set up categories")}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-4 p-3">
            {/* Selected — cards (icon tile, name, competition count, remove). */}
            {selected.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                {t("No sports yet. Add at least one below.")}
              </p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
                {selected.map((s) => {
                  const leaves = leafLabels(s.nodes ?? []).length;
                  return (
                    <li
                      key={s.key}
                      data-testid={`sport-${s.key}`}
                      className="flex items-center gap-3 rounded-lg border border-primary/30 bg-accent/40 p-2.5"
                    >
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary">
                        <Trophy aria-hidden="true" className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {s.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {leaves > 0
                            ? `${leaves} ${leaves === 1 ? t("competition") : t("competitions")}`
                            : t("No categories yet")}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(s.key)}
                        aria-label={t(`Remove ${s.name}`)}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div aria-hidden="true" className="border-t border-border" />

            {customName && !customExists ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  add({ key: slugKey(customName), name: customName, custom: true });
                  setSearch("");
                }}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t(`Add “${customName}”`)}
              </Button>
            ) : null}

            <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
              {matches.map((c) => {
                const added = isAdded(c.code);
                return (
                  <button
                    key={c.code}
                    type="button"
                    aria-pressed={added}
                    onClick={(e) => {
                      if (added) {
                        remove(slugKey(c.code));
                      } else {
                        add({ key: slugKey(c.code), name: c.name, custom: false });
                        burstFrom(e.currentTarget);
                      }
                    }}
                    title={added ? t("Added · click to remove") : t("Add sport")}
                    className={cn(
                      "relative flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      added
                        ? "border-primary bg-accent"
                        : "border-border bg-card hover:border-primary/40 hover:bg-muted",
                    )}
                  >
                    {added ? (
                      <Check
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-primary"
                      />
                    ) : (
                      <Plus
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-primary"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs capitalize text-muted-foreground">
                        {added ? t("added") : c.category}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {catalog.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("Loading sports…")}</p>
            ) : matches.length === 0 && !customName ? (
              <p className="text-sm text-muted-foreground">
                {t("Type to find a sport, or add a custom one.")}
              </p>
            ) : null}
          </div>
        </section>
      ) : effectiveStep === "configure" ? (
        <>
          {/* Editor with folder-style sport tabs (left) + live preview (right). */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Sport tabs — bookmarked onto the editor card below: the active
                  tab is the same surface as the panel, with no line between. */}
              <div
                role="tablist"
                aria-label={t("Sports")}
                className="flex flex-wrap items-end gap-1"
              >
                {selected.map((s) => {
                  const count = leafLabels(s.nodes ?? []).length;
                  const isActive = activeSport?.key === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveKey(s.key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isActive
                          ? "relative z-10 -mb-px border border-border border-b-transparent bg-card text-foreground"
                          : "border border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Trophy aria-hidden="true" className="h-3.5 w-3.5" />
                      {s.name}
                      {(s.nodes ?? []).length ? (
                        <span className="font-tabular opacity-70">({count})</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {/* Active sport's category tree — the panel the tabs attach to. */}
              {activeSport ? (
                <section
                  className="flex flex-col gap-3 rounded-b-xl rounded-tr-xl border border-border bg-card p-4 shadow-sm"
                  data-testid={`sport-${activeSport.key}`}
                >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
                  <span className="font-medium">{activeSport.name}</span>
                  {activeSport.custom ? (
                    <span className="rounded bg-muted px-1.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {t("custom")}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {(activeSport.nodes ?? []).length > 0 && selected.length > 1 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCopyTargets(new Set());
                        setCopyOpen(true);
                      }}
                      aria-haspopup="dialog"
                      aria-label={t("Copy categories to other sports")}
                    >
                      <CopyIcon aria-hidden="true" className="h-4 w-4" />
                      {t("Copy to…")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => remove(activeSport.key)}
                    aria-label={t("Remove sport")}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                    {t("Remove")}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("Categories")}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground/70">
                    {t("Nest as deep as you like: age, gender, format")}
                  </span>
                </div>
                {(activeSport.nodes ?? []).length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("No categories yet. The whole sport runs as one competition.")}
                  </p>
                ) : (
                  <ul className="rounded-lg border border-border px-1 py-1.5">
                    {(activeSport.nodes ?? []).map((n, i) =>
                      renderNode(activeSport, n, [i]),
                    )}
                  </ul>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() =>
                    setAddTarget({
                      sportKey: activeSport.key,
                      path: [],
                      label: activeSport.name,
                    })
                  }
                  aria-haspopup="dialog"
                  aria-label={t(`Add a category to ${activeSport.name}`)}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  {t("Add category")}
                </Button>
              </div>
            </section>
              ) : null}
            </div>

          {/* Live competitions preview — updates in real time as you add
              categories; grouped by top-level category so it stays scannable. */}
          <aside className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:w-80 lg:shrink-0 lg:overflow-y-auto">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                {t("Competitions")}
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-tabular text-xs text-primary">
                  {activeLeaves.length}
                </span>
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("Each gets its own entries and fixtures.")}
              </p>
            </div>
            {activeLeaves.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-xs text-muted-foreground">
                {t("Add categories on the left to see competitions here.")}
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {activeLeafGroups.map(({ head, subs }) =>
                  subs.length === 0 ? (
                    <li
                      key={head}
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs"
                    >
                      <Trophy
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                      />
                      <span className="truncate font-medium">{head}</span>
                    </li>
                  ) : (
                    <li key={head} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                          {head}
                        </span>
                        <span className="rounded-full bg-muted px-1.5 font-tabular text-[0.625rem] text-muted-foreground">
                          {subs.length}
                        </span>
                      </div>
                      <ul className="flex flex-col gap-1 border-l-2 border-border pl-2.5">
                        {subs.map((rest, i) => (
                          <li
                            key={i}
                            className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs"
                          >
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
                            />
                            <span className="truncate">{rest}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ),
                )}
              </ul>
            )}
          </aside>
          </div>

          {/* Per-sport progression (owner 2026-06-10): walk every sport
              before anything generates · no skipping straight to the form
              while other sports sit unconfigured. */}
          {(() => {
            const idx = selected.findIndex((s) => s.key === activeSport?.key);
            const nextSport = idx >= 0 ? selected[idx + 1] : undefined;
            return (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("pick")}
                >
                  <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                  {t("Back to choosing sports")}
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  {nextSport ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setStep("review")}
                      >
                        {t("Skip to review")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => setActiveKey(nextSport.key)}
                      >
                        {t("Next sport")}: {nextSport.name}
                        <ArrowRight aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <Button type="button" onClick={() => setStep("review")}>
                      {t("Review competitions")}
                      <ArrowRight aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}
        </>
      ) : (
        <>
          {/* Review — folder-tabbed by sport, mirroring the Categories step:
              the active sport's tab is the same surface as the panel below. */}
          <div>
            <div
              role="tablist"
              aria-label={t("Sports")}
              className="flex flex-wrap items-end gap-1"
            >
              {selected.map((s) => {
                const count = leafLabels(s.nodes ?? []).length;
                const isActive = activeSport?.key === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveKey(s.key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "relative z-10 -mb-px border border-border border-b-transparent bg-card text-foreground"
                        : "border border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Trophy aria-hidden="true" className="h-3.5 w-3.5" />
                    {s.name}
                    {(s.nodes ?? []).length ? (
                      <span className="font-tabular opacity-70">({count})</span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {activeSport
              ? (() => {
                  const paths = leafPaths(activeSport.nodes ?? []);
                  return (
                    <section
                      className="flex flex-col gap-3 rounded-b-xl rounded-tr-xl border border-border bg-card p-4 shadow-sm"
                      data-testid={`review-${activeSport.key}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm text-muted-foreground">
                          {paths.length
                            ? `${paths.length} ${paths.length === 1 ? t("competition") : t("competitions")}`
                            : t("No categories yet")}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActiveKey(activeSport.key);
                            setStep("configure");
                          }}
                        >
                          <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                          {t("Edit")}
                        </Button>
                      </div>
                      {paths.length ? (
                        // Top-down org chart: the sport is the root heading,
                        // categories branch beneath it, competitions are leaves.
                        <div className="overflow-x-auto pb-2">
                          <div className="orgtree">
                            <ul>
                              <li>
                                <div className="inline-flex flex-col items-center rounded-xl border border-primary/40 bg-primary/5 px-4 py-2 text-center shadow-sm">
                                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                                    <Trophy
                                      aria-hidden="true"
                                      className="h-4 w-4 shrink-0 text-primary"
                                    />
                                    <span className="whitespace-nowrap">
                                      {activeSport.name}
                                    </span>
                                  </span>
                                  <span className="mt-0.5 font-tabular text-[0.6875rem] text-muted-foreground">
                                    {paths.length}{" "}
                                    {paths.length === 1
                                      ? t("competition")
                                      : t("competitions")}
                                  </span>
                                </div>
                                <ul>
                                  {(activeSport.nodes ?? []).map((n, i) =>
                                    renderOrgNode(n, [i]),
                                  )}
                                </ul>
                              </li>
                            </ul>
                          </div>
                        </div>
                      ) : (
                        <p className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs">
                          {t("No categories. The whole sport runs as one competition. Add age groups or formats via Edit.")}
                        </p>
                      )}
                    </section>
                  );
                })()
              : null}
          </div>

          {/* Footer — context + nav: a proper Back button (same as the other
              steps) on the left, the generate CTA on the right. */}
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">
                {orgForm
                  ? t("Continue to institute registration")
                  : t("Generate form & start registration")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {orgForm?.stale
                  ? t("Your category changes aren't in the form yet. Continuing refreshes it.")
                  : t("Builds the form and opens institute registration. You can edit it first.")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("configure")}
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                {t("Back to categories")}
              </Button>
              <Button
                type="button"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
                data-testid="generate-institution-form"
                className="shrink-0"
              >
                <FileText aria-hidden="true" className="h-4 w-4" />
                {generate.isPending
                  ? t("Setting up…")
                  : orgForm
                    ? t("Continue to registration")
                    : t("Generate & start registration")}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Copy-categories modal — apply one sport's tree to all/selected. */}
      <Dialog
        open={copyOpen}
        onOpenChange={(o) => {
          if (!o) setCopyOpen(false);
        }}
        ariaLabel={t("Copy categories to other sports")}
      >
        {activeSport ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("Copy")} {activeSport.name} {t("categories to…")}
              </DialogTitle>
              <DialogDescription>
                {t("Replaces the picked sports' current categories with this tree.")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 border-b border-border pb-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={
                    copyTargets.size === selected.length - 1 &&
                    selected.length > 1
                  }
                  onChange={(e) =>
                    setCopyTargets(
                      e.target.checked
                        ? new Set(
                            selected
                              .filter((s) => s.key !== activeSport.key)
                              .map((s) => s.key),
                          )
                        : new Set(),
                    )
                  }
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                />
                {t("All other sports")}
              </label>
              {selected
                .filter((s) => s.key !== activeSport.key)
                .map((s) => {
                  const existing = leafLabels(s.nodes ?? []).length;
                  return (
                    <label
                      key={s.key}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={copyTargets.has(s.key)}
                        onChange={(e) =>
                          setCopyTargets((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(s.key);
                            else next.delete(s.key);
                            return next;
                          })
                        }
                        className="h-4 w-4 accent-[hsl(var(--primary))]"
                      />
                      <span className="flex-1">{s.name}</span>
                      {existing > 0 ? (
                        <span className="text-xs text-warning-foreground">
                          {existing} {t("will be replaced")}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCopyOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button
                disabled={copyTargets.size === 0}
                onClick={applyCopy}
                data-testid="apply-copy-categories"
              >
                <CopyIcon aria-hidden="true" className="h-4 w-4" />
                {t("Apply")}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>

      {/* Add-category modal — name, type and team size together. */}
      <Dialog
        open={addTarget !== null}
        onOpenChange={(o) => {
          if (!o) setAddTarget(null);
        }}
        ariaLabel={t("Add category")}
      >
        {addTarget ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {addTarget.path.length === 0
                  ? `${t("Add a category to")} ${addTarget.label}`
                  : `${t("Add a level under")} ${addTarget.label}`}
              </DialogTitle>
              <DialogDescription>
                {t("Name it and choose a type.")}
              </DialogDescription>
            </DialogHeader>
            <AddNodeForm
              onAdd={(n) => addNode(addTarget.sportKey, addTarget.path, n)}
              onCancel={() => setAddTarget(null)}
            />
          </>
        ) : null}
      </Dialog>

      {/* Edit modal for an existing category — name, type & team size. */}
      <Dialog
        open={kindTarget !== null}
        onOpenChange={(o) => {
          if (!o) setKindTarget(null);
        }}
        ariaLabel={t("Edit category")}
      >
        {kindTarget && kindNode ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("Edit category")} · {kindNode.name}
              </DialogTitle>
              <DialogDescription>
                {t("Rename it or change its type.")}
              </DialogDescription>
            </DialogHeader>
            <NodeKindEditor
              node={kindNode}
              onPatch={(patch) => {
                patchNode(kindTarget.sportKey, kindTarget.path, patch);
                // Picking a plain type is the whole job — close right away
                // (owner 2026-06-10: the panel lingering read as "it didn't
                // do anything"). Formats and age groups stay open for their
                // numbers (team size / age rule).
                if (
                  patch.kind !== undefined &&
                  patch.kind !== "format" &&
                  patch.kind !== "age_group"
                ) {
                  setKindTarget(null);
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-4">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  removeNode(kindTarget.sportKey, kindTarget.path);
                  setKindTarget(null);
                }}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                {t("Delete")}
              </Button>
              <Button type="button" size="sm" onClick={() => setKindTarget(null)}>
                {t("Done")}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
