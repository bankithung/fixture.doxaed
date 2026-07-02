import { ChevronRight, Search } from "lucide-react";
import type { DirectoryFilter } from "@/api/forms";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The directory-style filter rail content (search → hierarchical competition
 * tree → per-question selects). Shared by the PUBLIC directory page and the
 * admin Institutions tab so both surfaces filter the same way.
 */

export interface CompNode {
  key: string;
  label: string;
  count: number;
  children: CompNode[];
}

export function buildCompTree(
  comps: { leaf_key: string; label: string; count: number }[],
): CompNode[] {
  const roots: CompNode[] = [];
  const index = new Map<string, CompNode>();
  for (const c of comps) {
    const segs = c.leaf_key.split(".");
    const labels = c.label.split(/\s+[\u00b7\u2014]\s+/);
    let path = "";
    let siblings = roots;
    for (let i = 0; i < segs.length; i += 1) {
      path = path ? `${path}.${segs[i]}` : segs[i];
      let node = index.get(path);
      if (!node) {
        node = {
          key: path,
          label: labels[Math.min(i, labels.length - 1)] ?? segs[i],
          count: 0,
          children: [],
        };
        index.set(path, node);
        siblings.push(node);
      }
      node.count += c.count;
      siblings = node.children;
    }
  }
  return roots;
}

/** True when the leaf set has any entry at or under the prefix. */
export function matchesCompPrefix(
  leaves: { leaf_key: string }[],
  prefix: string,
): boolean {
  return leaves.some(
    (c) => c.leaf_key === prefix || c.leaf_key.startsWith(`${prefix}.`),
  );
}

/** The deepest competition leaf keys under a node (the node itself when it has
 *  no children). Selection is tracked in terms of these real leaves, so a parent
 *  is "checked" exactly when every leaf beneath it is selected. */
export function compLeafKeys(node: CompNode): string[] {
  return node.children.length ? node.children.flatMap(compLeafKeys) : [node.key];
}

/** Every branch (has-children) key in a subtree, including the node itself —
 *  the set to expand so ticking a parent reveals all its sub-options at once. */
function compBranchKeys(node: CompNode): string[] {
  if (!node.children.length) return [];
  return [node.key, ...node.children.flatMap(compBranchKeys)];
}

export function CompTreeRow({
  node,
  depth,
  selected,
  onToggle,
  expanded,
  onExpand,
}: {
  node: CompNode;
  depth: number;
  selected: Set<string>;
  onToggle: (key: string, on: boolean) => void;
  expanded: Set<string>;
  onExpand: (key: string, open: boolean) => void;
}): React.ReactElement {
  // Branches start COLLAPSED (Amazon-style) so a big catalog stays a short
  // list of sports; the chevron drills in level by level.
  const hasKids = node.children.length > 0;
  const isOpen = expanded.has(node.key);
  // Hierarchical (tristate) selection: ticking a parent ticks every leaf under
  // it; unticking any leaf drops the parent to "indeterminate" while its other
  // leaves stay selected. We toggle the real leaves so filtering stays a plain
  // union of leaf keys.
  const leaves = compLeafKeys(node);
  const selectedLeaves = leaves.reduce(
    (n, l) => n + (selected.has(l) ? 1 : 0),
    0,
  );
  const checked = selectedLeaves > 0 && selectedLeaves === leaves.length;
  const indeterminate = selectedLeaves > 0 && !checked;
  const toggleSelf = (): void => {
    const next = !checked; // empty/indeterminate → select all; full → clear all
    leaves.forEach((l) => onToggle(l, next));
    // Selecting a branch opens it (and every level beneath) so the just-picked
    // leaves are visible to review or untick — no manual drill-in needed.
    if (next && hasKids) compBranchKeys(node).forEach((k) => onExpand(k, true));
  };
  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5 text-sm"
        style={{ paddingLeft: depth * 12 }}
      >
        {hasKids ? (
          <button
            type="button"
            aria-label={
              isOpen ? t(`Collapse ${node.label}`) : t(`Expand ${node.label}`)
            }
            aria-expanded={isOpen}
            onClick={() => onExpand(node.key, !isOpen)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                isOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={checked}
            ref={(el) => {
              if (el) el.indeterminate = indeterminate;
            }}
            onChange={toggleSelf}
            className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              depth === 0 ? "font-medium" : "text-muted-foreground",
            )}
            title={node.label}
          >
            {node.label}
          </span>
          <span className="shrink-0 font-tabular text-xs text-muted-foreground/70">
            {node.count}
          </span>
        </label>
      </div>
      {isOpen
        ? node.children.map((c) => (
            <CompTreeRow
              key={c.key}
              node={c}
              depth={depth + 1}
              selected={selected}
              onToggle={onToggle}
              expanded={expanded}
              onExpand={onExpand}
            />
          ))
        : null}
    </>
  );
}

/**
 * The one set of filter controls (search → competition tree → per-question
 * selects). Render it inside a rail card or a mobile bottom-sheet — both
 * surfaces stay in sync because the state lives in the caller.
 */
export function FilterPanel({
  search,
  onSearch,
  compTree,
  compSel,
  onToggleComp,
  expanded,
  onExpand,
  filters,
  values,
  onValue,
}: {
  search: string;
  onSearch: (v: string) => void;
  compTree: CompNode[];
  compSel: Set<string>;
  onToggleComp: (key: string, on: boolean) => void;
  expanded: Set<string>;
  onExpand: (key: string, open: boolean) => void;
  filters: DirectoryFilter[];
  values: Record<string, string>;
  onValue: (key: string, v: string) => void;
}): React.ReactElement {
  return (
    <>
      <label className="relative block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("Search name or region…")}
          className="h-9 pl-9"
          aria-label={t("Search")}
        />
      </label>

      {compTree.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border pt-3">
          <button
            type="button"
            aria-expanded={!expanded.has("__comp_closed")}
            onClick={() => onExpand("__comp_closed", !expanded.has("__comp_closed"))}
            className="mb-1.5 flex items-center justify-between text-left text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
          >
            {t("Competitions")}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                !expanded.has("__comp_closed") && "rotate-90",
              )}
            />
          </button>
          {!expanded.has("__comp_closed")
            ? compTree.map((n) => (
                <CompTreeRow
                  key={n.key}
                  node={n}
                  depth={0}
                  selected={compSel}
                  onToggle={onToggleComp}
                  expanded={expanded}
                  onExpand={onExpand}
                />
              ))
            : null}
        </div>
      ) : null}

      {filters.map((f) => (
        <label
          key={f.key}
          className="flex flex-col gap-1 border-t border-border pt-3"
        >
          <span
            className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            title={f.label}
          >
            {f.label}
          </span>
          <Select
            size="sm"
            value={values[f.key] ?? ""}
            onChange={(v) => onValue(f.key, v)}
            options={[{ value: "", label: t("All") }, ...f.options]}
            aria-label={f.label}
          />
        </label>
      ))}
    </>
  );
}
