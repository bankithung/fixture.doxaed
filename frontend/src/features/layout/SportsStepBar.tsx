import { Link, useSearchParams } from "react-router-dom";
import { Check, ChevronRight } from "lucide-react";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** The Sports page's three sub-steps, in order. */
const SUB_STEPS: { key: string; label: string }[] = [
  { key: "pick", label: "Choose sports" },
  { key: "configure", label: "Categories" },
  { key: "review", label: "Review & generate" },
];

/**
 * Sticky sub-toolbar pinned just under the global top bar while you're on the
 * Sports page (AppShell renders it only there). A slim full-width strip with the
 * three sub-steps — wizard chrome that doesn't touch the sidebar or the
 * content's side space. The active step lives in the `?step=` URL param that
 * SportsTab reads, so this bar both reflects the page and drives it (clicking a
 * step navigates; done steps step back). Frosted to match the top bar; solid
 * tokens only, no gradients.
 */
export function SportsStepBar({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const [searchParams] = useSearchParams();
  const param = searchParams.get("step");
  const currentIdx = param === "configure" ? 1 : param === "review" ? 2 : 0;

  return (
    <div className="sticky top-14 z-10 border-b border-border bg-card/80 backdrop-blur">
      <nav
        aria-label={t("Sports setup steps")}
        className="flex h-12 items-center gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8"
      >
        {SUB_STEPS.map((s, i) => {
          const active = i === currentIdx;
          const done = i < currentIdx;
          const to =
            s.key === "pick"
              ? routes.tournamentSports(tournamentId)
              : `${routes.tournamentSports(tournamentId)}?step=${s.key}`;
          const inner = (
            <>
              <span
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold",
                  active || done
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground",
                )}
              >
                {done ? (
                  <Check aria-hidden="true" className="h-3 w-3" />
                ) : (
                  <span className="font-tabular">{i + 1}</span>
                )}
              </span>
              <span className="whitespace-nowrap">{t(s.label)}</span>
            </>
          );
          const cls = cn(
            "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
            active
              ? "bg-accent text-foreground"
              : done
                ? "text-foreground hover:bg-accent/60"
                : "text-muted-foreground",
          );
          return (
            <span key={s.key} className="flex items-center">
              {done ? (
                <Link
                  to={to}
                  className={cn(
                    cls,
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {inner}
                </Link>
              ) : (
                <span className={cls} aria-current={active ? "step" : undefined}>
                  {inner}
                </span>
              )}
              {i < SUB_STEPS.length - 1 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="mx-0.5 h-4 w-4 shrink-0 text-muted-foreground/40"
                />
              ) : null}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
