import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, ShieldOff, Users } from "lucide-react";
import { permissionsApi } from "@/api/permissions";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type {
  GrantState,
  ModuleDef,
  ModuleMatrixRow,
  ModuleScope,
} from "@/types/user";
import { GrantCell } from "./GrantCell";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";
import { cn } from "@/lib/tailwind";

function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ev_${Math.random().toString(36).slice(2)}`;
}

const SCOPE_ORDER: ModuleScope[] = [
  "platform",
  "org",
  "tournament",
  "match",
];

const SCOPE_LABEL: Record<ModuleScope, string> = {
  platform: "Platform",
  org: "Org",
  tournament: "Tournament",
  match: "Match",
};

const PAGE_WRAP = "flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8";
const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";
const CARD = "rounded-xl border border-border bg-card shadow-sm";

/** Per-row pending edits keyed by user_id then module key. */
type PendingMap = Record<string, Record<string, GrantState>>;

/**
 * v1Users.md Appendix B.16 — full per-user module override matrix.
 *
 * Layout:
 *   - Sticky-header table; first column ("Member") is sticky-left.
 *   - Modules grouped by scope (platform → org → tournament → match) with
 *     a scope-band header row above the per-module headers.
 *   - Each cell is a GrantCell (3-state: default / grant / deny). The
 *     "default" tile is tinted green when the user's role would grant.
 *   - Per-row Save button, only enabled when that row has unsaved edits.
 *   - Toolbar: "Reset to defaults" clears local edits across all rows
 *     (no auto-save).
 *   - On small screens the dense table collapses to a stacked per-member
 *     card list (modules grouped by scope) so the matrix stays usable.
 *
 * State strategy:
 *   - Optimistic save: PUT for that row's full cell map; on success,
 *     clear the row's pending edits and invalidate the query (server is
 *     authoritative). On error, KEEP the row's edits and toast — the user
 *     never silently loses input.
 *   - Module-gated: 403 from the matrix endpoint shows a graceful
 *     "no access" card instead of a generic error.
 */
export function ModuleMatrixPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { isMobile } = useBreakpoint();

  const matrixQ = useQuery({
    queryKey: ["permissions", "matrix", orgSlug],
    queryFn: () => permissionsApi.matrix(orgSlug),
    enabled: Boolean(orgSlug),
    retry: (count, err) => {
      // Don't retry 403 (gating) or 404 — only transient.
      if (err instanceof ApiError && (err.status === 403 || err.status === 404))
        return false;
      return count < 2;
    },
  });

  const [edits, setEdits] = useState<PendingMap>({});

  const saveRow = useMutation({
    mutationFn: ({
      userId,
      cells,
    }: {
      userId: string;
      cells: Record<string, GrantState>;
    }) =>
      permissionsApi.setGrants(orgSlug, userId, {
        cells,
        event_id: newEventId(),
      }),
    onSuccess: (_data, vars) => {
      setEdits((cur) => {
        const next = { ...cur };
        delete next[vars.userId];
        return next;
      });
      toast.push({ kind: "success", title: t("Permissions saved") });
      qc.invalidateQueries({
        queryKey: ["permissions", "matrix", orgSlug],
      });
    },
    onError: (e) => {
      // Keep edits in state so the user can retry.
      toast.push({
        kind: "error",
        title: t("Save failed"),
        description:
          e instanceof ApiError
            ? (e.payload.detail ?? e.message)
            : t("Network error"),
      });
    },
  });

  const onCellChange = (
    row: ModuleMatrixRow,
    moduleKey: string,
    next: GrantState,
  ): void => {
    setEdits((cur) => {
      const rowEdits = { ...(cur[row.user_id] ?? {}) };
      const stored = row.cells[moduleKey] ?? "default";
      if (next === stored) {
        // Cycled back to the persisted value — drop the edit.
        delete rowEdits[moduleKey];
      } else {
        rowEdits[moduleKey] = next;
      }
      const out = { ...cur };
      if (Object.keys(rowEdits).length === 0) {
        delete out[row.user_id];
      } else {
        out[row.user_id] = rowEdits;
      }
      return out;
    });
  };

  const onSaveRow = (row: ModuleMatrixRow): void => {
    const rowEdits = edits[row.user_id];
    if (!rowEdits) return;
    const cells: Record<string, GrantState> = { ...row.cells, ...rowEdits };
    saveRow.mutate({ userId: row.user_id, cells });
  };

  const onResetAll = (): void => {
    setEdits({});
  };

  // Hooks below MUST run unconditionally, BEFORE any early-return path,
  // to keep React's rules-of-hooks happy.
  const modules: ModuleDef[] = matrixQ.data?.modules ?? [];
  const rows: ModuleMatrixRow[] = matrixQ.data?.members ?? [];
  const grouped = useMemoModulesByScope(modules);
  const orderedModules: ModuleDef[] = useMemo(
    () => grouped.flatMap((g) => g.mods),
    [grouped],
  );

  // ----- Loading state -----
  if (matrixQ.isLoading) {
    return (
      <div className={PAGE_WRAP} role="status" aria-live="polite">
        <PageHeader rows={rows} modules={modules} totalEdits={0} editedRowCount={0} />
        <div className={cn(CARD, "p-6")}>
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded-lg bg-muted"
                aria-hidden="true"
              />
            ))}
          </div>
          <span className="sr-only">{t("Loading permissions...")}</span>
        </div>
      </div>
    );
  }

  // ----- Error state -----
  if (matrixQ.error) {
    const err = matrixQ.error;
    if (err instanceof ApiError && err.status === 403) {
      return (
        <div className={PAGE_WRAP}>
          <div>
            <p className={OVERLINE}>{t("Access control")}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              {t("Permissions")}
            </h1>
          </div>
          <div className={cn(CARD, "flex flex-col items-center gap-3 p-10 text-center")}>
            <span
              aria-hidden="true"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <ShieldOff className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">{t("Access required")}</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {t(
                  "You don't have access to the module override matrix in this organisation.",
                )}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={PAGE_WRAP}>
        <div>
          <p className={OVERLINE}>{t("Access control")}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Permissions")}
          </h1>
        </div>
        <div className={cn(CARD, "flex flex-col items-center gap-3 p-10 text-center")}>
          <div>
            <h2 className="text-lg font-semibold">{t("Couldn't load permissions")}</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {err instanceof ApiError
                ? (err.payload.detail ?? err.message)
                : t("Network error")}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => matrixQ.refetch()}>
            {t("Retry")}
          </Button>
        </div>
      </div>
    );
  }

  const totalEdits = Object.values(edits).reduce(
    (n, m) => n + Object.keys(m).length,
    0,
  );
  const editedRowCount = Object.keys(edits).length;

  const rowSaving = (userId: string): boolean =>
    saveRow.isPending && saveRow.variables?.userId === userId;

  return (
    <div className={PAGE_WRAP}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <PageHeader
          rows={rows}
          modules={modules}
          totalEdits={totalEdits}
          editedRowCount={editedRowCount}
        />
        <Button
          type="button"
          variant="outline"
          onClick={onResetAll}
          disabled={totalEdits === 0}
          className="shrink-0"
          aria-label={t("Reset all unsaved edits to defaults")}
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          {t("Reset to defaults")}
        </Button>
      </div>

      <section className={cn(CARD, "overflow-hidden")} aria-label={t("Module override matrix")}>
        <div className="border-b border-border p-4 sm:p-5">
          <h2 className="text-sm font-semibold">{t("Module override matrix")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Click a cell to cycle: default → grant → deny → default. Press Save to persist a row's edits.",
            )}
          </p>
          <Legend />
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <Users aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t("No members yet.")}</p>
          </div>
        ) : isMobile ? (
          <MobileMatrix
            rows={rows}
            grouped={grouped}
            edits={edits}
            onCellChange={onCellChange}
            onSaveRow={onSaveRow}
            rowSaving={rowSaving}
          />
        ) : (
          <div className="overflow-x-auto">
            <table
              className="min-w-full border-separate border-spacing-0 text-sm"
              aria-label={t("Per-user module override matrix")}
            >
              <thead className="sticky top-0 z-20 bg-card">
                {/* Scope band */}
                <tr>
                  <th
                    rowSpan={2}
                    scope="col"
                    className="sticky left-0 z-30 border-b border-r border-border bg-card px-4 py-2.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("Member")}
                  </th>
                  {grouped.map((g) => (
                    <th
                      key={g.scope}
                      scope="colgroup"
                      colSpan={g.mods.length}
                      className="border-b border-l border-border bg-muted/50 px-2 py-1.5 text-left text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                    >
                      {t(SCOPE_LABEL[g.scope] ?? g.scope)}
                    </th>
                  ))}
                  <th
                    rowSpan={2}
                    scope="col"
                    className="sticky right-0 z-30 border-b border-l border-border bg-card px-3 py-2.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("Save")}
                  </th>
                </tr>
                {/* Module headers */}
                <tr>
                  {orderedModules.map((m) => (
                    <th
                      key={m.key}
                      scope="col"
                      title={m.description}
                      className="border-b border-border px-1.5 py-2 text-left align-bottom text-xs font-medium text-muted-foreground"
                    >
                      <div className="w-24 truncate">{m.label}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rowEdits = edits[row.user_id] ?? {};
                  const isDirty = Object.keys(rowEdits).length > 0;
                  const saving = rowSaving(row.user_id);
                  return (
                    <tr
                      key={row.user_id}
                      aria-label={row.user_email}
                      className="group transition-colors hover:bg-accent/40"
                    >
                      <th
                        scope="row"
                        className="sticky left-0 z-10 border-b border-r border-border bg-card px-4 py-2.5 text-left transition-colors group-hover:bg-accent/40"
                      >
                        <MemberCell row={row} />
                      </th>
                      {orderedModules.map((m) => {
                        const stored: GrantState =
                          row.cells[m.key] ?? "default";
                        const eff: GrantState = rowEdits[m.key] ?? stored;
                        return (
                          <td
                            key={m.key}
                            className="border-b border-border px-1 py-1 text-center"
                          >
                            <GrantCell
                              state={eff}
                              roleDefault={Boolean(row.role_defaults[m.key])}
                              moduleLabel={m.label}
                              userLabel={row.user_email}
                              onChange={(n) => onCellChange(row, m.key, n)}
                              disabled={saving}
                            />
                          </td>
                        );
                      })}
                      <td className="sticky right-0 z-10 border-b border-l border-border bg-card px-3 py-1.5 transition-colors group-hover:bg-accent/40">
                        {isDirty ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => onSaveRow(row)}
                            disabled={saving}
                            aria-label={`${t("Save row for")} ${row.user_email}`}
                          >
                            {saving ? t("Saving...") : t("Save row")}
                          </Button>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="block text-center text-xs text-muted-foreground/60"
                          >
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PageHeader({
  rows,
  modules,
  totalEdits,
  editedRowCount,
}: {
  rows: ModuleMatrixRow[];
  modules: ModuleDef[];
  totalEdits: number;
  editedRowCount: number;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className={OVERLINE}>{t("Access control")}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
        {t("Module overrides")}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t(
          "Per-user module overrides. Default cells defer to the role; toggle to grant or deny explicitly. Saves are atomic per row.",
        )}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-tabular">{rows.length}</span> {t("members")} ·{" "}
        <span className="font-tabular">{modules.length}</span> {t("modules")}
        {totalEdits > 0 ? (
          <>
            {" · "}
            <span className="font-medium text-primary">
              <span className="font-tabular">{totalEdits}</span>{" "}
              {t("unsaved edit(s)")}
              {editedRowCount > 1 ? (
                <>
                  {" ("}
                  <span className="font-tabular">{editedRowCount}</span> {t("rows")}
                  {")"}
                </>
              ) : (
                ""
              )}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function Legend(): React.ReactElement {
  const items: { cls: string; label: string }[] = [
    { cls: "bg-grant-muted border border-grant/30", label: t("Role default (grants)") },
    { cls: "bg-muted border border-border", label: t("Role default (no grant)") },
    { cls: "bg-grant border border-grant", label: t("Granted") },
    { cls: "bg-deny border border-deny", label: t("Denied") },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn("h-3 w-3 shrink-0 rounded", it.cls)}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function MobileMatrix({
  rows,
  grouped,
  edits,
  onCellChange,
  onSaveRow,
  rowSaving,
}: {
  rows: ModuleMatrixRow[];
  grouped: ScopeGroup[];
  edits: PendingMap;
  onCellChange: (row: ModuleMatrixRow, moduleKey: string, next: GrantState) => void;
  onSaveRow: (row: ModuleMatrixRow) => void;
  rowSaving: (userId: string) => boolean;
}): React.ReactElement {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => {
        const rowEdits = edits[row.user_id] ?? {};
        const isDirty = Object.keys(rowEdits).length > 0;
        const saving = rowSaving(row.user_id);
        return (
          <li key={row.user_id} aria-label={row.user_email} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <MemberCell row={row} />
              {isDirty ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSaveRow(row)}
                  disabled={saving}
                  className="shrink-0"
                  aria-label={`${t("Save row for")} ${row.user_email}`}
                >
                  {saving ? t("Saving...") : t("Save row")}
                </Button>
              ) : null}
            </div>
            <div className="mt-3 space-y-3">
              {grouped.map((g) => (
                <div key={g.scope}>
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t(SCOPE_LABEL[g.scope] ?? g.scope)}
                  </p>
                  <div className="mt-1.5 space-y-1.5">
                    {g.mods.map((m) => {
                      const stored: GrantState = row.cells[m.key] ?? "default";
                      const eff: GrantState = rowEdits[m.key] ?? stored;
                      return (
                        <div
                          key={m.key}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background px-3 py-2"
                        >
                          <span className="min-w-0 truncate text-sm" title={m.description}>
                            {m.label}
                          </span>
                          <GrantCell
                            state={eff}
                            roleDefault={Boolean(row.role_defaults[m.key])}
                            moduleLabel={m.label}
                            userLabel={row.user_email}
                            onChange={(n) => onCellChange(row, m.key, n)}
                            disabled={saving}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MemberCell({ row }: { row: ModuleMatrixRow }): React.ReactElement {
  const initials = row.user_full_name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-semibold text-muted-foreground"
      >
        {initials || "?"}
      </span>
      <div className="min-w-[10rem]">
        <div className="text-sm font-medium text-foreground">
          {row.user_full_name}
        </div>
        <div className="text-xs text-muted-foreground">{row.user_email}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {row.roles.map((r) => (
            <span
              key={r}
              className="inline-flex items-center rounded-full bg-secondary px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-secondary-foreground"
            >
              {r.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ScopeGroup {
  scope: ModuleScope;
  mods: ModuleDef[];
}

/**
 * Group modules by scope in canonical order. Modules whose scope isn't
 * in `SCOPE_ORDER` get appended at the end under their literal scope key
 * so we don't silently swallow columns when the catalog grows.
 */
function useMemoModulesByScope(modules: ModuleDef[]): ScopeGroup[] {
  return useMemo(() => {
    const buckets = new Map<ModuleScope, ModuleDef[]>();
    for (const m of modules) {
      const arr = buckets.get(m.scope) ?? [];
      arr.push(m);
      buckets.set(m.scope, arr);
    }
    const ordered: ScopeGroup[] = [];
    for (const s of SCOPE_ORDER) {
      const mods = buckets.get(s);
      if (mods && mods.length > 0) {
        ordered.push({ scope: s, mods });
        buckets.delete(s);
      }
    }
    // Any leftover scopes (forward-compat).
    for (const [scope, mods] of buckets.entries()) {
      ordered.push({ scope, mods });
    }
    return ordered;
  }, [modules]);
}
