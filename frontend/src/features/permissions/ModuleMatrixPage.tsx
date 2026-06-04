import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { permissionsApi } from "@/api/permissions";
import { ApiError } from "@/types/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type {
  GrantState,
  ModuleDef,
  ModuleMatrixRow,
  ModuleScope,
} from "@/types/user";
import { GrantCell } from "./GrantCell";
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
      <div className="flex flex-col gap-4 p-6" role="status" aria-live="polite">
        <div className="text-2xl font-semibold">{t("Permissions")}</div>
        <Card>
          <CardContent className="space-y-2 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded bg-muted"
                aria-hidden="true"
              />
            ))}
            <span className="sr-only">{t("Loading permissions...")}</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ----- Error state -----
  if (matrixQ.error) {
    const err = matrixQ.error;
    if (err instanceof ApiError && err.status === 403) {
      return (
        <div className="flex flex-col gap-4 p-6">
          <h1 className="text-2xl font-semibold">{t("Permissions")}</h1>
          <Card>
            <CardHeader>
              <CardTitle>{t("Access required")}</CardTitle>
              <CardDescription>
                {t(
                  "You don't have access to the module override matrix in this organisation.",
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">{t("Permissions")}</h1>
        <Card>
          <CardHeader>
            <CardTitle>{t("Couldn't load permissions")}</CardTitle>
            <CardDescription>
              {err instanceof ApiError
                ? (err.payload.detail ?? err.message)
                : t("Network error")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <button
              type="button"
              onClick={() => matrixQ.refetch()}
              className="rounded border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            >
              {t("Retry")}
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalEdits = Object.values(edits).reduce(
    (n, m) => n + Object.keys(m).length,
    0,
  );
  const editedRowCount = Object.keys(edits).length;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("Module overrides")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Per-user module overrides. Default cells defer to the role; toggle to grant or deny explicitly. Saves are atomic per row.",
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rows.length} {t("members")} · {modules.length} {t("modules")}
            {totalEdits > 0 ? (
              <>
                {" · "}
                <span className="text-primary">
                  {totalEdits} {t("unsaved edit(s)")}
                  {editedRowCount > 1 ? ` (${editedRowCount} rows)` : ""}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onResetAll}
            disabled={totalEdits === 0}
            className={cn(
              "rounded border px-3 py-1.5 text-xs",
              totalEdits === 0
                ? "border-border text-muted-foreground"
                : "border-border bg-card hover:bg-muted",
            )}
            aria-label={t("Reset all unsaved edits to defaults")}
          >
            {t("Reset to defaults")}
          </button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Module override matrix")}</CardTitle>
          <CardDescription>
            {t(
              "Click a cell to cycle: default → grant → deny → default. Press Save to persist a row's edits.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {rows.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              {t("No members yet.")}
            </div>
          ) : (
            <table
              className="min-w-full border-separate border-spacing-0 text-xs"
              aria-label={t("Per-user module override matrix")}
            >
              <thead className="sticky top-0 z-20 bg-card">
                {/* Scope band */}
                <tr>
                  <th
                    rowSpan={2}
                    scope="col"
                    className="sticky left-0 z-30 border-b border-r bg-card p-2 text-left"
                  >
                    {t("Member")}
                  </th>
                  {grouped.map((g) => (
                    <th
                      key={g.scope}
                      scope="colgroup"
                      colSpan={g.mods.length}
                      className="border-b border-l bg-muted/40 p-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {t(SCOPE_LABEL[g.scope] ?? g.scope)}
                    </th>
                  ))}
                  <th
                    rowSpan={2}
                    scope="col"
                    className="sticky right-0 z-30 border-b border-l bg-card p-2"
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
                      className="border-b p-1 text-left align-bottom font-medium"
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
                  return (
                    <tr key={row.user_id} aria-label={row.user_email}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 border-b border-r bg-card p-2 text-left"
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
                            className="border-b p-0.5 text-center"
                          >
                            <GrantCell
                              state={eff}
                              roleDefault={Boolean(row.role_defaults[m.key])}
                              moduleLabel={m.label}
                              userLabel={row.user_email}
                              onChange={(n) => onCellChange(row, m.key, n)}
                              disabled={
                                saveRow.isPending &&
                                saveRow.variables?.userId === row.user_id
                              }
                            />
                          </td>
                        );
                      })}
                      <td className="sticky right-0 border-b border-l bg-card p-1">
                        {isDirty ? (
                          <button
                            type="button"
                            onClick={() => onSaveRow(row)}
                            disabled={
                              saveRow.isPending &&
                              saveRow.variables?.userId === row.user_id
                            }
                            className="rounded border border-primary bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                            aria-label={`${t("Save row for")} ${row.user_email}`}
                          >
                            {saveRow.isPending &&
                            saveRow.variables?.userId === row.user_id
                              ? t("Saving...")
                              : t("Save row")}
                          </button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
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
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
      >
        {initials || "?"}
      </span>
      <div className="min-w-[10rem]">
        <div className="font-medium">{row.user_full_name}</div>
        <div className="text-[10px] text-muted-foreground">
          {row.user_email}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {row.roles.map((r) => (
            <span
              key={r}
              className="rounded border border-border bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
            >
              {r}
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
