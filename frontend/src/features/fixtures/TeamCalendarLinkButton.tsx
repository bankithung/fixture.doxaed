import { useMutation } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/t";

/**
 * Per-team "Calendar link" (trust layer, increment H): mints the signed
 * iCal-feed URL for one team and copies it — schools subscribe once and
 * every repair/shift lands in their phone calendar automatically.
 */
export function TeamCalendarLinkButton({
  tournamentId,
  teamId,
  teamName,
}: {
  tournamentId: string;
  teamId: string;
  teamName: string;
}): React.ReactElement {
  const toast = useToast();
  const mint = useMutation({
    mutationFn: () => tournamentsApi.teamCalendarLink(tournamentId, teamId),
    onSuccess: async (r) => {
      try {
        await navigator.clipboard.writeText(r.url);
        toast.push({
          kind: "success",
          title: t("Calendar link copied"),
          description: t("Subscribe to it in any calendar app — schedule changes update automatically."),
        });
      } catch {
        toast.push({ kind: "info", title: t("Calendar link"), description: r.url });
      }
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not create the calendar link") }),
  });

  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={`calendar-link-${teamId}`}
      aria-label={t(`Calendar link for ${teamName}`)}
      disabled={mint.isPending}
      onClick={(e) => {
        e.stopPropagation();
        mint.mutate();
      }}
    >
      <CalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
      {t("Calendar link")}
    </Button>
  );
}
