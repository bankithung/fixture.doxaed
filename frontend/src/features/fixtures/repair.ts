import type { RepairViolation } from "@/api/tournaments";
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
