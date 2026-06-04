import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { orgsApi } from "@/api/orgs";
import { ApiError } from "@/types/api";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { ConflictOfInterestBanner } from "@/features/permissions/ConflictOfInterestBanner";
import { t } from "@/lib/t";

export interface OwnershipTransferModalProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-known target user (optional — modal can also let user pick). */
  targetUserId?: string;
  /** Whether to surface the conflict-of-interest banner up front. */
  conflictDetected?: boolean;
}

function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ev_${Math.random().toString(36).slice(2)}`;
}

/**
 * v1Users.md §2.14 — ownership transfer requires a typed reason and an
 * explicit acknowledgement. If the platform detects a conflict of
 * interest (e.g. SA-as-Org-member transferring within their own org),
 * the soft-warning banner is rendered.
 */
export function OwnershipTransferModal({
  orgSlug,
  open,
  onOpenChange,
  targetUserId,
  conflictDetected,
}: OwnershipTransferModalProps): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [toUserId, setToUserId] = useState(targetUserId ?? "");
  const [reason, setReason] = useState("");
  const [conflictAck, setConflictAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: () =>
      orgsApi.transferOwnership(orgSlug, {
        new_owner_user_id: toUserId,
        reason,
        event_id: newEventId(),
        conflict_acknowledged: conflictDetected ? conflictAck : undefined,
      }),
    onSuccess: () => {
      toast.push({
        kind: "success",
        title: t("Ownership transferred"),
      });
      qc.invalidateQueries({ queryKey: ["org", orgSlug] });
      onOpenChange(false);
    },
    onError: (e) => {
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Transfer failed"))
          : t("Transfer failed"),
      );
    },
  });

  const blocked =
    !toUserId ||
    reason.trim().length < 8 ||
    (conflictDetected && !conflictAck);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={t("Transfer ownership")}
    >
      <DialogHeader>
        <DialogTitle>{t("Transfer ownership")}</DialogTitle>
        <DialogDescription>
          {t(
            "Ownership transfer is irreversible from this UI. The new owner inherits all org-scoped privileges.",
          )}
        </DialogDescription>
      </DialogHeader>

      {conflictDetected ? (
        <ConflictOfInterestBanner
          message={t(
            "You appear to be a member of this organization. Transferring ownership while a stakeholder will be flagged in the audit log.",
          )}
          acknowledged={conflictAck}
          onChangeAcknowledged={setConflictAck}
        />
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          transfer.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="transfer-target">{t("New owner (user ID)")}</Label>
          <Input
            id="transfer-target"
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            placeholder="01HF..."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="transfer-reason">{t("Reason (audit log)")}</Label>
          <Input
            id="transfer-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={8}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={blocked || transfer.isPending}
          >
            {transfer.isPending ? t("Transferring...") : t("Transfer")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
