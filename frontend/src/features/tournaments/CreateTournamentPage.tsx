import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { tournamentsApi } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { newEventId } from "@/lib/eventId";
import { t } from "@/lib/t";

const schema = z.object({
  name: z.string().min(1, t("Tournament name is required")).max(200),
});
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
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="text-center text-2xl font-semibold tracking-tight">
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
          <Button type="submit" disabled={submitting} size="lg" className="w-full">
            {submitting ? t("Creating...") : t("Create tournament")}
          </Button>
        </form>
      </div>
    </div>
  );
}
