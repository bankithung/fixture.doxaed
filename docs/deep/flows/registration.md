# Flow: Public school self-registration (share link/token → public form → team/person/player creation)

> Ground-truth trace (verified against source 2026-06-08). Every claim cites `file:symbol` + line range.
> Scope: the legacy `apps/teams` RegistrationLink channel (`/register/:token`). The newer data-driven
> `apps/forms` engine (`/r/:token`, `/f/:formId`) is a *second, parallel* ingress that funnels into the
> same `register_school` write path via `apps.forms.services.mapping.map_response`; it is noted where it
> intersects but is documented in full under the forms flow, not here.

This flow has **two distinct sub-flows** that share the `RegistrationLink` token:

1. **Mint** (authenticated organizer): create a shareable link, surface the plaintext token exactly once.
2. **Self-register** (unauthenticated public): resolve the token → render a form → submit teams+players →
   `register_school` creates `Team`/`Person`/`Player` atomically and idempotently.

---

## Participants (concrete modules/files)

Backend (`/home/ubuntu/Fixture/backend`):
- `apps/teams/views.py` — `RegistrationLinkCreateView`, `PublicRegistrationView`, `TournamentTeamsListView`
- `apps/teams/serializers.py` — `SchoolRegistrationSerializer` / `TeamInSerializer` / `PlayerInSerializer`
- `apps/teams/throttling.py` — `RegistrationRateThrottle`
- `apps/teams/services/registration.py` — `create_registration_link`, `resolve_registration_link`, `register_school`, `_unique_team_slug`, `_hash_token`
- `apps/teams/models.py` — `RegistrationLink`, `Team`, `Person`, `Player`, `TeamStatus`
- `apps/tournaments/scope.py::accessible_tournaments` + `apps/tournaments/permissions.py::can_manage_tournament` — tenancy/authz gates (mint only)
- `apps/audit/services.py::emit_audit` — the idempotency ledger writer
- `apps/teams/urls.py` (mounts `/api/register/<token>/`) + `apps/tournaments/urls.py` (mounts `/api/tournaments/<id>/registration-link/` and `/teams/`) + `fixture/urls.py:64`

Frontend (`/home/ubuntu/Fixture/frontend`):
- `src/features/tournaments/TournamentDetailPage.tsx` — organizer "Share registration link" button + token banner
- `src/api/tournaments.ts::createRegistrationLink` — mint call
- `src/features/registration/RegistrationFormPage.tsx` — public form (state, submit)
- `src/features/registration/PublicShell.tsx` — unauthenticated chrome
- `src/api/registration.ts` — `registrationApi.info` / `.submit` / `.createLink`
- `src/api/client.ts::apiFetch` — fetch wrapper (CSRF, credentials, ApiError)
- `src/lib/eventId.ts::newEventId` — client UUID for idempotency
- `src/lib/csrf.ts::getCsrfToken` — reads `csrftoken` cookie
- `src/App.tsx:128-131` — route `/register/:token` (OUTSIDE the auth-gated `AppShell`)

