import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { StageType } from "@/api/tournaments";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  blankStage,
  isTerminal,
  moveStage,
  STAGE_TYPE_LABELS,
  STAGE_TYPE_ORDER,
  validateStages,
  type Stage,
} from "./stagesModel";

const num = (v: string, min: number) => Math.max(min, Math.floor(Number(v) || min));

/** The qualification band BETWEEN two stages ("Top 2 of each group advance →"). */
function Connector({
  stage,
  onChange,
  disabled,
  testId,
}: {
  stage: Stage;
  onChange: (patch: Partial<NonNullable<Stage["from"]>>) => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  const from = stage.from ?? { advance_per_group: 2, advance_best_thirds: 0, seeding: "cross" };
  return (
    <div
      data-testid={testId}
      className="ml-3 flex flex-wrap items-center gap-2 border-l-2 border-dashed border-border py-1.5 pl-3 text-xs text-muted-foreground"
    >
      {t("Top")}
      <Input
        type="number"
        min={1}
        disabled={disabled}
        data-testid={`${testId}-advance`}
        className="h-7 w-16 font-tabular"
        value={from.advance_per_group}
        onChange={(e) => onChange({ advance_per_group: num(e.target.value, 1) })}
      />
      {t("of each group advance")}
      <span className="text-muted-foreground/60">·</span>
      {t("+ best")}
      <Input
        type="number"
        min={0}
        disabled={disabled}
        data-testid={`${testId}-thirds`}
        className="h-7 w-14 font-tabular"
        value={from.advance_best_thirds}
        onChange={(e) => onChange({ advance_best_thirds: num(e.target.value, 0) })}
      />
      <div className="w-32" data-testid={`${testId}-seeding`}>
        <Select
          value={from.seeding}
          onChange={(v) => onChange({ seeding: v as "cross" | "overall" })}
          options={[
            { value: "cross", label: t("Cross-group") },
            { value: "overall", label: t("Overall rank") },
          ]}
          aria-label={t("Seeding")}
        />
      </div>
    </div>
  );
}

function StageCard({
  stage,
  index,
  total,
  error,
  onPatch,
  onMove,
  onRemove,
  disabled,
  testId,
}: {
  stage: Stage;
  index: number;
  total: number;
  error?: string;
  onPatch: (patch: Partial<Stage>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-lg border bg-card p-3",
        error ? "border-destructive" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-semibold font-tabular">
            {index + 1}
          </span>
          <div className="w-48" data-testid={`${testId}-type`}>
            <Select
              value={stage.type}
              onChange={(v) => onPatch(blankStageKeep(stage, v as StageType, index === 0))}
              options={STAGE_TYPE_ORDER.map((ty) => ({ value: ty, label: STAGE_TYPE_LABELS[ty] }))}
              aria-label={t("Stage type")}
            />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={disabled || index === 0}
            aria-label={t("Move up")}
            data-testid={`${testId}-up`}
            onClick={() => onMove(-1)}
            className="rounded p-1 hover:bg-muted disabled:opacity-30"
          >
            <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled || index === total - 1}
            aria-label={t("Move down")}
            data-testid={`${testId}-down`}
            onClick={() => onMove(1)}
            className="rounded p-1 hover:bg-muted disabled:opacity-30"
          >
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("Remove stage")}
            data-testid={`${testId}-remove`}
            onClick={onRemove}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {stage.type === "round_robin" ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("Teams per group")}
            <Input
              type="number" min={2} disabled={disabled}
              data-testid={`${testId}-group-size`}
              className="h-8 w-20 font-tabular"
              value={stage.group_size ?? 4}
              onChange={(e) => onPatch({ group_size: num(e.target.value, 2) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("Matches each team plays")}
            <Input
              type="number" min={1} disabled={disabled}
              data-testid={`${testId}-min-matches`}
              className="h-8 w-24 font-tabular"
              placeholder={t("all")}
              value={stage.min_matches_per_team ?? ""}
              onChange={(e) =>
                onPatch({
                  min_matches_per_team: e.target.value === "" ? null : num(e.target.value, 1),
                })
              }
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox" disabled={disabled}
              data-testid={`${testId}-balance`}
              className="h-4 w-4 rounded border-input text-primary"
              checked={stage.balance_groups ?? true}
              onChange={(e) => onPatch({ balance_groups: e.target.checked })}
            />
            {t("Balance group sizes")}
          </label>
        </div>
      ) : null}

      {stage.type === "knockout" ? (
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox" disabled={disabled}
            data-testid={`${testId}-third-place`}
            className="h-4 w-4 rounded border-input text-primary"
            checked={stage.third_place ?? false}
            onChange={(e) => onPatch({ third_place: e.target.checked })}
          />
          {t("Third-place match")}
        </label>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Switch a stage's type while keeping its id + qualification block. */
function blankStageKeep(prev: Stage, type: StageType, isFirst: boolean): Stage {
  const fresh = blankStage(type, isFirst);
  return { ...fresh, id: prev.id, from: isFirst ? undefined : (prev.from ?? fresh.from) };
}

/**
 * Compose an ordered list of stages for one competition (owner ask 2026-06-27:
 * "allow the user to add any number of stages of any type"). Controlled:
 * `stages` is the plan (empty = single-format, the dropdown governs). The board
 * persists it to draw_config[layer].stages.
 */
export function StagesEditor({
  stages,
  onChange,
  disabled,
  testId = "stages",
}: {
  stages: Stage[];
  onChange: (stages: Stage[]) => void;
  disabled?: boolean;
  testId?: string;
}): React.ReactElement {
  const errs = validateStages(stages);
  const lastTerminal = stages.length > 0 && isTerminal(stages[stages.length - 1]!.type);

  const add = () =>
    onChange([...stages, blankStage(stages.length === 0 ? "round_robin" : "knockout", stages.length === 0)]);

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {stages.map((s, i) => (
        <div key={s.id} className="flex flex-col gap-2">
          {i > 0 ? (
            <Connector
              stage={s}
              disabled={disabled}
              testId={`${testId}-connector-${i}`}
              onChange={(p) =>
                onChange(
                  stages.map((x, k) =>
                    k === i
                      ? {
                          ...x,
                          from: {
                            ...(x.from ?? {
                              advance_per_group: 2, advance_best_thirds: 0, seeding: "cross",
                            }),
                            ...p,
                          },
                        }
                      : x,
                  ),
                )
              }
            />
          ) : null}
          <StageCard
            stage={s}
            index={i}
            total={stages.length}
            error={errs[s.id]}
            disabled={disabled}
            testId={`${testId}-card-${i}`}
            onPatch={(p) => onChange(stages.map((x, k) => (k === i ? { ...x, ...p } : x)))}
            onMove={(dir) => onChange(moveStage(stages, i, dir))}
            onRemove={() => onChange(stages.filter((_, k) => k !== i))}
          />
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || lastTerminal}
        data-testid={`${testId}-add`}
        onClick={add}
        className="flex items-center gap-1.5 self-start rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        {lastTerminal ? t("A knockout ends the competition") : t("Add stage")}
      </button>
    </div>
  );
}
