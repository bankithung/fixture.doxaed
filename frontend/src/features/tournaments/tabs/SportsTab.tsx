import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  FileText,
  Plus,
  Search,
  SlidersHorizontal,
  Trophy,
  X,
} from "lucide-react";
import {
  tournamentsApi,
  type SportNode,
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
        // kind/format carry the team-size rules (W2-B) — round-trip them or
        // every save would wipe what the server stored.
        ...(typeof o.kind === "string" && o.kind
          ? { kind: o.kind as SportNode["kind"] }
          : {}),
        ...(o.format && typeof o.format === "object"
          ? { format: o.format as SportNode["format"] }
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
    else out.push(path.join(" — "));
  }
  return out;
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

const KIND_LABELS: Record<string, string> = {
  age_group: "Age group",
  gender: "Gender",
  format: "Format",
  level: "Level",
  custom: "Custom",
};

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

  const detected = detectPerSide(name);
  const effectiveKind = kind || (detected != null ? "format" : "");
  const showSize = effectiveKind === "format";
  const ppsValue = pps !== "" ? Number(pps) : detected;

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
            placeholder={t("e.g. U-14, Girls, 5v5, Doubles")}
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
            {t("Teams register exactly this squad; raise Squad max to allow substitutes.")}
          </p>
        </div>
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
 * Inline node "type & team size" editor (W2-B). Numbers commit on blur so the
 * auto-saving PUT doesn't fire per keystroke. A "format" node's team-size
 * rules become the generated team form's roster bounds (1v1 → exactly 1
 * player; widen squad max for substitutes).
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
  return (
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
                aria-label={`${label} — ${node.name}`}
              />
            </div>
          ))}
        </>
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
  const [showSettings, setShowSettings] = useState(false);
  // Two-step sub-flow: pick sports → configure each one (focused, via tabs).
  const [step, setStep] = useState<"pick" | "configure">("pick");
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
        title: t("Registration is set up — review and open it"),
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

  const stepChip = (active: boolean): string =>
    cn(
      "rounded-full px-2 py-0.5",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
    );

  /** One node row + its children, recursively. */
  const renderNode = (
    sport: TournamentSport,
    node: SportNode,
    path: number[],
    depth: number,
  ): React.ReactElement => {
    return (
      <li key={node.key ?? `${path.join(".")}-${node.name}`} className="min-w-0">
        <div className="group flex items-center gap-1.5 rounded-md py-1 pl-2 pr-1 hover:bg-accent/60">
          {depth > 0 ? (
            <CornerDownRight
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              node.children?.length ? "font-medium" : "",
            )}
            title={node.name}
          >
            {node.name}
          </span>
          {node.kind ? (
            <span className="rounded bg-muted px-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
              {t(KIND_LABELS[node.kind] ?? node.kind)}
            </span>
          ) : null}
          {!node.children?.length ? (
            <span className="rounded bg-primary/10 px-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary">
              {t("competition")}
            </span>
          ) : null}
          {node.format?.players_per_side ? (
            <span className="rounded bg-secondary px-1.5 font-tabular text-[0.625rem] font-medium text-secondary-foreground">
              {node.format.players_per_side}{t("-a-side")}
              {node.format.squad_max &&
              node.format.squad_max !== node.format.players_per_side
                ? ` · ${t("squad")} ${node.format.squad_min ?? node.format.players_per_side}–${node.format.squad_max}`
                : ""}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => setKindTarget({ sportKey: sport.key, path })}
              aria-label={t(`Category type and team size for ${node.name}`)}
              aria-haspopup="dialog"
              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SlidersHorizontal aria-hidden="true" className="h-3 w-3" />
              {t("type")}
            </button>
            <button
              type="button"
              onClick={() =>
                setAddTarget({ sportKey: sport.key, path, label: node.name })
              }
              aria-label={t(`Add a level under ${node.name}`)}
              aria-haspopup="dialog"
              className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus aria-hidden="true" className="h-3 w-3" />
              {t("level")}
            </button>
            <button
              type="button"
              onClick={() => removeNode(sport.key, path)}
              aria-label={t(`Remove ${node.name}`)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        {node.children?.length ? (
          <ul className="ml-3 border-l border-border pl-2">
            {(node.children ?? []).map((c, i) =>
              renderNode(sport, c, [...path, i], depth + 1),
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
      {/* Header + step indicator */}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{t("Sports")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {effectiveStep === "pick"
            ? t("Pick the sport(s) this tournament runs — you'll set up each one's categories next.")
            : t("Build each sport's category tree. Every last level is one competition with its own entries and fixtures.")}
        </p>
        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
          <span className={stepChip(effectiveStep === "pick")}>
            1 · {t("Choose sports")}
          </span>
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground/40" />
          <span className={stepChip(effectiveStep === "configure")}>
            2 · {t("Categories")}
          </span>
        </div>
      </div>

      {effectiveStep === "pick" ? (
        <>
          {/* Selected — compact chips (no per-sport detail here). */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              {t("Selected")}{" "}
              <span className="font-tabular text-muted-foreground">
                ({selected.length})
              </span>
            </h3>
            {selected.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t("No sports yet. Add at least one below.")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {selected.map((s) => {
                  const leaves = leafLabels(s.nodes ?? []).length;
                  return (
                    <li
                      key={s.key}
                      data-testid={`sport-${s.key}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-3 pr-1.5 text-sm shadow-sm"
                    >
                      <Trophy aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                      <span className="font-medium">{s.name}</span>
                      {(s.nodes ?? []).length ? (
                        <span className="font-tabular text-xs text-muted-foreground">
                          · {leaves} {t("comp")}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => remove(s.key)}
                        aria-label={t(`Remove ${s.name}`)}
                        className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Add from catalog / custom */}
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <h3 className="text-sm font-semibold">{t("Add a sport")}</h3>
            <label className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("Search sports (e.g. football, sepak takraw)…")}
                className="h-9 pl-9"
                aria-label={t("Search sports")}
              />
            </label>

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

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {matches.map((c) => {
                const added = isAdded(c.code);
                return (
                  <button
                    key={c.code}
                    type="button"
                    aria-pressed={added}
                    onClick={() =>
                      added
                        ? remove(slugKey(c.code))
                        : add({ key: slugKey(c.code), name: c.name, custom: false })
                    }
                    title={added ? t("Added — click to remove") : t("Add sport")}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      added
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-background hover:border-primary/40 hover:bg-accent",
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
                {t("Start typing to find a sport, or type a custom name.")}
              </p>
            ) : null}
          </section>

          {selected.length > 0 ? (
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setActiveKey(selected[0].key);
                  setStep("configure");
                }}
              >
                {t("Next: set up categories")}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setStep("pick")}
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Back to choosing sports")}
          </button>

          {/* Sport tabs — configure one sport at a time. */}
          <div role="tablist" aria-label={t("Sports")} className="flex flex-wrap gap-2">
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
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
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

          {/* Active sport's category tree (recursive, any depth). */}
          {activeSport ? (
            <section
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
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
                <button
                  type="button"
                  onClick={() => remove(activeSport.key)}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                >
                  {t("Remove sport")}
                </button>
              </div>

              <div className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("Categories")}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground/70">
                    {t("nest levels as deep as you need — age, gender, format")}
                  </span>
                </div>
                {(activeSport.nodes ?? []).length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("No categories yet — the whole sport is one competition. Add levels below (e.g. U-15 → Girls → 5v5).")}
                  </p>
                ) : (
                  <ul className="rounded-lg border border-border px-1 py-1.5">
                    {(activeSport.nodes ?? []).map((n, i) =>
                      renderNode(activeSport, n, [i], 0),
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

                {/* Competitions preview — what registration + fixtures will see. */}
                {activeLeaves.length > 0 ? (
                  <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("Competitions")}{" "}
                      <span className="font-tabular">({activeLeaves.length})</span>
                      <span className="ml-1 font-normal text-muted-foreground/70">
                        {t("— each gets its own entries and fixtures")}
                      </span>
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {activeLeaves.map((label) => (
                        <span
                          key={label}
                          className="rounded-full bg-muted px-2.5 py-0.5 text-xs"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Match settings — feeds the scheduler (duration, venue type). */}
              <div className="border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => setShowSettings((v) => !v)}
                  aria-expanded={showSettings}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Match settings")}
                  <span className="font-normal text-muted-foreground/70">
                    {activeSport.scheduling?.duration_minutes
                      ? t(`${activeSport.scheduling.duration_minutes} min / match`)
                      : t("(defaults from the sport profile)")}
                  </span>
                </button>
                {showSettings ? (
                  <div className="mt-2.5 grid max-w-md grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                      {t("Match duration (minutes)")}
                      <Input
                        inputMode="numeric"
                        defaultValue={activeSport.scheduling?.duration_minutes ?? ""}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          updateSport(activeSport.key, {
                            scheduling: {
                              ...(activeSport.scheduling ?? {}),
                              duration_minutes:
                                Number.isFinite(v) && v > 0 ? v : undefined,
                            },
                          });
                        }}
                        placeholder={t("e.g. 90")}
                        className="h-8 font-tabular"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                      {t("Venue type")}
                      <Input
                        defaultValue={activeSport.scheduling?.venue_type ?? ""}
                        onBlur={(e) =>
                          updateSport(activeSport.key, {
                            scheduling: {
                              ...(activeSport.scheduling ?? {}),
                              venue_type: e.target.value.trim() || undefined,
                            },
                          })
                        }
                        placeholder={t("e.g. ground, indoor_court")}
                        className="h-8"
                      />
                    </label>
                    <p className="col-span-2 text-[0.6875rem] leading-relaxed text-muted-foreground/80">
                      {t("Fixtures only land on venues of a matching type, and the calendar reserves this much time per match. Leave blank to use the sport's standard values.")}
                    </p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Generate the form AND move into the institute-registration stage. */}
          <section className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">
                {orgForm
                  ? t("Continue to institute registration")
                  : t("Generate form & start registration")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {orgForm?.stale
                  ? t("Your category changes haven't reached the registration form yet — continuing refreshes it automatically.")
                  : t("Builds the registration form from these sports + categories and moves the tournament into the institute-registration stage. You can review and edit it before opening.")}
              </p>
            </div>
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
          </section>
        </>
      )}

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
                {t("Name it, say what it is, and — for formats like 5v5 — set the team size. Every last level becomes one competition.")}
              </DialogDescription>
            </DialogHeader>
            <AddNodeForm
              onAdd={(n) => addNode(addTarget.sportKey, addTarget.path, n)}
              onCancel={() => setAddTarget(null)}
            />
          </>
        ) : null}
      </Dialog>

      {/* Type & team-size modal for an existing category. */}
      <Dialog
        open={kindTarget !== null}
        onOpenChange={(o) => {
          if (!o) setKindTarget(null);
        }}
        ariaLabel={t("Category type and team size")}
      >
        {kindTarget && kindNode ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("Category type")} — {kindNode.name}
              </DialogTitle>
              <DialogDescription>
                {t("Formats (1v1, 5v5…) carry a team size that the registration form enforces.")}
              </DialogDescription>
            </DialogHeader>
            <NodeKindEditor
              node={kindNode}
              onPatch={(patch) => {
                patchNode(kindTarget.sportKey, kindTarget.path, patch);
                // Picking a non-format type is the whole job — close right
                // away (owner 2026-06-10: the panel lingering read as "it
                // didn't do anything"). Formats stay open for the sizes.
                if (patch.kind !== undefined && patch.kind !== "format") {
                  setKindTarget(null);
                }
              }}
            />
            <div className="flex justify-end">
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
