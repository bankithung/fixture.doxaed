import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ClipboardList, Plus } from "lucide-react";
import {
  INSTITUTION_KINDS,
  institutionsApi,
  type InstitutionInput,
} from "@/api/institutions";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { EmptyState } from "./shared";

const BLANK: InstitutionInput = { name: "", kind: "school", region: "", contact_email: "" };

export function InstitutionsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<InstitutionInput>(BLANK);

  const list = useQuery({
    queryKey: ["t-institutions", id],
    queryFn: () => institutionsApi.list(id),
  });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage = stage.data?.can_manage ?? false;

  const create = useMutation({
    mutationFn: () => institutionsApi.create(id, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["t-institutions", id] });
      qc.invalidateQueries({ queryKey: ["tournament-stage", id] });
      toast.push({ kind: "success", title: t("Institution added") });
      setOpen(false);
      setForm(BLANK);
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not add institution"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const items = list.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("Institutions")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("The schools/colleges taking part. Add them directly, or open the registration form for them to apply.")}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={routes.tournamentForms(id)}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ClipboardList aria-hidden="true" className="h-4 w-4" />
              {t("Registration form")}
            </Link>
            <Button onClick={() => setOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add institution")}
            </Button>
          </div>
        ) : null}
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
          title={t("No institutions yet")}
          hint={t("Add a school/college directly, or share the registration form so they can apply themselves.")}
        >
          {canManage ? (
            <Button onClick={() => setOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add institution")}
            </Button>
          ) : null}
        </EmptyState>
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

      {/* Add-institution dialog */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) setOpen(false);
        }}
        ariaLabel={t("Add institution")}
      >
        <DialogHeader>
          <DialogTitle>{t("Add institution")}</DialogTitle>
          <DialogDescription>
            {t("Register a school/college directly. You can also collect these via the registration form.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Name")}</span>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("e.g. Mount Hermon School")}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t("Type")}</span>
              <Select
                value={form.kind ?? "school"}
                onChange={(v) => setForm((f) => ({ ...f, kind: v }))}
                options={INSTITUTION_KINDS.map((k) => ({ value: k.value, label: t(k.label) }))}
                aria-label={t("Type")}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t("Region / district")}</span>
              <Input
                value={form.region ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Contact email")}</span>
            <Input
              type="email"
              value={form.contact_email ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!form.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t("Adding…") : t("Add institution")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
