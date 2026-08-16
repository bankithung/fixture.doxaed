import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, UserSquare2 } from "lucide-react";
import {
  tournamentsApi,
  type RosterMember,
  type RosterMemberInput,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/types/api";
import { humanizeLeaf } from "@/features/controlroom/format";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Everyone a school declared, before any team exists (spec 2026-08-17).
 *
 * The page earns its place with one column the team list cannot have: every
 * competition each person ended up in. That is the owner's question — "we can
 * see if one student is in multiple sports" — and it is also exactly what the
 * scheduler reads, so a row showing two chips is a row the draw will keep
 * apart.
 */

const KINDS = [
  { value: "", label: "Everyone" },
  { value: "student", label: "Students" },
  { value: "teacher", label: "Teachers" },
] as const;

function EntryChips({ m }: { m: RosterMember }): React.ReactElement {
  if (m.entries.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">{t("Not on a team yet")}</span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {m.entries.map((e) => (
        <span
          key={`${e.team_id}-${e.role}`}
          title={`${e.team} · ${e.role}`}
          className={cn(
            "inline-flex max-w-[14rem] items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs",
            e.role === "player" ? "bg-secondary" : "bg-accent",
          )}
        >
          {e.leaf_key ? humanizeLeaf(e.leaf_key) : e.team}
        </span>
      ))}
    </span>
  );
}

