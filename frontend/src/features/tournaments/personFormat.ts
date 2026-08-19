import { t } from "@/lib/t";

/**
 * How a declared person's own details read on screen — shared by the team
 * squad panel and the participants list, so a child's date of birth is written
 * the same way wherever an organizer meets it.
 */

/** Humanize an ISO date ("2013-03-11" → "11 Mar 2013"); returns the raw input
 * on a parse miss so bad data never renders blank. */
export function fmtDob(iso: string): string {
  try {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Whole years from an ISO DOB to today — age matters for u-14/u-17 eligibility,
 * so it reads next to the date. null on a parse miss / implausible value. */
export function ageFrom(iso: string): number | null {
  try {
    const dob = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(dob.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age >= 0 && age < 130 ? age : null;
  } catch {
    return null;
  }
}

/** The gender answer as a word. Unknown values pass through, because the form
 * is data and an event may offer options this build has never heard of. */
export function fmtGender(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "male") return t("Male");
  if (v === "female") return t("Female");
  if (v === "other") return t("Other");
  return value.trim();
}
