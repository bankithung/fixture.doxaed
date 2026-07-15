import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Award,
  Check,
  EyeOff,
  Link2,
  Plus,
  QrCode,
  X,
} from "lucide-react";
import {
  lensApi,
  type LensCampaign,
  type LensCard,
  type LensPhoto,
  type LensSettingsBody,
} from "@/api/lens";
import { tournamentsApi } from "@/api/tournaments";
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
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { newEventId } from "@/lib/eventId";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { ApiError } from "@/types/api";
import { PassPrintSheet } from "./PassPrintSheet";

type TabKey = "campaign" | "cards" | "moderate" | "awards";

const DEFAULT_CATEGORIES = [
  "Best Team Spirit",
  "Best Sportsmanship Moment",
  "Best Action Shot",
  "Best Fun Fair Moment",
  "Best Visiting School POV",
];

const DEFAULT_INSTRUCTIONS =
  "Scan your school's QR card and upload your best photos from the event. The teacher in charge holds the card; everyone's photos count toward one shared album.";
const DEFAULT_CONSENT =
  "Selected photos may be used by the host for event highlights and social media. Please upload only appropriate event photos.";

/** Map backend string-codes to a human toast message. */
function errMsg(e: unknown): string {
  const code = e instanceof ApiError ? String(e.payload?.detail ?? "") : "";
  switch (code) {
    case "fixtures_not_generated":
      return t("Generate the fixtures first, then open the campaign.");
    case "unknown_category":
      return t("That award category is not on this campaign.");
    case "not_approved":
      return t("Only approved photos can win an award.");
    case "campaign_closed":
      return t("The campaign is closed.");
    default:
      return t("Something went wrong. Please try again.");
  }
}

interface SettingsDraft {
  title: string;
  tagline: string;
  instructions: string;
  consent_note: string;
  max_photos_per_institution: number;
  award_categories: string[];
  category_limits: Record<string, number>;
}

function draftFrom(c: LensCampaign | null): SettingsDraft {
  return {
    title: c?.title ?? "Guest Lens",
    tagline: c?.tagline ?? "36 Shots Challenge",
    instructions: c?.instructions ?? DEFAULT_INSTRUCTIONS,
    consent_note: c?.consent_note ?? DEFAULT_CONSENT,
    max_photos_per_institution: c?.max_photos_per_institution ?? 36,
    award_categories: c?.award_categories ?? DEFAULT_CATEGORIES,
    category_limits: c?.category_limits ?? {},
  };
}

const FIELD =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const AREA =
  "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Compact campaign-settings form (pre-open hero + Campaign tab share it). */
