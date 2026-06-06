import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { disputesApi } from "@/api/disputes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

const KINDS = ["score", "eligibility", "conduct", "other"] as const;

/** Disputes section for a tournament: raise + list + resolve/reject/withdraw. */
export function DisputesPanel({
  tournamentId,
}: {
  tournamentId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["disputes", tournamentId],
    queryFn: () => disputesApi.list(tournamentId),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["disputes", tournamentId] });

  const [kind, setKind] = useState<string>("score");
  const [desc, setDesc] = useState("");

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

  const promptResolve = (id: string, kind_: "resolve" | "reject") => {
    const note = window.prompt(t("Resolution note (min 5 chars):"));
    if (note && note.trim().length >= 5) {
      (kind_ === "resolve" ? resolve : reject).mutate({ id, resolution: note.trim() });
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{t("Disputes")}</h2>

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (desc.trim()) raise.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="dispute-kind" className="text-xs">{t("Type")}</Label>
          <select
            id="dispute-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{t(k)}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="dispute-desc" className="text-xs">{t("Describe the issue")}</Label>
          <Input
            id="dispute-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="min-w-56"
          />
        </div>
        <Button type="submit" size="sm" disabled={!desc.trim() || raise.isPending}>
          {t("Raise dispute")}
        </Button>
      </form>

      {disputes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No disputes raised.")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {disputes.map((d) => (
            <li key={d.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t(d.kind)}</span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t(d.status.replace(/_/g, " "))}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{d.description}</p>
              {d.resolution ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Resolution")}: {d.resolution}
                </p>
              ) : null}
              {d.status === "open" || d.status === "under_review" ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => promptResolve(d.id, "resolve")}
                  >
                    {t("Resolve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => promptResolve(d.id, "reject")}
                  >
                    {t("Reject")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(d.id)}>
                    {t("Withdraw")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
