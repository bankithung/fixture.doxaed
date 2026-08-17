import type { ConstraintRecord, ConstraintType } from "@/api/tournaments";

/**
 * How the rules page is organised (owner 2026-08-17: "the UI needs to be more
 * organised and properly grouped rather than just randomly placing it").
 *
 * A flat list of typed rows made every rule look equally important and left
 * the one an organizer actually wanted — which competition goes first — buried
 * in a dropdown of fourteen. The rules are grouped by the QUESTION they answer,
 * so you can find one by knowing what you want rather than by knowing its name.
 *
 * Membership is data: a catalog type nobody has placed still appears, under
 * "Anything else", so adding a constraint server-side can never make it
 * invisible here.
 */

export interface RuleGroup {
  key: string;
  title: string;
  /** What this group is for, in one line — the question it answers. */
  blurb: string;
  types: string[];
  /** The rule this group mainly exists for. While no record of it is saved the
   * group offers it as a NAMED action rather than an entry in a dropdown —
   * the owner asked twice where the ordering control was, which is what a
   * dropdown of fourteen does to the one rule you came for. */
  primary?: string;
  /** What to call that action. */
  primaryLabel?: string;
  /** What the group does when nothing is set, in the group's own terms. */
  emptyHint?: string;
}

/** Rule types owned by the "Clashes & sessions" step, which has its own
 * friendlier editor. They stay out of this page so one record never has two
 * editors (the same guard `ConstraintBuilder` already applied). */
export const OWNED_ELSEWHERE = new Set([
  "no_concurrent_competitions",
  "category_session_window",
  "official_capacity",
]);

export const RULE_GROUPS: RuleGroup[] = [
  {
    key: "order",
    title: "Order & priority",
    blurb:
      "Which competition gets the early slots, and which rounds are held back for the closing days.",
    primary: "competition_priority",
    primaryLabel: "Set which competition is scheduled first",
    emptyHint:
      "Competitions currently take slots in whatever order the draw produced them. Rank them to decide which plays first.",
    types: [
      "competition_priority",
      "closing_rounds_window",
      "round_pinned_to_window",
      "rotation_fairness",
    ],
  },
  {
    key: "timing",
    title: "Days & times",
    blurb: "When play may happen, and when it may not.",
    types: [
      "blackout_dates",
      "recurring_blackout_window",
      "ceremony_block",
      "reserve_days",
      "preferred_window",
      "team_unavailable",
    ],
  },
  {
    key: "load",
    title: "Rest & workload",
    blurb: "How hard a single team's day is allowed to be.",
    types: [
      "min_rest_minutes",
      "max_matches_per_team_per_day",
      "avoid_back_to_back",
      "even_spacing",
    ],
  },
  {
    key: "people",
    title: "People in two places",
    blurb:
      "Nobody plays two matches at once. Each rule is keyed on a different person, so turn on the one that matches how your teams travel.",
    types: [
      "no_person_overlap",
      "no_staff_overlap",
      "no_institution_overlap",
      "no_double_booking_team",
    ],
  },
  {
    key: "draw",
    title: "How the draw is made",
    blurb: "Who may meet whom, and how early.",
    types: ["keep_apart_until_round", "opening_round_separation"],
  },
  {
    key: "venues",
    title: "Courts & venues",
    blurb: "How play is spread across the places you have.",
    types: ["balance_venues", "venue_single_use"],
  },
];

const PLACED = new Set(RULE_GROUPS.flatMap((g) => g.types));

/** The group a rule type belongs to ("other" when the catalog grew past this
 * map — visible, never dropped). */
export function groupOf(type: string): string {
  return PLACED.has(type) ? RULE_GROUPS.find((g) => g.types.includes(type))!.key : "other";
}

export interface GroupedRules {
  group: RuleGroup;
  /** Indexes into the ORIGINAL rows array, so edits address the right record. */
  rows: number[];
  /** Catalog entries this group can add. */
  addable: ConstraintType[];
}

/**
 * Bucket the saved records and the catalog into the page's panels.
 *
 * Indexes rather than records: the builder edits `rows[i]`, and a group that
 * carried copies would write its edits to the wrong record the moment two
 * groups held rules of the same type.
 */
export function groupRules(
  rows: readonly ConstraintRecord[],
  catalog: readonly ConstraintType[],
): GroupedRules[] {
  const extras = catalog
    .map((c) => c.type)
    .filter((ty) => !PLACED.has(ty) && !OWNED_ELSEWHERE.has(ty));
  const groups: RuleGroup[] = extras.length
    ? [
        ...RULE_GROUPS,
        {
          key: "other",
          title: "Anything else",
          blurb: "Rules that do not fit the groups above.",
          types: extras,
        },
      ]
    : RULE_GROUPS;

  return groups.map((group) => ({
    group,
    rows: rows
      .map((r, i) => [r, i] as const)
      .filter(([r]) => !OWNED_ELSEWHERE.has(r.type) && group.types.includes(r.type))
      .map(([, i]) => i),
    addable: group.types
      .map((ty) => catalog.find((c) => c.type === ty))
      .filter((c): c is ConstraintType => Boolean(c)),
  }));
}
