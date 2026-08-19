import type { TournamentMember } from "@/api/tournaments";

/** The official roles a person can hold on a match, with their display labels
 * (wrap the label in t() at the call site). Shared by the per-match drawer and
 * the bulk-assign dialog. */
export const OFFICIAL_ROLES: { value: string; label: string }[] = [
  { value: "referee", label: "Referee" },
  { value: "assistant", label: "Assistant referee" },
  { value: "fourth", label: "Fourth official" },
  { value: "umpire", label: "Umpire" },
  { value: "commissioner", label: "Match commissioner" },
];

/** Roles a person can HOLD but nobody assigns from the picker above: the
 * scorer is its own seat on the match, and `linesman` arrived with sepak
 * takraw. Kept apart so the picker's list stays the assignable set. */
const EXTRA_ROLE_LABELS: Record<string, string> = {
  linesman: "Linesman",
  scorer: "Scorer",
};

export function officialRoleLabel(role: string): string {
  return (
    OFFICIAL_ROLES.find((r) => r.value === role)?.label ??
    EXTRA_ROLE_LABELS[role] ??
    role.replace(/_/g, " ")
  );
}

export interface Candidate {
  userId: string;
  name: string;
  roles: string[];
}

/** Active members deduped by person (the API returns one row per role). */
export function candidatesOf(members: TournamentMember[] | undefined): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const m of members ?? []) {
    if (m.status !== "active") continue;
    const c = by.get(m.user_id) ?? {
      userId: m.user_id,
      name: m.full_name || m.email,
      roles: [],
    };
    if (!c.roles.includes(m.role)) c.roles.push(m.role);
    by.set(m.user_id, c);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
