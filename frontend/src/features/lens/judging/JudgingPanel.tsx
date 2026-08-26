import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Gavel, Plus, Trash2 } from "lucide-react";
import { judgingApi } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The organisers' side of judging: appoint the panel, hand out links, read the
 * verdict.
 *
 * A judge's link is shown ONCE, when they are appointed — it is the credential
 * itself, so it is stored hashed and cannot be listed again. Losing one means
 * appointing that judge afresh, which is the same trade the school cards make.
 */
export function JudgingPanel({
  campaignId,
}: {
  campaignId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ name: string; url: string } | null>(null);
  const [showResults, setShowResults] = useState(false);

  const judgesQ = useQuery({
    queryKey: ["lens-judges", campaignId],
    queryFn: () => judgingApi.judges(campaignId),
  });
  const resultsQ = useQuery({
    queryKey: ["lens-judging", campaignId],
    queryFn: () => judgingApi.results(campaignId),
    enabled: showResults,
  });

  const appoint = useMutation({
    mutationFn: () => judgingApi.appoint(campaignId, { name: name.trim() }),
    onSuccess: (j) => {
      setName("");
      setMinted({ name: j.name, url: j.url });
      void qc.invalidateQueries({ queryKey: ["lens-judges", campaignId] });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not appoint that judge.") }),
  });

  const revoke = useMutation({
    mutationFn: (judgeId: string) => judgingApi.revokeJudge(campaignId, judgeId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["lens-judges", campaignId] });
      toast.push({ kind: "success", title: t("Judging link revoked") });
    },
  });

  const judges = judgesQ.data?.judges ?? [];
  const entries = judgesQ.data?.entries ?? 0;

  return (
    <section
      data-testid="judging-panel"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10">
          <Gavel aria-hidden="true" className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("Judging panel")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("Judges score without seeing the school or the photographer.")}
          </p>
        </div>
        <span className="ml-auto font-tabular text-xs text-muted-foreground">
          {entries} {entries === 1 ? t("entry") : t("entries")}
        </span>
      </header>

      <div className="flex flex-wrap items-end gap-2 border-y border-border py-3">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium">{t("Appoint a judge")}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Their name")}
            data-testid="judge-name-input"
          />
        </label>
        <Button
          data-testid="appoint-judge-btn"
          disabled={!name.trim() || appoint.isPending}
          onClick={() => appoint.mutate()}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t("Appoint")}
        </Button>
      </div>

      {minted ? (
        <div
          data-testid="minted-link"
          className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
        >
          <p className="text-xs font-medium">
            {t("Send this link to")} {minted.name}.{" "}
            <span className="font-normal text-muted-foreground">
              {t("It is shown once — it is the credential itself.")}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 text-[0.6875rem]">
              {minted.url}
            </code>
            <Button
              size="sm"
              variant="outline"
              data-testid="copy-judge-link"
              onClick={() => {
                void navigator.clipboard?.writeText(minted.url);
                toast.push({ kind: "success", title: t("Link copied") });
              }}
            >
              <Copy className="mr-1.5 h-4 w-4" />
              {t("Copy")}
            </Button>
          </div>
        </div>
      ) : null}

      {judges.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t("No judges appointed yet.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {judges.map((j) => (
            <li
              key={j.id}
              data-testid={`judge-${j.id}`}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm",
                j.revoked && "opacity-50",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{j.name}</span>
              <span className="font-tabular text-xs text-muted-foreground">
                {j.scored}/{entries} {t("scored")}
              </span>
              {j.revoked ? (
                <span className="text-xs text-muted-foreground">
                  {t("revoked")}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => revoke.mutate(j.id)}
                  aria-label={`${t("Revoke")} ${j.name}`}
                  data-testid={`revoke-${j.id}`}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-3">
        <Button
          size="sm"
          variant="outline"
          data-testid="toggle-results"
          onClick={() => setShowResults(!showResults)}
        >
          {showResults ? t("Hide results") : t("Show results")}
        </Button>
        {showResults ? (
          <div className="mt-3 flex flex-col gap-4" data-testid="judging-results">
            {(resultsQ.data?.categories ?? []).map((cat) => (
              <div key={cat.category} className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {cat.category}
                </h4>
                {cat.entries.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="w-6 shrink-0 font-tabular text-xs text-muted-foreground">
                      {e.rank ?? "—"}
                    </span>
                    <img
                      src={e.photos[0]?.thumb_url}
                      alt=""
                      className="h-9 w-12 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {e.caption || t("Untitled")}
                      </span>
                      <span className="block truncate text-[0.6875rem] text-muted-foreground">
                        {e.school}
                        {e.photographer ? ` · ${e.photographer}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-tabular text-sm font-semibold">
                        {e.average ?? "—"}
                      </span>
                      <span className="block text-[0.625rem] text-muted-foreground">
                        {e.judges} {e.judges === 1 ? t("judge") : t("judges")}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
