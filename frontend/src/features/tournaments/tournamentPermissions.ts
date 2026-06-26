/** Whether the current user may manage (e.g. rename) this tournament from the
 * list. Mirrors the server's manager check: org owner, or an active admin /
 * co-organizer member. The server is the source of truth; this just gates UI. */
export function canManageTournament(
  origin?: string | null,
  roles?: string[],
): boolean {
  if (origin === "owner") return true;
  return (roles ?? []).some((r) => r === "admin" || r === "co_organizer");
}
