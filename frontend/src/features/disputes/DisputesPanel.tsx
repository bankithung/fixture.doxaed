import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { disputesApi } from "@/api/disputes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const KINDS = ["score", "eligibility", "conduct", "other"] as const;

/** Status -> badge token classes + leading-dot color. */
function statusMeta(status: string): { badge: string; dot: string } {
  const map: Record<string, { badge: string; dot: string }> = {
    open: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    under_review: { badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    resolved: { badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
    rejected: { badge: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
    withdrawn: { badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" },
  };
  return map[status] ?? { badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
}

/** Disputes section for a tournament: raise + list + resolve/reject/withdraw. */
export function DisputesPanel({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ["disputes", tournamentId],
    queryFn: () => disputesApi.list(tournamentId),
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["disputes", tournamentId] });

  const [kind, setKind] = useState<string>("score");
  const [desc, setDesc] = useState("");

  // --- resolution dialog (replaces window.prompt) ---------------------------
  const [resolveTarget, setResolveTarget] = useState<{
    id: string;
    mode: "resolve" | "reject";
  } | null>(null);
  const [note, setNote] = useState("");

  const raise = useMutation({
    mutationFn: () =>
      disputesApi.raise(tournamentId, {
        kind,
        description: desc.trim(),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      setDesc("");
      refresh();
    },
  });
  const resolve = useMutation({
    mutationFn: (p: { id: string; resolution: string }) =>
      disputesApi.resolve(p.id, p.resolution),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: (p: { id: string; resolution: string }) =>
      disputesApi.reject(p.id, p.resolution),
    onSuccess: refresh,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => disputesApi.withdraw(id),
    onSuccess: refresh,
  });

  const disputes = query.data ?? [];

  const openResolve = (id: string, mode: "resolve" | "reject"): void => {
    setNote("");
    setResolveTarget({ id, mode });
  };
  const closeResolve = (): void => {
    setResolveTarget(null);
    setNote("");
  };
  const submitResolution = (): void => {
    if (!resolveTarget) return;
    const trimmed = note.trim();
    if (trimmed.length < 5) {
      toast.push({
        kind: "error",
        title: t("Resolution note too short"),
        description: t("Enter at least 5 characters."),
      });
      return;
    }
    const mut = resolveTarget.mode === "resolve" ? resolve : reject;
    mut.mutate(
      { id: resolveTarget.id, resolution: trimmed },
      {
        onSuccess: () => {
          toast.push({
            kind: "success",
            title:
              resolveTarget.mode === "resolve"
                ? t("Dispute resolved")
                : t("Dispute rejected"),
          });
          closeResolve();
        },
        onError: () =>
          toast.push({
            kind: "error",
            title: t("Could not update dispute"),
          }),
      },
    );
  };

  const submitting = resolve.isPending || reject.isPending;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ShieldAlert aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("Disputes")}</h2>
        {disputes.length > 0 ? (
          <span className="font-tabular text-xs text-muted-foreground">
            {disputes.length}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 p-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (desc.trim()) raise.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="dispute-kind" className="text-xs text-muted-foreground">
              {t("Type")}
            </Label>
            <Select
              id="dispute-kind"
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => ({ value: k, label: t(k) }))}
              aria-label={t("Type")}
              className="w-40"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label
              htmlFor="dispute-desc"
              className="text-xs text-muted-foreground"
            >
              {t("Describe the issue")}
            </Label>
            <Input
              id="dispute-desc"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t("What went wrong?")}
              className="min-w-56"
            />
          </div>
          <Button type="submit" disabled={!desc.trim() || raise.isPending}>
            {raise.isPending ? t("Sending...") : t("Raise dispute")}
          </Button>
        </form>

        {query.isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-lg border border-border bg-muted"
              />
            ))}
          </div>
        ) : disputes.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {t("No disputes raised.")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {disputes.map((d) => {
              const sm = statusMeta(d.status);
              const actionable =
                d.status === "open" || d.status === "under_review";
              return (
                <li
                  key={d.id}
                  className="rounded-lg border border-border bg-background p-3 transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium capitalize">
                      {t(d.kind)}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                        sm.badge,
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("h-1.5 w-1.5 rounded-full", sm.dot)}
                      />
                      {t(d.status.replace(/_/g, " "))}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {d.description}
                  </p>
                  {d.resolution ? (
                    <p className="mt-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {t("Resolution")}:
                      </span>{" "}
                      {d.resolution}
                    </p>
                  ) : null}
                  {actionable ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openResolve(d.id, "resolve")}
                      >
                        {t("Resolve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openResolve(d.id, "reject")}
                      >
                        {t("Reject")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => withdraw.mutate(d.id)}
                        disabled={withdraw.isPending}
                      >
                        {t("Withdraw")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={resolveTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeResolve();
        }}
        ariaLabel={
          resolveTarget?.mode === "reject"
            ? t("Reject dispute")
            : t("Resolve dispute")
        }
      >
        <DialogHeader>
          <DialogTitle>
            {resolveTarget?.mode === "reject"
              ? t("Reject dispute")
              : t("Resolve dispute")}
          </DialogTitle>
          <DialogDescription>
            {t("Add a resolution note (5+ characters).")}
          </DialogDescription>
        </DialogHeader>
        <textarea
          aria-label={t("Resolution note")}
          className="min-h-[100px] w-full rounded-lg border border-input bg-background p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={t("Explain the outcome…")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
        />
        <DialogFooter>
          <Button variant="outline" onClick={closeResolve} disabled={submitting}>
            {t("Cancel")}
          </Button>
          <Button onClick={submitResolution} disabled={submitting}>
            {submitting
              ? t("Saving...")
              : resolveTarget?.mode === "reject"
                ? t("Reject")
                : t("Resolve")}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
