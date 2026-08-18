import { PenLine, UserSquare2, type LucideIcon } from "lucide-react";
import type { RosterMode } from "@/api/tournaments";
import { t } from "@/lib/t";

/**
 * How players come into existence (spec 2026-08-17).
 *
 * Asked at creation and again in Settings, from one list, so the two screens
 * can never describe the same choice differently. Unlike `scope` it stays
 * switchable for as long as the funnel is ahead of you: switching MIGRATES
 * the players already registered (owner 2026-08-18), so the copy sells the
 * trade-off rather than warning about permanence.
 */
export const ROSTER_MODES: {
  value: RosterMode;
  label: string;
  hint: string;
  icon: LucideIcon;
}[] = [
  {
    value: "inline",
    label: t("Names typed on the team form"),
    hint: t("Quickest. Fine when nobody plays in two competitions."),
    icon: PenLine,
  },
  {
    value: "roster_first",
    label: t("Participants first, then teams"),
    hint: t(
      "Each school enters all its students and teachers once, then picks teams from that list, so the draw can see who is in two events.",
    ),
    icon: UserSquare2,
  },
];
