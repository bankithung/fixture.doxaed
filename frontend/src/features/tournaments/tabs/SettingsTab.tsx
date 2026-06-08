import { Link, useParams } from "react-router-dom";
import { ChevronRight, ScrollText } from "lucide-react";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { DisputesPanel } from "@/features/disputes/DisputesPanel";

export function SettingsTab(): React.ReactElement {
  const { id = "" } = useParams();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">{t("Settings")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Stage changes happen on the Overview tab. Here are the records and admin tools.")}
        </p>
      </div>

      <Link
        to={routes.tournamentAudit(id)}
        className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10">
          <ScrollText aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("Audit log")}</div>
          <div className="text-xs text-muted-foreground">
            {t("Every stage change, score, and admin action — append-only.")}
          </div>
        </div>
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </Link>

      <DisputesPanel tournamentId={id} />
    </div>
  );
}
