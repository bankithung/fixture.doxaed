import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ScrollText } from "lucide-react";
import { judgingApi, type JudgeCriterion, type JudgeEntry } from "@/api/lens";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * The judge's sheet, reached by a link.
 *
 * **It does not know whose photograph it is.** The rules promise judges a view
 * with the school's and photographer's identities hidden, so the payload never
 * carries them — there is nothing here to accidentally render.
 *
 * A photo story is ONE entry: its four photographs are shown together, in the
 * order the school arranged them, under the story rubric.
 */
export function JudgePanelPage(): React.ReactElement {
  const { token = "" } = useParams();
  const q = useQuery({
    queryKey: ["judge-panel", token],
    queryFn: () => judgingApi.panel(token),
    enabled: Boolean(token),
    retry: false,
  });

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="h-64 animate-pulse rounded-xl bg-muted/40" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">{t("This link is not valid.")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Ask the organisers for a new judging link.")}
        </p>
      </div>
    );
  }

  const { judge, campaign, rubrics, entries, totals } = q.data;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <BrandLogo className="h-7 w-7 rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{campaign.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("Judging as")} {judge.name}
          </p>
        </div>
        <span
          data-testid="judge-progress"
          className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 font-tabular text-xs font-medium text-primary"
        >
          {totals.scored}/{totals.entries}
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          {t(
            "Entries are shown without the school or the photographer. Scores save as you set them and can be revised until judging closes.",
          )}
        </p>
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-10 text-center">
            <ScrollText aria-hidden="true" className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium">{t("Nothing to judge yet.")}</p>
            <p className="text-xs text-muted-foreground">
              {t("Entries appear here as schools upload them.")}
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <EntrySheet
              key={entry.id}
              token={token}
              entry={entry}
              criteria={
                entry.kind === "story"
                  ? rubrics.story.criteria
                  : rubrics.photo.criteria
              }
              guide={
                entry.kind === "story" ? rubrics.story.guide : rubrics.photo.guide
              }
            />
          ))
        )}
      </main>
    </div>
  );
}

function EntrySheet({
  token,
  entry,
  criteria,
  guide,
}: {
  token: string;
  entry: JudgeEntry;
  criteria: JudgeCriterion[];
  guide: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [marks, setMarks] = useState<Record<string, number>>(
    () => entry.score?.marks ?? {},
  );
  const [note, setNote] = useState(entry.score?.note ?? "");

  const total = useMemo(
    () =>
      criteria.reduce(
        (n, c) => n + Math.min(Math.max(marks[c.key] ?? 0, 0), c.max),
        0,
      ),
    [criteria, marks],
  );

  const save = useMutation({
    mutationFn: () =>
      judgingApi.score(token, {
        kind: entry.kind,
        entry_id: entry.id,
        marks,
        note,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["judge-panel", token] });
      toast.push({ kind: "success", title: t("Score saved") });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not save that score.") }),
  });

  return (
    <section
      data-testid={`judge-entry-${entry.id}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary">
          {entry.category}
        </span>
        {entry.kind === "story" ? (
          <span className="rounded-md bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
            {entry.photos.length} {t("photographs, one entry")}
          </span>
        ) : null}
        {entry.score ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-success">
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Scored")}
          </span>
        ) : null}
      </header>

      <div
        className={cn(
          "grid gap-2",
          entry.photos.length > 1 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-1",
        )}
      >
        {entry.photos.map((p, i) => (
          <a
            key={p.url}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={entry.photos.length > 1 ? p.thumb_url : p.url}
              alt={`${entry.caption || t("Entry")} ${i + 1}`}
              loading="lazy"
              className={cn(
                "w-full object-cover",
                entry.photos.length > 1 ? "aspect-[4/3]" : "max-h-[46vh] object-contain",
              )}
            />
          </a>
        ))}
      </div>

      {entry.caption ? (
        <p className="text-sm font-medium">{entry.caption}</p>
      ) : null}
      {entry.description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.description}
        </p>
      ) : null}

      <p className="text-[0.6875rem] italic text-muted-foreground">{guide}</p>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {criteria.map((c) => (
          <label key={c.key} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-xs">{c.label}</span>
            <input
              type="range"
              min={0}
              max={c.max}
              value={marks[c.key] ?? 0}
              data-testid={`mark-${entry.id}-${c.key}`}
              onChange={(e) =>
                setMarks({ ...marks, [c.key]: Number(e.target.value) })
              }
              className="h-1.5 w-32 shrink-0 accent-primary sm:w-48"
            />
            <span className="w-12 shrink-0 text-right font-tabular text-xs">
              {marks[c.key] ?? 0}
              <span className="text-muted-foreground">/{c.max}</span>
            </span>
          </label>
        ))}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder={t("A note for the panel (optional)")}
        aria-label={t("Note")}
        data-testid={`note-${entry.id}`}
        className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm"
      />

      <div className="flex items-center gap-3">
        <span className="font-tabular text-lg font-semibold">
          {total}
          <span className="text-sm text-muted-foreground">/100</span>
        </span>
        <Button
          className="ml-auto"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          data-testid={`save-${entry.id}`}
        >
          {save.isPending ? t("Saving") : t("Save score")}
        </Button>
      </div>
    </section>
  );
}
