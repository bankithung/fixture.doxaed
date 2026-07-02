import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Plus, Search, Trophy } from "lucide-react";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { Input } from "@/components/ui/input";
import { RoleBadge } from "@/components/ui/RoleBadge";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { RenameTournamentButton } from "./RenameTournamentButton";
import { canManageTournament } from "./tournamentPermissions";

/** Show the search/filter row only once the list is long enough to need it. */
const SEARCH_THRESHOLD = 4;

/**
 * Color-coded tournament status (soft tint + accessible text, dark-mode aware).
 * Mirrors the named-palette pill convention already used for institution
 * statuses — a richer signal than the flat brand tokens.
 */
// Tokens only (owner rule): semantic status colors, no Tailwind palette.
const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  published: { label: "Published", cls: "bg-info-muted text-info-foreground" },
  registration_open: {
    label: "Registration open",
    cls: "bg-success-muted text-success-foreground",
  },
  scheduled: { label: "Scheduled", cls: "bg-secondary text-secondary-foreground" },
  completed: { label: "Completed", cls: "bg-accent text-accent-foreground" },
  archived: { label: "Archived", cls: "bg-muted text-muted-foreground" },
};

function statusStyle(status: string): { label: string; cls: string; pulse: boolean } {
  if (status.startsWith("live"))
    return { label: "Live", cls: "bg-primary/15 text-primary", pulse: true };
  const s = STATUS_STYLES[status];
  return {
    label: s?.label ?? status.replace(/_/g, " "),
    cls: s?.cls ?? "bg-muted text-muted-foreground",
    pulse: false,
  };
}

/** Soft, distinct monogram tint per tournament (deterministic by name) —
 * token opacity steps, not palette colors. */
const TINTS = [
  "bg-primary/15 text-primary",
  "bg-success-muted text-success-foreground",
  "bg-info-muted text-info-foreground",
  "bg-warning-muted text-warning-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-accent text-accent-foreground",
];

function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

function formatCreated(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "·";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function sportLabel(code: string | null): string {
  return code ? code.replace(/_/g, " ") : "";
}

/** Square monogram tile anchoring each row/card, softly tinted per tournament. */
export function Monogram({ name }: { name: string }): React.ReactElement {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg text-sm font-semibold",
        tintFor(name),
      )}
    >
      {initial}
    </span>
  );
}

export function StatusPill({ status }: { status: string }): React.ReactElement {
  const s = statusStyle(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        s.cls,
      )}
    >
      <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
        {s.pulse ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {t(s.label)}
    </span>
  );
}

function Sport({ code }: { code: string | null }): React.ReactElement {
  return code ? (
    <span className="capitalize text-muted-foreground">{sportLabel(code)}</span>
  ) : (
    <span className="text-muted-foreground/40">·</span>
  );
}

/** How the user got this tournament: gold Owner chip (created it / owns the
 * workspace) vs the tournament-scoped role(s) they were invited with. */
function AccessBadge({ tn }: { tn: Tournament }): React.ReactElement {
  if (tn.origin === "owner") return <RoleBadge role="owner" />;
  const roles = tn.my_roles ?? [];
  if (tn.origin !== "invited" || roles.length === 0)
    return <span className="text-muted-foreground/40">·</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {roles.map((role) => (
        <RoleBadge key={role} role={role} />
      ))}
    </span>
  );
}

/**
 * The primary post-login surface: tournaments the user runs OR was invited
 * into (server isolation-scoped), shown as a clean table — click a row to open
 * the tournament workspace. (Member invites live inside each tournament's
 * Members area, not here.)
 */
