import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

export interface ConflictOfInterestBannerProps {
  message: string;
  acknowledged: boolean;
  onChangeAcknowledged: (v: boolean) => void;
  className?: string;
}

/**
 * v1Users.md Appendix B.22 — soft-warning banner pattern. The platform
 * does NOT block conflicted actions; it requires the actor to tick an
 * acknowledgement which the backend logs to AuditEvent. The same banner
 * is reused by ownership transfer, suspension, and any verb where the
 * caller is themselves a stakeholder of the target object.
 */
export function ConflictOfInterestBanner({
  message,
  acknowledged,
  onChangeAcknowledged,
  className,
}: ConflictOfInterestBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-warn bg-warn-muted p-3 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="text-base font-semibold">
          !
        </span>
        <div className="flex-1">
          <p className="font-medium">{t("Conflict of interest")}</p>
          <p className="text-muted-foreground">{message}</p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onChangeAcknowledged(e.target.checked)}
        />
        {t(
          "I acknowledge this conflict and accept that this action will be recorded in the audit log.",
        )}
      </label>
    </div>
  );
}
