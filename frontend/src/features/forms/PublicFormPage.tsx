import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle2,
  ClipboardList,
  Info,
  KeyRound,
  Lock,
  MessageCircle,
  ShieldCheck,
  Trophy,
  Users,
} from "lucide-react";
import { formsApi } from "@/api/forms";
import type { FileMeta, RosterPayload } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichText } from "@/components/ui/RichText";
import { StarBorder } from "@/components/ui/StarBorder";
import { cn } from "@/lib/tailwind";
import { compressImage } from "@/lib/compressImage";
import { newEventId } from "@/lib/eventId";
import {
  isVisible,
  optionSelected,
  reachableSections,
  sectionActiveFields,
  validateRequired,
} from "@/lib/formLogic";
import { BentoGrid } from "@/features/dashboard/BentoCard";
import { t } from "@/lib/t";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { ContactAdminDialog } from "./ContactAdminDialog";
import { FieldRenderer } from "./fieldRenderers";
import { eventCovers, leafOfSection } from "./prefillTeams";
import type { Field, FormSchema } from "./types";

/** Which roster list a data-bound field draws from (spec 2026-08-17). */
const ROSTER_SOURCES: Record<string, keyof Pick<RosterPayload, "students" | "teachers">> =
  {
    roster_students: "students",
    roster_teachers: "teachers",
  };

/**
 * Fill the person pickers from the school's own roster.
 *
 * These options are deliberately absent from the public schema — a roll of
 * children is PII, and schema resolution happens before anyone proves who they
 * are. They arrive with the access-code exchange instead, and are grafted on
 * here so the renderer, the branching engine and the review step all see one
 * ordinary schema.
 */
function withRoster(schema: FormSchema, roster: RosterPayload | null): FormSchema {
  if (!roster?.enabled) return schema;
  const fill = (fields: Field[]): Field[] =>
    fields.map((f) => {
      const list = ROSTER_SOURCES[f.data_source?.type ?? ""];
      const next =
        list !== undefined
          ? {
              ...f,
              options: roster[list].map((o) => ({
                value: o.value,
                label: o.class_section
                  ? `${o.label} · ${o.class_section}`
                  : o.label,
              })),
            }
          : f;
      return next.fields ? { ...next, fields: fill(next.fields) } : next;
    });
  return {
    ...schema,
    sections: (schema.sections ?? []).map((s) => ({
      ...s,
      fields: fill(s.fields ?? []),
    })),
  };
}

/**
 * Fill the person pickers from the participants sheet at the top of THIS form.
 *
 * Owner 2026-08-17: a school declares its people in step one and picks them in
 * the steps that follow, so the options are whatever it has typed a moment ago
 * — there is no second form to publish and no roster to wait for. Grafted onto
 * the schema exactly like `withRoster`, so the renderer, the branching engine
 * and the review step all still see one ordinary schema.
 *
 * A row with no name yet is not offered: half a typed row is not a person.
 */
function withFormGroups(
  schema: FormSchema,
  values: Record<string, unknown>,
): FormSchema {
  /** How many times each declared person is ALREADY picked somewhere on this
   * form (owner 2026-08-18: "how will I know if a student is in multiple
   * categories, it is hard to tell").
   *
   * Counted by walking the answers for the row's own id, skipping the sheet
   * that declares them (where the id is the row's identity, not a pick). It is
   * schema-agnostic on purpose: any picker bound to that group contributes,
   * so a new competition needs no wiring here. */
  const pickCounts = (group: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === "object") {
        Object.values(v as Record<string, unknown>).forEach(walk);
      }
    };
    for (const [k, v] of Object.entries(values)) {
      if (k === group) continue; // the sheet itself is not an assignment
      walk(v);
    }
    return counts;
  };

  const optionsFor = (
    ds: NonNullable<Field["data_source"]>,
    leafKey: string,
  ) => {
    const rows = values[ds.group ?? ""];
    if (!Array.isArray(rows)) return [];
    const counts = pickCounts(ds.group ?? "");
    const eventsKey =
      ds.group === "participant_staff" ? "staff_events" : "participant_events";
    return rows
      .filter((row) => {
        // Narrowed to the people who said they play this sport (owner
        // 2026-08-17). Someone who declared nothing stays offered — a blank
        // answer must never hide a child the school means to enter.
        if (!leafKey) return true;
        const declared = (row as Record<string, unknown>)?.[eventsKey];
        if (!Array.isArray(declared) || declared.length === 0) return true;
        return declared.some((d) => eventCovers(String(d), leafKey));
      })
      .map((row) => {
        const r = (row ?? {}) as Record<string, unknown>;
        const value = String(r[ds.value_field ?? ""] ?? "");
        const label = String(r[ds.label_field ?? ""] ?? "").trim();
        const hint = String(r[ds.hint_field ?? ""] ?? "").trim();
        const n = counts.get(value) ?? 0;
        // Say how many entries they already have, so a school can see at a
        // glance who is being spread across competitions.
        const used = n > 0 ? `${n} ${n === 1 ? t("entry") : t("entries")}` : "";
        const suffix = [hint, used].filter(Boolean).join(" · ");
        return { value, label: suffix ? `${label} · ${suffix}` : label };
      })
      .filter((o) => o.value && o.label);
  };
  // Which section each pickable group lives in, so an empty picker can NAME
  // the step to go and fill instead of showing a silent empty list. Read off
  // the schema, never a hardcoded list of group keys — a form the generator
  // reshapes must not need this file changed with it.
  const sectionOfGroup = new Map<string, string>();
  const index = (fields: Field[] | undefined, title: string): void => {
    for (const f of fields ?? []) {
      if (f.key) sectionOfGroup.set(f.key, title);
      index(f.fields, title);
    }
  };
  for (const s of schema.sections ?? []) index(s.fields, s.title);

  /** Why a picker is empty, in the school's own words. Two different reasons,
   * and telling them apart is the whole point: nobody declared yet, versus
   * nobody declared for THIS competition. */
  const emptyHint = (
    ds: NonNullable<Field["data_source"]>,
    hasRows: boolean,
  ): string => {
    const where = sectionOfGroup.get(ds.group ?? "") ?? t("the first step");
    return hasRows
      ? `${t("Nobody in")} "${where}" ${t("is entered for this competition yet.")}`
      : `${t("Add your people in")} "${where}" ${t("first, then pick them here.")}`;
  };

  const fill = (fields: Field[], leafKey: string): Field[] =>
    fields.map((f) => {
      let next = f;
      if (f.data_source?.type === "form_group") {
        const options = optionsFor(f.data_source, leafKey);
        const hasRows = Array.isArray(values[f.data_source.group ?? ""])
          && (values[f.data_source.group ?? ""] as unknown[]).length > 0;
        next = {
          ...f,
          options,
          // The author's own help still leads; the reason is appended, so a
          // picker never sits there empty with nothing to say for itself.
          help: options.length
            ? f.help
            : [f.help, emptyHint(f.data_source, hasRows)]
                .filter(Boolean)
                .join(" "),
        };
      }
      return next.fields
        ? { ...next, fields: fill(next.fields, leafKey) }
        : next;
    });
  return {
    ...schema,
    sections: (schema.sections ?? []).map((s) => ({
      ...s,
      fields: fill(s.fields ?? [], leafOfSection(s)),
    })),
  };
}

/** Pull a DRF `{ errors: { field: msg } }` map off an ApiError, if present.
 * Nested-group errors arrive with dotted paths ("teams_u15.0.players_u15");
 * they're mapped onto their TOP-LEVEL field key so the failing group
 * highlights and the section jump works (review W2-F — dotted keys used to
 * match nothing and the submit failed with zero visible feedback). */
function serverFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const raw = e.payload.errors;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const topKey = k.split(".")[0];
    const msg = Array.isArray(v) ? String(v[0]) : String(v);
    if (!(topKey in out)) out[topKey] = msg;
  }
  return out;
}

/** The SAME errors keyed by their full dotted path
 * ("teams_x.0.staff_x.1.staff_role_x"), so a nested field can show its own
 * message instead of the whole group carrying one detached line at the bottom
 * (owner 2026-08-18: "the user will never know" which answer is wrong). */
function serverErrorPaths(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const raw = e.payload.errors;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}


/**
 * Two sheets behind one pair of tabs (owner 2026-08-18: "two tabs, one for
 * teachers and one for the students"). Every panel stays mounted, just
 * hidden, so uploads in the background tab survive switching; a tab whose
 * sheet holds a validation problem carries a dot, so an error can never hide
 * behind the other tab.
 */
