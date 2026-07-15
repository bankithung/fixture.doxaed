import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronRight, ImageIcon, Plus } from "lucide-react";
import { lensApi, type LensSettingsBody } from "@/api/lens";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";

function errMsg(e: unknown): string {
  const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
  if (code === "fixtures_not_generated") {
    return t("Generate the fixtures first, then create a campaign.");
  }
  return t("Something went wrong. Please try again.");
}

/**
 * Guest Lens landing (multi-campaign, 2026-07-15): a tournament can run several
 * photo campaigns, so this is the picker — every campaign as a card plus a
 * "New campaign" action. Picking one opens its console; the console is now
 * scoped to a campaign id in the route.
 */
export function LensCampaignListPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { push } = useToast();

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("Guest Lens");
  const [tagline, setTagline] = useState("36 Shots Challenge");

  const listQ = useQuery({
    queryKey: qk.lensCampaigns(id),
    queryFn: () => lensApi.campaigns(id),
    enabled: Boolean(id),
  });
  // The legacy no-campaign overview still reports whether fixtures exist (the
  // gate for creating a campaign at all).
  const gateQ = useQuery({
    queryKey: [...qk.lens(id), "_gate"],
    queryFn: () => lensApi.overview(id),
    enabled: Boolean(id),
  });
  const fixturesReady = gateQ.data?.fixtures_ready ?? false;
  const campaigns = listQ.data?.campaigns ?? [];

  const createM = useMutation({
    mutationFn: (body: LensSettingsBody) =>
      lensApi.create(id, { ...body, event_id: newEventId() }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.lensCampaigns(id) });
      setCreating(false);
      push({ kind: "success", title: t("Campaign created") });
      nav(routes.tournamentLensCampaign(id, res.campaign.id));
    },
    onError: (e) => push({ kind: "error", title: errMsg(e) }),
  });

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{t("Guest Lens")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("Shared photo albums your visiting schools capture.")}
          </p>
        </div>
        <Button
          className="ml-auto"
          size="sm"
          data-testid="lens-new-campaign"
          disabled={!fixturesReady}
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("New campaign")}
        </Button>
      </div>

      {!fixturesReady ? (
        <p
          className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-xs text-muted-foreground"
          data-testid="fixtures-hint"
        >
          {t("Generate the fixtures first. Campaigns open once the schedule exists.")}
        </p>
      ) : null}

      {listQ.isLoading ? (
        <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
      ) : campaigns.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <Camera aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("No photo campaigns yet")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t(
              "Each campaign is one shared album: schools scan a QR pass and upload their best shots, you approve and pick winners.",
            )}
          </p>
          {fixturesReady ? (
            <Button
              size="sm"
              data-testid="lens-new-campaign-empty"
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("New campaign")}
            </Button>
          ) : null}
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <Link
              key={c.id}
              to={routes.tournamentLensCampaign(id, c.id)}
              data-testid={`lens-campaign-${c.id}`}
              className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold">{c.title}</h3>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.tagline}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                    c.is_open
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {c.is_open ? t("Open") : t("Closed")}
                </span>
              </div>
              <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="font-tabular">{c.photos_total}</span>
                  {t("photos")}
                </span>
                {c.photos_pending > 0 ? (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <span className="font-tabular">{c.photos_pending}</span>
                    {t("pending")}
                  </span>
                ) : null}
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto h-4 w-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
                />
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setCreating(false)}
          ariaLabel={t("New campaign")}
        >
          <DialogHeader>
            <DialogTitle>{t("New campaign")}</DialogTitle>
            <DialogDescription>
              {t("Name it now; the rest of the settings live in its console.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-campaign-title">{t("Campaign title")}</Label>
              <Input
                id="new-campaign-title"
                data-testid="new-campaign-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-campaign-tagline">{t("Tagline")}</Label>
              <Input
                id="new-campaign-tagline"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t("Cancel")}
            </Button>
            <Button
              data-testid="new-campaign-create"
              disabled={!title.trim() || createM.isPending}
              onClick={() => createM.mutate({ title: title.trim(), tagline: tagline.trim() })}
            >
              {t("Create campaign")}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </div>
  );
}
