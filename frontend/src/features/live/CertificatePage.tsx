import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Printer } from "lucide-react";
import { api } from "@/api/client";
import { t } from "@/lib/t";

interface AwardData {
  id: string;
  badge_key: string;
  name: string;
  description: string;
  subject: string;
  team_name: string | null;
  evidence: Record<string, unknown>;
  tournament_name: string;
  tournament_slug: string;
  tournament_id: string;
  season: string;
  awarded_at: string;
}

function evidenceLine(ev: Record<string, unknown>): string {
  if (Array.isArray(ev.set_scores) && ev.set_scores.length) {
    const sets = (ev.set_scores as number[][])
      .map(([h, a]) => `${h}-${a}`)
      .join(", ");
    return ev.conceded != null
      ? `${sets} (${t("conceded only")} ${ev.conceded} ${t("points")})`
      : sets;
  }
  if (ev.point_difference != null) return `${t("Point difference")} +${ev.point_difference}`;
  if (ev.goals != null) return `${ev.goals} ${t("goals")}`;
  if (ev.streak != null) return `${ev.streak} ${t("in a row")}`;
  if (ev.wins != null) return `${ev.wins} ${t("wins, no defeats")}`;
  return "";
}

/**
 * Printable certificate for a badge award (owner: "we can generate
 * certificates for these badges"). Public page; Save as PDF via print —
 * zero server dependencies, exact design-token styling.
 */
export function CertificatePage(): React.ReactElement {
  const { awardId = "" } = useParams();
  const q = useQuery({
    queryKey: ["certificate", awardId],
    queryFn: () => api.get<AwardData>(`/api/public/badges/${awardId}/`),
  });
  useEffect(() => {
    if (q.data) document.title = `${q.data.name} · ${q.data.subject}`;
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="h-96 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p role="alert" className="mx-auto max-w-2xl px-4 py-10 text-sm text-destructive">
        {t("This certificate could not be loaded.")}
      </p>
    );
  }
  const a = q.data;
  const date = new Date(a.awarded_at).toLocaleDateString([], {
    day: "2-digit", month: "long", year: "numeric",
  });

  return (
    <div className="min-h-screen text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
        <div className="flex items-center justify-between print:hidden">
          <Link
            to={`/t/${a.tournament_slug}/${a.tournament_id}/schedule`}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {a.tournament_name}
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <Printer aria-hidden="true" className="h-4 w-4" />
            {t("Print or save as PDF")}
          </button>
        </div>

        {/* The certificate itself */}
        <div className="rounded-2xl border-4 border-double border-primary/60 bg-card p-10 text-center shadow-sm print:rounded-none print:border-foreground print:shadow-none">
          <Award aria-hidden="true" className="mx-auto h-12 w-12 text-primary" />
          <p className="mt-4 text-[0.6875rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            {t("Certificate of achievement")}
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            {a.name}
          </h1>
          <p className="mt-6 text-sm text-muted-foreground">{t("Awarded to")}</p>
          <p className="mt-1 text-2xl font-semibold">{a.subject}</p>
          {a.team_name && a.team_name !== a.subject ? (
            <p className="text-sm text-muted-foreground">{a.team_name}</p>
          ) : null}
          <p className="mx-auto mt-5 max-w-md text-sm text-muted-foreground">
            {a.description}
          </p>
          {evidenceLine(a.evidence) ? (
            <p className="mt-3 font-tabular text-base font-semibold">
              {evidenceLine(a.evidence)}
            </p>
          ) : null}
          <div className="mx-auto mt-8 h-px w-32 bg-border" />
          <p className="mt-4 text-sm font-medium">{a.tournament_name}</p>
          <p className="text-xs text-muted-foreground">
            {a.season ? `${t("Season")} ${a.season} · ` : ""}
            {date}
          </p>
          <div className="mt-10 grid grid-cols-2 gap-8 text-xs text-muted-foreground">
            <div>
              <div className="mx-auto h-px w-36 bg-border" />
              <p className="mt-1.5">{t("Organizer")}</p>
            </div>
            <div>
              <div className="mx-auto h-px w-36 bg-border" />
              <p className="mt-1.5">{t("Official")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