function SheetTabs({
  fields,
  render,
  countOf,
  errorOn,
  active,
  onActive,
}: {
  fields: Field[];
  render: (f: Field) => React.ReactNode;
  countOf: (f: Field) => number;
  errorOn: (f: Field) => boolean;
  /** Controlled tab, so the page's Next button can walk the tabs. */
  active?: string | null;
  onActive?: (key: string) => void;
}): React.ReactElement {
  const [own, setOwn] = useState(fields[0]?.key ?? "");
  const activeKey = active ?? own;
  const setActive = onActive ?? setOwn;
  const current = fields.some((f) => f.key === activeKey)
    ? activeKey
    : (fields[0]?.key ?? "");
  // Bookmark tabs on an INNER card (owner 2026-08-19): the tabs sit on the
  // card's top edge like file-folder tabs, the active one joined to the panel
  // below, so the two sheets read as one clickable surface.
  return (
    <div className="flex flex-col">
      <div
        role="tablist"
        aria-label={t("Your participants")}
        className="flex items-end gap-1 px-2"
      >
        {fields.map((f) => {
          const on = f.key === current;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`people-tab-${f.key}`}
              onClick={() => setActive(f.key)}
              className={cn(
                "relative -mb-px inline-flex h-9 items-center gap-1.5 rounded-t-lg border border-b-0 px-4 text-xs font-medium transition-colors",
                on
                  ? "z-10 border-border bg-card text-foreground"
                  : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(f.tab_label ?? f.label)}
              <span
                className={cn(
                  "rounded-full px-1.5 py-px font-tabular text-[0.6875rem] font-semibold",
                  on
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {countOf(f)}
              </span>
              {errorOn(f) ? (
                <span
                  data-testid={`people-tab-error-${f.key}`}
                  aria-label={t("Needs attention")}
                  className="h-1.5 w-1.5 rounded-full bg-destructive"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
        {fields.map((f) => (
          <div
            key={f.key}
            role="tabpanel"
            className={f.key === current ? undefined : "hidden"}
          >
            {render(f)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Standalone PUBLIC form renderer reached by a school via a shared link
 * (`/f/:formId` for an open public form, `/r/:token` for a personalised share
 * link). It renders the data-driven schema as a paged wizard, evaluating
 * branching with the SAME `lib/formLogic` traversal the backend uses, so the
 * client and server always agree on which sections/fields are reachable.
 *
 * Rendered OUTSIDE the authenticated AppShell — it carries its own light
 * branded chrome. No account needed.
 */
export function PublicFormPage(): React.ReactElement {
  const { formId, token } = useParams();

  const payload = useQuery({
    queryKey: ["public-form", formId ?? token],
    queryFn: () =>
      token !== undefined
        ? formsApi.publicGetByToken(token)
        : formsApi.publicGet(formId ?? ""),
    // Retry transient errors (network / brief server restart) so a deploy blip
    // doesn't strand the page on "form not found"; a real 404 fails fast.
    retry: (count, err) =>
      count < 2 && !(err instanceof ApiError && err.status === 404),
  });

  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [uploadRefs, setUploadRefs] = useState<Record<string, string>>({});
  // Filename + signed view URL for files already on the server, revealed by the
  // code-exchange / manager prefill (the bound-link case is merged in via
  // useMemo below). Lets prefilled uploads show as names, thumbnails and links.
  const [accessFileMeta, setAccessFileMeta] = useState<Record<string, FileMeta>>(
    {},
  );
  // Document names the respondent typed, keyed by upload_ref (edits only —
  // prior-submission names are merged in from fileMeta at submit time).
  const [fileLabels, setFileLabels] = useState<Record<string, string>>({});
  // Client-side display metadata for files uploaded THIS session (name, type, an
  // object URL to preview), so the review step shows them like prefilled files.
  const [localFileMeta, setLocalFileMeta] = useState<Record<string, FileMeta>>(
    {},
  );
  const [stepIndex, setStepIndex] = useState(0);
  // Which tab of a tabbed participants surface is showing. Page-owned so
  // Next can WALK the tabs: Teachers, then Students, and only then the
  // review — a sheet behind an unvisited tab was getting missed (owner
  // 2026-08-18).
  const [sheetTab, setSheetTab] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The same failures keyed by full dotted path, so the exact row and field
  // can carry the message rather than the group carrying one detached line.
  const [errorPaths, setErrorPaths] = useState<Record<string, string>>({});
  // Once a check has run, errors go LIVE: they are recomputed as the answers
  // change, so fixing a field clears its message immediately instead of the
  // respondent having to press Next again to find out (owner 2026-08-18).
  const [liveCheck, setLiveCheck] = useState(false);
  const [eventId] = useState(newEventId); // stable across retries (idempotency)
  const [done, setDone] = useState<string | null>(null);

  // H8: a refresh used to wipe an entire typed roster (the LONGEST public
  // form) and force access-code re-verification. Answers now autosave to
  // this device and restore on return; the draft clears on submit.
  const draftKey = `fixture.form-draft.v1.${formId ?? token ?? ""}`;
  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current) return;
    draftRestored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as {
        answers?: Record<string, unknown>;
        fileLabels?: Record<string, string>;
      };
      if (draft.answers && Object.keys(draft.answers).length > 0) {
        setAnswers((a) =>
          Object.keys(a).length === 0 ? draft.answers! : { ...draft.answers, ...a },
        );
        if (draft.fileLabels) setFileLabels((l) => ({ ...draft.fileLabels, ...l }));
      }
    } catch {
      // A corrupt draft must never block the form.
    }
  }, [draftKey]);
  useEffect(() => {
    if (done !== null) return;
    if (Object.keys(answers).length === 0) return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ answers, fileLabels, savedAt: Date.now() }),
        );
      } catch {
        // Storage full/blocked: typing continues, only persistence degrades.
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, [answers, fileLabels, done, draftKey]);

  const data = payload.data;
  const form = data?.form;

  // Name the browser tab after the tournament (richer than "Fixture Platform").
  // NB: chat-app link unfurling needs server-side meta — see PR notes.
  useEffect(() => {
    const name = data?.tournament_name;
    if (name) document.title = form?.title ? `${name} · ${form.title}` : name;
  }, [data, form]);

  // Per-institution link: seed answers from the link's prefill ONCE, so the
  // school sees its carried-over details (and the locked institution) ready to
  // confirm. User edits afterwards win (prefill never clobbers later input).
  const prefillApplied = useRef(false);
  useEffect(() => {
    if (data?.prefill && !prefillApplied.current) {
      prefillApplied.current = true;
      setAnswers((a) => ({ ...data.prefill, ...a }));
    }
  }, [data]);

  // Merge bound-link file metadata (on the payload) with whatever the
  // code-exchange / manager prefill revealed — derived, so no setState-in-effect.
  const fileMeta = useMemo(
    () => ({ ...(data?.file_meta ?? {}), ...accessFileMeta }),
    [data?.file_meta, accessFileMeta],
  );
  // Names carried in from a prior submission — the baseline the respondent's
  // edits (fileLabels) layer over when the registration is re-submitted.
  const metaLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [ref, m] of Object.entries(fileMeta))
      if (m.label) out[ref] = m.label;
    return out;
  }, [fileMeta]);

  // What the renderer shows for each file: server + this-session uploads, with
  // the live document name (typed edits over prior-submission names) overlaid —
  // so the review step reflects exactly what will be submitted.
  const displayFileMeta = useMemo(() => {
    const base: Record<string, FileMeta> = { ...fileMeta, ...localFileMeta };
    const labels = { ...metaLabels, ...fileLabels };
    const out: Record<string, FileMeta> = {};
    for (const [ref, m] of Object.entries(base))
      out[ref] = { ...m, label: labels[ref] ?? m.label ?? "" };
    return out;
  }, [fileMeta, localFileMeta, metaLabels, fileLabels]);

  // Fields the link locks (e.g. the institution) are hidden from the wizard —
  // their value rides along in `answers` and the server is authoritative anyway.
  const lockedSet = useMemo(() => new Set(data?.locked ?? []), [data?.locked]);
  const boundLabel = data?.bound?.label;

  // The school's declared people, revealed by the access-code exchange (or,
  // for a manager, by picking the school). Null until then — and for every
  // tournament that types names, forever.
  const [roster, setRoster] = useState<RosterPayload | null>(null);
  const rawSchema = form?.schema ?? { version: 1, sections: [] };
  // Within-school: there is no mailed code — authorization is house
  // membership — so the pickers arrive with the form, already narrowed to the
  // houses this caller may register for, and follow the house they pick.
  const houseField = useMemo(() => {
    for (const s of rawSchema.sections ?? [])
      for (const f of s.fields ?? [])
        if (f.data_source?.type === "house_list") return f;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.schema]);
  const houseRoster = houseField
    ? (data?.roster_by_house?.[String(answers[houseField.key] ?? "")] ?? null)
    : null;
  // The in-form participants sheet is filled LAST, so a school that typed its
  // people a moment ago sees them in every picker below without a reload.
  const schema = useMemo(
    () => withFormGroups(withRoster(rawSchema, houseRoster ?? roster), answers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form?.schema, roster, houseRoster, answers],
  );

  // --- Institution-aware competition scoping (team forms) ------------------
  // Selecting a school narrows the sport/category questions to what IT
  // registered at Stage 1 — pre-selected, so the next step goes straight to
  // teams & players, with no admin regeneration of the form.
  const instField = useMemo(() => {
    for (const s of schema.sections ?? [])
      for (const f of s.fields ?? [])
        if (f.data_source?.type === "institution_list") return f;
    return null;
  }, [schema]);
  const compFieldKeys = useMemo(
    () => new Set(data?.competition_fields ?? []),
    [data],
  );
  /** A prior submission's answers, minus the competition-selection fields.
   * Those are DERIVED from the school's Stage-1 registration and re-marked on
   * every landing; a prior response saved under an older schema carries
   * values that match no current option (owner 2026-08-19: Grace's saved
   * branch keys blanked the whole matrix). */
  /** Derived team groups the user has edited by hand this session — the
   * synthesis leaves those alone; everything else it keeps in lockstep with
   * the sheet's ticks. */
  const dirtyTeams = useRef<Set<string>>(new Set());
  const autoTeamKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const sec of data?.form?.schema?.sections ?? []) {
      if (!sec.auto) continue;
      for (const f of sec.fields ?? []) {
        if (f.type === "group" && f.repeatable) keys.add(f.key);
      }
    }
    return keys;
  }, [data]);
  const scrubPrefill = (
    pf: Record<string, unknown>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(pf).filter(
        // The competition selection AND the auto sections' teams are DERIVED
        // (from Stage-1 leaves and the sheet's ticks): a prior submission
        // saved under an older flow blocked the synthesis and reviewed as
        // "No players" beside a ticked student (owner 2026-08-19).
        ([k]) => !compFieldKeys.has(k) && !autoTeamKeys.has(k),
      ),
    );
  /** The selected school's registered leaves (null until a school with a
   * registration is chosen → no scoping). */
  const instLeaves = useMemo(() => {
    if (!instField) return null;
    const v = String(answers[instField.key] ?? "");
    if (!v) return null;
    const leaves = instField.options?.find((o) => String(o.value) === v)?.leaves;
    return leaves && leaves.length > 0 ? leaves : null;
  }, [instField, answers]);
  const compAllowed = (value: string): boolean =>
    !instLeaves ||
    instLeaves.some((l) => l === value || l.startsWith(`${value}.`));

  // On school change: pre-select every competition option implied by its
  // registration (each chain level), replacing prior selections so a switch
  // of school can't leave stale categories ticked.
  const lastScopedInst = useRef<string | null>(null);
  // Set by the school-switch wipe so the manager-prefill effect refetches and
  // re-merges the new school's details AFTER the wipe, whatever the ordering
  // (owner 2026-08-18: "even after selecting school the contact details are
  // not getting appended").
  const wantPrefill = useRef(false);
  useEffect(() => {
    if (!instField || compFieldKeys.size === 0) return;
    const v = String(answers[instField.key] ?? "");
    if (!v || v === lastScopedInst.current) return;
    // A NEW SCHOOL IS A NEW SUBMISSION (owner 2026-08-18: "why is the same
    // data showing for all the schools" — the sheets, logo and teams of the
    // previous school were surviving the switch). Switching wipes everything
    // but the school itself; the contact prefill and this scoping then
    // rebuild the rest from that school's own registration.
    const switching = lastScopedInst.current !== null;
    lastScopedInst.current = v;

    const leaves =
      instField.options?.find((o) => String(o.value) === v)?.leaves ?? [];
    const next: Record<string, unknown> = {};
    for (const s of schema.sections ?? []) {
      for (const f of s.fields ?? []) {
        if (!compFieldKeys.has(f.key)) continue;
        // The selection is DERIVED from the school's Stage-1 registration and
        // is re-marked every time a school lands here — a stale draft holding
        // last week's unticked sports left Grace's competitions unmarked
        // (owner 2026-08-18), and predictability beats preserving edits to a
        // field the sheet's own ticks now supersede.
        const sel = (f.options ?? [])
          .map((o) => String(o.value))
          .filter((ov) => leaves.some((l) => l === ov || l.startsWith(`${ov}.`)));
        next[f.key] = f.type === "multi_choice" ? sel : (sel[0] ?? "");
      }
    }
    if (leaves.length === 0 && !switching) return;
    setAnswers((a) => {
      const base = switching ? { [instField.key]: v } : { ...a };
      return { ...base, ...(leaves.length ? next : {}) };
    });
    if (switching) {
      setErrors({});
      setErrorPaths({});
      setSheetTab(null);
      wantPrefill.current = true;
      dirtyTeams.current.clear();
    }
  }, [answers, instField, compFieldKeys, schema]);

  // --- School access code (team forms) --------------------------------------
  // An institution holding an emailed code must verify it before its teams
  // can be registered or edited. Verification returns a short-lived signed
  // token (sent with the submission) plus the school's previous answers so
  // a returning school EDITS its registration instead of starting fresh.
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [editingPrior, setEditingPrior] = useState(false);

  const selectedInstOption = useMemo(() => {
    if (!instField) return null;
    const v = String(answers[instField.key] ?? "");
    if (!v) return null;
    return instField.options?.find((o) => String(o.value) === v) ?? null;
  }, [instField, answers]);
  // Bound links lock the institution and are their own secret — no code.
  // An authenticated manager (admin "Add team" path) is never asked either.
  const needsCode =
    !!selectedInstOption?.requires_code &&
    !!instField &&
    !lockedSet.has(instField.key) &&
    !data?.can_manage;

  const selectedInstValue = selectedInstOption?.value;

  // A team is named after its school unless the respondent says otherwise
  // (owner 2026-08-18). The SERVER has always defaulted a blank team name to
  // the institution, so the help text promised something the form never
  // showed — the value now actually appears, and can be typed over.
  //
  // Only an UNTOUCHED field is filled (`undefined`, never `""`), so clearing
  // the box stays cleared instead of the default fighting the typist.
  // The competition sections BUILD THEMSELVES from the sheet (owner
  // 2026-08-18): a tick on a student's row is the entry, so each auto
  // section's team group is synthesized — players chunked into squads of the
  // format's size, in row order, and every teacher whose "In charge of"
  // ticks cover the sport attached to each team. The derived groups MIRROR
  // the ticks continuously (owner 2026-08-19: stale teams from earlier tick
  // states piled up and outlived their students): unticking removes the team,
  // re-chunking replaces it, and only a group the user edited by hand this
  // session is left alone. Team names stay unset here; the institution-name
  // effect fills them "<School> <TAG>-n" after each rebuild.
  useEffect(() => {
    const schema = data?.form?.schema;
    if (!schema) return;
    type Build = {
      teamKey: string;
      playersKey: string;
      pickKey: string;
      cap: number;
      members: string[];
      staffKey?: string;
      staffPickKey?: string;
      staffIds: string[];
    };
    const builds: Build[] = [];
    for (const sec of schema.sections ?? []) {
      if (!sec.auto) continue;
      const leaf = leafOfSection(sec);
      if (!leaf) continue;
      const teamGroup = (sec.fields ?? []).find(
        (f) => f.type === "group" && f.repeatable,
      );
      if (!teamGroup) continue;
      // The STAFF group also holds a form_group picker, and finding the
      // first picker-bearing child returned it — which put the teachers in
      // the Players column and the players nowhere (owner 2026-08-19). The
      // staff group is the one carrying seed metadata; players is the other.
      const playersChild = (teamGroup.fields ?? []).find(
        (g) =>
          !g.seed_from_group &&
          g.fields?.some((c) => c.data_source?.type === "form_group"),
      );
      const pick = playersChild?.fields?.find(
        (c) => c.data_source?.type === "form_group",
      );
      if (!playersChild || !pick?.data_source?.group) continue;
      const sheetKey = pick.data_source.group;
      const idField = pick.data_source.value_field ?? "";
      const sheet = answers[sheetKey];
      if (!Array.isArray(sheet)) continue;
      // The sheet's tick column names who is in THIS competition.
      const ticksChild = (schema.sections ?? [])
        .flatMap((x) => x.fields ?? [])
        .find((g) => g.key === sheetKey)
        ?.fields?.find((c) => c.layout === "columns");
      if (!ticksChild) continue;
      const members = sheet
        .filter((r) => {
          const row = (r ?? {}) as Record<string, unknown>;
          const declared = Array.isArray(row[ticksChild.key])
            ? (row[ticksChild.key] as unknown[]).map(String)
            : [];
          return Boolean(row[idField]) && declared.some((d) => eventCovers(d, leaf));
        })
        .map((r) => String((r as Record<string, unknown>)[idField]));
      const staffChild = (teamGroup.fields ?? []).find((g) => g.seed_from_group);
      let staffIds: string[] = [];
      if (staffChild?.seed_from_group && staffChild.seed_events && staffChild.seed_row_id) {
        const staffSheet = answers[staffChild.seed_from_group];
        if (Array.isArray(staffSheet)) {
          staffIds = staffSheet
            .filter((r) => {
              const row = (r ?? {}) as Record<string, unknown>;
              const declared = Array.isArray(row[staffChild.seed_events!])
                ? (row[staffChild.seed_events!] as unknown[]).map(String)
                : [];
              return (
                Boolean(row[staffChild.seed_row_id!]) &&
                declared.some((d) => eventCovers(d, leaf))
              );
            })
            .map((r) =>
              String((r as Record<string, unknown>)[staffChild.seed_row_id!]),
            );
        }
      }
      builds.push({
        teamKey: teamGroup.key,
        playersKey: playersChild.key,
        pickKey: pick.key,
        cap:
          typeof playersChild.max_items === "number" && playersChild.max_items > 0
            ? playersChild.max_items
            : Number.MAX_SAFE_INTEGER,
        members,
        staffKey: staffChild?.key,
        staffPickKey: staffChild?.seed_field,
        staffIds,
      });
    }
    if (!builds.length) return;

    setAnswers((prev) => {
      let touched = false;
      const next = { ...prev };
      for (const b of builds) {
        if (dirtyTeams.current.has(b.teamKey)) continue;
        const existing = Array.isArray(prev[b.teamKey])
          ? (prev[b.teamKey] as Record<string, unknown>[])
          : [];
        const teams: Record<string, unknown>[] = [];
        for (let at = 0; at < b.members.length; at += b.cap) {
          const squad = b.members.slice(at, at + b.cap);
          const row: Record<string, unknown> = {
            [b.playersKey]: squad.map((id) => ({ [b.pickKey]: id })),
          };
          if (b.staffKey && b.staffPickKey && b.staffIds.length) {
            row[b.staffKey] = b.staffIds.map((id) => ({
              [b.staffPickKey!]: id,
            }));
          }
          teams.push(row);
        }
        // Compare only what the synthesis owns (players + teacher), so the
        // name the other effect fills in does not read as a difference and
        // the two effects converge instead of ping-ponging.
        const sameShape =
          existing.length === teams.length &&
          teams.every((row, i) => {
            const cur = (existing[i] ?? {}) as Record<string, unknown>;
            const owned = (k?: string): boolean =>
              !k ||
              JSON.stringify(cur[k] ?? null) === JSON.stringify(row[k] ?? null);
            return owned(b.playersKey) && owned(b.staffKey);
          });
        if (sameShape) continue;
        if (teams.length === 0) delete next[b.teamKey];
        else next[b.teamKey] = teams;
        touched = true;
      }
      return touched ? next : prev;
    });
  }, [answers, data]);

  /** The review's team read-back (owner 2026-08-18: "all the following
   * should also be in a proper table sheet-like view"). Every built team as
   * one row — competition, team name, the players and the teacher by NAME,
   * resolved off the sheets — instead of ten collapsed sections where empty
   * competitions still printed headings. */
  const reviewTeams = useMemo(() => {
    const schema = data?.form?.schema;
    if (!schema) return [];
    const out: {
      competition: string;
      team: string;
      players: string[];
      staff: string[];
    }[] = [];
    const nameOf = (
      sheetKey: string,
      idField: string,
      labelField: string,
      id: string,
    ): string => {
      const rows = answers[sheetKey];
      if (!Array.isArray(rows)) return "";
      const hit = rows.find(
        (r) => String((r as Record<string, unknown>)?.[idField] ?? "") === id,
      ) as Record<string, unknown> | undefined;
      // An id with no sheet row behind it is a deleted person's residue,
      // not a name. Show nothing rather than the raw id.
      return String(hit?.[labelField] ?? "").trim();
    };
    for (const sec of reachableSections(schema, answers)) {
      if (!sec.auto) continue;
      const teamGroup = (sec.fields ?? []).find(
        (f) => f.type === "group" && f.repeatable,
      );
      if (!teamGroup) continue;
      const rows = answers[teamGroup.key];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const nameChild = (teamGroup.fields ?? []).find(
        (c) => c.default_from === "institution",
      );
      const playersChild = (teamGroup.fields ?? []).find(
        (g) =>
          !g.seed_from_group &&
          g.fields?.some((c) => c.data_source?.type === "form_group"),
      );
      const pick = playersChild?.fields?.find(
        (c) => c.data_source?.type === "form_group",
      );
      const staffChild = (teamGroup.fields ?? []).find((g) => g.seed_from_group);
      const staffPick = staffChild?.fields?.find(
        (c) => c.data_source?.type === "form_group",
      );
      const competition = t(sec.title).replace(/^Teams\s*·\s*/, "");
      for (const r of rows) {
        const row = (r ?? {}) as Record<string, unknown>;
        const players = (
          Array.isArray(row[playersChild?.key ?? ""])
            ? (row[playersChild!.key] as Record<string, unknown>[])
            : []
        )
          .map((pr) =>
            pick?.data_source
              ? nameOf(
                  pick.data_source.group ?? "",
                  pick.data_source.value_field ?? "",
                  pick.data_source.label_field ?? "",
                  String(pr?.[pick.key] ?? ""),
                )
              : "",
          )
          .filter(Boolean);
        const staff = (
          Array.isArray(row[staffChild?.key ?? ""])
            ? (row[staffChild!.key] as Record<string, unknown>[])
            : []
        )
          .map((sr) =>
            staffPick?.data_source
              ? nameOf(
                  staffPick.data_source.group ?? "",
                  staffPick.data_source.value_field ?? "",
                  staffPick.data_source.label_field ?? "",
                  String(sr?.[staffPick.key] ?? ""),
                )
              : "",
          )
          .filter(Boolean);
        out.push({
          competition,
          team: String(row[nameChild?.key ?? ""] ?? "").trim(),
          players,
          staff,
        });
      }
    }
    return out;
  }, [answers, data]);

  /** The band mirrors the directory's per-game counts, and it counts what
   * was actually ENTERED (owner 2026-08-18: it read "Table Tennis 8" off the
   * step-one selection while zero students were in, which is wrong data).
   * With a participants sheet present it tallies the students' own ticks per
   * sport; before the sheet exists it falls back to the selection. */
  const entrySummary = useMemo(() => {
    const allFields = (data?.form?.schema?.sections ?? []).flatMap(
      (sec) => sec.fields ?? [],
    );
    // The sheet's per-competition tick column, and the group holding it.
    for (const g of allFields) {
      if (g.type !== "group") continue;
      const events = (g.fields ?? []).find((c) => c.layout === "columns");
      if (!events) continue;
      const sportOf = new Map(
        (events.options ?? []).map((o) => [String(o.value), o.sport ?? ""]),
      );
      const counts = new Map<string, number>();
      // Every sport with a column shows, zeros included, like the directory.
      for (const sport of sportOf.values()) {
        if (!counts.has(sport)) counts.set(sport, 0);
      }
      const rows = answers[g.key];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const ticks = (r as Record<string, unknown> | null)?.[events.key];
          if (!Array.isArray(ticks)) continue;
          for (const v of ticks) {
            const sport = sportOf.get(String(v));
            if (sport !== undefined) {
              counts.set(sport, (counts.get(sport) ?? 0) + 1);
            }
          }
        }
      }
      return [...counts.entries()].map(([name, count]) => ({
        key: name,
        name,
        count,
      }));
    }
    const sportsField = allFields.find((f) => f.key === "sports");
    const chosen = Array.isArray(answers.sports)
      ? (answers.sports as unknown[]).map(String)
      : [];
    return chosen.map((key) => {
      const picked = answers[`categories_${key}`];
      return {
        key,
        name: t(
          sportsField?.options?.find((o) => String(o.value) === key)?.label ??
            key,
        ),
        count: Array.isArray(picked) ? picked.length : 1,
      };
    });
  }, [answers, data]);

  const schoolName = selectedInstOption ? t(selectedInstOption.label) : "";
  useEffect(() => {
    const schema = data?.form?.schema;
    if (!schoolName || !schema) return;
    // Which group holds which institution-defaulted child.
    const targets: { group: string; field: string; suffix: string }[] = [];
    const walk = (fields: Field[] | undefined, group: string): void => {
      for (const f of fields ?? []) {
        if (f.default_from === "institution" && group) {
          targets.push({ group, field: f.key, suffix: f.default_suffix ?? "" });
        }
        walk(f.fields, f.type === "group" ? f.key : group);
      }
    };
    for (const sec of schema.sections ?? []) walk(sec.fields, "");
    if (!targets.length) return;

    setAnswers((prev) => {
      let touched = false;
      const next = { ...prev };
      for (const { group, field, suffix } of targets) {
        const rows = next[group];
        if (!Array.isArray(rows)) continue;
        const filled = rows.map((r, i) => {
          if (r && typeof r === "object" && !(field in (r as object))) {
            touched = true;
            // "<School> <SPORT>-<n>", numbered per row so a school entering
            // two squads in one competition gets two distinct names.
            const name = suffix
              ? `${schoolName} ${suffix}-${i + 1}`
              : schoolName;
            return { ...(r as Record<string, unknown>), [field]: name };
          }
          return r;
        });
        if (touched) next[group] = filled;
      }
      return touched ? next : prev;
    });
  }, [schoolName, data, answers]);

  useEffect(() => {
    // Switching school invalidates any prior verification — including the
    // person pickers, which belong to the school that proved itself.
    setAccessToken(null);
    setCodeInput("");
    setCodeError(null);
    setEditingPrior(false);
    setRoster(null);
  }, [selectedInstValue]);

  const verifyCode = useMutation({
    mutationFn: () =>
      formsApi.teamAccess(form?.id ?? formId ?? "", {
        institution_id: String(selectedInstValue ?? ""),
        code: codeInput.trim(),
      }),
    onSuccess: (res) => {
      setAccessToken(res.access_token);
      setEditingPrior(res.editing);
      setCodeError(null);
      if (res.prefill) {
        // Their saved registration becomes the working answers (edit mode) —
        // except the derived competition selection, which the scoping owns.
        const pf = res.prefill;
        setAnswers((a) => ({ ...a, ...scrubPrefill(pf) }));
      }
      if (res.file_meta) setAccessFileMeta((m) => ({ ...m, ...res.file_meta }));
      if (res.roster) setRoster(res.roster);
    },
    onError: (e) =>
      setCodeError(
        e instanceof ApiError && e.status === 403
          ? e.payload.detail === "locked"
            ? t("Too many wrong attempts · try again in 15 minutes.")
            : t("That code isn't right · check the email sent to your school.")
          : t("Could not verify the code. Try again."),
      ),
  });

  // Admin "Add team" path: a manager needs no code, but should still get the
  // school's details prefilled. When a manager picks a school, fetch the same
  // prefill the code-exchange returns (the endpoint skips the code check for
  // an authenticated manager) and overlay it onto the answers.
  const lastManagerInst = useRef<string | null>(null);
  const managerPrefill = useMutation({
    mutationFn: (instId: string) =>
      formsApi.teamAccess(form?.id ?? formId ?? "", {
        institution_id: instId,
        code: "",
      }),
    onSuccess: (res) => {
      setEditingPrior(res.editing);
      if (res.prefill) {
        const pf = res.prefill;
        setAnswers((a) => ({ ...a, ...scrubPrefill(pf) }));
      }
      if (res.file_meta) setAccessFileMeta((m) => ({ ...m, ...res.file_meta }));
      if (res.roster) setRoster(res.roster);
    },
    onError: () => {
      // Silent failure here is how "the contact details are not appending"
      // happens (owner 2026-08-19: throttled 429s left blank fields with no
      // explanation). Say it, and let the next landing retry.
      wantPrefill.current = true;
      setErrors((e) => ({
        ...e,
        __form: t(
          "Could not load this school's saved details. Re-select the school to retry.",
        ),
      }));
    },
  });
  useEffect(() => {
    if (!data?.can_manage || !instField) return;
    const v = String(selectedInstValue ?? "");
    if (!v) return;
    // A wipe demands a fresh merge even for a school fetched before: the
    // fetched details were just erased with the rest of the previous
    // school's answers.
    if (v === lastManagerInst.current && !wantPrefill.current) return;
    wantPrefill.current = false;
    lastManagerInst.current = v;
    managerPrefill.mutate(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, instField, selectedInstValue, answers]);

  // Inline duplicate-name guard (team forms): two rows of one team group
  // sharing a name show an error AS YOU TYPE and block Next/Submit — the
  // server enforces the same per-competition rule on submit.
  const dupErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const tg of data?.team_groups ?? []) {
      const rows = answers[tg.group];
      if (!Array.isArray(rows)) continue;
      const seen = new Set<string>();
      for (const r of rows) {
        const n = String(
          (r as Record<string, unknown> | null)?.[tg.field] ?? "",
        )
          .trim()
          .toLowerCase();
        if (!n) continue;
        if (seen.has(n)) {
          out[tg.group] = t(
            "Two teams here have the same name · give each team a different name.",
          );
          break;
        }
        seen.add(n);
      }
    }
    return out;
  }, [answers, data]);

  // The reachable path is recomputed from answers on every render so picking an
  // option that changes branching immediately re-routes the wizard.
  const sections = useMemo(
    () => reachableSections(schema, answers),
    [schema, answers],
  );
  // Sections the sheet already answered stay OUT of the walk (owner
  // 2026-08-18: "everything will be done here in the current table" — the
  // per-competition pages were the same ticks asked again). An auto section
  // rejoins the walk only while it holds a validation problem, so a squad the
  // server refuses can still be fixed by hand. Review renders ALL sections,
  // so the built teams are read back before submitting.
  const errSectionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const sec of sections) {
      const owns = sectionActiveFields(sec, answers).some(
        (f) =>
          Boolean(errors[f.key]) ||
          Object.keys(errorPaths).some((k) => k.startsWith(`${f.key}.`)),
      );
      if (owns) keys.add(sec.key);
    }
    return keys;
  }, [sections, answers, errors, errorPaths]);
  const steps = useMemo(
    () => sections.filter((sec) => !sec.auto || errSectionKeys.has(sec.key)),
    [sections, errSectionKeys],
  );
  // A virtual final "review" step (index === steps.length) lets the
  // respondent read everything back before committing — they Submit there, not
  // from the last question section.
  const reviewIndex = steps.length;
  const clamped = Math.min(stepIndex, reviewIndex);
  const isReview = steps.length > 0 && clamped >= reviewIndex;
  const current = isReview ? undefined : steps[clamped];

  const setAnswer = (key: string, value: unknown) => {
    // A hand edit to a derived team group (reached via the error walk) takes
    // it out of the synthesis's hands for this session.
    if (autoTeamKeys.has(key)) dirtyTeams.current.add(key);
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const [contactOpen, setContactOpen] = useState(false);

  const handleUpload = async (field: Field, file: File): Promise<string> => {
    const id = form?.id ?? formId ?? "";
    // Document fields (multi-file) compress to JPEG — scans/ID photos shrink far
    // more that way; single-image fields (logos) keep their type for transparency.
    const prepared = await compressImage(file, { preferJpeg: field.multiple === true });
    const res = await formsApi.publicUpload(id, field.key, prepared);
    // Key by the ref itself (not the field key) so files in repeatable groups
    // and multi-file fields all survive into `upload_refs` — the backend claims
    // every value, and the answer carries which row/field owns each ref.
    setUploadRefs((r) => ({ ...r, [res.upload_ref]: res.upload_ref }));
    setLocalFileMeta((m) => ({
      ...m,
      [res.upload_ref]: {
        name: prepared.name,
        url:
          prepared.type.startsWith("image/") &&
          typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(prepared)
            : "",
        content_type: prepared.type,
        label: "",
      },
    }));
    return res.upload_ref;
  };

  const handleFileLabel = (ref: string, label: string): void =>
    setFileLabels((m) => ({ ...m, [ref]: label }));

  const submit = useMutation({
    mutationFn: () => {
      // Prior-submission names first, the respondent's edits on top.
      const file_labels = { ...metaLabels, ...fileLabels };
      const body = {
        answers,
        event_id: eventId,
        upload_refs: uploadRefs,
        file_labels,
        ...(accessToken ? { access_token: accessToken } : {}),
      };
      return token !== undefined
        ? formsApi.publicSubmitByToken(token, {
            answers,
            event_id: eventId,
            upload_refs: uploadRefs,
            file_labels,
          })
        : formsApi.publicSubmit(form?.id ?? formId ?? "", body);
    },
    onSuccess: (res) => {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* draft cleanup is best-effort */
      }
      setDone(res.message);
    },
    onError: (e) => {
      const fieldErrs = serverFieldErrors(e);
      setErrorPaths(serverErrorPaths(e));
      if (Object.keys(fieldErrs).length) {
        setErrors(fieldErrs);
        // Jump to the first reachable section that owns a failing field.
        const idx = steps.findIndex((s) =>
          sectionActiveFields(s, answers).some((f) => fieldErrs[f.key]),
        );
        if (idx >= 0) setStepIndex(idx);
      } else {
        setErrors({
          __form:
            e instanceof ApiError
              ? (e.payload.detail ?? t("Submission failed"))
              : t("Submission failed"),
        });
      }
    },
  });

  /** Validate ONLY the current section's required fields before advancing. */
  function validateCurrent(): boolean {
    setLiveCheck(true);
    if (!current) return true;
    const all = validateRequired(schema, answers);
    const here: Record<string, string> = {};
    // Include nested (option-revealed) fields of the current section.
    for (const f of sectionActiveFields(current, answers)) {
      if (all[f.key]) here[f.key] = all[f.key];
      else if (dupErrors[f.key]) here[f.key] = dupErrors[f.key];
    }
    setErrors(here);
    return Object.keys(here).length === 0;
  }

  // Live re-check: after the first check, every keystroke re-runs the SAME
  // rules, so a message disappears the moment its field is satisfied and a
  // newly-emptied required field says so straight away. Server-reported
  // failures are left alone here; only the server can clear those.
  useEffect(() => {
    if (!liveCheck || !current) return;
    const all = validateRequired(schema, answers);
    const here: Record<string, string> = {};
    for (const f of sectionActiveFields(current, answers)) {
      if (all[f.key]) here[f.key] = all[f.key];
      else if (dupErrors[f.key]) here[f.key] = dupErrors[f.key];
    }
    setErrors((prev) =>
      JSON.stringify(prev) === JSON.stringify(here) ? prev : here,
    );
    // `current` and `dupErrors` derive from answers; answers is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, liveCheck, schema]);

  /** True when the visible section contains the institution picker and the
   * selected school still has to verify its access code. */
  const codeGateOpen = (section: typeof current): boolean =>
    !!section &&
    needsCode &&
    !accessToken &&
    section.fields.some((f) => f.key === instField?.key);

  /** The tabbed sheets of one section, in render order. */
  const tabRunOf = (sec: typeof current): Field[] =>
    (sec?.fields ?? []).filter((f) => f.layout === "sheet" && f.tab_label);

  function onNext() {
    if (codeGateOpen(current)) {
      // Pressing Next must visibly react (owner 2026-08-18: "nothing
      // happens") — a school with no code minted cannot proceed at all, and
      // the page has to say WHY right where the button was pressed.
      const noCode = selectedInstOption?.has_code === false;
      const msg = noCode
        ? t("This school has no access code yet, so it cannot register. Ask the organizer to send one.")
        : t("Enter your school's access code to continue.");
      setCodeError(msg);
      // The code panel already carries the enter-your-code prompt; only the
      // no-code DEAD END needs the form-level banner, because there the panel
      // text was static and pressing Next visibly did nothing.
      if (noCode) setErrors((e) => ({ ...e, __form: msg }));
      return;
    }
    // A tabbed sheet walks tab by tab, so nothing behind a tab is skipped:
    // Next moves Teachers -> Students, and only the LAST tab's press leads on
    // to the review (owner 2026-08-18).
    const tabs = tabRunOf(current);
    if (tabs.length > 1) {
      const curKey =
        sheetTab && tabs.some((f) => f.key === sheetTab)
          ? sheetTab
          : tabs[0].key;
      const at = tabs.findIndex((f) => f.key === curKey);
      if (at < tabs.length - 1) {
        setSheetTab(tabs[at + 1].key);
        if (typeof window !== "undefined")
          window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
    }
    if (!validateCurrent()) {
      // The failing answer may live behind the other tab — open it.
      if (tabs.length > 1) {
        const all = { ...dupErrors, ...validateRequired(schema, answers) };
        const bad = tabs.find(
          (f) =>
            all[f.key] ||
            Object.keys(all).some((k) => k.startsWith(`${f.key}.`)),
        );
        if (bad) setSheetTab(bad.key);
      }
      return;
    }
    setSheetTab(null);
    setStepIndex((i) => Math.min(i + 1, reviewIndex));
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function onBack() {
    setErrors({});
    setErrorPaths({});
    setSheetTab(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function onSubmit() {
    if (needsCode && !accessToken) {
      setCodeError(t("Enter your school's access code to continue."));
      const idx = steps.findIndex((s) =>
        s.fields.some((f) => f.key === instField?.key),
      );
      if (idx >= 0) setStepIndex(idx);
      return;
    }
    // Full-schema check across every reachable section so nothing slips by.
    const all = { ...dupErrors, ...validateRequired(schema, answers) };
    if (Object.keys(all).length) {
      setErrors({
        ...all,
        __form: t("Please answer the required questions highlighted below."),
      });
      const idx = steps.findIndex((s) =>
        sectionActiveFields(s, answers).some((f) => all[f.key]),
      );
      if (idx >= 0) setStepIndex(idx);
      if (typeof window !== "undefined")
        window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    submit.mutate();
  }

  // --- Terminal & loading states -------------------------------------------

  if (payload.isError) {
    return (
      <PublicShell>
        <Centered>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldCheck aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("This form could not be found")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Ask the organizer for a fresh link.")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  if (data?.closed) {
    return (
      <PublicShell tournamentName={data.tournament_name}>
        <Centered>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Lock aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("Registration closed")}
          </h1>
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {t("No longer accepting submissions.")}
          </p>
          {data.has_directory && data.form_id ? (
            <a
              href={`/f/${data.form_id}/directory`}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              {t("View registered institutions")}
            </a>
          ) : null}
        </Centered>
      </PublicShell>
    );
  }

  if (done !== null) {
    return (
      <PublicShell tournamentName={data?.tournament_name}>
        <Centered>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {t("Registration received")}
          </h1>
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-sm text-muted-foreground"
          >
            {done || t("Thank you! Your submission has been recorded.")}
          </p>
          {/* Straight to the public list of registered institutions. */}
          <a
            href={`/f/${form?.id ?? formId}/directory`}
            className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Building2 aria-hidden="true" className="h-4 w-4" />
            {t("View the public directory")}
          </a>
        </Centered>
      </PublicShell>
    );
  }

  if (payload.isLoading || !form) {
    return (
      <PublicShell>
        <Centered>
          <p role="status" className="text-sm text-muted-foreground">
            {t("Loading…")}
          </p>
        </Centered>
      </PublicShell>
    );
  }

  const formError = errors.__form;

  // Consecutive fields sharing `group` render inside ONE card titled by the
  // group label. Chain questions NEST: each follow-up renders directly under
  // the option that revealed it (owner 2026-07-05: pick a sport, its
  // sub-options unfold right below, level by level) — driven purely by each
  // field's visibility pointer, nothing sport-specific.
  /** A short answer that can share a row: one line of text, a date, a pick.
   * Choice lists, uploads and groups are tall and keep the full width. */
  const isCompact = (f: Field): boolean =>
    ["short_text", "email", "phone", "number", "date", "time", "dropdown"].includes(
      f.type,
    ) && !f.data_source;

  const renderGrouped = (
    fields: Field[],
    readOnly = false,
  ): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    // Which field decides whether each group appears. Its options ARE the
    // group headings, so asking it separately ("Which sport(s) are you
    // entering teams for?") and then heading each card with the same name was
    // the same question twice (owner 2026-08-18). The heading carries the
    // checkbox instead, and the question itself is not drawn.
    const gateOf = new Map<string, { field: string; value: string }>();
    for (const f of fields) {
      const v = f.visibility;
      if (f.group && v?.op === "includes" && typeof v.value === "string") {
        if (!gateOf.has(f.group)) {
          gateOf.set(f.group, { field: v.field, value: v.value });
        }
      }
    }
    const gaters = new Set([...gateOf.values()].map((g) => g.field));
    let i = 0;
    while (i < fields.length) {
      const f = fields[i];
      if (gaters.has(f.key)) {
        i += 1;
        continue;
      }
      // Consecutive sheets with tab labels share one tabbed surface.
      if (!f.group && f.layout === "sheet" && f.tab_label) {
        const tabs: Field[] = [];
        while (
          i < fields.length &&
          !fields[i].group &&
          fields[i].layout === "sheet" &&
          fields[i].tab_label
        ) {
          tabs.push(fields[i]);
          i += 1;
        }
        out.push(
          <SheetTabs
            key={`tabs-${tabs[0].key}`}
            fields={tabs}
            active={sheetTab}
            onActive={setSheetTab}
            render={(fld) => renderField(fld, readOnly)}
            countOf={(fld) =>
              Array.isArray(answers[fld.key])
                ? (answers[fld.key] as unknown[]).length
                : 0
            }
            errorOn={(fld) =>
              Boolean(errors[fld.key]) ||
              Object.keys(errorPaths).some((k) => k.startsWith(`${fld.key}.`))
            }
          />,
        );
        continue;
      }
      if (!f.group) {
        // Consecutive SHORT answers pack two to a row (owner 2026-08-18): the
        // contact block is a name, an email and a phone, and stacked full
        // width they read as three unrelated questions instead of one card of
        // details about the school. Anything tall keeps its own row.
        const compact: Field[] = [];
        while (i < fields.length && !fields[i].group && isCompact(fields[i])) {
          compact.push(fields[i]);
          i += 1;
        }
        if (compact.length > 1) {
          out.push(
            <div
              key={`pack-${compact[0].key}`}
              className={cn(
                "grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2",
                // Three short answers are one line of one record (owner
                // 2026-08-18: the contact person, email and phone on a
                // single row). Pairs stay two-up; only a full trio spreads.
                compact.length % 3 === 0 && "lg:grid-cols-3",
              )}
            >
              {compact.map((c) => (
                <div key={c.key}>{renderField(c, readOnly)}</div>
              ))}
            </div>,
          );
          continue;
        }
        for (const c of compact) out.push(renderField(c, readOnly));
        if (compact.length) continue;
        out.push(renderField(f, readOnly));
        i += 1;
        continue;
      }
      const group = f.group;
      const chunk: Field[] = [];
      while (i < fields.length && fields[i].group === group) {
        chunk.push(fields[i]);
        i += 1;
      }
      const visible = chunk.filter(
        (c) => isVisible(c.visibility, answers) && !lockedSet.has(c.key),
      );
      // An UNTICKED group has nothing visible inside it, but its card must
      // still be drawn: the header checkbox is what reveals the rest, and
      // skipping the card would leave no way to tick it.
      if (!visible.length && !gateOf.has(group)) continue;

      // Wire each field to the option that reveals it (visibility points at
      // the parent field + value). Fields gated from OUTSIDE the chunk (e.g.
      // by the sports question) are the roots.
      const chunkKeys = new Set(chunk.map((c) => c.key));
      const kidsOf = new Map<string, Map<string, Field[]>>();
      const roots: Field[] = [];
      for (const c of chunk) {
        const vis = c.visibility;
        if (vis && chunkKeys.has(vis.field)) {
          const byVal = kidsOf.get(vis.field) ?? new Map<string, Field[]>();
          const val = String(vis.value ?? "");
          byVal.set(val, [...(byVal.get(val) ?? []), c]);
          kidsOf.set(vis.field, byVal);
        } else {
          roots.push(c);
        }
      }
      const renderChain = (c: Field, nested: boolean): React.ReactNode => {
        const byVal = kidsOf.get(c.key);
        return renderField({ ...c, label: c.short_label ?? c.label }, readOnly, {
          hideLabel: nested,
          optionExtra: byVal
            ? (val) => {
                const list = (byVal.get(val) ?? []).filter(
                  (k) =>
                    isVisible(k.visibility, answers) && !lockedSet.has(k.key),
                );
                if (!list.length) return null;
                return (
                  <div className="ml-4 flex flex-col gap-3 border-l-2 border-primary/40 pl-3 pb-0.5">
                    {list.map((k) => renderChain(k, true))}
                  </div>
                );
              }
            : undefined,
        });
      };
      out.push(
        <div
          key={`group-${group}`}
          className="flex flex-col gap-4 rounded-lg border border-border bg-muted/20 p-4"
        >
          {(() => {
            const gate = gateOf.get(group);
            const name = t(chunk[0].group_label ?? group);
            if (!gate) {
              return <h3 className="text-sm font-semibold">{name}</h3>;
            }
            const chosen = Array.isArray(answers[gate.field])
              ? (answers[gate.field] as unknown[]).map(String)
              : [];
            const on = chosen.includes(gate.value);
            return (
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={readOnly}
                  aria-label={name}
                  onChange={(e) =>
                    setAnswer(
                      gate.field,
                      e.target.checked
                        ? [...chosen, gate.value]
                        : chosen.filter((v) => v !== gate.value),
                    )
                  }
                  className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <h3 className="text-sm font-semibold">{name}</h3>
              </label>
            );
          })()}
          {roots.map((c) => renderChain(c, false))}
        </div>,
      );
    }
    return out;
  };

  // Render a field and, recursively, the nested follow-up fields of any selected
  // option (indented). Returns null for hidden/locked fields. Competition-scoped
  // fields show ONLY the options the selected school registered for.
  const renderField = (
    raw: Field,
    readOnly = false,
    extra?: {
      optionExtra?: (value: string) => React.ReactNode;
      hideLabel?: boolean;
    },
  ): React.ReactNode => {
    if (!isVisible(raw.visibility, answers) || lockedSet.has(raw.key)) return null;
    let f =
      instLeaves && compFieldKeys.has(raw.key)
        ? {
            ...raw,
            options: (raw.options ?? []).filter((o) =>
              compAllowed(String(o.value)),
            ),
          }
        : raw;
    // The sheet's per-competition tick columns are scoped the same way
    // (owner 2026-08-18: "based on what the institute selected during
    // institute registration"). The flag lives on the CHILD inside the
    // group, so the children are filtered here before the sheet draws them.
    if (instLeaves && f.fields?.some((c) => c.scope_to_institution)) {
      f = {
        ...f,
        fields: f.fields.map((c) =>
          c.scope_to_institution
            ? {
                ...c,
                options: (c.options ?? []).filter((o) =>
                  compAllowed(String(o.value)),
                ),
              }
            : c,
        ),
      };
    }
    const nested: React.ReactNode[] = [];
    for (const o of f.options ?? []) {
      if (o.fields?.length && optionSelected(f, o.value, answers)) {
        for (const child of o.fields) {
          const rendered = renderField(child, readOnly);
          if (rendered) nested.push(rendered);
        }
      }
    }
    return (
      <div key={f.key} className="flex flex-col gap-5">
        <FieldRenderer
          field={f}
          value={answers[f.key]}
          error={readOnly ? undefined : (errors[f.key] ?? dupErrors[f.key])}
          errorPaths={readOnly ? undefined : errorPaths}
          path={f.key}
          onChange={(v) => setAnswer(f.key, v)}
          onUpload={readOnly ? undefined : handleUpload}
          fileMeta={displayFileMeta}
          onFileLabel={readOnly ? undefined : handleFileLabel}
          disabled={readOnly}
          optionExtra={extra?.optionExtra}
          hideLabel={extra?.hideLabel}
        />
        {nested.length ? (
          <div className="ml-3 flex flex-col gap-5 border-l-2 border-border pl-4">
            {nested}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <PublicShell tournamentName={data?.tournament_name}>
      {/* Extra bottom padding reserves room for the floating contact button so it
          never covers the Back/Next/Submit footer (notably on narrow screens). */}
      {/* Roughly 70% of a desk, capped so a line of text never runs too long
          to track (owner 2026-08-18). A phone still gets the full width. */}
      {/* Same frame as the public directory (owner 2026-08-18): 90% of a
          desk, a page header above the panel, and one bordered panel with a
          toolbar band. The two pages are the same product and were reading
          as two different ones. */}
      <BentoGrid className="mx-auto flex w-full flex-col gap-4 px-4 pb-28 pt-6 sm:px-6 lg:w-[90%] lg:max-w-none">
        <ContactAdminDialog
          formId={form?.id ?? formId ?? ""}
          open={contactOpen}
          onOpenChange={setContactOpen}
        />

        {/* Floating "contact" launcher — the familiar website overlay-button
            pattern; opens the contact dialog. Fixed to the viewport, always
            reachable as the applicant scrolls the form. */}
        <button
          type="button"
          onClick={() => setContactOpen(true)}
          aria-label={t("Contact the organisers")}
          className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <MessageCircle aria-hidden="true" className="h-5 w-5" />
          <span className="hidden sm:inline">{t("Contact the organisers")}</span>
        </button>

        {/* ONE panel for the whole form (owner 2026-08-15): the heading, the
            organiser's instructions, who you are registering as, the step you
            are on, the questions themselves and the Back/Next footer are bands
            of a single card, not a stack of them. */}
        <StarBorder>
          <section
            data-testid="registration-panel"
            className="bento-card panel flex w-full flex-col divide-y divide-border overflow-hidden"
          >
            {/* The page header lives INSIDE the panel (owner 2026-08-18):
                eyebrow, title, purpose and the Registered link are the card's
                own first band, not a floater above it. */}
            <header className="flex flex-wrap items-end justify-between gap-3 px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-primary">
                  {t("Registration")}
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                  {t(form.title)}
                </h1>
                {/* The shell already names the tournament above this, so the
                    subtitle says what this form is FOR instead of repeating it. */}
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Enter your school's teams for this tournament.")}
                </p>
              </div>
              <a
                href={`/f/${form.id}/directory`}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "h-8 shrink-0 px-2.5 text-xs",
                )}
              >
                <Users aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Registered")}
              </a>
            </header>

            {/* Instructions — dates, age cut-off, rules — where they are read. */}
            {form.description ? (
              <aside role="note" className="flex gap-3 bg-primary/[0.06] px-5 py-4 sm:px-6">
                <Info aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <RichText
                  html={form.description}
                  className="text-sm leading-relaxed text-foreground/90 [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold"
                />
              </aside>
            ) : null}

            {/* Admin entry path: organizer filling the form — no access code. */}
            {data?.can_manage ? (
              <div className="flex items-center gap-2 bg-primary/5 px-5 py-2.5 text-sm sm:px-6">
                <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                <span>
                  {t(
                    "Signed in as an organizer. Add or replace any school's teams without a code.",
                  )}
                </span>
              </div>
            ) : null}

            {/* Bound per-institution link: show who they're registering as. */}
            {boundLabel ? (
              <div className="flex items-center gap-2 bg-muted/40 px-5 py-2.5 text-sm sm:px-6">
                <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                <span>
                  {t("Registering as")}{" "}
                  <span className="font-medium text-foreground">{boundLabel}</span>
                </span>
              </div>
            ) : null}

            {/* Where you are, and what this step is — said ONCE (the section
                used to repeat its own title as a second heading). */}
            {/* How far through, and how much is left. A tournament with ten
                competitions is a ten-step form, and "Step 3 of 13" alone does
                not show how much is still ahead (owner 2026-08-18). */}
            {steps.length > 1 ? (
              <div
                className="h-1 w-full bg-muted"
                role="progressbar"
                aria-label={t("Registration progress")}
                aria-valuemin={1}
                aria-valuemax={steps.length + 1}
                aria-valuenow={clamped + 1}
                data-testid="form-progress"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{
                    width: `${((clamped + 1) / (steps.length + 1)) * 100}%`,
                  }}
                />
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border p-3">
              <ClipboardList aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              <h2 className="text-sm font-semibold">
                {isReview
                  ? t("Review your registration")
                  : current
                    ? t(current.title)
                    : t("Questions")}
              </h2>
              {steps.length >= 1 ? (
                <span className="flex items-baseline gap-1 pl-1" aria-live="polite">
                  <span className="font-tabular text-base font-semibold leading-none">
                    {clamped + 1}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("of")} {steps.length + 1}
                    {steps.length - clamped > 0
                      ? ` · ${steps.length - clamped} ${t("left")}`
                      : ""}
                  </span>
                </span>
              ) : null}
              <p className="w-full text-sm text-muted-foreground">
                {isReview
                  ? t("Check your answers, then submit. Use Back to edit.")
                  : current?.description
                    ? t(current.description)
                    : ""}
              </p>
            </div>

            {/* Per-sport tally, exactly the band the public directory carries
                under its toolbar (owner 2026-08-18: the two pages should read
                as one product). It says what the school has entered so far,
                and appears as soon as a sport is ticked. */}
            {/* The tally appears once it can MEAN something: on the sheet
                itself, on review, or as soon as any entry exists. On step one
                two zeros read as something broken (owner 2026-08-19). */}
            {entrySummary.length > 0 &&
            (isReview ||
              entrySummary.some((g) => g.count > 0) ||
              tabRunOf(current).length > 0) ? (
              <section
                aria-label={t("Your entry so far")}
                data-testid="entry-summary"
                className="flex flex-wrap gap-x-4 gap-y-1.5 border-b border-border px-3 py-2"
              >
                {entrySummary.map((g) => (
                  <span
                    key={g.key}
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
                      g.count === 0 && "opacity-60",
                    )}
                  >
                    <Trophy aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                    {g.name}
                    <span className="font-tabular text-sm font-semibold text-foreground">
                      {g.count}
                    </span>
                    <span className="text-[0.6875rem]">
                      {g.count === 1 ? t("entry") : t("entries")}
                    </span>
                  </span>
                ))}
              </section>
            ) : null}

            {/* The questions themselves. */}
            {isReview ? (
              <div
                aria-label={t("Review your registration")}
                className="flex flex-col gap-6 px-5 py-5 sm:px-6"
              >
                {sections.map((s, i) => {
                  // The built competitions read back as ONE table below,
                  // never as a stack of collapsed sections.
                  if (s.auto) return null;
                  const fields = renderGrouped(s.fields, true);
                  if (fields.length === 0) return null;
                  return (
                    <div
                      key={i}
                      className="flex flex-col gap-4 border-t border-border pt-5 first:border-t-0 first:pt-0"
                    >
                      {s.title ? (
                        <h3 className="text-sm font-semibold text-muted-foreground">
                          {t(s.title)}
                        </h3>
                      ) : null}
                      <div className="flex flex-col gap-5">{fields}</div>
                    </div>
                  );
                })}
                {reviewTeams.length > 0 ? (
                  <div className="flex flex-col gap-4 border-t border-border pt-5">
                    <h3 className="text-sm font-semibold text-muted-foreground">
                      {t("Your teams")}
                    </h3>
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table
                        data-testid="review-teams"
                        className="w-full border-separate border-spacing-0 text-sm"
                      >
                        <caption className="sr-only">
                          {t("The teams this registration will create")}
                        </caption>
                        <thead>
                          <tr>
                            {[
                              t("Competition"),
                              t("Team"),
                              t("Players"),
                              t("Teacher in charge"),
                            ].map((h) => (
                              <th
                                key={h}
                                scope="col"
                                className="border-b border-r border-border bg-muted px-3 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {reviewTeams.map((row, i) => (
                            <tr
                              key={`${row.competition}-${i}`}
                              className={i % 2 ? "bg-muted/20" : "bg-card"}
                            >
                              <td className="border-b border-r border-border px-3 py-2 text-xs text-muted-foreground">
                                {row.competition}
                              </td>
                              <td className="border-b border-r border-border px-3 py-2 font-medium">
                                {row.team || t("(named on submit)")}
                              </td>
                              <td className="border-b border-r border-border px-3 py-2">
                                {row.players.join(", ") || (
                                  <span className="text-destructive">
                                    {t("No players")}
                                  </span>
                                )}
                              </td>
                              <td className="border-b border-border px-3 py-2 text-muted-foreground">
                                {row.staff.join(", ") || "·"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : current ? (
              <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
                {/* While a school's prior registration is loading, neither the
                    EMPTY fields nor the previous school's answers may show —
                    both read as the truth and both are wrong (owner
                    2026-08-18). The skeleton stands in until the merge lands. */}
                {managerPrefill.isPending || verifyCode.isPending ? (
                  <div
                    aria-busy="true"
                    data-testid="prefill-skeleton"
                    className="flex flex-col gap-3"
                  >
                    {Array.from({ length: 6 }, (_, i) => (
                      <div
                        key={i}
                        className="h-9 animate-pulse rounded-md bg-muted/50"
                        style={{ animationDelay: `${i * 70}ms` }}
                      />
                    ))}
                    <p role="status" className="text-xs text-muted-foreground">
                      {t("Loading this school's registration…")}
                    </p>
                  </div>
                ) : (
                  <>
                {/* Until the access code is verified, the ONLY things on screen
                    are the school picker and the code panel · no prefilled
                    contacts, sports or categories leak to someone without the
                    code. */}
                {renderGrouped(
                  codeGateOpen(current)
                    ? current.fields.filter((f) => f.key === instField?.key)
                    : current.fields,
                )}

                {/* School access code — required before this school's teams can
                    be registered or edited (sent to the school's contact email
                    when team registration opened). */}
                {needsCode && current.fields.some((f) => f.key === instField?.key) ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-primary/5 p-4">
                    {accessToken ? (
                      <div className="flex items-start gap-2 text-sm">
                        <ShieldCheck
                          aria-hidden="true"
                          className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                        />
                        <span>
                          {editingPrior
                            ? t(
                                "Code verified. You're editing your existing registration; submitting replaces it.",
                              )
                            : t("Code verified. You can register your teams.")}
                        </span>
                      </div>
                    ) : selectedInstOption?.has_code === false ? (
                      <>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <KeyRound aria-hidden="true" className="h-4 w-4 text-primary" />
                          {t("School access code")}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "This school has no access code yet. Ask the organizer to send one to your school's contact email before registering teams.",
                          )}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <KeyRound aria-hidden="true" className="h-4 w-4 text-primary" />
                          {t("School access code")}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "A code was emailed to your school's contact. Enter it to add or edit teams. No code? Ask the organizer.",
                          )}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            value={codeInput}
                            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                            placeholder="E.g. K7MWPX2A"
                            className="h-9 max-w-[11rem] font-tabular uppercase"
                            aria-label={t("Access code")}
                          />
                          <Button
                            size="sm"
                            disabled={verifyCode.isPending || codeInput.trim().length < 4}
                            onClick={() => verifyCode.mutate()}
                          >
                            {verifyCode.isPending ? t("Checking…") : t("Verify code")}
                          </Button>
                        </div>
                        {codeError ? (
                          <p role="alert" className="text-xs text-destructive">
                            {codeError}
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
                  </>
                )}
              </div>
            ) : (
              <p className="px-5 py-5 text-sm text-muted-foreground sm:px-6">
                {t("This form has no questions yet.")}
              </p>
            )}

            {/* Form-level error */}
            {formError ? (
              <div
                role="alert"
                aria-live="assertive"
                className="bg-destructive/10 px-5 py-3 text-sm text-destructive sm:px-6"
              >
                {formError}
              </div>
            ) : null}

            {/* Navigation closes the same panel. */}
            <div className="flex items-center justify-between gap-3 bg-muted/30 px-5 py-3 sm:px-6">
              <Button
                type="button"
                variant="outline"
                onClick={onBack}
                disabled={clamped === 0 || submit.isPending}
              >
                {t("Back")}
              </Button>
              {isReview ? (
                <Button
                  type="button"
                  size="lg"
                  disabled={submit.isPending}
                  onClick={onSubmit}
                >
                  {submit.isPending ? t("Submitting…") : t("Submit")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="lg"
                  disabled={!current}
                  onClick={onNext}
                >
                  {(() => {
                    // The button names where it GOES (owner 2026-08-19):
                    // the next tab's own label mid-walk, the next step's name
                    // otherwise, and the confirm at the end. A bare "Next"
                    // said nothing.
                    const tabs = tabRunOf(current);
                    const curKey =
                      sheetTab && tabs.some((f) => f.key === sheetTab)
                        ? sheetTab
                        : tabs[0]?.key;
                    const at = tabs.findIndex((f) => f.key === curKey);
                    if (tabs.length > 1 && at < tabs.length - 1) {
                      return t(tabs[at + 1].tab_label ?? "Next");
                    }
                    if (steps.length > 0 && clamped === steps.length - 1) {
                      return t("Confirm & review");
                    }
                    const upcoming = steps[clamped + 1];
                    if (upcoming && tabRunOf(upcoming).length > 0) {
                      return t(upcoming.title).replace(/^Your\s+/i, "");
                    }
                    return t("Next");
                  })()}
                </Button>
              )}
            </div>
          </section>
        </StarBorder>
      </BentoGrid>
    </PublicShell>
  );
}