---

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Org as Organizer (browser)
    participant TDP as TournamentDetailPage.tsx
    participant TApi as api/tournaments.ts
    participant RLCV as teams/views.py::RegistrationLinkCreateView
    participant Scope as tournaments/scope+permissions
    participant RegSvc as teams/services/registration.py
    participant DB as Postgres
    actor School as School rep (browser, no account)
    participant RFP as registration/RegistrationFormPage.tsx
    participant RApi as api/registration.ts
    participant Client as api/client.ts::apiFetch
    participant PRV as teams/views.py::PublicRegistrationView
    participant Thr as throttling.py::RegistrationRateThrottle
    participant Ser as serializers.py::SchoolRegistrationSerializer
    participant Audit as audit/services.py::emit_audit

    rect rgb(235,242,255)
    note over Org,DB: SUB-FLOW 1 — Mint link (authenticated, manager-gated)
    Org->>TDP: click "Share registration link"
    TDP->>TApi: createRegistrationLink(id)
    TApi->>Client: POST /api/tournaments/{id}/registration-link/ (X-CSRFToken, cookie)
    Client->>RLCV: POST (session-authed)
    RLCV->>DB: Tournament.objects.filter(id, deleted_at__isnull=True).select_related(org)
    RLCV->>Scope: accessible_tournaments(user).filter(id).exists()  %% 404 if not
    RLCV->>Scope: can_manage_tournament(user, t)  %% 403 if not
    RLCV->>RegSvc: create_registration_link(tournament, created_by, label)
    RegSvc->>RegSvc: secrets.token_urlsafe(24); _hash_token(token)=sha256
    RegSvc->>DB: RegistrationLink.objects.create(token_hash=..., org, tournament)
    RegSvc-->>RLCV: (link, plaintext token)
    RLCV-->>Client: 201 {token, path:"/register/{token}", tournament_id}
    Client-->>TDP: onSuccess
    TDP->>TDP: setLinkUrl(origin + "/register/" + token)  %% shown ONCE, never re-fetchable
    end

    rect rgb(238,250,238)
    note over School,DB: SUB-FLOW 2 — Public self-register (AllowAny, throttled, idempotent)
    School->>RFP: open /register/{token} (route outside AppShell)
    RFP->>RApi: registrationApi.info(token)  (useQuery, retry:false)
    RApi->>Client: GET /api/register/{token}/
    Client->>PRV: GET
    PRV->>Thr: allow_request (GET exempt → True)
    PRV->>RegSvc: resolve_registration_link(token)
    RegSvc->>DB: filter(token_hash, is_active, tournament not-deleted).select_related().first()
    RegSvc->>RegSvc: check expires_at / submission_count<max  %% all failures → None
    alt link is None
        PRV-->>Client: 404 invalid_link
        Client-->>RFP: ApiError → info.isError → "Invalid or expired link"
    else valid
        PRV-->>Client: 200 {tournament_name, tournament_id}
        Client-->>RFP: render form heading
    end

    School->>RFP: fill school + teams + players; click Submit
    RFP->>RFP: build payload; event_id = newEventId() (client UUID)
    RFP->>RApi: registrationApi.submit(token, payload)  (useMutation)
    RApi->>Client: POST /api/register/{token}/ (X-CSRFToken IF cookie present)
    Client->>PRV: POST
    PRV->>Thr: allow_request (POST → per-IP 30/hour) %% 429 if exceeded
    PRV->>RegSvc: resolve_registration_link(token)  %% re-resolved → 404 if now invalid
    PRV->>Ser: SchoolRegistrationSerializer(data).is_valid(raise)  %% 400 on bad shape/>1 captain/empty teams
    PRV->>RegSvc: register_school(tournament, school_name, teams, channel="self", event_id, request)

    alt event_id replays a prior AuditEvent("school_registered")
        RegSvc->>DB: AuditEvent.filter(idempotency_key=event_id, type=...).first()
        RegSvc-->>PRV: existing Teams (NO writes)  %% IDEMPOTENT
    else first time — transaction.atomic()
        loop each team
            RegSvc->>RegSvc: _unique_team_slug(tournament, name)  %% TOCTOU, DB-constraint backstop
            RegSvc->>DB: Team.create(status=REGISTERED, org, tournament)
            loop each player
                RegSvc->>DB: Person.create(...)  %% ALWAYS new Person (no de-dup)
                RegSvc->>DB: Player.create(team, person, org, tournament, jersey, ...)
            end
        end
        RegSvc->>Audit: emit_audit(SYSTEM, "school_registered", idempotency_key=event_id) [INSIDE txn]
        Audit->>DB: AuditEvent.create(...)  %% the idempotency ledger row
        RegSvc-->>PRV: created Teams
    end

    alt IntegrityError (dup team name / jersey within submission)
        PRV-->>Client: 400 {detail:"duplicate_team_name_or_jersey_in_submission"}
    else success
        PRV->>DB: RegistrationLink.filter(pk).update(submission_count=F+1)  %% atomic, AFTER txn
        PRV-->>Client: 201 {registered, teams:[names]}
        Client-->>RFP: onSuccess → setDone(registered) → "Registration received"
    end
    end
