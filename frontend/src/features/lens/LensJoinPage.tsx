import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, Search } from "lucide-react";
import { lensApi } from "@/api/lens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { ApiError } from "@/types/api";
import { Centered, PublicShell } from "@/features/registration/PublicShell";
import { LensUploadPage } from "./LensUploadPage";

/** The session outlives a reload (a phone that drops the tab mid-upload should
 * not send a teacher back for the code), but never the browser session. */
const STORE_KEY = "lens.session";

function readStored(card: string): string {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { card?: string; token?: string };
    return parsed.card === card ? (parsed.token ?? "") : "";
  } catch {
    return "";
  }
}

function store(card: string, token: string): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ card, token }));
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

function joinErr(e: unknown): string {
  const payload = e instanceof ApiError ? e.payload : null;
  const code = String(
    (payload as { code?: string[] | string } | null)?.code ?? "",
  );
  if (code.includes("locked")) {
    return t(
      "Too many wrong codes. Try again in 15 minutes, or ask the host for a new code.",
    );
  }
  if (code.includes("invalid_code")) {
    return t("That code does not match this school. Check it and try again.");
  }
  return t("Could not sign in. Check your connection and try again.");
}

/**
 * The page behind the event's ONE QR card (owner 2026-08-13).
 *
 * Every school scans the same poster, so the card alone proves nothing: it
 * names the album, then the school says who it is and types the code the host
 * gave it. A correct code returns a signed, expiring session token and the
 * normal upload page takes over in place — the token never enters the URL,
 * where it would ride into browser history and shoulder-surfing range.
 */
export function LensJoinPage(): React.ReactElement {
  const { token: card = "" } = useParams();
  const [session, setSession] = useState<string>(() => readStored(card));
  const [institutionId, setInstitutionId] = useState("");
  const [code, setCode] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const ctxQ = useQuery({
    queryKey: ["lens-join", card],
    queryFn: () => lensApi.joinContext(card),
    enabled: Boolean(card) && !session,
    retry: false,
  });

  useEffect(() => {
    const name = ctxQ.data?.campaign.title;
    if (name) document.title = `${name} · ${t("Upload photos")}`;
  }, [ctxQ.data]);

  const schools = useMemo(() => {
    const all = ctxQ.data?.institutions ?? [];
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((i) => i.name.toLowerCase().includes(needle))
      : all;
  }, [ctxQ.data, q]);

  // Signed in: the upload page IS this page from here on.
  if (session)
    return (
      <LensUploadPage
        sessionToken={session}
        onSwitchSchool={() => {
          // Back to the picker: forget this session on this device.
          try {
            sessionStorage.removeItem(STORE_KEY);
          } catch {
            /* ignore */
          }
          setSession("");
        }}
      />
    );

  if (ctxQ.isLoading) {
    return (
      <PublicShell>
        <Centered>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            {t("Opening the album…")}
          </div>
        </Centered>
      </PublicShell>
    );
  }

  if (ctxQ.isError || !ctxQ.data) {
    return (
      <PublicShell>
        <Centered>
          <div className="panel p-6 text-center">
            <p role="alert" className="text-sm text-destructive">
              {t("This card is not valid any more.")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Ask the host for the current card.")}
            </p>
          </div>
        </Centered>
      </PublicShell>
    );
  }

  const ctx = ctxQ.data;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!institutionId || !code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await lensApi.join(card, {
        institution_id: institutionId,
        code: code.trim(),
      });
      store(card, res.token);
      setSession(res.token);
    } catch (err) {
      setError(joinErr(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell tournamentName={ctx.tournament.name}>
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <section className="panel" data-testid="lens-join">
          <div className="border-b border-border px-4 py-4">
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {ctx.tournament.name}
            </p>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight">
              {ctx.campaign.title}
            </h1>
            {ctx.campaign.instructions ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {ctx.campaign.instructions}
              </p>
            ) : null}
          </div>

          {!ctx.campaign.is_open ? (
            <p
              role="status"
              className="px-4 py-6 text-center text-sm text-muted-foreground"
            >
              {t("This album is closed. Photos can no longer be uploaded.")}
            </p>
          ) : ctx.institutions.length === 0 ? (
            <p
              role="status"
              className="px-4 py-6 text-center text-sm text-muted-foreground"
            >
              {t("No school can sign in yet. Ask the host for your code.")}
            </p>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="lens-school-search"
                  className="text-sm font-medium"
                >
                  {t("Your school")}
                </label>
                <div className="relative">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    id="lens-school-search"
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("Search schools…")}
                    data-testid="school-search"
                    className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                {/* A list, not a dropdown: on a phone at an event, thirty-odd
                    school names are easier to hit than to scroll blind. */}
                <ul
                  data-testid="school-list"
                  className="max-h-64 overflow-y-auto rounded-md border border-border"
                >
                  {schools.length === 0 ? (
                    <li className="px-3 py-3 text-sm text-muted-foreground">
                      {t("No school matches that search.")}
                    </li>
                  ) : (
                    schools.map((i) => (
                      <li key={i.id} className="border-b border-border last:border-b-0">
                        <button
                          type="button"
                          data-testid={`school-${i.id}`}
                          aria-pressed={institutionId === i.id}
                          onClick={() => {
                            setInstitutionId(i.id);
                            setError("");
                          }}
                          className={cn(
                            "flex w-full items-center px-3 py-2.5 text-left text-sm transition-colors",
                            institutionId === i.id
                              ? "bg-primary/10 font-medium text-primary"
                              : "hover:bg-accent",
                          )}
                        >
                          {i.name}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="lens-code" className="text-sm font-medium">
                  {t("Your code")}
                </label>
                <div className="relative">
                  <KeyRound
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    id="lens-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={16}
                    placeholder={t("8 character code")}
                    data-testid="code-input"
                    className="h-11 w-full rounded-md border border-border bg-background pl-8 pr-2 font-tabular text-base tracking-[0.2em] outline-none placeholder:tracking-normal placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>

              {error ? (
                <p role="alert" data-testid="join-error" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                data-testid="join-submit"
                disabled={!institutionId || !code.trim() || busy}
                className="h-11"
              >
                {busy ? (
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                ) : null}
                {t("Open my school's uploads")}
              </Button>
            </form>
          )}
        </section>
      </main>
    </PublicShell>
  );
}
