import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/t";

const STATE_OPTIONS = [
  { value: "default", label: t("Role default") },
  { value: "grant", label: t("Grant") },
  { value: "deny", label: t("Deny") },
];

const MIN_REASON = 20;

/** Human grouping labels for the module catalog's categories. */
const CATEGORY_LABELS: Record<string, string> = {
  tournament_scoped: t("Tournament"),
  match_scoped: t("Match day"),
};

/**
 * Per-member access editor (spec 2026-06-10 P5): the member's effective
 * module set — role defaults plus this tournament's overrides — with a
 * tri-state control per module. Every change requires a written reason
 * (audited server-side) and takes effect immediately.
 */
export function PermissionsDialog({
  tournamentId,
  userId,
  email,
  open,
  onClose,
}: {
  tournamentId: string;
  userId: string;
  email: string;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = React.useState("");

  const matrix = useQuery({
    queryKey: ["t-permissions", tournamentId],
    queryFn: () => tournamentsApi.permissionMatrix(tournamentId),
    enabled: open && Boolean(tournamentId),
  });
  const member = matrix.data?.members.find((m) => m.user_id === userId);

  const save = useMutation({
    mutationFn: (args: { module_code: string; state: "grant" | "deny" | "default" }) =>
      tournamentsApi.setPermission(tournamentId, {
        user_id: userId,
        module_code: args.module_code,
        state: args.state,
        reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-permissions", tournamentId] });
      toast.push({ kind: "success", title: t("Access updated") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not update access"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      }),
  });

  const reasonOk = reason.trim().length >= MIN_REASON;
  const grouped = React.useMemo(() => {
    const by: Record<string, { code: string; name: string }[]> = {};
    for (const m of matrix.data?.modules ?? []) {
      (by[m.category] ||= []).push({ code: m.code, name: m.name });
    }
    return by;
  }, [matrix.data]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason("");
          onClose();
        }
      }}
      ariaLabel={t("Member access editor")}
    >
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />
            {t("Access for")} {email}
          </DialogTitle>
          <DialogDescription>
            {t("Role defaults apply automatically. Grant adds an extra capability; Deny removes one.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="perm-reason">{t("Reason for the change")}</Label>
          <Input
            id="perm-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("e.g. Covers scheduling for the U-15 competitions this season")}
          />
          <p className="text-xs text-muted-foreground">
            {reasonOk
              ? t("Recorded in the audit log with every change.")
              : t(`At least ${MIN_REASON} characters to unlock changes.`)}
          </p>
        </div>

        {matrix.isLoading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : member ? (
          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto pr-1">
            {Object.entries(grouped).map(([category, modules]) => (
              <section key={category} className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {CATEGORY_LABELS[category] ?? category}
                </h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {modules.map((mod) => {
                    const override = member.overrides[mod.code];
                    const effective = member.effective.includes(mod.code);
                    return (
                      <li
                        key={mod.code}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{mod.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {effective ? t("Has access") : t("No access")}
                            {override === "grant"
                              ? ` · ${t("granted here")}`
                              : override === "deny"
                                ? ` · ${t("denied here")}`
                                : ""}
                          </p>
                        </div>
                        <div className="w-36 shrink-0">
                          <Select
                            aria-label={t(`Access to ${mod.name}`)}
                            value={override ?? "default"}
                            options={STATE_OPTIONS}
                            disabled={!reasonOk || save.isPending}
                            onChange={(v) =>
                              save.mutate({
                                module_code: mod.code,
                                state: v as "grant" | "deny" | "default",
                              })
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            {t("No active membership in this tournament.")}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