```

---

## Ordered walkthrough (file:function + line ranges)

### Sub-flow 1 — Organizer mints the link

1. **Organizer clicks "Share registration link".** `TournamentDetailPage.tsx:382-385` renders the button;
   its `onClick` fires the `createLink` mutation declared at `TournamentDetailPage.tsx:278-282`
   (`mutationFn: () => tournamentsApi.createRegistrationLink(id)`).

2. **API call.** `tournaments.ts:170-173` (`createRegistrationLink`) issues
   `POST /api/tournaments/{id}/registration-link/` with body `{label: ""}` (the teams view also accepts a
   `label`, but this caller hardcodes empty — note the public-form `registration.ts::createLink` at
   `registration.ts:36-40` DOES forward a label). The request goes through `api.post` →
   `apiFetch` (`client.ts:31-86`): attaches `X-CSRFToken` from the `csrftoken` cookie (`client.ts:59-62`,
   token read in `csrf.ts:8-12`), sends `credentials:"include"` (`client.ts:69`), serialises JSON.

3. **Route + view.** Mounted at `tournaments/urls.py:52-56` → `RegistrationLinkCreateView.post`
   (`teams/views.py:30-49`). `permission_classes = [IsAuthenticated]` (`teams/views.py:28`).

4. **Tenancy + manager gates (transaction-less reads).**
   - Fetch tournament not-deleted + `select_related("organization")` (`teams/views.py:31-35`).
   - **404 (no existence leak)** if tournament is None OR not in
     `accessible_tournaments(request.user).filter(id).exists()` (`teams/views.py:36-39`;
     `scope.py::accessible_tournaments` = active TournamentMembership OR org-admin of the workspace).
   - **403** if not `can_manage_tournament(user, tournament)` (`teams/views.py:40-41`;
     `permissions.py:17-36` = active admin/co-organizer membership OR org admin).

5. **Mint.** `create_registration_link` (`registration.py:26-41`): `secrets.token_urlsafe(24)` →
   plaintext token; `_hash_token` = `sha256().hexdigest()` (`registration.py:22-23`); creates
   `RegistrationLink` with `organization = tournament.organization` (denormalised, invariant #2),
   `token_hash` (plaintext NEVER stored), `label[:120]`. Returns `(link, token)`.
   No `transaction.atomic()` wrapper — a single `.create()` is its own implicit transaction.

6. **Response.** `teams/views.py:46-49` returns **201** `{token, path:"/register/{token}", tournament_id}`.

7. **Surface token once.** `TournamentDetailPage.tsx:280-281` `onSuccess` sets
   `linkUrl = window.location.origin + "/register/" + r.token`. The plaintext token exists only in this
   response and in client memory; it is unrecoverable afterward (only the hash is in the DB).
   `copyLink` (`TournamentDetailPage.tsx:311-329`) copies it to the clipboard. A banner renders at
   `TournamentDetailPage.tsx:401+`.

### Sub-flow 2 — Public self-registration

8. **Open the link.** `App.tsx:128-131` routes `/register/:token` to `RegistrationFormPage`, declared
   among the **public** routes (outside `ProtectedRoute`/`AppShell` at `App.tsx:137-144`). It renders in
   `PublicShell` (`PublicShell.tsx:12-42`) — its own branded chrome, no auth required.

9. **Resolve the token (GET).** `RegistrationFormPage.tsx:65-69` runs a `useQuery`
   (`queryKey:["reglink",token]`, `retry:false`) calling `registrationApi.info(token)`
   (`registration.ts:28`) → `GET /api/register/{token}/`.
   Route: `fixture/urls.py:64` (`register/` include) → `teams/urls.py:9` → `PublicRegistrationView.get`
   (`teams/views.py:60-66`). `permission_classes=[AllowAny]`, `throttle_classes=[RegistrationRateThrottle]`
   (`teams/views.py:56-57`). **GET is throttle-exempt** (`throttling.py:16-19` returns True for non-POST).

10. **`resolve_registration_link`** (`registration.py:44-66`) — the no-leak gate:
    - empty token → None (`registration.py:46-47`);
    - query by `token_hash` + `is_active=True` + `tournament__deleted_at__isnull=True`,
      `select_related("tournament","tournament__organization")`, `.first()` (`registration.py:48-56`);
    - expired (`expires_at <= now()`) → None (`registration.py:59-60`);
    - over cap (`submission_count >= max_submissions`) → None (`registration.py:61-65`).
    **Every failure mode collapses to `None`** so inactive/expired/over-cap/wrong-token are indistinguishable.

11. **GET response.** None → `NotFound("invalid_link")` = **404** (`teams/views.py:62-63`); the client's
    `info.isError` branch (`RegistrationFormPage.tsx:133-149`) shows "Invalid or expired registration link".
    Else **200** `{tournament_name, tournament_id}` (`teams/views.py:64-66`) → form heading renders with
    `info.data?.tournament_name` (`RegistrationFormPage.tsx:177,183`).

12. **Fill + submit.** Local React state: `school` + `teams[]` of `{name, players[]}`
    (`RegistrationFormPage.tsx:71-103`). On submit (`RegistrationFormPage.tsx:328-339`), the `submit`
    mutation (`RegistrationFormPage.tsx:105-131`) builds the payload:
    - **`event_id = newEventId()`** (`RegistrationFormPage.tsx:109`; `eventId.ts:6-11` →
      `crypto.randomUUID()` with fallback) — the idempotency key.
    - filters out blank teams (`tm.name.trim()`) and blank players (`p.full_name.trim()`),
      coerces `jersey_no`/`dob_year` to `Number`, omits empty optional fields
      (`RegistrationFormPage.tsx:110-122`).
    - client-side enable guard: `canSubmit = school.trim() && namedTeams>0`
      (`RegistrationFormPage.tsx:174`).
    Note: the public form UI **never sends `captain` or `is_goalkeeper`** (not collected); the serializer
    defaults them False (`serializers.py:11-12`).

13. **POST.** `registrationApi.submit` (`registration.ts:30-34`) → `POST /api/register/{token}/`.
    Through `apiFetch`: it WILL attach `X-CSRFToken` only **if** a `csrftoken` cookie is present
    (`client.ts:59-62`). On a truly cold public visit there may be no such cookie, so the header is
    omitted — backend acceptance therefore depends on DRF `SessionAuthentication` enforcing CSRF only for
    authenticated sessions (an `AllowAny` endpoint with no session is not CSRF-checked).

14. **POST view.** `PublicRegistrationView.post` (`teams/views.py:68-92`):
    - **Throttle** (`throttling.py`): POST is rate-limited per client IP at scope `school_registration`
      = **30/hour** (`settings/base.py:178`), key = `get_ident(request)` (`throttling.py:21-25`).
      Exceed → **429**.
    - **Re-resolve** the link (`teams/views.py:69-71`) → 404 if it became invalid/over-cap since the GET.
    - **Validate** `SchoolRegistrationSerializer(data).is_valid(raise_exception=True)`
      (`teams/views.py:72-73`). `serializers.py:21-37`: `school_name` required; `teams` (many) required;
      `event_id` optional UUID; `validate_teams` rejects empty list and any team with **>1 captain**.
      Bad shape → **400**.

15. **`register_school`** (`registration.py:86-159`) — the central write path, called at
    `teams/views.py:75-82` with `channel="self"`, `event_id=validated event_id`, `request=request`
    (no `submitted_by` → anonymous, columns `created_by`/`added_by`/`actor_user` = None):

    - **Idempotency replay (invariant #3)** (`registration.py:101-110`): if `event_id` set and a prior
      `AuditEvent` exists with `idempotency_key=event_id` AND `event_type="school_registered"`, return the
      existing `Team`s (filtered by tournament+school+not-deleted) **with NO writes**. The audit row IS the
      idempotency ledger — there is no separate registration record.
    - else **`transaction.atomic()`** (`registration.py:114`) — the single transaction boundary:
      - per team: `slug = _unique_team_slug(tournament, name)` (`registration.py:77-83`, a
        check-then-insert TOCTOU; DB constraint `unique_team_slug_per_tournament` is the backstop),
        `Team.objects.create(status=REGISTERED, organization=tournament.organization, ...)` with all
        string fields truncated to model max lengths (`registration.py:116-127`).
      - per player: **always** `Person.objects.create(...)` (`registration.py:129-134`) — **no de-dup /
        reuse** of existing Persons — then `Player.objects.create(team, person, org, tournament, jersey,
        position, captain, is_goalkeeper, ...)` (`registration.py:135-145`).
      - after the loop, **inside the same txn**, `emit_audit(actor_role=SYSTEM,
        event_type="school_registered", target=tournament, idempotency_key=event_id,
        payload_after={school, teams:[names]})` (`registration.py:148-158`). `emit_audit`
        (`audit/services.py:24-77`) is itself idempotent on `idempotency_key` (`services.py:45-48`) and
        writes inline (NOT on_commit), so audit + entity writes share one atomicity.
    - returns the created `Team` list (`registration.py:159`).

16. **IntegrityError handling** (`teams/views.py:83-86`): a duplicate team name or jersey that races the
    DB partial-unique constraints surfaces as `IntegrityError`, caught and re-raised as **400**
    `{detail:"duplicate_team_name_or_jersey_in_submission"}`. Because `register_school`'s
    `transaction.atomic()` rolls back, **no partial school persists**.

17. **Bump link usage counter** (`teams/views.py:87-89`), only on success and **outside / after** the
    `register_school` transaction: `RegistrationLink.objects.filter(pk).update(submission_count=F+1)`
    (atomic F-expression). This is what `resolve_registration_link`'s cap check reads. NOTE: the
    forms-mapping ingress does NOT touch this counter, so the `max_submissions` cap applies only to the
    `/register/` channel.

18. **Response.** **201** `{registered: len(teams), teams:[t.name ...]}` (`teams/views.py:90-92`).
    Client `onSuccess` (`RegistrationFormPage.tsx:124`) sets `done = res.registered` →
    "Registration received" terminal card (`RegistrationFormPage.tsx:151-167`). On error,
    `onError` (`RegistrationFormPage.tsx:125-131`) reads `ApiError.payload.detail`.

19. **Downstream contract.** The created `Team`s have `status=TeamStatus.REGISTERED` (`models.py:65`
    default + explicitly set in `registration.py:125`). The fixture generator selects exactly
    `status=REGISTERED, deleted_at__isnull=True` — so self-registered teams are immediately eligible for
    fixture generation. `TournamentTeamsListView` (`teams/views.py:95-125`, routed from
    `tournaments/urls.py:57-61`) is how the organizer later sees them (with `player_count`).

---

## Transaction boundaries & `transaction.on_commit`

- **Mint:** no explicit transaction; the lone `RegistrationLink.objects.create` is its own implicit
  autocommit (`registration.py:32-40`).
- **Self-register write path:** exactly **one** `transaction.atomic()` in
  `register_school` (`registration.py:114-158`) spanning **all** Team + Person + Player creates **and**
  the `emit_audit("school_registered")` ledger row. This is the partial-failure boundary: an
  `IntegrityError` (or any exception) rolls back the entire school + its audit row together.
- **No `transaction.on_commit` anywhere in this flow.** The audit is emitted *inline* via `emit_audit`
  (`audit/services.py:61` direct `.create`), deliberately sharing atomicity with the entity writes — this
  is the opposite choice from the matches event-publish path (which uses `on_commit` for live fan-out).
  `emit_audit_on_commit` exists (`audit/services.py:80-87`) but is **not** used here. There is **no**
  WS/SSE publish, no notification, and no async task on registration.
- **`submission_count` bump** (`teams/views.py:87-89`) runs in the request *after* and *outside*
  `register_school`'s transaction — its own atomic `UPDATE ... = F+1`. So a successful registration whose
  counter-bump statement failed would still have persisted the teams (the two are not co-transactional);
  in practice both run in the same request and DRF wraps the request in `ATOMIC_REQUESTS` only if
  configured (check settings; default DRF does not).

---

## Idempotency points

1. **Client event_id (invariant #3).** `RegistrationFormPage.tsx:109` generates a fresh UUID per submit
   attempt via `newEventId` (`eventId.ts`). Reused across React-Query retries of the *same* mutation
   instance because the payload is built once per `mutate()` call. (TanStack `useMutation` here has no
   `retry` configured, so it does not auto-retry on its own.)
2. **`register_school` replay** (`registration.py:101-110`): keyed on the tuple
   `(event_id, event_type="school_registered")` against `AuditEvent.idempotency_key` (globally unique).
   A replay returns the existing Teams with **no new rows** — proven by
   `apps/teams/tests/test_registration.py:88-96` (two calls, same `event_id` → 1 Team).
3. **`emit_audit` self-idempotency** (`audit/services.py:45-48`): even if the replay check were bypassed,
   the audit `idempotency_key` lookup short-circuits a duplicate ledger row.
4. **DB partial-unique constraints** as the last line of defence (`models.py`):
   `unique_team_slug_per_tournament` (`models.py:79-81`, unconditional),
   `unique_team_name_per_tournament` (`models.py:82-86`, where not-deleted),
   `unique_jersey_per_team` (`models.py:121-125`), `unique_person_per_tournament`
   (`models.py:126-130`), `unique_captain_per_team` (`models.py:131-135`). These convert
   concurrent/duplicate submissions into `IntegrityError` → 400 rather than silent dupes.
5. **NON-idempotent corner:** `submission_count += 1` (`teams/views.py:87-89`) is NOT guarded by the
   replay path — it runs on every successful POST including a replayed (no-op) `register_school`. So an
   `event_id` replay that returns existing teams will STILL increment the link counter. (Tracked as a
   latent over-count vs the cap; documented here for the restructure.)
6. **No `event_id` on mint or teams-list** — only the public POST is idempotent.

---

## Client ↔ server contracts this flow depends on

| Contract | Producer | Consumer | Shape |
|---|---|---|---|
| Mint request | `tournaments.ts:170-173` / `registration.ts:36-40` | `RegistrationLinkCreateView` (`teams/views.py:30`) | `POST /api/tournaments/{id}/registration-link/` body `{label?}` |
| Mint response | `teams/views.py:46-49` | `TournamentDetailPage.tsx:280-281` | **201** `{token, path, tournament_id}` (token shown ONCE) |
| Link path convention | backend `path:"/register/{token}"` | FE builds `origin + "/register/" + token` (`TournamentDetailPage.tsx:281`) | `/register/:token` SPA route (`App.tsx:129`, `routes.ts:51`) |
| Resolve request | `registration.ts:28` | `PublicRegistrationView.get` | `GET /api/register/{token}/` (no body) |
| Resolve response | `teams/views.py:64-66` | `RegistrationFormPage.tsx:65-68,177,183` (`RegLinkInfo` `registration.ts:3-6`) | **200** `{tournament_name, tournament_id}` / **404** invalid_link |
| Submit request | `RegistrationFormPage.tsx:106-123` (`RegSubmission` `registration.ts:20-24`) | `SchoolRegistrationSerializer` (`serializers.py:21-37`) | `POST /api/register/{token}/` `{school_name, event_id?, teams:[{name, short_name?, players:[{full_name, jersey_no?, position?, dob_year?, is_goalkeeper?, captain?}]}]}` |
| Submit response | `teams/views.py:90-92` | `RegistrationFormPage.tsx:124` | **201** `{registered:number, teams:string[]}` |
| Error envelope | `client.ts::parseApiError` (`client.ts:6-15`) / DRF | `RegistrationFormPage.tsx:125-131`, `133-149` | `ApiError{status, payload.detail}`; 400 `duplicate_team_name_or_jersey_in_submission`, 404, 429 |
| CSRF | `csrf.ts:8-12` cookie read → `client.ts:59-62` header | DRF SessionAuthentication | `X-CSRFToken` on unsafe verbs (only if cookie present; public POST may have none) |
| Session/cookie | `client.ts:69` `credentials:"include"` | Django session (mint only; public is AllowAny) | invariant #15 |
| Validation rules the FE relies on | `serializers.py` | FE pre-checks | empty teams rejected (`serializers.py:28-30`), >1 captain rejected (`serializers.py:31-36`), jersey 1..999 (`serializers.py:8`), dob_year 1950..2025 (`serializers.py:10`) |

**Type-shape coupling note:** all three teams views hand-roll JSON dicts (no DRF output serializer), so the
public-registration responses are **not** part of the drf-spectacular schema and are typed manually in
`src/api/registration.ts` (`RegLinkInfo`, the `{registered, teams}` inline type). A field rename on either
side is a silent break — there is no `gen:types` coverage for this surface.

---

## Verification anchors (tests that lock this behavior)

- `apps/teams/tests/test_registration.py:52-66` — `register_school` creates 2 teams / 6 players / 6 Persons.
- `apps/teams/tests/test_registration.py:69-85` — jersey-unique-per-team enforced (IntegrityError).
- `apps/teams/tests/test_registration.py:88-96` — **idempotent on event_id** (2 calls → 1 team).
- `apps/teams/tests/test_registration_link.py:24-34` — manager mints link (201, 1 row).
- `apps/teams/tests/test_registration_link.py:37-60` — public GET 200 + POST 201 + 2 teams created.
- `apps/teams/tests/test_registration_link.py:63-65` — invalid token → 404.
- `apps/teams/tests/test_registration_link.py:68-76` — non-manager mint → 403/404.
- `apps/teams/tests/test_registration_link_limits.py` — expiry + usage cap collapse to 404.
- `apps/teams/tests/test_registration_throttle.py` — POST rate limit → 429.

---

## Restructuring-relevant observations (verified, not editorializing)

- **`register_school` is the single shared write seam** — both `PublicRegistrationView.post`
  (`teams/views.py:75-82`) and `apps/forms/services/mapping._map_team_registration` call it; the latter
  derives a *distinct* `uuid5` idempotency key (so the form-submit audit and the school-registered audit
  don't collide on the globally-unique `AuditEvent.idempotency_key`). Any change to the
  `(event_id, "school_registered")` idempotency tuple breaks BOTH ingresses.
- **`Person` is never de-duped** (`registration.py:129` always `.create`): re-registering the same human
  across tournaments yields duplicate `Person` rows, weakening invariant #8's cross-tournament-stats
  rationale until a merge tool exists.
- **`TeamStatus` is vestigial** beyond `REGISTERED`: no approval/withdraw transitions exist; the public
  channel always lands teams as `REGISTERED`, immediately fixture-eligible (no review gate).
- **URL ownership is split**: `apps/teams/urls.py` owns only `/api/register/`; the mint + teams-list views
  are imported and routed from `apps/tournaments/urls.py:9,52-61` — an avoidable cross-app import edge.
- **`submission_count` over-count on replay** (idempotency point 5) — the cap counter increments on a
  no-op replayed POST.
