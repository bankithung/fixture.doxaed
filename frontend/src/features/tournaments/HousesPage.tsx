import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Home, Plus, Trash2, UserPlus, X } from "lucide-react";
import { tournamentsApi, type GroupKind, type TournamentHouse } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/types/api";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Stage two of a WITHIN-SCHOOL event — where institution registration sits in a
 * between-schools one (spec 2026-08-16).
 *
 * The admin names the competitors (whatever the school actually calls them) and
 * puts a person in charge of each. That person can then register their own
 * house's students and nobody else's, which is the whole point: before this,
 * every scope in the system was per-org or per-tournament, so a team manager
 * could edit anyone's teams.
 */

const NOUN: Record<string, { one: string; many: string }> = {
  house: { one: "house", many: "Houses" },
  class: { one: "class", many: "Classes" },
  form: { one: "form", many: "Forms" },
  department: { one: "department", many: "Departments" },
};

function nouns(kind: GroupKind | "" | undefined): { one: string; many: string } {
  return NOUN[kind || "house"] ?? NOUN.house;
}

export function HousesPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { push } = useToast();
  const [name, setName] = useState("");
  const [memberFor, setMemberFor] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  const q = useQuery({
    queryKey: ["tournament-houses", id],
    queryFn: () => tournamentsApi.houses(id),
    enabled: Boolean(id),
    retry: false,
  });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["tournament-houses", id] });
    void qc.invalidateQueries({ queryKey: ["tournament-stage", id] });
  };
  const fail = (e: unknown, fallback: string): void => {
    push({
      kind: "error",
      title: e instanceof ApiError ? (e.payload.detail ?? fallback) : fallback,
    });
  };

  const add = useMutation({
    mutationFn: (n: string) => tournamentsApi.createHouse(id, { name: n }),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: (e) => fail(e, t("Could not add it")),
  });
  const remove = useMutation({
    mutationFn: (houseId: string) => tournamentsApi.removeHouse(id, houseId),
    onSuccess: refresh,
    onError: (e) => fail(e, t("Could not remove it")),
  });
  const addMember = useMutation({
    mutationFn: (v: { houseId: string; email: string }) =>
      tournamentsApi.addHouseMember(id, v.houseId, v.email),
    onSuccess: () => {
      setEmail("");
      setMemberFor(null);
      refresh();
    },
    onError: (e) => fail(e, t("Could not add that person")),
  });
  const removeMember = useMutation({
    mutationFn: (v: { houseId: string; userId: string }) =>
      tournamentsApi.removeHouseMember(id, v.houseId, v.userId),
    onSuccess: refresh,
    onError: (e) => fail(e, t("Could not remove them")),
  });

  const data = q.data;
  const noun = nouns(data?.group_kind);
  const canManage = data?.can_manage ?? false;
  const houses = data?.houses ?? [];

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              {t(noun.many)} {t("& members")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("Name the")} {t(noun.many).toLowerCase()}{" "}
              {t("that are competing, and put someone in charge of each one — they can register their own")}{" "}
              {t(noun.one)}
              {t("'s students, and no one else's.")}
            </p>
          </div>
          <span className="font-tabular text-xs text-muted-foreground">
            {houses.length} {t(noun.many).toLowerCase()}
          </span>
        </div>

        {canManage ? (
          <form
            className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) add.mutate(name.trim());
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${t("Add a")} ${t(noun.one)} — ${t("call it whatever your school calls it")}`}
              className="h-9 max-w-md flex-1"
              aria-label={`${t("New")} ${t(noun.one)}`}
            />
            <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Add")}
            </Button>
          </form>
        ) : null}

        {q.isLoading ? (
          <div className="h-40 animate-pulse bg-muted/40" />
        ) : q.isError ? (
          <p role="alert" className="px-4 py-10 text-center text-sm text-destructive">
            {t("This page is only for a within-school tournament.")}
          </p>
        ) : houses.length === 0 ? (
          <div
            data-testid="houses-empty"
            className="flex flex-col items-center gap-3 px-6 py-14 text-center"
          >
            <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Home className="h-7 w-7 text-primary" />
            </span>
            <h2 className="text-base font-semibold">
              {t("No")} {t(noun.many).toLowerCase()} {t("yet")}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("Add at least two before opening registration — one cannot play itself.")}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {houses.map((h: TournamentHouse) => (
              <li key={h.id} data-testid={`house-${h.id}`} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full border border-border"
                    style={h.colour ? { background: h.colour } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {h.name}
                  </span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {h.teams} {h.teams === 1 ? t("team") : t("teams")}
                  </span>
                  {canManage ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setMemberFor(memberFor === h.id ? null : h.id)}
                      >
                        <UserPlus aria-hidden="true" className="h-4 w-4" />
                        {t("Add member")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`${t("Remove")} ${h.name}`}
                        onClick={() => remove.mutate(h.id)}
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  ) : null}
                </div>

                {h.members.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {h.members.map((m) => (
                      <li
                        key={m.id}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                      >
                        <span className="truncate">{m.name}</span>
                        {canManage ? (
                          <button
                            type="button"
                            aria-label={`${t("Remove")} ${m.name}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              removeMember.mutate({ houseId: h.id, userId: m.user_id })
                            }
                          >
                            <X aria-hidden="true" className="h-3 w-3" />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {memberFor === h.id ? (
                  <form
                    className="mt-2 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (email.trim()) {
                        addMember.mutate({ houseId: h.id, email: email.trim() });
                      }
                    }}
                  >
                    <Input
                      autoFocus
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t("Their email address")}
                      className={cn("h-9 max-w-xs flex-1")}
                      aria-label={t("Member email")}
                    />
                    <Button type="submit" size="sm" disabled={addMember.isPending}>
                      {t("Add")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
