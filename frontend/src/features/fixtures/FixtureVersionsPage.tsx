import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Printer, RotateCcw, Save } from "lucide-react";
import {
  tournamentsApi,
  type FixtureVersionMatch,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { humanizeLeaf } from "@/features/controlroom/format";

/**
 * Operations — **Fixture versions**. Every fixture this tournament has had.
 *
 * A fixture is drawn, scheduled, repaired and re-drawn, and until now each pass
 * overwrote the last with nothing kept: an organiser who preferred yesterday's
 * draw had no way back to it, and no way to show a school what moved. Every
 * generation and every scheduling run now freezes a copy, and one can be
 * opened, printed or put back.
 *
 * Restoring is refused once anything has been played — a fixture with results
 * in it is no longer a plan to rewind — and the fixture being replaced is
 * frozen first, so the restore itself can be undone.
 */
export function FixtureVersionsPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const [openId, setOpenId] = useState<string>("");
  const [confirmId, setConfirmId] = useState<string>("");
  const [label, setLabel] = useState("");

  const list = useQuery({
    queryKey: ["fixture-versions", id],
    queryFn: () => tournamentsApi.fixtureVersions(id),
    enabled: Boolean(id),
  });
  const detail = useQuery({
    queryKey: ["fixture-version", openId],
    queryFn: () => tournamentsApi.fixtureVersion(openId),
    enabled: Boolean(openId),
  });

  const save = useMutation({
    mutationFn: () => tournamentsApi.saveFixtureVersion(id, label.trim()),
    onSuccess: () => {
      setLabel("");
      push({ title: t("Fixture saved"), kind: "success" });
      void qc.invalidateQueries({ queryKey: ["fixture-versions", id] });
    },
    onError: () =>
      push({ title: t("Could not save this fixture"), kind: "error" }),
  });

  const restore = useMutation({
    mutationFn: (vid: string) => tournamentsApi.restoreFixtureVersion(vid),
    onSuccess: (r) => {
      setConfirmId("");
      push({
        title: t("Fixture restored"),
        description: `${r.restored} ${t("matches put back")}`,
        kind: "success",
      });
      void qc.invalidateQueries({ queryKey: ["fixture-versions", id] });
    },
    onError: (e: unknown) => {
      setConfirmId("");
      const msg =
        (e as { data?: { detail?: string } })?.data?.detail ??
        t("This fixture could not be restored.");
      push({ title: t("Not restored"), description: msg, kind: "error" });
    },
  });

  const versions = list.data?.versions ?? [];
  const confirming = versions.find((v) => v.id === confirmId);

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <History aria-hidden className="h-4 w-4 text-primary" />
          <h1 className="page-title">{t("Fixture versions")}</h1>
          <span className="font-tabular text-xs text-muted-foreground">
            {versions.length} {versions.length === 1 ? t("version") : t("versions")}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("Name this fixture")}
              aria-label={t("Name this fixture")}
              data-testid="version-label"
              className="h-9 w-48 rounded-md border border-border bg-background px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              data-testid="save-version"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              <Save aria-hidden className="h-3.5 w-3.5" />
              {t("Save current fixture")}
            </Button>
          </div>
        </div>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {t(
            "Every draw and every scheduling run is saved here automatically. Open one to read it, or put it back.",
          )}
        </p>

        {list.isLoading ? (
          <div className="h-40 animate-pulse bg-muted/40" />
        ) : versions.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t("No fixture has been generated yet.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table
              data-testid="versions-table"
              className="w-full min-w-[46rem] border-collapse text-sm"
            >
              <thead>
                <tr className="border-b border-border bg-muted text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                  {[
                    t("Saved"),
                    t("What happened"),
                    t("Name"),
                    t("Matches"),
                    t("Competitions"),
                    t("Days"),
                    t("By"),
                    "",
                  ].map((h, i) => (
                    <th
                      key={i}
                      scope="col"
                      className={cn(
                        "px-3 py-1.5 font-semibold",
                        i === 3 || i === 4 ? "text-right" : "text-left",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {versions.map((v, i) => (
                  <tr
                    key={v.id}
                    data-testid={`version-${v.id}`}
                    className="transition-colors hover:bg-accent"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-tabular text-xs">
                      {new Date(v.created_at).toLocaleString(undefined, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                      {i === 0 ? (
                        <span className="ml-2 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
                          {t("current")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {v.kind_label}
                    </td>
                    <td className="px-3 py-2">{v.label}</td>
                    <td className="px-3 py-2 text-right font-tabular">
                      {v.match_count}
                    </td>
                    <td className="px-3 py-2 text-right font-tabular text-muted-foreground">
                      {v.summary.competition_count ?? 0}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {(v.summary.days ?? []).length}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {v.created_by?.email ?? t("System")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`view-${v.id}`}
                        onClick={() => setOpenId(v.id)}
                      >
                        {t("View")}
                      </Button>
                      {i === 0 ? null : (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`restore-${v.id}`}
                          onClick={() => setConfirmId(v.id)}
                        >
                          <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                          {t("Restore")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* One frozen fixture, read-only, printable. */}
      <Dialog
        open={Boolean(openId)}
        onOpenChange={(o) => {
          if (!o) setOpenId("");
        }}
        ariaLabel={t("Fixture version")}
        variant="drawer"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t("Fixture version")}</h2>
          {detail.data ? (
            <span className="font-tabular text-xs text-muted-foreground">
              {detail.data.match_count} {t("matches")}
              {detail.data.label ? ` · ${detail.data.label}` : ""}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer aria-hidden className="h-3.5 w-3.5" />
              {t("Print")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpenId("")}>
              {t("Close")}
            </Button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {detail.isLoading ? (
            <div className="h-40 animate-pulse bg-muted/40" />
          ) : (
            <VersionSheet matches={detail.data?.matches ?? []} />
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(confirmId)}
        onOpenChange={(o) => {
          if (!o) setConfirmId("");
        }}
        ariaLabel={t("Restore this fixture")}
      >
        <DialogTitle>{t("Restore this fixture?")}</DialogTitle>
        <p className="pt-2 text-sm text-muted-foreground">
          {t(
            "Every match goes back to how it was in this version. The fixture you have now is saved first, so you can undo this.",
          )}
        </p>
        {confirming ? (
          <p className="pt-2 font-tabular text-xs text-muted-foreground">
            {new Date(confirming.created_at).toLocaleString()} ·{" "}
            {confirming.match_count} {t("matches")}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmId("")}>
            {t("Cancel")}
          </Button>
          <Button
            data-testid="confirm-restore"
            disabled={restore.isPending}
            onClick={() => confirmId && restore.mutate(confirmId)}
          >
            {t("Restore")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** The frozen fixture as a sheet: one aligned row per match, grouped by
 * competition, the way the live fixture reads. */
function VersionSheet({
  matches,
}: {
  matches: FixtureVersionMatch[];
}): React.ReactElement {
  const byLeaf = new Map<string, FixtureVersionMatch[]>();
  for (const m of matches) {
    const k = m.leaf_key || "_";
    if (!byLeaf.has(k)) byLeaf.set(k, []);
    byLeaf.get(k)!.push(m);
  }
  if (matches.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        {t("This version holds no matches.")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      {[...byLeaf.entries()].map(([leaf, ms]) => (
        <section
          key={leaf}
          data-testid={`version-leaf-${leaf}`}
          className="overflow-hidden rounded-lg border border-border"
        >
          <h3 className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm font-semibold">
            {leaf === "_" ? t("Fixtures") : humanizeLeaf(leaf)}
            <span className="font-tabular text-xs font-normal text-muted-foreground">
              {ms.length}
            </span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                  {[t("No"), t("Round"), t("Group"), t("When"), t("Court"), t("Status")].map(
                    (h) => (
                      <th key={h} scope="col" className="px-3 py-1.5 text-left font-semibold">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...ms]
                  .sort((a, b) => a.match_no - b.match_no)
                  .map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-1.5 font-tabular text-xs text-muted-foreground">
                        {m.match_no}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {m.stage} {m.round_no}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{m.group_label}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-tabular text-xs">
                        {m.scheduled_at
                          ? new Date(m.scheduled_at).toLocaleString(undefined, {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : t("TBD")}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {m.venue}
                      </td>
                      <td className="px-3 py-1.5 text-xs capitalize text-muted-foreground">
                        {m.status.replace(/_/g, " ")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
