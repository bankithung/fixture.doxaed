import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  allLeavesOf,
  buildCompetitionTree,
  compressToPrefixes,
  expandPrefixes,
  flattenTree,
  nodeState,
  toggleNode,
  type CompNode,
  type NodeState,
} from "./courtCompetitions";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** A checkbox that can also say "some of this group" (owner: selecting a sport
 * must select everything under it, and the row has to show that honestly). */
function TriCheckbox({
  state,
  onToggle,
  label,
  testId,
}: {
  state: NodeState;
  onToggle: () => void;
  label: string;
  testId?: string;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // `indeterminate` is a property, never an attribute — React cannot set it.
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "on"}
      onChange={onToggle}
      aria-label={label}
      data-testid={testId}
      data-state={state}
      className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
    />
  );
}

/**
 * Per-court reservations as a grid: the competition tree down the side, one
 * column per court, a checkbox where they meet.
 *
 * It replaced a flat strip that repeated every leaf for every court — ten
 * identical chips per court, three courts, no grouping — which made "reserve
 * this court for Sepak Takraw" a hunting exercise and buried which court was
 * actually dedicated to what. Checking a group checks everything beneath it,
 * and the value is stored at that altitude (`sepak_takraw`, not two leaves),
 * which is exactly what `Court.competitions` prefixes already meant.
 */
export function CourtCompetitionTable({
  options,
  count,
  courts,
  onChange,
  onExclusive,
  venueName,
  testIdPrefix,
}: {
  options: { key: string; label: string }[];
  /** How many courts this venue runs. */
  count: number;
  courts: { index: number; competitions: string[]; exclusive?: boolean }[];
  onChange: (courtIndex: number, competitions: string[]) => void;
  /** Flip a court between a LOCK and a preference (owner 2026-08-17). */
  onExclusive?: (courtIndex: number, exclusive: boolean) => void;
  venueName: string;
  testIdPrefix: string;
}): React.ReactElement {
  const tree = useMemo(() => buildCompetitionTree(options), [options]);
  const allLeaves = useMemo(() => allLeavesOf(tree), [tree]);
  // Sports start open — the grouping is the point, so show it — but a long
  // tree can be folded back to its sports.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  const indices = Array.from({ length: Math.max(1, count) }, (_, i) => i + 1);
  const selectedFor = (idx: number): Set<string> =>
    expandPrefixes(
      courts.find((c) => c.index === idx)?.competitions ?? [],
      allLeaves,
    );
  const courtLabel = (idx: number): string =>
    count <= 1 ? venueName || t("Court") : `${t("Court")} ${idx}`;

  const toggle = (idx: number, node: CompNode): void => {
    const next = toggleNode(node, selectedFor(idx));
    onChange(idx, compressToPrefixes(next, tree));
  };

  return (
    <div className="flex w-full flex-col gap-1.5 border-t border-border/60 pt-2">
      <span className="text-xs font-medium">
        {t("Per-court categories")}
        <span className="ml-1 font-normal text-muted-foreground">
          {t("(leave a court empty and it takes anything)")}
        </span>
      </span>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-muted/40 px-2.5 py-1.5 text-left font-medium"
              >
                {t("Competition")}
              </th>
              {indices.map((idx) => {
                const n = selectedFor(idx).size;
                return (
                  <th
                    key={idx}
                    scope="col"
                    className="whitespace-nowrap px-2.5 py-1.5 text-center font-medium"
                  >
                    <span className="block">{courtLabel(idx)}</span>
                    <span
                      className={cn(
                        "block text-[0.625rem] font-normal",
                        n === 0 ? "text-muted-foreground" : "text-primary",
                      )}
                    >
                      {n === 0
                        ? t("Any")
                        : `${n} ${n === 1 ? t("competition") : t("competitions")}`}
                    </span>
                    {/* Only meaningful once the court IS reserved: an
                        unrestricted court already takes anything. */}
                    {n > 0 && onExclusive ? (
                      <button
                        type="button"
                        data-testid={`court-exclusive-${idx}`}
                        aria-pressed={
                          courts.find((c) => c.index === idx)?.exclusive !== false
                        }
                        onClick={() =>
                          onExclusive(
                            idx,
                            courts.find((c) => c.index === idx)?.exclusive === false,
                          )
                        }
                        title={t(
                          "Only these: nothing else may use this court. Prefer these: its own competitions come first, but a waiting match may use it rather than leave it empty.",
                        )}
                        className={cn(
                          "mt-1 block w-full rounded border px-1 py-0.5 text-[0.625rem] font-medium transition-colors",
                          courts.find((c) => c.index === idx)?.exclusive === false
                            ? "border-info/40 bg-info-muted text-info"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {courts.find((c) => c.index === idx)?.exclusive === false
                          ? t("Prefer these")
                          : t("Only these")}
                      </button>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => {
              const isGroup = node.children.length > 0;
              const isOpen = !collapsed.has(node.key);
              return (
                <tr
                  key={node.key}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    node.depth === 0 && "bg-muted/20",
                  )}
                >
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-card px-2.5 py-1 text-left font-normal"
                  >
                    <span
                      className="flex items-center gap-1"
                      style={{ paddingLeft: `${node.depth * 0.875}rem` }}
                    >
                      {isGroup ? (
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={
                            isOpen
                              ? t(`Collapse ${node.label}`)
                              : t(`Expand ${node.label}`)
                          }
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(node.key)) next.delete(node.key);
                              else next.add(node.key);
                              return next;
                            })
                          }
                          className="rounded text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {isOpen ? (
                            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : (
                        <span aria-hidden="true" className="w-3.5" />
                      )}
                      <span
                        className={cn(
                          "truncate",
                          node.depth === 0 && "font-medium",
                          isGroup && node.depth > 0 && "text-foreground",
                          !isGroup && "text-muted-foreground",
                        )}
                      >
                        {node.label}
                      </span>
                    </span>
                  </th>
                  {indices.map((idx) => (
                    <td key={idx} className="px-2.5 py-1 text-center">
                      <TriCheckbox
                        state={nodeState(node, selectedFor(idx))}
                        onToggle={() => toggle(idx, node)}
                        label={`${courtLabel(idx)} · ${node.label}`}
                        testId={`${testIdPrefix}-court-${idx}-comp-${node.key}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