function SettingsFields({
  draft,
  onChange,
}: {
  draft: SettingsDraft;
  onChange: (d: SettingsDraft) => void;
}): React.ReactElement {
  const [newCat, setNewCat] = useState("");
  const addCategory = (): void => {
    const v = newCat.trim();
    if (!v || draft.award_categories.includes(v)) return;
    onChange({ ...draft, award_categories: [...draft.award_categories, v] });
    setNewCat("");
  };
  const removeCategory = (cat: string): void => {
    const limits = { ...draft.category_limits };
    delete limits[cat];
    onChange({
      ...draft,
      award_categories: draft.award_categories.filter((c) => c !== cat),
      category_limits: limits,
    });
  };
  const setLimit = (cat: string, raw: string): void => {
    const limits = { ...draft.category_limits };
    if (raw === "") {
      delete limits[cat];
    } else {
      limits[cat] = Math.min(500, Math.max(1, Number(raw) || 1));
    }
    onChange({ ...draft, category_limits: limits });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lens-title">{t("Campaign title")}</Label>
          <Input
            id="lens-title"
            className="h-9"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lens-tagline">{t("Tagline")}</Label>
          <Input
            id="lens-tagline"
            className="h-9"
            value={draft.tagline}
            onChange={(e) => onChange({ ...draft, tagline: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-cap">{t("Photos per school")}</Label>
        <input
          id="lens-cap"
          type="number"
          min={1}
          max={500}
          className={cn(FIELD, "max-w-32 font-tabular")}
          value={draft.max_photos_per_institution}
          onChange={(e) =>
            onChange({
              ...draft,
              max_photos_per_institution: Math.max(
                1,
                Number(e.target.value) || 1,
              ),
            })
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t("Categories")}</span>
        <p className="text-xs text-muted-foreground">
          {t("Schools pick a category for each upload. Set a per school photo limit for a category, or leave it blank for no limit.")}
        </p>
        {draft.award_categories.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {draft.award_categories.map((cat) => (
              <li
                key={cat}
                className="flex items-center gap-2 px-2.5 py-1.5"
                data-testid={`category-row-${cat}`}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{cat}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  placeholder={t("No limit")}
                  aria-label={`${t("Photo limit per school for")} ${cat}`}
                  data-testid={`limit-${cat}`}
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right font-tabular text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.category_limits[cat] ?? ""}
                  onChange={(e) => setLimit(cat, e.target.value)}
                />
                <button
                  type="button"
                  aria-label={`${t("Remove category")} ${cat}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                  onClick={() => removeCategory(cat)}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            className="h-9 max-w-64"
            placeholder={t("Add a category")}
            aria-label={t("New award category")}
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCategory();
              }
            }}
          />
          <Button variant="outline" size="sm" onClick={addCategory}>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Add")}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-instructions">{t("Instructions on the card")}</Label>
        <textarea
          id="lens-instructions"
          className={AREA}
          value={draft.instructions}
          onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="lens-consent">{t("Consent note")}</Label>
        <textarea
          id="lens-consent"
          className={AREA}
          value={draft.consent_note}
          onChange={(e) => onChange({ ...draft, consent_note: e.target.value })}
        />
      </div>
    </div>
  );
}

function statusChip(photo: LensPhoto): React.ReactElement {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] font-medium",
        photo.status === "approved" && "bg-primary/10 text-primary",
        photo.status === "pending" && "bg-muted text-muted-foreground",
        photo.status === "hidden" && "bg-destructive/10 text-destructive",
      )}
    >
      {photo.status === "approved"
        ? t("In album")
        : photo.status === "pending"
          ? t("Pending")
          : t("Hidden")}
    </span>
  );
}

/**
 * Guest Lens manager console: Campaign settings, printable QR pass cards,
 * moderation grid, and award winners (spec 2026-07-10 §4.2). Manager-only
 * route under /tournaments/:id/lens.
 */
export function LensConsolePage(): React.ReactElement {
  const { id = "", campaignId = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const { isMobile } = useBreakpoint();

  // Land on the operational view, not the settings form: a running campaign
  // opens on Moderate (the photos actually needing attention); a fresh one with
  // no cards yet opens on Cards (the setup step). Settings is a tab you visit,
  // not the front page. `null` = "use the derived default"; a click pins it.
  const [tabState, setTab] = useState<TabKey | null>(null);
  const [cards, setCards] = useState<LensCard[]>([]);
  const [confirm, setConfirm] = useState<
    | { kind: "close" }
    | { kind: "reopen" }
    | { kind: "rotate"; passId: string; name: string }
    | { kind: "revoke"; passId: string; name: string }
    | null
  >(null);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [instFilter, setInstFilter] = useState<string>("");
  const [catFilter, setCatFilter] = useState<string>("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [hideTarget, setHideTarget] = useState<LensPhoto | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [pickCategory, setPickCategory] = useState<string | null>(null);

  const overviewQ = useQuery({
    queryKey: [...qk.lens(id), campaignId],
    queryFn: () => lensApi.overview(id, campaignId),
    enabled: Boolean(id && campaignId),
  });
  const tournamentQ = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
    enabled: Boolean(id),
  });
  const campaign = overviewQ.data?.campaign ?? null;
  // Derived default landing tab (see the tabState comment above).
  const defaultTab: TabKey =
    (overviewQ.data?.stats.passes_active ?? 0) > 0 ? "moderate" : "cards";
  const tab = tabState ?? defaultTab;

  const photosQ = useQuery({
    queryKey: [...qk.lensPhotos(id), campaignId, statusFilter, instFilter, catFilter],
    queryFn: () =>
      lensApi.photos(id, campaignId, {
        status: statusFilter || undefined,
        institution_id: instFilter || undefined,
        category: catFilter || undefined,
      }),
    enabled: Boolean(id && campaignId) && campaign !== null,
  });
  const approvedQ = useQuery({
    queryKey: [...qk.lensPhotos(id), campaignId, "approved", ""],
    queryFn: () => lensApi.photos(id, campaignId, { status: "approved" }),
    enabled: Boolean(id && campaignId) && campaign !== null && tab === "awards",
  });
  const photos = useMemo(() => photosQ.data?.photos ?? [], [photosQ.data]);
  const approvedPhotos = approvedQ.data?.photos ?? [];
  // Approved photos still carrying an award_category the manager later removed
  // from the campaign: without a panel these prizes are unclearable (and keep
  // showing on the public album), so surface them with a Clear action.
  const orphanAwards = approvedPhotos.filter(
    (p) =>
      p.award_category &&
      !(campaign?.award_categories ?? []).includes(p.award_category),
  );

  // The settings form starts from the campaign (or the defaults pre-open) and
  // only becomes local state once the manager edits something — no effect
  // needed to sync it after a refetch.
  const [draftEdits, setDraft] = useState<SettingsDraft | null>(null);
  const draft = draftEdits ?? draftFrom(campaign);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: qk.lens(id) });
    void qc.invalidateQueries({ queryKey: qk.lensPhotos(id) });
  };
  const fail = (e: unknown): void => {
    push({ kind: "error", title: errMsg(e) });
  };

  const updateM = useMutation({
    mutationFn: (body: LensSettingsBody) =>
      lensApi.update(id, campaignId, { ...body, event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Settings saved") });
    },
    onError: fail,
  });
  const closeM = useMutation({
    mutationFn: () => lensApi.close(id, campaignId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Campaign closed") });
    },
    onError: fail,
  });
  const reopenM = useMutation({
    mutationFn: () => lensApi.reopen(id, campaignId, { event_id: newEventId() }),
    onSuccess: () => {
      invalidate();
      push({ kind: "success", title: t("Campaign reopened") });
    },
    onError: fail,
  });
  const mintM = useMutation({
    mutationFn: () => lensApi.mint(id, campaignId, { event_id: newEventId() }),
    onSuccess: (res) => {
      invalidate();
      setCards(res.cards);
      push({
        kind: "success",
        title: res.cards.length
          ? t("Cards generated")
          : t("Every school already has a card"),
      });
    },
    onError: fail,
  });
  const rotateM = useMutation({
    mutationFn: (passId: string) =>
      lensApi.rotate(id, passId, { event_id: newEventId() }),
    onSuccess: (res) => {
      invalidate();
      setCards((cur) => [
        res.card,
        ...cur.filter((c) => c.pass_id !== res.card.pass_id),
      ]);
      push({ kind: "success", title: t("Card regenerated") });
    },
    onError: fail,
  });
  const revokeM = useMutation({
    mutationFn: (passId: string) =>
      lensApi.revoke(id, passId, { event_id: newEventId() }),
    onSuccess: (_res, passId) => {
      invalidate();
      setCards((cur) => cur.filter((c) => c.pass_id !== passId));
      push({ kind: "success", title: t("Card revoked") });
    },
    onError: fail,
  });
  const approveM = useMutation({
    mutationFn: (photoId: string) =>
      lensApi.approve(id, photoId, { event_id: newEventId() }),
    onSuccess: (_res, photoId) => {
      // Keep the moderator moving: the approved photo drops out of the Pending
      // grid on refetch, so advance the lightbox to the next item instead of
      // letting it close, so the queue can be cleared without reopening each.
      setLightbox((cur) => {
        if (cur !== photoId) return cur;
        const idx = photos.findIndex((p) => p.id === photoId);
        if (idx < 0) return null;
        const next = photos[idx + 1] ?? photos[idx - 1] ?? null;
        return next ? next.id : null;
      });
      invalidate();
      push({ kind: "success", title: t("Photo approved") });
    },
    onError: fail,
  });
  const hideM = useMutation({
    mutationFn: (vars: { photoId: string; reason: string }) =>
      lensApi.hide(id, vars.photoId, {
        event_id: newEventId(),
        reason: vars.reason || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setHideTarget(null);
      setHideReason("");
      setLightbox(null);
      push({ kind: "success", title: t("Photo hidden") });
    },
    onError: fail,
  });
  const awardM = useMutation({
    mutationFn: (vars: { photoId: string; category: string }) =>
      lensApi.award(id, vars.photoId, {
        event_id: newEventId(),
        category: vars.category,
      }),
    onSuccess: (_res, vars) => {
      invalidate();
      setPickCategory(null);
      push({
        kind: "success",
        title: vars.category ? t("Winner chosen") : t("Award cleared"),
      });
    },
    onError: fail,
  });

  const lightboxIdx = photos.findIndex((p) => p.id === lightbox);
  const lightboxPhoto = lightboxIdx >= 0 ? photos[lightboxIdx] : null;

  // Winner picker: photos filed under the category are the natural entries;
  // when none exist (older uploads carry no category) fall back to all
  // approved photos so a winner can still be chosen.
  const inCategory = pickCategory
    ? approvedPhotos.filter((p) => p.category === pickCategory)
    : [];
  const pickable = inCategory.length > 0 ? inCategory : approvedPhotos;

  // Lightbox prev/next on arrow keys while it is open.
  useEffect(() => {
    if (!lightboxPhoto) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" && lightboxIdx < photos.length - 1) {
        setLightbox(photos[lightboxIdx + 1].id);
      }
      if (e.key === "ArrowLeft" && lightboxIdx > 0) {
        setLightbox(photos[lightboxIdx - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxPhoto, lightboxIdx, photos]);

  const slug = tournamentQ.data?.slug ?? "";
  const copyAlbumLink = async (): Promise<void> => {
    if (!slug) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${routes.publicAlbum(slug, id, campaignId)}`,
      );
      push({ kind: "success", title: t("Album link copied") });
    } catch {
      push({ kind: "error", title: t("Could not copy the link") });
    }
  };

  if (overviewQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (overviewQ.isError || !overviewQ.data) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("The Guest Lens overview could not be loaded.")}
        </p>
      </div>
    );
  }
  const overview = overviewQ.data;
  const stats = overview.stats;

  // ---- The campaign in the URL no longer exists (deleted / bad link). ----
  if (!campaign) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="page-title">{t("Guest Lens")}</h1>
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-sm font-medium">{t("This campaign was not found.")}</p>
          <Link
            to={routes.tournamentLens(id)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t("Back to campaigns")}
          </Link>
        </section>
      </div>
    );
  }

  // ---- Open campaign: tabbed console. Operational tabs lead; Settings is
  // last (it's configure-once, not the front page). ----
  const TABS: { key: TabKey; label: string }[] = [
    { key: "moderate", label: t("Moderate") },
    { key: "cards", label: t("Cards") },
    { key: "awards", label: t("Awards") },
    { key: "campaign", label: t("Settings") },
  ];
  const statCells: { label: string; value: number }[] = [
    { label: t("Schools"), value: stats.institutions_total },
    { label: t("Active cards"), value: stats.passes_active },
    { label: t("Photos"), value: stats.photos_total },
    { label: t("Pending"), value: stats.photos_pending },
    { label: t("Approved"), value: stats.photos_approved },
    { label: t("Hidden"), value: stats.photos_hidden },
  ];
  const instOptions = [
    { value: "", label: t("All schools") },
    ...overview.passes.map((p) => ({
      value: p.institution_id,
      label: p.institution_name,
    })),
  ];
  const catOptions = [
    { value: "", label: t("All categories") },
    ...campaign.award_categories.map((c) => ({ value: c, label: c })),
  ];

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link
          to={routes.tournamentLens(id)}
          data-testid="lens-back"
          aria-label={t("Back to campaigns")}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="page-title">{campaign.title}</h1>
          <p className="text-xs text-muted-foreground">{campaign.tagline}</p>
        </div>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium",
            campaign.is_open
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
          data-testid="campaign-state"
        >
          {campaign.is_open ? t("Open") : t("Closed")}
        </span>
        {slug ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void copyAlbumLink()}
            data-testid="copy-album-link"
          >
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Copy album link")}
          </Button>
        ) : null}
      </div>

      {/* One combined section: the overview stats and the bookmark tabs share
          a single card, and the stats stay visible on every tab (they used to
          be a separate panel buried inside Campaign). */}
      <section className="panel print:hidden">
        <div className="grid grid-cols-3 divide-x divide-border border-b border-border sm:grid-cols-6">
          {statCells.map((cell) => (
            <div key={cell.label} className="px-3 py-2.5">
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {cell.label}
              </p>
              <p className="font-tabular text-xl font-semibold">{cell.value}</p>
            </div>
          ))}
        </div>
        <div
          role="tablist"
          aria-label={t("Guest Lens sections")}
          className="flex gap-0.5 overflow-x-auto px-2"
        >
          {TABS.map((tb) => (
            <button
              key={tb.key}
              type="button"
              role="tab"
              data-testid={`lens-tab-${tb.key}`}
              aria-selected={tab === tb.key}
              aria-current={tab === tb.key ? "page" : undefined}
              onClick={() => setTab(tb.key)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                tab === tb.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.label}
              {tb.key === "moderate" && stats.photos_pending > 0 ? (
                <span className="rounded-full bg-primary/10 px-1.5 font-tabular text-xs text-primary">
                  {stats.photos_pending}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </section>

      {tab === "campaign" ? (
        <div className="flex flex-col gap-4 print:hidden">
          <section className="panel">
            <div className="panel-header justify-between">
              <h3 className="panel-title">{t("Settings")}</h3>
              {campaign.is_open ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirm({ kind: "close" })}
                  data-testid="close-campaign-btn"
                >
                  {t("Close campaign")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => setConfirm({ kind: "reopen" })}
                  data-testid="reopen-campaign-btn"
                >
                  {t("Reopen campaign")}
                </Button>
              )}
            </div>
            <div className="p-4">
              <SettingsFields draft={draft} onChange={setDraft} />
              <div className="mt-4">
                <Button
                  data-testid="save-settings-btn"
                  disabled={updateM.isPending}
                  onClick={() => updateM.mutate(draft)}
                >
                  {t("Save settings")}
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {tab === "cards" ? (
        <div className="flex flex-col gap-4">
          {cards.length > 0 ? (
            <PassPrintSheet
              cards={cards}
              tournamentName={tournamentQ.data?.name ?? ""}
              tagline={campaign.tagline}
              consentNote={campaign.consent_note}
            />
          ) : null}
          <section className="panel print:hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <h3 className="panel-title">{t("Pass cards")}</h3>
              <span className="font-tabular text-xs text-muted-foreground">
                {overview.passes.length}
              </span>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => mintM.mutate()}
                disabled={mintM.isPending}
                data-testid="mint-btn"
              >
                <QrCode aria-hidden="true" className="h-4 w-4" />
                {t("Generate cards")}
              </Button>
            </div>
            {overview.passes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {t("No cards yet. Generate cards to give each school its QR pass.")}
              </p>
            ) : isMobile ? (
              <ul className="divide-y divide-border">
                {overview.passes.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1.5 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {p.institution_name}
                      </span>
                      {p.is_active ? null : (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-destructive">
                          {t("Revoked")}
                        </span>
                      )}
                    </div>
                    <p className="font-tabular text-xs text-muted-foreground">
                      {p.photos_used}/{campaign.max_photos_per_institution}{" "}
                      {t("photos")}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setConfirm({
                            kind: "rotate",
                            passId: p.id,
                            name: p.institution_name,
                          })
                        }
                      >
                        {t("Regenerate")}
                      </Button>
                      {p.is_active ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() =>
                            setConfirm({
                              kind: "revoke",
                              passId: p.id,
                              name: p.institution_name,
                            })
                          }
                        >
                          {t("Revoke")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="passes-table">
                  <thead className="border-b border-border">
                    <tr>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("School")}
                      </th>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Status")}
                      </th>
                      <th className="px-4 py-2 text-right text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Photos used")}
                      </th>
                      <th className="px-4 py-2 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        {t("Last minted")}
                      </th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {overview.passes.map((p) => (
                      <tr key={p.id} data-testid={`pass-row-${p.id}`}>
                        <td className="px-4 py-2 text-sm font-medium">
                          {p.institution_name}
                        </td>
                        <td className="px-4 py-2 text-sm">
                          {p.is_active ? (
                            <span className="text-success">{t("Active")}</span>
                          ) : (
                            <span className="text-destructive">
                              {t("Revoked")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-tabular text-sm">
                          {p.photos_used}/{campaign.max_photos_per_institution}
                        </td>
                        <td className="px-4 py-2 text-sm text-muted-foreground">
                          {p.last_minted_at
                            ? new Date(p.last_minted_at).toLocaleString([], {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : ""}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setConfirm({
                                  kind: "rotate",
                                  passId: p.id,
                                  name: p.institution_name,
                                })
                              }
                              data-testid={`rotate-${p.id}`}
                            >
                              {t("Regenerate")}
                            </Button>
                            {p.is_active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() =>
                                  setConfirm({
                                    kind: "revoke",
                                    passId: p.id,
                                    name: p.institution_name,
                                  })
                                }
                                data-testid={`revoke-${p.id}`}
                              >
                                {t("Revoke")}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "moderate" ? (
        <section className="panel flex flex-col print:hidden">
          {/* Filters + the photo grid live in ONE card (redesign 2026-07-15):
              status segments and the category/school pickers sit on the panel
              header, the photos fill the body. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5">
              {(
                [
                  { key: "pending", label: t("Pending"), n: stats.photos_pending },
                  { key: "approved", label: t("Approved"), n: stats.photos_approved },
                  { key: "hidden", label: t("Hidden"), n: stats.photos_hidden },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  aria-pressed={statusFilter === chip.key}
                  data-testid={`filter-${chip.key}`}
                  onClick={() => setStatusFilter(chip.key)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    statusFilter === chip.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {chip.label}
                  <span className="font-tabular">{chip.n}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              {campaign.award_categories.length > 0 ? (
                <div className="w-full sm:w-52">
                  <Select
                    size="sm"
                    aria-label={t("Filter by category")}
                    value={catFilter}
                    onChange={setCatFilter}
                    options={catOptions}
                  />
                </div>
              ) : null}
              <div className="w-full sm:w-52">
                <Select
                  size="sm"
                  aria-label={t("Filter by school")}
                  value={instFilter}
                  onChange={setInstFilter}
                  options={instOptions}
                />
              </div>
            </div>
          </div>
          {photosQ.isLoading ? (
            <div className="p-4">
              <div className="h-40 animate-pulse rounded-lg border border-border bg-muted" />
            </div>
          ) : photosQ.isError ? (
            <p role="alert" className="px-4 py-12 text-center text-sm text-destructive">
              {t("These photos could not be loaded. Refresh to try again.")}
            </p>
          ) : photos.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {t("No photos here yet.")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
              {photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`photo-${p.id}`}
                  onClick={() => setLightbox(p.id)}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={p.thumb_url}
                    alt={p.caption || p.institution_name}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                  <div className="flex flex-col gap-0.5 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {p.institution_name}
                      </span>
                      {statusChip(p)}
                    </div>
                    {p.category ? (
                      <span className="truncate text-[0.625rem] text-muted-foreground">
                        {p.category}
                      </span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === "awards" ? (
        <div className="flex flex-col gap-4 print:hidden">
          <section className="panel">
            <div className="flex items-center gap-2 border-b border-border p-3">
              <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
              <h3 className="panel-title">{t("Award winners")}</h3>
              {campaign.award_categories.length > 0 ? (
                <span className="font-tabular text-xs text-muted-foreground">
                  {campaign.award_categories.length}
                </span>
              ) : null}
            </div>
            {approvedQ.isLoading ? (
              <div className="p-4">
                <div className="h-40 animate-pulse rounded-lg border border-border bg-muted" />
              </div>
            ) : approvedQ.isError ? (
              <p role="alert" className="px-4 py-12 text-center text-sm text-destructive">
                {t("The approved photos could not be loaded. Refresh to try again.")}
              </p>
            ) : campaign.award_categories.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {t("No award categories. Add some in Settings.")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {campaign.award_categories.map((cat) => {
                  const winner = approvedPhotos.find(
                    (p) => p.award_category === cat,
                  );
                  return (
                    <div
                      key={cat}
                      data-testid={`award-panel-${cat}`}
                      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-3"
                    >
                      <div className="flex items-center gap-1.5">
                        <Award aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                        <h4 className="text-[13px] font-semibold">{cat}</h4>
                      </div>
                      {winner ? (
                        <>
                          <img
                            src={winner.thumb_url}
                            alt={winner.caption || winner.institution_name}
                            loading="lazy"
                            className="aspect-video w-full rounded-md object-cover"
                          />
                          <p className="text-sm font-medium">
                            {winner.institution_name}
                          </p>
                        </>
                      ) : (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                          {t("No winner yet")}
                        </p>
                      )}
                      <div className="mt-auto flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPickCategory(cat)}
                          data-testid={`choose-winner-${cat}`}
                        >
                          {winner ? t("Change winner") : t("Choose winner")}
                        </Button>
                        {winner ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              awardM.mutate({ photoId: winner.id, category: "" })
                            }
                          >
                            {t("Clear")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          {orphanAwards.length > 0 ? (
            <section className="panel" data-testid="orphan-awards">
              <div className="panel-header">
                <Award
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-muted-foreground"
                />
                <h3 className="panel-title">{t("Removed categories")}</h3>
              </div>
              <div className="flex flex-col gap-2 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("These photos still hold a category you removed. Clear each to take it off the album.")}
                </p>
                <ul className="flex flex-col gap-2">
                  {orphanAwards.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <img
                        src={p.thumb_url}
                        alt={p.caption || p.institution_name}
                        loading="lazy"
                        className="h-10 w-10 rounded object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {p.institution_name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {p.award_category}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`clear-orphan-${p.id}`}
                        onClick={() =>
                          awardM.mutate({ photoId: p.id, category: "" })
                        }
                      >
                        {t("Clear")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* Close / reopen / rotate / revoke confirmations. */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        ariaLabel={t("Confirm action")}
      >
        {confirm ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {confirm.kind === "close"
                  ? t("Close the campaign?")
                  : confirm.kind === "reopen"
                    ? t("Reopen the campaign?")
                    : confirm.kind === "rotate"
                      ? t("Regenerate this card?")
                      : t("Revoke this card?")}
              </DialogTitle>
              <DialogDescription>
                {confirm.kind === "close"
                  ? t("Uploading stops for every school. The album stays public.")
                  : confirm.kind === "reopen"
                    ? t("Schools can upload photos again.")
                    : confirm.kind === "rotate"
                      ? `${confirm.name}. ${t("The old QR card stops working and a new one prints.")}`
                      : `${confirm.name}. ${t("The school can no longer upload photos.")}`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                {t("Cancel")}
              </Button>
              <Button
                data-testid="confirm-action-btn"
                variant={confirm.kind === "revoke" ? "destructive" : "default"}
                onClick={() => {
                  if (confirm.kind === "close") closeM.mutate();
                  else if (confirm.kind === "reopen") reopenM.mutate();
                  else if (confirm.kind === "rotate")
                    rotateM.mutate(confirm.passId);
                  else revokeM.mutate(confirm.passId);
                  setConfirm(null);
                }}
              >
                {t("Confirm")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>

      {/* Moderation lightbox. */}
      <Dialog
        open={lightboxPhoto !== null && hideTarget === null}
        onOpenChange={(o) => {
          if (!o) setLightbox(null);
        }}
        ariaLabel={t("Photo review")}
      >
        {lightboxPhoto ? (
          <div className="flex flex-col gap-3" data-testid="lightbox">
            <img
              src={lightboxPhoto.url}
              alt={lightboxPhoto.caption || lightboxPhoto.institution_name}
              className="max-h-[60vh] w-full rounded-md object-contain"
            />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {lightboxPhoto.institution_name}
                </p>
                {lightboxPhoto.caption ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {lightboxPhoto.caption}
                  </p>
                ) : null}
                {lightboxPhoto.category ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {t("Category")}: {lightboxPhoto.category}
                  </p>
                ) : null}
              </div>
              {statusChip(lightboxPhoto)}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={lightboxIdx <= 0}
                onClick={() => setLightbox(photos[lightboxIdx - 1]?.id ?? null)}
              >
                {t("Previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={lightboxIdx >= photos.length - 1}
                onClick={() => setLightbox(photos[lightboxIdx + 1]?.id ?? null)}
              >
                {t("Next")}
              </Button>
              {lightboxPhoto.status !== "hidden" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  data-testid="hide-btn"
                  onClick={() => {
                    setHideTarget(lightboxPhoto);
                    setHideReason("");
                  }}
                >
                  <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Hide")}
                </Button>
              ) : null}
              {lightboxPhoto.status !== "approved" ? (
                <Button
                  size="sm"
                  data-testid="approve-btn"
                  disabled={approveM.isPending}
                  onClick={() => approveM.mutate(lightboxPhoto.id)}
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Approve")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* Hide-with-reason dialog. */}
      <Dialog
        open={hideTarget !== null}
        onOpenChange={(o) => {
          if (!o) setHideTarget(null);
        }}
        ariaLabel={t("Hide photo")}
      >
        {hideTarget ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("Hide this photo?")}</DialogTitle>
              <DialogDescription>
                {t("It leaves the public album and its file is quarantined. You can approve it again later.")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hide-reason">{t("Reason (optional)")}</Label>
              <Input
                id="hide-reason"
                className="h-9"
                value={hideReason}
                onChange={(e) => setHideReason(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setHideTarget(null)}>
                {t("Cancel")}
              </Button>
              <Button
                variant="destructive"
                data-testid="confirm-hide-btn"
                disabled={hideM.isPending}
                onClick={() =>
                  hideM.mutate({ photoId: hideTarget.id, reason: hideReason })
                }
              >
                {t("Hide photo")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>

      {/* Award winner picker. */}
      <Dialog
        open={pickCategory !== null}
        onOpenChange={(o) => {
          if (!o) setPickCategory(null);
        }}
        ariaLabel={t("Choose a winner")}
      >
        {pickCategory ? (
          <div className="flex flex-col gap-3">
            <DialogHeader>
              <DialogTitle>{pickCategory}</DialogTitle>
              <DialogDescription>
                {pickable.length > 0 && pickable.length < approvedPhotos.length
                  ? t("Pick the winning photo from this category's approved entries.")
                  : t("Pick the winning photo. Only approved photos can win.")}
              </DialogDescription>
            </DialogHeader>
            {approvedQ.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("Loading the approved photos.")}
              </p>
            ) : pickable.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("Approve some photos first.")}
              </p>
            ) : (
              <div className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto">
                {pickable.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`pick-${p.id}`}
                    disabled={awardM.isPending}
                    onClick={() =>
                      awardM.mutate({ photoId: p.id, category: pickCategory })
                    }
                    className={cn(
                      "overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      p.award_category === pickCategory
                        ? "border-primary ring-1 ring-primary"
                        : "border-border",
                    )}
                  >
                    <img
                      src={p.thumb_url}
                      alt={p.caption || p.institution_name}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
