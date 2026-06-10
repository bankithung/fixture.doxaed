import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newEventId } from "@/lib/eventId";
import {
  isVisible,
  optionSelected,
  reachableSections,
  sectionActiveFields,
  validateRequired,
} from "@/lib/formLogic";
import { t } from "@/lib/t";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { FieldRenderer } from "./fieldRenderers";
import type { Field } from "./types";

const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

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
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [eventId] = useState(newEventId); // stable across retries (idempotency)
  const [done, setDone] = useState<string | null>(null);

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

  // Fields the link locks (e.g. the institution) are hidden from the wizard —
  // their value rides along in `answers` and the server is authoritative anyway.
  const lockedSet = useMemo(() => new Set(data?.locked ?? []), [data?.locked]);
  const boundLabel = data?.bound?.label;

  const schema = useMemo(
    () => form?.schema ?? { version: 1, sections: [] },
    [form?.schema],
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
  useEffect(() => {
    if (!instField || compFieldKeys.size === 0) return;
    const v = String(answers[instField.key] ?? "");
    if (!v || v === lastScopedInst.current) return;
    lastScopedInst.current = v;
    const leaves =
      instField.options?.find((o) => String(o.value) === v)?.leaves ?? [];
    if (leaves.length === 0) return;
    const next: Record<string, unknown> = {};
    for (const s of schema.sections ?? []) {
      for (const f of s.fields ?? []) {
        if (!compFieldKeys.has(f.key)) continue;
        const sel = (f.options ?? [])
          .map((o) => String(o.value))
          .filter((ov) => leaves.some((l) => l === ov || l.startsWith(`${ov}.`)));
        next[f.key] = f.type === "multi_choice" ? sel : (sel[0] ?? "");
      }
    }
    setAnswers((a) => ({ ...a, ...next }));
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
  useEffect(() => {
    // Switching school invalidates any prior verification.
    setAccessToken(null);
    setCodeInput("");
    setCodeError(null);
    setEditingPrior(false);
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
        // Their saved registration becomes the working answers (edit mode).
        setAnswers((a) => ({ ...a, ...res.prefill }));
      }
    },
    onError: (e) =>
      setCodeError(
        e instanceof ApiError && e.status === 403
          ? e.payload.detail === "locked"
            ? t("Too many wrong attempts — try again in 15 minutes.")
            : t("That code isn't right — check the email sent to your school.")
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
      if (res.prefill) setAnswers((a) => ({ ...a, ...res.prefill }));
    },
  });
  useEffect(() => {
    if (!data?.can_manage || !instField) return;
    const v = String(selectedInstValue ?? "");
    if (!v || v === lastManagerInst.current) return;
    lastManagerInst.current = v;
    managerPrefill.mutate(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, instField, selectedInstValue]);

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
            "Two teams here have the same name — give each team a different name.",
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
  const clamped = Math.min(stepIndex, Math.max(sections.length - 1, 0));
  const current = sections[clamped];
  const isLast = clamped >= sections.length - 1;

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const handleUpload = async (field: Field, file: File): Promise<string> => {
    const id = form?.id ?? formId ?? "";
    const res = await formsApi.publicUpload(id, field.key, file);
    setUploadRefs((r) => ({ ...r, [field.key]: res.upload_ref }));
    return res.upload_ref;
  };

  const submit = useMutation({
    mutationFn: () => {
      const body = {
        answers,
        event_id: eventId,
        upload_refs: uploadRefs,
        ...(accessToken ? { access_token: accessToken } : {}),
      };
      return token !== undefined
        ? formsApi.publicSubmitByToken(token, { answers, event_id: eventId })
        : formsApi.publicSubmit(form?.id ?? formId ?? "", body);
    },
    onSuccess: (res) => setDone(res.message),
    onError: (e) => {
      const fieldErrs = serverFieldErrors(e);
      if (Object.keys(fieldErrs).length) {
        setErrors(fieldErrs);
        // Jump to the first reachable section that owns a failing field.
        const idx = sections.findIndex((s) =>
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

  /** True when the visible section contains the institution picker and the
   * selected school still has to verify its access code. */
  const codeGateOpen = (section: typeof current): boolean =>
    !!section &&
    needsCode &&
    !accessToken &&
    section.fields.some((f) => f.key === instField?.key);

  function onNext() {
    if (codeGateOpen(current)) {
      setCodeError(t("Enter your school's access code to continue."));
      return;
    }
    if (!validateCurrent()) return;
    setStepIndex((i) => Math.min(i + 1, sections.length - 1));
  }

  function onBack() {
    setErrors({});
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function onSubmit() {
    if (needsCode && !accessToken) {
      setCodeError(t("Enter your school's access code to continue."));
      const idx = sections.findIndex((s) =>
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
      const idx = sections.findIndex((s) =>
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
            {t("This form is no longer accepting submissions.")}
          </p>
          {data.has_directory && data.form_id ? (
            <a
              href={`/f/${data.form_id}/directory`}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              {t("View registered institutions")} →
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
  // group label, each question indented per `indent` and shown with its
  // sport-less `short_label` (W2: the flat run of chained category questions
  // was unreadable once several sports were selected). Ungrouped fields
  // render exactly as before.
  const renderGrouped = (fields: Field[]): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    let i = 0;
    while (i < fields.length) {
      const f = fields[i];
      if (!f.group) {
        out.push(renderField(f));
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
      if (!visible.length) continue;
      out.push(
        <div
          key={`group-${group}`}
          className="flex flex-col gap-4 rounded-lg border border-border bg-muted/20 p-4"
        >
          <h3 className="text-sm font-semibold">
            {t(chunk[0].group_label ?? group)}
          </h3>
          {visible.map((c) => {
            const depth = Math.min(c.indent ?? 0, 4);
            return (
              <div
                key={c.key}
                className={depth > 0 ? "border-l-2 border-border pl-3" : undefined}
                style={depth > 0 ? { marginLeft: (depth - 1) * 16 } : undefined}
              >
                {renderField({ ...c, label: c.short_label ?? c.label })}
              </div>
            );
          })}
        </div>,
      );
    }
    return out;
  };

  // Render a field and, recursively, the nested follow-up fields of any selected
  // option (indented). Returns null for hidden/locked fields. Competition-scoped
  // fields show ONLY the options the selected school registered for.
  const renderField = (raw: Field): React.ReactNode => {
    if (!isVisible(raw.visibility, answers) || lockedSet.has(raw.key)) return null;
    const f =
      instLeaves && compFieldKeys.has(raw.key)
        ? {
            ...raw,
            options: (raw.options ?? []).filter((o) =>
              compAllowed(String(o.value)),
            ),
          }
        : raw;
    const nested: React.ReactNode[] = [];
    for (const o of f.options ?? []) {
      if (o.fields?.length && optionSelected(f, o.value, answers)) {
        for (const child of o.fields) {
          const rendered = renderField(child);
          if (rendered) nested.push(rendered);
        }
      }
    }
    return (
      <div key={f.key} className="flex flex-col gap-5">
        <FieldRenderer
          field={f}
          value={answers[f.key]}
          error={errors[f.key] ?? dupErrors[f.key]}
          onChange={(v) => setAnswer(f.key, v)}
          onUpload={handleUpload}
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        {/* Heading */}
        <div>
          <p className={OVERLINE}>{t("Registration")}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t(form.title)}
          </h1>
          {form.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t(form.description)}
            </p>
          ) : null}
          <a
            href={`/f/${form.id}/directory`}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            {t("View registered organisations")} →
          </a>
        </div>

        {/* Admin entry path: organizer filling the form — no access code. */}
        {data?.can_manage ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />
            <span>
              {t(
                "You're signed in as an organizer — add or replace any school's teams without a code.",
              )}
            </span>
          </div>
        ) : null}

        {/* Bound per-institution link: show who they're registering as. */}
        {boundLabel ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />
            <span>
              {t("Registering as")}{" "}
              <span className="font-medium text-foreground">{boundLabel}</span>
            </span>
          </div>
        ) : null}

        {/* Step indicator */}
        {sections.length > 1 ? (
          <p className="font-tabular text-xs text-muted-foreground" aria-live="polite">
            {t("Step")} {clamped + 1} {t("of")} {sections.length}
            {current?.title ? ` · ${t(current.title)}` : ""}
          </p>
        ) : null}

        {/* Current section */}
        {current ? (
          <section
            aria-label={current.title || t("Section")}
            className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
          >
            <div>
              <h2 className="text-base font-semibold">{t(current.title)}</h2>
              {current.description ? (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(current.description)}
                </p>
              ) : null}
            </div>

            {/* Until the access code is verified, the ONLY things on screen
                are the school picker and the code panel — no prefilled
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
                            "Code verified — you're editing your school's existing registration. Submitting replaces it.",
                          )
                        : t("Code verified — you can register your teams.")}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <KeyRound aria-hidden="true" className="h-4 w-4 text-primary" />
                      {t("School access code")}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "A code was emailed to your school's contact when team registration opened. Enter it to add or edit your teams. No code? Ask the organizer.",
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
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("This form has no questions yet.")}
          </p>
        )}

        {/* Form-level error */}
        {formError ? (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {formError}
          </div>
        ) : null}

        {/* Navigation */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={clamped === 0 || submit.isPending}
          >
            {t("Back")}
          </Button>
          {isLast ? (
            <Button
              type="button"
              size="lg"
              disabled={submit.isPending || !current}
              onClick={onSubmit}
            >
              {submit.isPending ? t("Submitting…") : t("Submit")}
            </Button>
          ) : (
            <Button type="button" size="lg" onClick={onNext}>
              {t("Next")}
            </Button>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
