import type { DrawConfig, DrawStage, StageType } from "@/api/tournaments";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

export type Stage = DrawStage & { id: string };

export const STAGE_TYPE_LABELS: Record<StageType, string> = {
  round_robin: t("Group / league"),
  knockout: t("Knockout"),
  swiss: t("Swiss"),
  double_elim: t("Double elimination"),
};

export const STAGE_TYPE_ORDER: StageType[] = [
  "round_robin", "knockout", "swiss", "double_elim",
];

export function isTerminal(type: StageType): boolean {
  return type === "knockout" || type === "double_elim";
}

/** A fresh stage of `type`; non-first stages get a default qualification block. */
export function blankStage(type: StageType, isFirst: boolean): Stage {
  const s: Stage = { id: newEventId(), type };
  if (type === "round_robin") {
    s.group_size = 4;
    s.balance_groups = true;
    s.min_matches_per_team = null;
  }
  if (type === "knockout") s.third_place = false;
  if (!isFirst) {
    s.from = { advance_per_group: 2, advance_best_thirds: 0, seeding: "cross" };
  }
  return s;
}

/** Stored stages for a layer (empty = single-format, the dropdown governs). */
export function stagesFromConfig(eff: DrawConfig | undefined): Stage[] {
  const raw = eff?.stages;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((s) => ({ ...s, id: s.id ?? newEventId() }));
  }
  return [];
}

export function moveStage(stages: Stage[], i: number, dir: -1 | 1): Stage[] {
  const j = i + dir;
  if (j < 0 || j >= stages.length) return stages;
  const next = stages.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Inline validation mirroring the backend's legal-chain rules (best-effort;
 * the server is the source of truth). Keyed by stage id. */
export function validateStages(stages: Stage[]): Record<string, string> {
  const errs: Record<string, string> = {};
  stages.forEach((s, i) => {
    if (isTerminal(s.type) && i !== stages.length - 1) {
      errs[s.id] = t("A knockout decides a winner, so it has to be the last stage.");
    }
    if (i > 0) {
      const src = stages[i - 1]!;
      const adv = s.from?.advance_per_group ?? 1;
      if (src.type === "round_robin" && src.group_size && adv >= src.group_size) {
        errs[s.id] = t("Fewer teams must advance than the group holds.");
      }
    }
    if (s.type === "round_robin" && s.min_matches_per_team != null) {
      const cap = (s.group_size ?? 2) - 1;
      if (s.min_matches_per_team > cap) {
        errs[s.id] = t("A team can play at most one fewer match than the group size.");
      }
    }
  });
  return errs;
}
