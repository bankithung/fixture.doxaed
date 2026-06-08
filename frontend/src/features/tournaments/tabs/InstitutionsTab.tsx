import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  ExternalLink,
  Eye,
  Link2,
  Pencil,
  Plus,
  Send,
} from "lucide-react";
import { institutionsApi } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { CreateFormDialog } from "../CreateFormDialog";
import { EmptyState } from "./shared";

const ORG_PURPOSE = "organization_registration";
const ORG_STAGE = "org_registration";

export function InstitutionsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const forms = useQuery({ queryKey: ["forms", id], queryFn: () => formsApi.list(id) });
  const list = useQuery({ queryKey: ["t-institutions", id], queryFn: () => institutionsApi.list(id) });
  const stage = useQuery({ queryKey: ["tournament-stage", id], queryFn: () => tournamentsApi.stage(id) });
  const canManage = stage.data?.can_manage ?? false;

  // The org-registration form bound to this stage (or by purpose, for legacy).
  const orgForm =
    (forms.data ?? []).find((f) => f.stage === ORG_STAGE) ??
    (forms.data ?? []).find((f) => f.purpose === ORG_PURPOSE);

  const [createOpen, setCreateOpen] = useState(false);

  const publish = useMutation({
    mutationFn: () => formsApi.publish(orgForm!.id),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Registration form is open") });
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not open the form"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : "",
      }),
  });

  const publicUrl = orgForm ? `${window.location.origin}/f/${orgForm.id}` : "";
  const directoryUrl = orgForm ? `${window.location.origin}/f/${orgForm.id}/directory` : "";

  const copy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.push({ kind: "success", title: t("Link copied") });
    } catch {
      toast.push({ kind: "error", title: t("Could not copy"), description: url });
    }
  };

  const items = list.data ?? [];
  const isOpen = orgForm?.status === "open";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">{t("Institution registration")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Build one registration form. Share it for schools to apply, or fill it yourself to add them — same form, one source of truth.")}
        </p>
      </div>

      {/* The form is the single mechanism. */}
      {canManage ? (
        !orgForm ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card py-10 text-center">
            <Building2 aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium">{t("Create the registration form first")}</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {t("Add the questions you want schools to answer (name, contact, sport, categories). You can then share it or fill it in yourself.")}
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Create registration form")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{orgForm.title}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
                      isOpen ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {t(orgForm.status)}
                  </span>
                </div>
                <p className="mt-0.5 font-tabular text-xs text-muted-foreground">
                  {orgForm.response_count} {t("submissions")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(routes.tournamentFormBuilder(id, orgForm.id))}
                >
                  <Pencil aria-hidden="true" className="h-4 w-4" />
                  {t("Edit form")}
                </Button>
                {!isOpen ? (
                  <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
                    <Send aria-hidden="true" className="h-4 w-4" />
                    {t("Open registration")}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void copy(publicUrl)}>
                      {copied ? (
                        <Check aria-hidden="true" className="h-4 w-4" />
                      ) : (
                        <Link2 aria-hidden="true" className="h-4 w-4" />
                      )}
                      {t("Share link")}
                    </Button>
                    <Button size="sm" onClick={() => navigate(`/f/${orgForm.id}`)}>
                      <Plus aria-hidden="true" className="h-4 w-4" />
                      {t("Add institute")}
                    </Button>
                  </>
                )}
              </div>
            </div>
            {isOpen ? (
              <a
                href={directoryUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                {t("View public directory of registered institutions")}
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        )
      ) : null}

      {/* Registered institutions */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("Registered institutions")}</h3>
          <span className="font-tabular text-xs text-muted-foreground">{items.length}</span>
        </div>
        {list.isLoading ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-muted" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title={t("No institutions registered yet")}
            hint={t("Share the form, or fill it in yourself with “Add institute”.")}
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((i) => (
              <div
                key={i.id}
                className={cn(
                  "rounded-xl border border-border bg-card p-4 shadow-sm",
                  i.status === "withdrawn" && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{i.name}</div>
                    <div className="mt-0.5 text-xs capitalize text-muted-foreground">
                      {t(i.kind)}
                      {i.region ? ` · ${i.region}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
                    {i.team_count} {t("teams")}
                  </span>
                </div>
                {i.contact_email ? (
                  <div className="mt-2 truncate text-xs text-muted-foreground">{i.contact_email}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateFormDialog
        tournamentId={id}
        stage={ORG_STAGE}
        purpose={ORG_PURPOSE}
        defaultTitle={t("Institution registration")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
