import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Home, Trophy } from "lucide-react";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { tournamentsApi, type TournamentScope } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/tailwind";
import { routes } from "@/lib/routes";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

const schema = z.object({
  name: z.string().min(1, t("Tournament name is required")).max(200),
});

/** Who competes. Asked HERE and only here: it decides which setup stages
 * exist, so it cannot be changed once registration data exists. */
const SCOPES: {
  value: TournamentScope;
  label: string;
  hint: string;
  icon: typeof Trophy;
}[] = [
  {
    value: "inter_school",
    label: t("Between schools"),
    hint: t("Each school registers, then enters its own teams."),
    icon: Building2,
  },
  {
    value: "intra_school",
    label: t("Within one school"),
    hint: t("Houses or classes compete. No school registration — you set up the groups."),
    icon: Home,
  },
];
type FormValues = z.infer<typeof schema>;

/**
 * Self-serve "Start a tournament" page. Posting auto-provisions the creator's
 * hidden personal workspace and makes them the tournament admin (no org concept
 * shown). On success we land on the workspace dashboard.
 */
export function CreateTournamentPage(): React.ReactElement {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [scope, setScope] = useState<TournamentScope>("inter_school");
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "" },
  });

  const onSubmit = async (values: FormValues): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const created = await tournamentsApi.create({
        name: values.name,
        event_id: newEventId(),
        scope,
      });
      // Refresh the list so the new tournament shows without a manual reload.
      await qc.invalidateQueries({ queryKey: ["tournaments"] });
      // Land INSIDE the new workspace (FlowLanding routes to the first setup
      // step) — creation used to dump the admin back on the list to go find
      // their own tournament.
      navigate(routes.tournamentDetail(created.id));
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not create tournament"))
          : t("Could not create tournament"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[80dvh] w-full items-center justify-center px-4 py-10">
      <BentoGrid className="w-full max-w-md">
        <BentoCard particles className="animate-fade-up p-6 sm:p-8">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Trophy aria-hidden="true" className="h-6 w-6 text-primary" />
          </span>
          <h1 className="mt-4 text-center text-2xl font-semibold tracking-tight">
            {t("Start a tournament")}
          </h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {t("Name it. You'll be admin and can invite people next.")}
          </p>

        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="mt-6 flex flex-col gap-4"
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t("Tournament name")}</Label>
            <Input
              id="name"
              autoFocus
              placeholder={t("e.g. Kohima Premier League 2026")}
              aria-invalid={!!form.formState.errors.name}
              {...form.register("name")}
            />
            {form.formState.errors.name ? (
              <p role="alert" className="text-xs text-destructive">
                {form.formState.errors.name.message}
              </p>
            ) : null}
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1.5 text-sm font-medium">{t("Who is competing?")}</legend>
            <div className="grid gap-2">
              {SCOPES.map((s) => {
                const Icon = s.icon;
                const on = scope === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-testid={`scope-${s.value}`}
                    onClick={() => setScope(s.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      on
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border hover:bg-secondary/40",
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        on ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Button type="submit" disabled={submitting} size="lg" className="w-full">
            {submitting ? t("Creating...") : t("Create tournament")}
          </Button>
        </form>
        </BentoCard>
      </BentoGrid>
    </div>
  );
}