export function ParticipantsPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const { isMobile } = useBreakpoint();

  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [institution, setInstitution] = useState("");
  const [draft, setDraft] = useState<RosterMemberInput>({ kind: "student" });

  const q = useQuery({
    queryKey: ["tournament-roster", id, kind, search, institution],
    queryFn: () =>
      tournamentsApi.roster(id, { kind, q: search, institution }),
    enabled: Boolean(id),
    retry: false,
  });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["tournament-roster", id] });
    void qc.invalidateQueries({ queryKey: ["tournament-stage", id] });
  };
  const fail = (e: unknown, fallback: string): void => {
    push({
      kind: "error",
      title: e instanceof ApiError ? (e.payload.detail ?? fallback) : fallback,
    });
  };

  const declare = useMutation({
    mutationFn: (payload: RosterMemberInput) =>
      tournamentsApi.declareParticipant(id, payload),
    onSuccess: () => {
      setDraft({ kind: draft.kind });
      refresh();
    },
    onError: (e) => fail(e, t("Could not add them")),
  });
  const withdraw = useMutation({
    mutationFn: (memberId: string) =>
      tournamentsApi.withdrawParticipant(id, memberId),
    onSuccess: refresh,
    onError: (e) => fail(e, t("Could not withdraw them")),
  });

  const members = useMemo(() => q.data?.members ?? [], [q.data]);
  const counts = q.data?.counts;
  const canManage = q.data?.can_manage ?? false;
  const groupNoun = q.data?.group_kind || "house";

  // Every school seen in the current result set, for the filter. Derived rather
  // than fetched: the roster payload already names each person's institution.
  const institutions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of members) {
      if (m.institution) seen.set(m.institution.id, m.institution.name);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [members]);

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("Search a name, class or roll number")}
        className="h-9 w-full max-w-xs"
        aria-label={t("Search participants")}
      />
      <Select
        size="sm"
        value={kind}
        onChange={setKind}
        options={KINDS.map((k) => ({ value: k.value, label: t(k.label) }))}
        aria-label={t("Filter by kind")}
        className="w-40"
      />
      {institutions.length > 1 ? (
        <Select
          size="sm"
          value={institution}
          onChange={setInstitution}
          options={[{ value: "", label: t("Every school") }, ...institutions]}
          aria-label={t("Filter by school")}
          className="w-56"
        />
      ) : null}
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("Participants")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "Everyone the schools entered, before any team was built. Teams pick from this list, so one person is one person — and the draw can keep their competitions apart.",
              )}
            </p>
          </div>
          {counts ? (
            <ul className="flex flex-wrap gap-2" data-testid="roster-counts">
              {[
                { key: "students", label: t("students"), n: counts.students },
                { key: "teachers", label: t("teachers"), n: counts.teachers },
                {
                  key: "multi",
                  label: t("in more than one"),
                  n: counts.multi_entry,
                },
              ].map((c) => (
                <li
                  key={c.key}
                  className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs"
                >
                  <span className="font-tabular text-sm font-semibold">{c.n}</span>{" "}
                  <span className="text-muted-foreground">{c.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="border-b border-border px-4 py-3 sm:px-5">{filters}</div>

        {canManage ? (
          <form
            className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5"
            onSubmit={(e) => {
              e.preventDefault();
              if ((draft.full_name ?? "").trim()) declare.mutate(draft);
            }}
          >
            <Input
              value={draft.full_name ?? ""}
              onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
              placeholder={t("Full name")}
              className="h-9 w-full max-w-xs"
              aria-label={t("Full name")}
            />
            <Input
              value={draft.class_section ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, class_section: e.target.value })
              }
              placeholder={t("Class & section")}
              className="h-9 w-36"
              aria-label={t("Class & section")}
            />
            <Input
              value={draft.roll_no ?? ""}
              onChange={(e) => setDraft({ ...draft, roll_no: e.target.value })}
              placeholder={t("Roll no.")}
              className="h-9 w-28"
              aria-label={t("Roll number")}
            />
            <Select
              size="sm"
              value={draft.kind ?? "student"}
              onChange={(v) =>
                setDraft({ ...draft, kind: v as "student" | "teacher" })
              }
              options={[
                { value: "student", label: t("Student") },
                { value: "teacher", label: t("Teacher in charge") },
              ]}
              aria-label={t("Kind")}
              className="w-44"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!(draft.full_name ?? "").trim() || declare.isPending}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add")}
            </Button>
          </form>
        ) : null}

        {q.isLoading ? (
          <div className="h-40 animate-pulse bg-muted/40" />
        ) : q.isError ? (
          <p role="alert" className="px-4 py-10 text-center text-sm text-destructive">
            {t("Could not load the participants.")}
          </p>
        ) : members.length === 0 ? (
          <div
            data-testid="participants-empty"
            className="flex flex-col items-center gap-3 px-6 py-14 text-center"
          >
            <span
              aria-hidden="true"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"
            >
              <UserSquare2 className="h-7 w-7 text-primary" />
            </span>
            <h2 className="text-base font-semibold">
              {search || kind || institution
                ? t("Nobody matches that")
                : t("Nobody has been entered yet")}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {search || kind || institution
                ? t("Clear the filters to see the whole list.")
                : t(
                    "Open the participants form and the schools will fill this in — or add someone here yourself.",
                  )}
            </p>
          </div>
        ) : isMobile ? (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li
                key={m.id}
                data-testid={`participant-${m.id}`}
                className="flex flex-col gap-1.5 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {m.full_name}
                  </span>
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`${t("Withdraw")} ${m.full_name}`}
                      onClick={() => withdraw.mutate(m.id)}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4 text-destructive" />
                    </Button>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">
                  {[
                    m.kind === "teacher" ? t("Teacher in charge") : m.class_section,
                    m.roll_no,
                    m.group?.name ?? m.institution?.name,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <EntryChips m={m} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium sm:px-5">{t("Name")}</th>
                  <th className="px-4 py-2 font-medium">{t("Class")}</th>
                  <th className="px-4 py-2 font-medium">{t("Roll")}</th>
                  <th className="px-4 py-2 font-medium">
                    {q.data?.scope === "intra_school" ? t(groupNoun) : t("School")}
                  </th>
                  <th className="px-4 py-2 font-medium">{t("Entered in")}</th>
                  {canManage ? <th className="px-4 py-2" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.map((m) => (
                  <tr
                    key={m.id}
                    data-testid={`participant-${m.id}`}
                    data-multi={m.entries.length > 1 ? "" : undefined}
                  >
                    <td className="px-4 py-2 sm:px-5">
                      <span className="font-medium">{m.full_name}</span>
                      {m.kind === "teacher" ? (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t("Teacher")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {m.class_section || "—"}
                    </td>
                    <td className="px-4 py-2 font-tabular text-muted-foreground">
                      {m.roll_no || "—"}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {m.group?.name ?? m.institution?.name ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <EntryChips m={m} />
                    </td>
                    {canManage ? (
                      <td className="px-4 py-2 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`${t("Withdraw")} ${m.full_name}`}
                          onClick={() => withdraw.mutate(m.id)}
                        >
                          <Trash2
                            aria-hidden="true"
                            className="h-4 w-4 text-destructive"
                          />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
