/**
 * The competition tree behind per-court reservations (spec 2026-08-16).
 *
 * `Court.competitions` holds leaf-key PREFIXES, matched segment-aligned by the
 * backend's `sports.leaf_allowed_by`: `table_tennis` reserves the whole sport,
 * `table_tennis.u_14` both genders, `table_tennis.u_14.boys` one competition.
 * The picker used to ignore that entirely and offer a flat strip of every leaf,
 * so reserving a court for "all of Sepak Takraw" meant hunting down each leaf by
 * eye — and the stored value said nothing about the intent.
 *
 * These helpers turn that flat option list into the tree the keys already
 * describe, and round-trip a selection through it:
 *
 *   stored prefixes --expandPrefixes--> leaf set --(user toggles)--> leaf set
 *                                                --compressToPrefixes--> stored
 *
 * Working in leaves internally is what makes cascading selection simple and
 * exact: a group is checked when every leaf under it is, indeterminate when only
 * some are. Compressing on the way out keeps the stored value at the altitude
 * the organiser actually chose ("all of Table Tennis", not eight rows).
 */

export interface CompNode {
  /** Full dot-joined prefix — what gets stored when this node is chosen. */
  key: string;
  /** This segment's own label ("Boys"), not the whole path. */
  label: string;
  /** 0 = sport. */
  depth: number;
  children: CompNode[];
  /** Every leaf key at or under this node. A leaf's is `[key]`. */
  leaves: string[];
}

/** True when `leaf` is covered by `prefix` — the segment-aligned rule the
 * backend uses, so `table_tennis.u_1` must NOT match `table_tennis.u_14`. */
export function coveredBy(leaf: string, prefix: string): boolean {
  return leaf === prefix || leaf.startsWith(`${prefix}.`);
}

/**
 * Build the tree from the flat `{key, label}` options. `configuredLeaves` joins
 * keys with "." and labels with " · " from the SAME walk, so segment i of one
 * names segment i of the other; a label with fewer parts than its key falls
 * back to the raw key segment rather than misaligning the rest.
 */
export function buildCompetitionTree(
  options: { key: string; label: string }[],
): CompNode[] {
  const roots: CompNode[] = [];
  for (const opt of options) {
    const keys = opt.key.split(".");
    const labels = opt.label.split(" · ");
    let level = roots;
    let path = "";
    keys.forEach((seg, i) => {
      path = i === 0 ? seg : `${path}.${seg}`;
      let node = level.find((n) => n.key === path);
      if (!node) {
        node = {
          key: path,
          label: labels[i] ?? seg,
          depth: i,
          children: [],
          leaves: [],
        };
        level.push(node);
      }
      node.leaves.push(opt.key);
      level = node.children;
    });
  }
  return roots;
}

/** Every leaf key in the tree, in display order. */
export function allLeavesOf(roots: CompNode[]): string[] {
  return roots.flatMap((r) => r.leaves);
}

/**
 * Stored prefixes -> the concrete leaves they reserve. Prefixes that match
 * nothing in the current tree are simply absent: a sport dropped from the
 * tournament should not keep holding a court.
 */
export function expandPrefixes(
  prefixes: string[],
  allLeaves: string[],
): Set<string> {
  const out = new Set<string>();
  for (const p of prefixes) {
    for (const leaf of allLeaves) if (coveredBy(leaf, p)) out.add(leaf);
  }
  return out;
}

/**
 * Leaves -> the shallowest prefixes that cover exactly them. A fully selected
 * subtree collapses to its own key, so "every Table Tennis competition" stores
 * as `table_tennis` and keeps meaning that if a category is added later.
 */
export function compressToPrefixes(
  selected: Set<string>,
  roots: CompNode[],
): string[] {
  const out: string[] = [];
  const walk = (nodes: CompNode[]): void => {
    for (const n of nodes) {
      const on = n.leaves.filter((l) => selected.has(l)).length;
      if (on === 0) continue;
      if (on === n.leaves.length) {
        out.push(n.key); // whole subtree — store the prefix, stop descending
        continue;
      }
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** How a group row renders: every leaf under it on, some, or none. */
export type NodeState = "on" | "partial" | "off";

export function nodeState(node: CompNode, selected: Set<string>): NodeState {
  const on = node.leaves.filter((l) => selected.has(l)).length;
  if (on === 0) return "off";
  return on === node.leaves.length ? "on" : "partial";
}

/** Toggle a whole node: off/partial -> select all its leaves, on -> clear them. */
export function toggleNode(node: CompNode, selected: Set<string>): Set<string> {
  const next = new Set(selected);
  if (nodeState(node, selected) === "on") {
    for (const l of node.leaves) next.delete(l);
  } else {
    for (const l of node.leaves) next.add(l);
  }
  return next;
}

/** Depth-first rows for rendering, honouring collapsed groups. */
export function flattenTree(
  roots: CompNode[],
  collapsed: ReadonlySet<string> = new Set(),
): CompNode[] {
  const out: CompNode[] = [];
  const walk = (nodes: CompNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length && !collapsed.has(n.key)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}
