import { t } from "@/lib/t";

/**
 * Extract the bare group name ("A") from a group label that may be either the
 * short "Group A" OR the full legacy "Football — U15 — Group A" (em-dash
 * joined). Always returns ASCII with no em/en-dashes.
 */
export function shortGroupName(groupLabel: string | null | undefined): string {
  if (!groupLabel) return "";
  // The group sits in the LAST dash-joined segment; strip a leading "Group ".
  const segs = groupLabel.split(/\s*[\u2014\u2013\u00b7-]\s*/);
  const last = (segs[segs.length - 1] ?? "").trim();
  return last.replace(/^Group\s+/i, "").trim();
}

/** Loose pointer shape shared by MatchSource (the bracket) and
 * PreviewSide.source (the preview chips) — both carry an index signature so
 * either is structurally assignable here. */
type SlotPointer = Record<string, unknown>;

/**
 * Clean, ASCII placeholder label for an unresolved `group_position` bracket
 * slot. Shared by the FIFA bracket (FifaBracket.sourceLabel) and the preview
 * chips (sideName) so the two ALWAYS agree and neither ever leaks the raw
 * em-dash legacy label.
 *   { best_third, rank }      → "Best 3rd #1"
 *   { group_label, position } → "Group A top 2"  (the rule the organiser set:
 *                               top 1 / 2 / 3 of each group advance)
 * Returns null when the pointer has nothing positional to show.
 */
export function groupPositionLabel(
  src: SlotPointer | null | undefined,
): string | null {
  if (!src) return null;
  if (src.best_third) {
    const rank =
      typeof src.rank === "number"
        ? src.rank
        : typeof src.position === "number"
          ? src.position
          : null;
    return rank ? `${t("Best 3rd")} #${rank}` : t("Best 3rd");
  }
  const position = typeof src.position === "number" ? src.position : null;
  if (position) {
    const group = shortGroupName(
      typeof src.group_label === "string" ? src.group_label : null,
    );
    return group
      ? `${t("Group")} ${group} ${t("top")} ${position}`
      : `${t("Top")} ${position}`;
  }
  return null;
}