export function TournamentsListPage(): React.ReactElement {
  const { up } = useBreakpoint();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const all = useMemo(() => query.data ?? [], [query.data]);

  const q = search.trim().toLowerCase();
  const tournaments = useMemo(
    () =>
      q
        ? all.filter(
            (tn) => tn.name.toLowerCase().includes(q) || tn.slug.toLowerCase().includes(q),
          )
        : all,
    [all, q],
  );

  const startCta = (
    <Link
      to={routes.tournamentNew()}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus aria-hidden="true" className="h-4 w-4" />
      {t("Start a tournament")}
    </Link>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("Your tournaments")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Tournaments you run or were invited into.")}
          </p>
        </div>
        {startCta}
      </div>

      {query.isLoading ? (
        <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load tournaments.")}
        </p>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <Trophy aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {t("You haven't started any tournaments yet.")}
          </p>
          {startCta}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {all.length > SEARCH_THRESHOLD ? (
            <div className="flex items-center gap-3">
              <label className="relative max-w-xs flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("Search tournaments…")}
                  className="h-9 pl-9"
                  aria-label={t("Search tournaments")}
                />
              </label>
              <span className="font-tabular text-xs text-muted-foreground">
                {tournaments.length === all.length
                  ? all.length
                  : `${tournaments.length}/${all.length}`}
              </span>
            </div>
          ) : null}

          {tournaments.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card py-8 text-center text-sm text-muted-foreground">
              {t("No tournaments match your search.")}
            </p>
          ) : up("lg") ? (
            <TournamentTable
              items={tournaments}
              onOpen={(id) => navigate(routes.tournamentDetail(id))}
            />
          ) : (
            <TournamentCards items={tournaments} />
          )}
        </div>
      )}
    </div>
  );
}

function TournamentTable({
  items,
  onOpen,
}: {
  items: Tournament[];
  onOpen: (id: string) => void;
}): React.ReactElement {
  return (
    // table-fixed + w-full → the table always fits its container (never forces a
    // horizontal scrollbar); the name/slug truncate and the less-important
    // columns drop on narrower widths.
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">{t("Tournament")}</th>
            <th className="hidden w-24 px-3 py-2.5 font-medium 2xl:table-cell">{t("Sport")}</th>
            <th className="w-40 px-3 py-2.5 font-medium">{t("Status")}</th>
            <th className="w-28 px-3 py-2.5 font-medium">{t("Your role")}</th>
            <th className="hidden w-28 px-3 py-2.5 font-medium xl:table-cell">{t("Created")}</th>
            <th className="w-24 px-4 py-2.5">
              <span className="sr-only">{t("Open")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((tn) => (
            <tr
              key={tn.id}
              onClick={() => onOpen(tn.id)}
              className="group cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-accent/40"
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <Monogram name={tn.name} />
                  <div className="min-w-0">
                    <Link
                      to={routes.tournamentDetail(tn.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate font-medium tracking-tight hover:text-primary focus-visible:text-primary focus-visible:underline focus-visible:outline-none"
                    >
                      {tn.name}
                    </Link>
                    <div className="truncate font-tabular text-xs text-muted-foreground">
                      {tn.slug}
                    </div>
                  </div>
                </div>
              </td>
              <td className="hidden px-3 py-3 2xl:table-cell">
                <Sport code={tn.sport_code} />
              </td>
              <td className="px-3 py-3">
                <StatusPill status={tn.status} />
              </td>
              <td className="px-3 py-3">
                <AccessBadge tn={tn} />
              </td>
              <td className="hidden whitespace-nowrap px-3 py-3 font-tabular text-muted-foreground xl:table-cell">
                {formatCreated(tn.created_at)}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  {canManageTournament(tn.origin, tn.my_roles) ? (
                    <RenameTournamentButton
                      tournamentId={tn.id}
                      currentName={tn.name}
                    />
                  ) : null}
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TournamentCards({ items }: { items: Tournament[] }): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {items.map((tn) => (
        <div
          key={tn.id}
          className="flex items-center gap-1 rounded-xl border border-border bg-card pr-2 shadow-sm transition-colors hover:bg-accent/40"
        >
          <Link
            to={routes.tournamentDetail(tn.id)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Monogram name={tn.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{tn.name}</span>
                <StatusPill status={tn.status} />
                <AccessBadge tn={tn} />
              </div>
              <div className="mt-0.5 truncate font-tabular text-xs text-muted-foreground">
                <span>{tn.slug}</span>
                {tn.sport_code ? <span className="capitalize"> · {sportLabel(tn.sport_code)}</span> : null}
                <span> · {formatCreated(tn.created_at)}</span>
              </div>
            </div>
          </Link>
          {canManageTournament(tn.origin, tn.my_roles) ? (
            <RenameTournamentButton tournamentId={tn.id} currentName={tn.name} />
          ) : null}
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/50" />
        </div>
      ))}
    </div>
  );
}
