import type { RepairViolation } from "@/api/tournaments";
import { isNetworkError } from "@/api/client";
import { ApiError } from "@/types/api";
import { t } from "@/lib/t";

/** Match statuses a slot edit may touch (mirrors the backend's gate). */
export const MOVABLE_STATUSES = new Set(["scheduled", "postponed"]);

/** 409 `schedule_conflicts` → the violations payload; anything else → null. */
export function conflictsOf(e: unknown): RepairViolation[] | null {
  if (
    e instanceof ApiError &&
    e.status === 409 &&
    e.payload.detail === "schedule_conflicts"
  ) {
    return (e.payload.violations as RepairViolation[] | undefined) ?? [];
  }
  return null;
}

export function errorDetail(e: unknown): string {
  return e instanceof ApiError ? String(e.payload.detail ?? "") : t("Try again.");
}

/**
 * True when a write's RESPONSE never arrived — client timeout, abort, offline.
 * The request itself may well have reached the server and committed (Django
 * shields sync views, so a client abort does NOT roll the work back; nginx just
 * logs a 499). Never render this class of failure as "it did not happen", and
 * never push the user into a retry: re-submitting a *different* idempotency key
 * re-runs the write for real. Reconcile with the server instead.
 */
export function writeMayHaveLanded(e: unknown): boolean {
  return isNetworkError(e);
}

/** The honest toast for {@link writeMayHaveLanded}: still running, refreshing. */
export function stillRunningToast(
  title: string = t("Still assigning — this is taking longer than expected."),
): { title: string; description: string } {
  return { title, description: t("Refreshing to show the result.") };
}
