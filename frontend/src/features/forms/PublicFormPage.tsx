import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { formsApi } from "@/api/forms";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
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

/** Pull a DRF `{ errors: { field: msg } }` map off an ApiError, if present. */
function serverFieldErrors(e: unknown): Record<string, string> {
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
      const body = { answers, event_id: eventId, upload_refs: uploadRefs };
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
    }
    setErrors(here);
    return Object.keys(here).length === 0;
  }

  function onNext() {
    if (!validateCurrent()) return;
    setStepIndex((i) => Math.min(i + 1, sections.length - 1));
  }

  function onBack() {
    setErrors({});
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function onSubmit() {
    // Full-schema check across every reachable section so nothing slips by.
    const all = validateRequired(schema, answers);
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

  // Render a field and, recursively, the nested follow-up fields of any selected
  // option (indented). Returns null for hidden/locked fields.
  const renderField = (f: Field): React.ReactNode => {
    if (!isVisible(f.visibility, answers) || lockedSet.has(f.key)) return null;
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
          error={errors[f.key]}
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

            {current.fields.map(renderField)}
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
