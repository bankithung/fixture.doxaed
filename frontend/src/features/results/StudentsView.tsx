import type { PublicResultStudent } from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { MedalChip } from "./MedalChip";

/**
 * What each student did, across every event they played.
 *
 * No paper tally has ever been able to say this. A school row hides the child
 * who played three events and medalled in two, and until the participants
 * layer there was no way to even ask — the same name typed twice was two
 * people. Here a student is ONE row with every event on it.
 *
 * **A student carries the FULL points of their team's placing** (owner
 * 2026-08-25): both halves of a winning doubles pair show 5, and the school
 * still counts the gold once. The caption says so, because two totals that do
 * not add up are otherwise read as a bug.
 */

function Events({
  student,
}: {
  student: PublicResultStudent;
}): React.ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {student.events.map((e) => (
        <span
          key={`${e.team_id}-${e.leaf_key}-${e.place ?? "none"}`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[0.6875rem]",
            e.place
              ? "border-border bg-card font-medium"
              : "border-dashed border-border text-muted-foreground",
          )}
          title={`${e.sport_name} · ${e.label} · ${e.team_name}`}
        >
          {e.place ? (
            <MedalChip place={e.place} label={e.place_label} size="sm" />
          ) : null}
          {/* The sport is on the chip, not only in the tooltip: a two-sport
              meet has a "U-14 · Girls" in table tennis AND in sepaktakraw,
              and a phone has no hover to tell them apart (owner 2026-08-30). */}
          <span className="max-w-[8rem] truncate font-semibold">{e.sport_name}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="max-w-[12rem] truncate">{e.label}</span>
        </span>
      ))}
    </span>
  );
}

export function StudentsView({
  students,
  places,
  labelOf,
}: {
  students: PublicResultStudent[];
  places: number[];
  labelOf: (p: number) => string;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();

  if (!students.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {t("No student matches that search.")}
      </p>
    );
  }

  if (isMobile) {
    return (
      <ul className="flex flex-col gap-2" data-testid="students-cards">
        {students.map((s) => (
          <li
            key={s.person_id}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex items-center gap-2">
              <TeamCrest src={s.crest} name={s.institution_name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {s.name}
                </span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">
                  {s.institution_name}
                  {s.class_section ? ` · ${s.class_section}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-tabular text-base font-semibold">
                  {s.points}
                </span>
                <span className="block text-[0.625rem] text-muted-foreground">
                  {t("points")}
                </span>
              </span>
            </div>
            <Events student={s} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        className="w-full min-w-[48rem] border-separate border-spacing-0 text-sm"
        data-testid="students-table"
      >
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="border-b border-border px-3 py-2 text-left">
              {t("Student")}
            </th>
            <th scope="col" className="border-b border-border px-3 py-2 text-left">
              {t("School")}
            </th>
            <th scope="col" className="border-b border-border px-3 py-2 text-left">
              {t("Events")}
            </th>
            {places.map((p) => (
              <th
                key={p}
                scope="col"
                className="border-b border-border px-2 py-2 text-center"
              >
                {labelOf(p)}
              </th>
            ))}
            <th scope="col" className="border-b border-border px-3 py-2 text-right">
              {t("Points")}
            </th>
          </tr>
        </thead>
        <tbody>
          {students.map((s, i) => (
            <tr
              key={s.person_id}
              data-testid={`student-row-${s.person_id}`}
              className={cn("group", i % 2 && "bg-muted/20")}
            >
              <td className="border-b border-border px-3 py-2 transition-colors group-hover:bg-accent/60">
                <span className="block font-medium">{s.name}</span>
                {s.class_section || s.roll_no ? (
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {[s.class_section, s.roll_no && `#${s.roll_no}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </td>
              <td className="border-b border-border px-3 py-2 transition-colors group-hover:bg-accent/60">
                <span className="flex items-center gap-2">
                  <TeamCrest src={s.crest} name={s.institution_name} size="sm" />
                  <span className="max-w-[14rem] truncate text-xs">
                    {s.institution_name}
                  </span>
                </span>
              </td>
              <td className="border-b border-border px-3 py-2 transition-colors group-hover:bg-accent/60">
                <Events student={s} />
              </td>
              {places.map((p) => (
                <td
                  key={p}
                  className={cn(
                    "border-b border-border px-2 py-2 text-center font-tabular",
                    !(s.medals[String(p)] ?? 0) && "text-muted-foreground/50",
                  )}
                >
                  {s.medals[String(p)] ?? 0}
                </td>
              ))}
              <td className="border-b border-border px-3 py-2 text-right font-tabular font-semibold transition-colors group-hover:bg-accent/60">
                {s.points}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
