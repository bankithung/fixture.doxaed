import { Fragment, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Clock,
  KeyRound,
  Link2,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trophy,
  Users,
} from "lucide-react";
import { institutionsApi } from "@/api/institutions";
import { formsApi } from "@/api/forms";
import {
  tournamentsApi,
  type TeamPlayerRow,
  type TeamRegistrationDetail,
  type TeamRow,
  type TournamentSport,
  type UploadRef,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { ActionMenu, ActionMenuItem } from "@/components/ui/menu";
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
import { FilePlus2 } from "lucide-react";
import { TeamCalendarLinkButton } from "@/features/fixtures/TeamCalendarLinkButton";
import { newEventId } from "@/lib/eventId";
import { invalidateTournament } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { t } from "@/lib/t";
import "@/components/ui/star-border.css";
import { StarBorder } from "@/components/ui/StarBorder";
import { RangePills } from "@/features/dashboard/RangePills";
import { CreateFormDialog } from "../CreateFormDialog";
import { configuredLeaves, EmptyState } from "./shared";

export function TeamsTab(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [institutionId, setInstitutionId] = useState("");
  const [name, setName] = useState("");
  // Access-codes dialog (Stage-2 security): send/re-send emailed codes and
  // recover schools without an email (manual entry or a temporary edit link).
  const [codesOpen, setCodesOpen] = useState(false);
  // Teams table vs the per-category counts view (same switch the
  // institutions page has — owner 2026-07-05).
  const [view, setView] = useState<"teams" | "categories">("teams");
  // Master-detail (owner 2026-07-05, ChMS-style): the school list on the
  // left drives which school's teams show on the right.
  const [selectedSchoolKey, setSelectedSchoolKey] = useState<string | null>(null);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [emailDrafts, setEmailDrafts] = useState<Record<string, string>>({});

  const refreshAfterCodes = (): void => {
    qc.invalidateQueries({ queryKey: ["t-institutions", id] });
  };
  // Send to ALL schools still missing a code.
  const issueAllCodes = useMutation({
    mutationFn: () => tournamentsApi.issueTeamCodes(id, {}),
    onSuccess: (r) => {
      refreshAfterCodes();
      toast.push({
        kind: "success",
        title:
          r.sent > 0
            ? t("Codes emailed")
            : t("Every school with an email already has a code"),
        description: `${r.sent} ${t("sent")} · ${r.no_email} ${t("without an email")}`,
      });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not send access codes") }),
  });
  // Send / resend to ONE chosen school (force-rotates that school's code).
  const issueOneCode = useMutation({
    mutationFn: (instId: string) =>
      tournamentsApi.issueTeamCodes(id, { institution_ids: [instId] }),
    onSuccess: (r) => {
      refreshAfterCodes();
      toast.push({
        kind: r.no_email > 0 ? "error" : "success",
        title: r.no_email > 0 ? t("No email on file") : t("Code emailed"),
      });
    },
    onError: () => toast.push({ kind: "error", title: t("Could not send the code") }),
  });
  const saveEmailAndSend = useMutation({
    mutationFn: async (instId: string) => {
      await institutionsApi.update(id, instId, {
        contact_email: (emailDrafts[instId] ?? "").trim(),
      });
      return tournamentsApi.issueTeamCodes(id, { institution_ids: [instId] });
    },
    onSuccess: () => {
      refreshAfterCodes();
      toast.push({ kind: "success", title: t("Code emailed") });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not save the email") }),
  });
  const copyEditLink = useMutation({
    mutationFn: (instId: string) => institutionsApi.editLink(id, instId),
    onSuccess: async (r) => {
      try {
        await navigator.clipboard.writeText(window.location.origin + r.path);
        toast.push({
          kind: "success",
          title: t("Temporary link copied"),
          description: t("Single-use; expires in 7 days. Share it with the school."),
        });
      } catch {
        toast.push({ kind: "success", title: t("Link created"), description: r.path });
      }
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not create the link") }),
  });

  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const sportsQ = useQuery({ queryKey: ["t-sports", id], queryFn: () => tournamentsApi.sports(id) });
  const institutions = useQuery({
    queryKey: ["t-institutions", id],
    queryFn: () => institutionsApi.list(id),
  });
  const forms = useQuery({ queryKey: ["forms", id], queryFn: () => formsApi.list(id) });
  const stage = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });
  const canManage = stage.data?.can_manage ?? false;
  const teamForm =
    (forms.data ?? []).find((f) => f.stage === "team_registration") ??
    (forms.data ?? []).find((f) => f.purpose === "team_registration");

  const generateForm = useMutation({
    mutationFn: () => formsApi.generateTeamForm(id),
    onSuccess: (f) => {
      invalidateTournament(qc, id);
      toast.push({
        kind: "success",
        title: t("Team form generated"),
        description: t("Review and edit the template, then open it for registration."),
      });
      navigate(routes.tournamentFormBuilder(id, f.id));
    },
    onError: () => toast.push({ kind: "error", title: t("Could not generate the team form") }),
  });

  // Every registered school is a row — with a submitted / not-yet status —
  // so the admin sees who has filled the team form and who hasn't. Teams are
  // attached by institution id; any team with no matching institution (legacy
  // direct adds) falls into its own trailing group.
  const schoolGroups = useMemo<SchoolGroup[]>(() => {
    const byInst = new Map<string, TeamRow[]>();
    const orphans: TeamRow[] = [];
    for (const tm of teams.data ?? []) {
      if (tm.institution_id) {
        const list = byInst.get(tm.institution_id) ?? [];
        list.push(tm);
        byInst.set(tm.institution_id, list);
      } else orphans.push(tm);
    }
    const groups: SchoolGroup[] = (institutions.data ?? []).map((inst) => {
      const rows = byInst.get(inst.id) ?? [];
      return {
        key: inst.id,
        name: inst.name,
        teams: rows,
        submitted: rows.length > 0,
        hasCode: !!inst.has_team_code,
      };
    });
    // Stable order: not-yet-submitted first (the admin's follow-up list).
    groups.sort((a, b) =>
      a.submitted === b.submitted
        ? a.name.localeCompare(b.name)
        : a.submitted
          ? 1
          : -1,
    );
    if (orphans.length)
      groups.push({
        key: "__orphans",
        name: t("Other teams"),
        teams: orphans,
        submitted: true,
        hasCode: false,
      });
    return groups;
  }, [teams.data, institutions.data]);
  const schoolQ = schoolQuery.trim().toLowerCase();
  const filteredGroups = schoolQ
    ? schoolGroups.filter((g) => g.name.toLowerCase().includes(schoolQ))
    : schoolGroups;
  const activeGroup =
    schoolGroups.find((g) => g.key === selectedSchoolKey) ??
    filteredGroups[0] ??
    null;

  const submittedCount = schoolGroups.filter(
    (g) => g.submitted && g.key !== "__orphans",
  ).length;
  const schoolCount = (institutions.data ?? []).length;

  const add = useMutation({
    mutationFn: () =>
      institutionsApi.addTeam(id, {
        institution_id: institutionId,
        name: name.trim(),
        event_id: newEventId(),
      }),
    onSuccess: () => {
      invalidateTournament(qc, id);
      toast.push({ kind: "success", title: t("Team added") });
      setOpen(false);
      setName("");
    },
    onError: (e) =>
      toast.push({
        kind: "error",
        title: t("Could not add team"),
        description: e instanceof ApiError ? (e.payload.detail ?? "") : t("Try again."),
      }),
  });

  const instOptions = (institutions.data ?? []).map((i) => ({ value: i.id, label: i.name }));

  return (
    <div className="flex flex-col gap-4">
      {/* ONE panel, same shape as Institution registration (owner
          2026-07-05): toolbar with the team count + view switch + actions,
          a slim progress row, the table below. */}
      <StarBorder>
      <section className="bento-card panel" aria-label={t("Team registration")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Users aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <h2 className="text-sm font-semibold">{t("Team registration")}</h2>
        {teamForm ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
              teamForm.status === "open"
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {t(teamForm.status)}
          </span>
        ) : null}
        <span className="flex items-baseline gap-1 pl-1" data-testid="teams-count">
          <span className="font-tabular text-base font-semibold leading-none">
            {(teams.data ?? []).length}
          </span>
          <span className="text-xs text-muted-foreground">
            {(teams.data ?? []).length === 1 ? t("team") : t("teams")}
          </span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RangePills
            label={t("View")}
            options={[
              { value: "teams", label: t("Teams") },
              { value: "categories", label: t("By category") },
            ]}
            value={view}
            onChange={(v) => setView(v as typeof view)}
          />
        {canManage ? (
          <>
            <ActionMenu label={t("Form tools")} icon={FilePlus2} data-testid="form-tools-menu">
              {teamForm?.status === "open" ? (
                <ActionMenuItem icon={KeyRound} onSelect={() => setCodesOpen(true)}>
                  {t("Access codes")}
                </ActionMenuItem>
              ) : null}
              {teamForm ? (
                <ActionMenuItem
                  icon={Pencil}
                  onSelect={() => navigate(routes.tournamentFormBuilder(id, teamForm.id))}
                >
                  {t("Edit team form")}
                </ActionMenuItem>
              ) : (
                <>
                  <ActionMenuItem
                    icon={Sparkles}
                    disabled={(institutions.data?.length ?? 0) === 0 || generateForm.isPending}
                    onSelect={() => generateForm.mutate()}
                    title={
                      (institutions.data?.length ?? 0) === 0
                        ? t("Register institutions first")
                        : undefined
                    }
                  >
                    {generateForm.isPending ? t("Generating…") : t("Auto-generate team form")}
                  </ActionMenuItem>
                  <ActionMenuItem icon={FilePlus2} onSelect={() => setCreateOpen(true)}>
                    {t("Create form")}
                  </ActionMenuItem>
                </>
              )}
            </ActionMenu>
            <Button
              disabled={(institutions.data?.length ?? 0) === 0}
              title={
                (institutions.data?.length ?? 0) === 0
                  ? t("Register an institution first")
                  : undefined
              }
              onClick={() => {
                // The team form IS the proper add page (full competition +
                // roster). An organizer opens it signed in → no access code.
                if (teamForm) navigate(routes.publicForm(teamForm.id));
                else {
                  setInstitutionId(institutions.data?.[0]?.id ?? "");
                  setOpen(true);
                }
              }}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add team")}
            </Button>
          </>
        ) : null}
        </div>
      </div>

      {/* Progress + hints row. */}
      {schoolCount > 0 || (canManage && !teamForm) ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-3 py-2 text-xs">
          {schoolCount > 0 ? (
            <span className="font-tabular font-medium text-muted-foreground">
              {submittedCount}/{schoolCount} {t("schools have submitted teams")}
            </span>
          ) : null}
          {canManage && (institutions.data?.length ?? 0) > 0 && !teamForm ? (
            <span className="text-muted-foreground">
              {t("Tip: “Auto-generate team form” builds a form from each institution's selected categories, ready to review and open.")}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="p-3">
        {schoolCount === 0 ? (
          <EmptyState
            icon={<Users className="h-8 w-8" />}
            title={t("No institutions yet")}
            hint={t("Register an institution first, then collect its teams.")}
          />
        ) : view === "categories" ? (
          <CategoryReport
            teams={teams.data ?? []}
            sports={sportsQ.data?.sports ?? []}
          />
        ) : (
          /* ChMS-style master-detail (owner 2026-07-05): pick a school on
             the left, its teams + rosters fill the right. */
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:w-80">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-[0.8125rem] font-semibold">
                  {t("Schools")}
                </span>
                <span className="font-tabular text-xs text-muted-foreground">
                  {filteredGroups.length === schoolGroups.length
                    ? schoolGroups.length
                    : `${filteredGroups.length}/${schoolGroups.length}`}
                </span>
              </div>
              <div className="border-b border-border p-2">
                <label className="relative block">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={schoolQuery}
                    onChange={(e) => setSchoolQuery(e.target.value)}
                    placeholder={t("Search schools…")}
                    aria-label={t("Search schools")}
                    className="h-8 pl-8"
                  />
                </label>
              </div>
              <ul className="max-h-[30rem] overflow-y-auto">
                {filteredGroups.map((g) => {
                  const active = g.key === activeGroup?.key;
                  return (
                    <li key={g.key}>
                      <button
                        type="button"
                        onClick={() => setSelectedSchoolKey(g.key)}
                        data-testid={`school-pick-${g.key}`}
                        aria-pressed={active}
                        className={cn(
                          "flex w-full items-center gap-2.5 border-b border-border/60 border-l-2 px-3 py-2.5 text-left transition-colors",
                          active
                            ? "border-l-primary bg-accent"
                            : "border-l-transparent hover:bg-accent/40",
                        )}
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-sm font-semibold text-primary">
                          {g.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {g.name}
                          </span>
                          <span className="block font-tabular text-xs text-muted-foreground">
                            {g.teams.length}{" "}
                            {g.teams.length === 1 ? t("team") : t("teams")}
                          </span>
                        </span>
                        <SubmissionBadge submitted={g.submitted} />
                      </button>
                    </li>
                  );
                })}
                {filteredGroups.length === 0 ? (
                  <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("No schools match.")}
                  </li>
                ) : null}
              </ul>
            </aside>
            <div className="min-w-0 flex-1">
              {activeGroup ? (
                <TeamsTable
                  key={activeGroup.key}
                  groups={[activeGroup]}
                  tournamentId={id}
                  canManage={canManage}
                />
              ) : (
                <p className="rounded-xl border border-dashed border-border bg-card py-10 text-center text-sm text-muted-foreground">
                  {t("Pick a school to see its teams.")}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      </section>
      </StarBorder>

      {/* Access codes — a per-school list: send to all at once, or send /
          resend to one; schools without an email get inline recovery. */}
      <Dialog
        open={codesOpen}
        onOpenChange={(o) => {
          if (!o) setCodesOpen(false);
        }}
        ariaLabel={t("Team access codes")}
      >
        <DialogHeader>
          <DialogTitle>{t("Team access codes")}</DialogTitle>
          <DialogDescription>
            {t(
              "Schools need their emailed code to register or edit teams. Send to all at once, or one at a time.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Button
            disabled={issueAllCodes.isPending}
            onClick={() => issueAllCodes.mutate()}
          >
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            {issueAllCodes.isPending
              ? t("Sending…")
              : t("Email codes to all schools without one")}
          </Button>
          <ul className="flex max-h-[22rem] flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {(institutions.data ?? []).map((inst) => {
              const hasEmail = (inst.contact_email ?? "").includes("@");
              return (
                <li key={inst.id} className="flex flex-col gap-1.5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {inst.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {inst.has_team_code
                          ? t("Code sent")
                          : hasEmail
                            ? t("No code yet")
                            : t("No contact email")}
                        {hasEmail ? ` · ${inst.contact_email}` : ""}
                      </span>
                    </div>
                    {hasEmail ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={issueOneCode.isPending}
                        onClick={() => issueOneCode.mutate(inst.id)}
                      >
                        {inst.has_team_code ? t("Resend") : t("Send code")}
                      </Button>
                    ) : null}
                  </div>
                  {!hasEmail ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="email"
                        value={emailDrafts[inst.id] ?? ""}
                        onChange={(e) =>
                          setEmailDrafts((d) => ({ ...d, [inst.id]: e.target.value }))
                        }
                        placeholder={t("contact@school.example")}
                        className="h-9 max-w-[15rem]"
                        aria-label={t(`Email for ${inst.name}`)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          saveEmailAndSend.isPending ||
                          !(emailDrafts[inst.id] ?? "").includes("@")
                        }
                        onClick={() => saveEmailAndSend.mutate(inst.id)}
                      >
                        {t("Save & send")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={copyEditLink.isPending}
                        onClick={() => copyEditLink.mutate(inst.id)}
                      >
                        <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("Temp link")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCodesOpen(false)}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) setOpen(false);
        }}
        ariaLabel={t("Add team")}
      >
        <DialogHeader>
          <DialogTitle>{t("Add team")}</DialogTitle>
          <DialogDescription>
            {t("Select the institution, then name the team.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Institution")}</span>
            <Select
              value={institutionId}
              onChange={setInstitutionId}
              options={instOptions}
              placeholder={t("Select an institution")}
              aria-label={t("Institution")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("Team name")}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("e.g. U-16 Boys")}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!institutionId || !name.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? t("Adding…") : t("Add team")}
          </Button>
        </DialogFooter>
      </Dialog>

      <CreateFormDialog
        tournamentId={id}
        stage="team_registration"
        purpose="team_registration"
        defaultTitle={t("Team registration")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

/** A row of uploaded-file chips — images preview as thumbnails, everything
 * else shows a paperclip; each opens the signed view URL in a new tab. */
function FileChips({ files }: { files: UploadRef[] }): React.ReactElement | null {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => {
        const isImg = f.content_type.startsWith("image/");
        // Show the respondent's document name when given; the filename is the
        // hover title so the admin can still see the original.
        const label = f.label || f.name;
        return (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={f.label ? f.name : undefined}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
          >
            {isImg ? (
              <img
                src={f.url}
                alt={label}
                className="h-6 w-6 shrink-0 rounded border border-border object-cover"
              />
            ) : (
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="max-w-[11rem] truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}

/** One line per player (jersey · name · captain · DOB); expands to documents
 * when there are any (owner 2026-06-17: "one line per player, details inline"). */
function PlayerRow({
  player,
}: {
  player: TeamRegistrationDetail["players"][number];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasDocs = player.documents.length > 0;
  return (
    <li className="rounded-md border border-border bg-background">
      <button
        type="button"
        disabled={!hasDocs}
        aria-expanded={hasDocs ? open : undefined}
        onClick={() => hasDocs && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          hasDocs && "hover:bg-accent/40",
        )}
      >
        <span className="w-5 shrink-0 text-right font-tabular text-xs text-muted-foreground">
          {player.jersey_no ?? ""}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {player.name || t("Unnamed")}
        </span>
        {player.captain ? (
          <span className="shrink-0 rounded bg-primary/15 px-1 font-tabular text-[0.6875rem] font-semibold text-primary">
            C
          </span>
        ) : null}
        {player.dob ? (
          <span className="shrink-0 font-tabular text-xs text-muted-foreground">
            {player.dob}
          </span>
        ) : null}
        {hasDocs ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 font-tabular text-[0.6875rem] text-muted-foreground">
            <Paperclip aria-hidden="true" className="h-3 w-3" />
            {player.documents.length}
          </span>
        ) : null}
        {hasDocs ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {open && hasDocs ? (
        <div className="border-t border-border/60 px-2.5 py-2">
          <p className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("Documents")}
          </p>
          <FileChips files={player.documents} />
        </div>
      ) : null}
    </li>
  );
}

/** A team's full registration detail — logo + coach(es) header, then one
 * expandable line per player. Lazily fetched: only mounted when the team is
 * expanded, so the list view stays cheap. Falls back to the inline roster while
 * the detail loads or when the team has no originating submission. */
function TeamDetail({
  tournamentId,
  teamId,
  teamName,
  fallback,
  canManage,
}: {
  tournamentId: string;
  teamId: string;
  teamName: string;
  fallback: TeamPlayerRow[];
  canManage: boolean;
}): React.ReactElement {
  const detail = useQuery({
    queryKey: ["team-reg-detail", tournamentId, teamId],
    queryFn: () => tournamentsApi.teamRegistrationDetail(tournamentId, teamId),
  });
  const d = detail.data;
  // Show the basic roster immediately (no DOB/docs) until the detail lands, so
  // expanding a team never flashes empty.
  const players: TeamRegistrationDetail["players"] =
    d?.players ??
    fallback.map((p) => ({
      id: p.id,
      name: p.full_name,
      jersey_no: p.jersey_no,
      position: p.position,
      captain: p.captain,
      dob: null,
      documents: [],
    }));

  return (
    <div className="flex flex-col gap-3">
      {d && (d.logo || d.coaches.length > 0) ? (
        <div className="flex flex-wrap items-start gap-4">
          {d.logo ? (
            <a href={d.logo.url} target="_blank" rel="noreferrer" className="shrink-0">
              <img
                src={d.logo.url}
                alt={t(`${teamName} logo`)}
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
            </a>
          ) : null}
          {d.coaches.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                {d.coaches.length === 1 ? t("Coach") : t("Coaches")}
              </span>
              {d.coaches.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  <FileChips files={c.documents} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {players.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {players.map((p) => (
            <PlayerRow key={p.id} player={p} />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">{t("No players yet.")}</p>
      )}
      {detail.isError ? (
        <p className="text-xs text-muted-foreground">
          {t("Couldn't load player details.")}
        </p>
      ) : null}

      {canManage ? (
        <TeamCalendarLinkButton
          tournamentId={tournamentId}
          teamId={teamId}
          teamName={teamName}
        />
      ) : null}
    </div>
  );
}

const TEAM_TH =
  "sticky top-0 z-10 border-b border-border bg-muted px-3 py-2.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground";
const TEAM_TD = "border-b border-border px-3 py-2.5 align-middle";

/** Render a competition leaf label ("Sport — Age — Gender — Format") as separate
 *  pills instead of a dashed string — the sport tinted, the rest muted (owner:
 *  no dashed strings). Empty label → "Uncategorized". */
function CompetitionLabel({ label }: { label: string }): React.ReactElement {
  if (!label) {
    return (
      <span className="text-xs text-muted-foreground">{t("Uncategorized")}</span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {label.split(/\s+[\u00b7\u2014]\s+/).map((seg, i) => (
        <span
          key={i}
          className={cn(
            "rounded px-1.5 py-0.5 text-xs",
            i === 0
              ? "bg-primary/10 font-medium text-primary"
              : "bg-muted text-foreground",
          )}
        >
          {seg}
        </span>
      ))}
    </span>
  );
}

/** Per-competition registration summary (teams / schools / players), one entry
 * per leaf, sorted by label (which groups by sport since the sport leads). */
export interface CategoryKpi {
  key: string;
  label: string;
  teams: number;
  schools: number;
  players: number;
}

export function categoryKpis(rows: TeamRow[]): CategoryKpi[] {
  const map = new Map<
    string,
    { label: string; teams: number; schools: Set<string>; players: number }
  >();
  for (const tm of rows) {
    const key = tm.leaf_key || "__uncategorized";
    let c = map.get(key);
    if (!c) {
      c = { label: tm.pool, teams: 0, schools: new Set(), players: 0 };
      map.set(key, c);
    }
    c.teams += 1;
    if (tm.institution_id) c.schools.add(tm.institution_id);
    c.players += tm.player_count ?? 0;
  }
  return [...map.entries()]
    .map(([key, c]) => ({
      key,
      label: c.label,
      teams: c.teams,
      schools: c.schools.size,
      players: c.players,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Grouped per-competition report: EVERY configured competition shows —
 * zeros included, so thin categories are visible (owner 2026-07-05) — as a
 * table with one section per sport. */
function CategoryReport({
  teams,
  sports,
}: {
  teams: TeamRow[];
  sports: TournamentSport[];
}): React.ReactElement {
  const groups = useMemo(() => {
    const rows = new Map<
      string,
      { label: string; teams: number; schools: Set<string>; players: number }
    >();
    for (const leaf of configuredLeaves(sports)) {
      rows.set(leaf.leaf_key, {
        label: leaf.label,
        teams: 0,
        schools: new Set(),
        players: 0,
      });
    }
    for (const tm of teams) {
      const key = tm.leaf_key || "__uncategorized";
      let r = rows.get(key);
      if (!r) {
        r = {
          label: tm.pool || t("Uncategorized"),
          teams: 0,
          schools: new Set(),
          players: 0,
        };
        rows.set(key, r);
      }
      r.teams += 1;
      if (tm.institution_id) r.schools.add(tm.institution_id);
      r.players += tm.player_count ?? 0;
    }
    const bySport = new Map<
      string,
      {
        sport: string;
        teams: number;
        rows: { key: string; label: string; teams: number; schools: number; players: number }[];
      }
    >();
    for (const [key, r] of [...rows.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const segs = r.label.split(/\s+[\u00b7\u2014]\s+/);
      const sport = segs[0] ?? r.label;
      const within =
        segs.length > 1 ? segs.slice(1).join(" · ") : t("Open competition");
      const g = bySport.get(sport) ?? { sport, teams: 0, rows: [] };
      g.rows.push({
        key,
        label: within,
        teams: r.teams,
        schools: r.schools.size,
        players: r.players,
      });
      g.teams += r.teams;
      bySport.set(sport, g);
    }
    return [...bySport.values()];
  }, [teams, sports]);

  const num = (v: number): React.ReactElement => (
    <span
      className={cn(
        "inline-block min-w-[1.75rem] rounded-md px-1.5 py-0.5 text-center font-tabular text-xs font-medium",
        v > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground/60",
      )}
    >
      {v}
    </span>
  );

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-testid="category-report"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">{t("Competition")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("Teams")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("Schools")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("Players")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.sport}>
              <tr className="border-b border-border bg-accent/40">
                <td colSpan={4} className="px-4 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <Trophy
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                    />
                    <span className="text-[0.8125rem] font-semibold">
                      {g.sport}
                    </span>
                    <span className="ml-auto font-tabular text-xs text-muted-foreground">
                      {g.teams} {g.teams === 1 ? t("team") : t("teams")}
                    </span>
                  </span>
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr
                  key={r.key}
                  data-testid={`report-${r.key}`}
                  className="border-b border-border transition-colors last:border-b-0 hover:bg-accent/20"
                >
                  <td
                    className={cn(
                      "px-4 py-2 capitalize",
                      r.teams === 0 && "text-muted-foreground",
                    )}
                  >
                    {r.label}
                  </td>
                  <td className="px-3 py-2 text-right">{num(r.teams)}</td>
                  <td className="px-3 py-2 text-right">{num(r.schools)}</td>
                  <td className="px-3 py-2 text-right">{num(r.players)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Teams as a proper TABLE (owner 2026-06-10): collapsible institution group
 * rows, and every team row expands to its full player roster inline. Phones
 * get the same hierarchy as stacked cards.
 */
interface SchoolGroup {
  key: string;
  name: string;
  teams: TeamRow[];
  submitted: boolean;
  hasCode: boolean;
}

/** Submitted / not-yet pill — the admin's at-a-glance progress per school. */
function SubmissionBadge({ submitted }: { submitted: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        submitted
          ? "bg-success-muted text-success"
          : // text-warning, NOT -foreground: the foreground pair is dark
            // amber and disappears on the dark tint (owner 2026-07-05).
            "bg-warning-muted text-warning",
      )}
    >
      {submitted ? (
        <Check aria-hidden="true" className="h-3 w-3" />
      ) : (
        <Clock aria-hidden="true" className="h-3 w-3" />
      )}
      {submitted ? t("Submitted") : t("Not submitted")}
    </span>
  );
}

function TeamsTable({
  groups,
  tournamentId,
  canManage,
}: {
  groups: SchoolGroup[];
  tournamentId: string;
  /** Managers can mint the per-team iCal calendar link. */
  canManage: boolean;
}): React.ReactElement {
  const { isMobile } = useBreakpoint();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const flip = (
    set: Set<string>,
    update: (next: Set<string>) => void,
    key: string,
  ): void => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  if (isMobile) {
    return (
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <section key={g.key} className="bento-card star-rim rounded-xl border border-border bg-card shadow-sm">
            <button
              type="button"
              aria-expanded={!collapsed.has(g.key)}
              onClick={() => flip(collapsed, setCollapsed, g.key)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  !collapsed.has(g.key) && "rotate-90",
                )}
              />
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{g.name}</h3>
              <SubmissionBadge submitted={g.submitted} />
            </button>
            {!collapsed.has(g.key) ? (
              <div className="flex flex-col gap-2 border-t border-border p-3">
                {g.teams.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    {t("No teams registered yet.")}
                  </p>
                ) : (
                  g.teams.map((tm) => (
                    <div key={tm.id} className="rounded-lg border border-border bg-background">
                      <button
                        type="button"
                        aria-expanded={expanded.has(tm.id)}
                        onClick={() => flip(expanded, setExpanded, tm.id)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                            expanded.has(tm.id) && "rotate-90",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{tm.name}</span>
                          <span className="mt-1 block">
                            <CompetitionLabel label={tm.pool} />
                          </span>
                          <span className="mt-0.5 block font-tabular text-xs text-muted-foreground">
                            {tm.player_count} {t("players")}
                          </span>
                        </span>
                      </button>
                      {expanded.has(tm.id) ? (
                        <div className="border-t border-border/60 px-3 py-2.5">
                          <TeamDetail
                            tournamentId={tournamentId}
                            teamId={tm.id}
                            teamName={tm.name}
                            fallback={tm.players ?? []}
                            canManage={canManage}
                          />
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="bento-card star-rim max-h-[36rem] overflow-auto rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className={cn(TEAM_TH, "w-8")} aria-label={t("Expand")} />
            <th className={TEAM_TH}>{t("Team")}</th>
            <th className={TEAM_TH}>{t("Competition")}</th>
            <th className={cn(TEAM_TH, "text-right")}>{t("Players")}</th>
            <th className={TEAM_TH}>{t("Status")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.key}>
              <tr>
                <td colSpan={5} className="border-b border-border bg-muted/50 px-3 py-2">
                  <button
                    type="button"
                    aria-expanded={!collapsed.has(g.key)}
                    onClick={() => flip(collapsed, setCollapsed, g.key)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        !collapsed.has(g.key) && "rotate-90",
                      )}
                    />
                    <span className="text-sm font-semibold">{g.name}</span>
                    <SubmissionBadge submitted={g.submitted} />
                    {g.teams.length > 0 ? (
                      <span className="font-tabular text-xs text-muted-foreground">
                        {g.teams.length} {g.teams.length === 1 ? t("team") : t("teams")}
                      </span>
                    ) : null}
                  </button>
                </td>
              </tr>
              {!collapsed.has(g.key) && g.teams.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="border-b border-border px-4 py-2.5 pl-12 text-xs text-muted-foreground"
                  >
                    {t("No teams registered yet.")}
                  </td>
                </tr>
              ) : null}
              {!collapsed.has(g.key)
                ? g.teams.map((tm) => (
                    <Fragment key={tm.id}>
                      <tr
                        className="group cursor-pointer hover:bg-accent/40"
                        onClick={() => flip(expanded, setExpanded, tm.id)}
                      >
                        <td className={cn(TEAM_TD, "pl-4")}>
                          <button
                            type="button"
                            aria-expanded={expanded.has(tm.id)}
                            aria-label={t(`Show players of ${tm.name}`)}
                            onClick={(e) => {
                              e.stopPropagation();
                              flip(expanded, setExpanded, tm.id);
                            }}
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={cn(
                                "h-3.5 w-3.5 transition-transform",
                                expanded.has(tm.id) && "rotate-90",
                              )}
                            />
                          </button>
                        </td>
                        <td className={cn(TEAM_TD, "font-medium")}>{tm.name}</td>
                        <td className={TEAM_TD}>
                          <CompetitionLabel label={tm.pool} />
                        </td>
                        <td className={cn(TEAM_TD, "text-right font-tabular")}>
                          {tm.player_count}
                        </td>
                        <td className={cn(TEAM_TD, "capitalize text-muted-foreground")}>
                          {t(tm.status)}
                        </td>
                      </tr>
                      {expanded.has(tm.id) ? (
                        <tr>
                          <td colSpan={5} className="border-b border-border bg-muted/20 px-4 py-3 pl-12">
                            <TeamDetail
                              tournamentId={tournamentId}
                              teamId={tm.id}
                              teamName={tm.name}
                              fallback={tm.players ?? []}
                              canManage={canManage}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))
                : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
