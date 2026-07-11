# Guest Lens ("36 Shots Challenge") - Design & Implementation Spec

Date: 2026-07-10. Status: approved for build (owner request). Author: main session (Fable), from a 6-agent research fleet over the live codebase.

## 1. Product summary

Once a tournament's fixtures are generated, managers can open a **Guest Lens campaign**: a shared event album captured by the *visiting* institutions, not the host. Each participating institution (school) gets a printed **QR pass card**. Scanning it opens a no-login mobile upload page where the teacher in charge uploads up to N photos (default 36) from their own phone. Managers moderate (approve/hide), pick **award winners** per category (Best Team Spirit, Best Sportsmanship Moment, Best Action Shot, Best Fun Fair Moment, Best Visiting School POV - editable list), and the approved photos form a **public shared album** on the tournament's public pages. Theme: "20 schools. 2 days. 1 shared album."

Everything is data-driven and sport-agnostic (flexibility-first): cap, categories, copy are campaign settings, not code.

## 2. Decisions (do not relitigate)

| # | Decision | Why |
|---|----------|-----|
| D1 | New app `apps/lens/` + `frontend/src/features/lens/` | Self-contained domain, mirrors `apps/badges` (structure) + `apps/forms` (uploads) |
| D2 | QR pass token = **Family A**: `secrets.token_urlsafe(24)`, sha256-at-rest (`token_hash`), plaintext returned ONCE at mint | Copies `FormShareLink`/`create_share_link` (`apps/forms/services/links.py:22-39,96-118`, model `forms/models.py:71-97`). Revocable (`is_active`), quota-capable, DB-leak-safe. Signed tokens rejected: not revocable, no counters |
| D3 | No Argon2/lockout on the pass token | 192-bit URL token; sha256 lookup suffices (that machinery exists only for the hand-typed 8-char team code) |
| D4 | "Fixtures generated" gate = `Match.objects.filter(tournament=t, deleted_at__isnull=True).exists()` (reuse `apps.fixtures.services.draw_config.leaf_has_matches(t, None)`); FE gates on stage payload `ready` (opsMode) | The canonical signal; NOTE `_match_count` (state.py:120) counts soft-deleted rows - do NOT use it |
| D5 | Photos re-encoded server-side to JPEG (Pillow: `exif_transpose`, RGB, max side 2560, q85) + 480px thumb; original bytes never stored/served | Kills fake-image/XSS vector (forms trusts client content_type - known gap), strips EXIF/GPS (child-safety), bounds disk |
| D6 | Storage: `MEDIA_ROOT/lens_photos/<campaign_id>/<upload_ref>.jpg` (+ `<upload_ref>_t.jpg` thumb), served directly by nginx `/media/` (7d cache). Unguessable uuid7 names. NOT under `form_uploads/` (nginx 404s that) | Public album needs cacheable direct serving; possession-of-URL == capability, same posture as share links |
| D7 | Hide = physically move image+thumb to `BASE_DIR/media_quarantine/...` (outside MEDIA_ROOT; nginx naturally 404s). Approve-from-hidden moves back | Makes takedown real at the file layer with zero nginx changes. Browser caches (7d) may retain copies - accepted |
| D8 | Moderation state = nullable timestamps `approved_at`/`hidden_at` (+ `hidden_reason`), never booleans; status derived: hidden_at set -> hidden, elif approved_at -> approved, else pending | Invariant 6 / badges precedent |
| D9 | Manager endpoints gate on `can_manage_tournament` (no new RBAC module in v1) | Avoids catalog churn; media-manager module grant can come later |
| D10 | Quota = live `COUNT` of the institution's photo rows (any status) under `select_for_update` on the pass row; no drifting counter column | Teacher delete-own-pending frees quota; count can't drift |
| D11 | Award = winner-per-category: assigning category X to a photo clears X from any other photo (audited) | Categories are prizes, not tags |
| D12 | Reprint = rotate: plaintext lives only in mint/rotate responses (client memory); passes table never shows URLs | Hash-at-rest consequence; matches house security posture |
| D13 | QR delivered as base64 data URI in mint/rotate response (`qrcode.make` -> BytesIO -> b64, the `twofa.py:98-115` idiom); cards printed from an in-app React sheet (`window.print()` + `print:` classes, `CertificatePage.tsx` pattern) | No cached PNG containing secrets under /media/; no client QR lib needed |
| D14 | New `LensUploadThrottle` keyed on the pass token (fallback IP), POST-only, 120/hour hardcoded rate | `PublicFormThrottle` 60/hour/IP would break a 36-photo batch behind school NAT |
| D15 | Public album lives at `/t/:slug/:id/album`; upload page at `/lens/:token` (both SPA public routes, PublicShell chrome) | (slug, UUID) pair convention; /lens/* falls through nginx to the SPA |

## 3. Backend

### 3.1 App skeleton

- `apps/lens/__init__.py`, `apps/lens/apps.py` (`LensConfig`, `name="apps.lens"`, BigAutoField default - copy `badges/apps.py`).
- Register in `LOCAL_APPS` (`fixture/settings/base.py:48-65`).
- Migration via `makemigrations lens` (deps: tournaments, teams, organizations latest). **Never run `migrate` in the build phase - this box's dev DB is production.** pytest is safe (separate test DB).

### 3.2 Models (`apps/lens/models.py`) - all uuid7 PKs (`from apps.accounts.models import uuid7`), all with `organization` FK (invariant 2)

**LensCampaign** - one per tournament (`UniqueConstraint` on tournament where deleted_at isnull if soft-delete used; simplest: OneToOne-like unique FK):
- organization FK, tournament FK (unique), title (default "Guest Lens"), tagline (default "36 Shots Challenge"), instructions TextField (sensible default copy), consent_note TextField (default: "Selected photos may be used by the host for event highlights and social media. Please upload only appropriate event photos."), max_photos_per_institution PositiveIntegerField(default=36), award_categories JSONField(default=list) seeded with the 5 defaults, opened_at, closed_at (nullable), created_by FK accounts.User, created_at, event_id UUIDField(unique=True, null=True, blank=True).
- `is_open` property: opened_at set, closed_at null.

**LensPass** - the QR card credential (copy FormShareLink shape, `forms/models.py:71-97`):
- organization FK, campaign FK, institution FK (`teams.Institution`), token_hash CharField(128, db_index=True), is_active Boolean(default=True), expires_at (nullable, unused v1), last_minted_at DateTimeField, created_at. Unique active pass per (campaign, institution) - enforce in service (mint is idempotent-skip, rotate replaces token_hash in place on the same row).

**LensPhoto**:
- organization FK, campaign FK, institution FK, pass FK (PROTECT? use CASCADE=no - SET_NULL null=True; rotation keeps same row so FK stable), upload_ref UUIDField(default=uuid7, db_index=True, editable=False), image FileField(upload_to=callable -> `lens_photos/<campaign_id>/<upload_ref>.jpg`), thumb FileField (same dir, `<upload_ref>_t.jpg`), original_name CharField(255), content_type CharField(100) (always "image/jpeg" post-re-encode), size/width/height IntegerFields, caption CharField(200, blank), approved_at/hidden_at DateTimeFields(null), hidden_reason CharField(200, blank), award_category CharField(100, blank), approved_by/hidden_by FK User(null), event_id UUIDField(unique=True, null=True, blank=True), created_at.
- indexes: (campaign, institution), (campaign, approved_at), upload_ref.

### 3.3 Services (`apps/lens/services/`)

`campaign.py`: `open_campaign` (guard `leaf_has_matches(t, None)` else DRFValidationError `{"detail": "fixtures_not_generated"}`; idempotent on event_id AND on existing campaign -> returns existing), `update_settings`, `close_campaign`, `reopen_campaign`. Every mutation: `transaction.atomic()` + `emit_audit` (`apps.audit.services`, event types `lens_campaign_opened/updated/closed/reopened`, idempotency_key=event_id).

`passes.py`: `_hash(token) = hashlib.sha256(token.encode()).hexdigest()`; `mint_passes(campaign, user)` - for every institution registered to the tournament lacking an active pass (follow the institutions listing base queryset in apps/teams - non-deleted, tournament-scoped): create pass, collect `(pass, plaintext)`; idempotent-skip existing (copy `mint_institution_links`, `links.py:61-93`). `rotate_pass(pass, user)` - new token, update token_hash + last_minted_at + is_active=True. `revoke_pass`. `resolve_pass(token)` - hash lookup, is_active, campaign/tournament not deleted (copy `resolve_share_link`, `links.py:96-118`). Card payload helper: `{pass_id, institution_id, institution_name, upload_url, token, qr_data_uri}` - upload_url absolute (same base-URL mechanism `apps/badges/services/cards.py` uses for its QR); qr_data_uri via the twofa idiom.

`photos.py`: `add_photo(pass_, file, caption, event_id)`:
1. event_id replay -> return prior (matches `events.py:94-103` idiom).
2. Guards: campaign.is_open else `campaign_closed`; size <= 10MB else `file_too_large`; content_type in {image/jpeg, image/png, image/webp} else `unsupported_type`.
3. Pillow: `Image.open(f)` + decode inside try/except -> `invalid_image`; `ImageOps.exif_transpose`, convert RGB, cap max side 2560, save JPEG q85 to a ContentFile; thumb 480px q80.
4. `select_for_update` the pass row; quota: `LensPhoto.objects.filter(campaign=c, institution=i).count() >= max` -> `quota_exceeded`.
5. Create row.
`remove_own_photo(pass_, upload_ref)` - only own institution's photo, only status pending, hard-delete row + files, else `photo_locked`.
`approve/hide/award` (manager): timestamps per D8; hide moves files to quarantine (`BASE_DIR/media_quarantine/lens_photos/<campaign_id>/...` via `os.replace`, mkdir parents), approve from hidden moves back; award enforces category in campaign.award_categories (`unknown_category`) + clears other holder (D11) + only approved photos (`not_approved`); all audited (`lens_photo_approved/hidden/award_assigned`), idempotent via AuditEvent replay or event_id param.

### 3.4 Views (`apps/lens/views.py`) - GenericAPIView only, string-code errors, hand-built dict output, no pagination

Manager (mounted in `apps/tournaments/urls.py` under `<uuid:tournament_id>/lens/...`, imports at top like teams; gate every method: fetch tournament (deleted_at isnull) -> `accessible_tournaments` 404 `tournament_not_found` -> `can_manage_tournament` else 403 `not_tournament_manager` - the `teams/views.py:152-162` recipe):

| Route | Verb | Body | Response |
|---|---|---|---|
| `lens/` | GET | - | `{campaign: null\|{...}, fixtures_ready: bool, stats: {institutions_total, passes_active, photos_total, photos_pending, photos_approved, photos_hidden}, passes: [{id, institution_id, institution_name, is_active, photos_used, last_minted_at}]}` |
| `lens/open/` | POST | `{event_id, title?, tagline?, instructions?, consent_note?, max_photos_per_institution?, award_categories?}` | 201 `{campaign}` (200 on replay/existing) |
| `lens/` | PATCH | any settings subset + event_id | 200 `{campaign}` |
| `lens/close/`, `lens/reopen/` | POST | `{event_id}` | 200 `{campaign}` |
| `lens/passes/mint/` | POST | `{event_id}` | 200 `{cards: [card...], skipped: n}` (plaintext once) |
| `lens/passes/<uuid:pass_id>/rotate/` | POST | `{event_id}` | 200 `{card}` |
| `lens/passes/<uuid:pass_id>/revoke/` | POST | `{event_id}` | 200 `{pass}` |
| `lens/photos/` | GET `?status=&institution_id=` | - | `{photos: [{id, upload_ref, institution_id, institution_name, caption, url, thumb_url, width, height, size, status, hidden_reason, award_category, created_at}]}` |
| `lens/photos/<uuid:photo_id>/approve/` | POST | `{event_id}` | 200 `{photo}` |
| `lens/photos/<uuid:photo_id>/hide/` | POST | `{event_id, reason?}` | 200 `{photo}` |
| `lens/photos/<uuid:photo_id>/award/` | POST | `{event_id, category}` ("" clears) | 200 `{photo}` |

(If `tournaments/urls.py` already uses `:verb` colon routes, match that; otherwise plain `/verb/` segments as above.)

Public (own `apps/lens/urls.py` included from root `fixture/urls.py` api_v1; AllowAny):

| Route | Verb | Notes |
|---|---|---|
| `lens/p/<str:token>/` | GET | `{tournament: {id, slug, name}, institution: {id, name}, campaign: {title, tagline, instructions, consent_note, is_open, max_photos_per_institution}, quota: {used, max}, photos: [{upload_ref, url, thumb_url, caption, status, created_at}]}`; 404 `pass_not_found` on bad/revoked token (no leak). status reported as pending/approved/removed (hidden -> "removed", no reason exposed) |
| `lens/p/<str:token>/photos/` | POST multipart `{file, caption?, event_id}` | 201 `{photo}`; errors 400 `campaign_closed/quota_exceeded/no_file/file_too_large/unsupported_type/invalid_image`; `parser_classes=[MultiPartParser, FormParser]`; `throttle_classes=[LensUploadThrottle]` |
| `lens/p/<str:token>/photos/<uuid:upload_ref>/` | DELETE | 200 `{removed: true}`; 400 `photo_locked` unless pending; 404 unknown |
| `public/tournaments/<slug:slug>/<uuid:tournament_id>/album/` | GET | root urls.py next to badges public routes; gate slug+id+`_PUBLIC_STATUSES` (copy `badges/views.py:15-21,129-141`); `{campaign: null\|{title, tagline}, award_categories: [...], institutions: [{id, name, count}], photos: [{upload_ref, url, thumb_url, institution_name, caption, award_category, created_at}]}` - approved only, newest first |

`apps/lens/throttling.py`: `LensUploadThrottle(SimpleRateThrottle)` - scope `lens_upload`, `rate = "120/hour"` class attr, key on the URL token (`request.parser_context/kwargs` or resolver kwargs), fallback `get_ident`; None for safe methods (copy `forms/throttling.py:14-27` shape).

photo `url`/`thumb_url` in payloads: `settings.MEDIA_URL + <relative path>` (relative same-origin, like existing media). Hidden photos: manager payload uses the same url fields (files are in quarantine -> URL 404s while hidden; acceptable - manager grid shows placeholder; approve restores files).

### 3.5 Backend tests (`apps/lens/tests/`) - pytest, `pytestmark = pytest.mark.django_db`, local `_verified()` + `create_tournament()` helpers, `APIClient().force_authenticate`, NO factories, build via services (`create_tournament`, `register_school`). In-memory JPEGs via Pillow for upload tests.

- `test_campaign.py`: open blocked pre-fixtures (`fixtures_not_generated`); open ok with a Match row; idempotent replay (same id, one AuditEvent); close/reopen; settings patch; cross-org isolation (403/404); non-manager denied.
- `test_passes.py`: mint idempotent (second call skips), plaintext not stored (token_hash only, sha256(token) matches), rotate invalidates old token + keeps row, revoke blocks resolve, resolve rejects unknown/inactive.
- `test_upload.py`: happy path (row + files exist, re-encoded JPEG, thumb, EXIF orientation applied); caption; event_id replay returns same photo; quota_exceeded at cap (set cap 2); campaign_closed; revoked pass 404; file_too_large; unsupported_type; invalid_image (garbage bytes with image/jpeg content_type); delete-own-pending frees quota; delete approved -> photo_locked.
- `test_moderation.py`: approve sets approved_at + audit; hide moves files to quarantine (assert on-disk move) + url 404 semantics; approve-from-hidden restores files; award assigns + steals from previous holder + rejects unknown_category + rejects non-approved; all idempotent replays.
- `test_public_album.py`: approved-only listing; hidden/pending excluded; award_category present; draft tournament 404; unknown slug 404; no campaign -> `{campaign: null, photos: []}`.

Use `tmp_path`/`settings.MEDIA_ROOT` override (`django_settings` or `settings` fixture: `settings.MEDIA_ROOT = tmp_path`) so tests never write into the real media tree.

## 4. Frontend

### 4.1 Plumbing

- `src/api/lens.ts` (copy `disputes.ts` shape): hand-written interfaces (swap to generated types later); `lensApi = { overview(tid), open(tid, body), update(tid, body), close(tid, body), reopen(tid, body), mint(tid, body), rotate(tid, passId, body), revoke(tid, passId, body), photos(tid, params), approve/hide/award(tid, photoId, body), passContext(token), upload(token, formData) [FormData passthrough, pass larger timeoutMs ~60000], removeOwn(token, uploadRef), publicAlbum(slug, tid) }`.
- `src/lib/queryKeys.ts`: `qk.lens(id)`, `qk.lensPhotos(id)`, `qk.lensPass(token)`, `qk.publicAlbum(slug, id)`; wire lens keys into `invalidateTournament`.
- `src/lib/routes.ts`: `tournamentLens(id)`, `lensUpload(token)` = `/lens/${encodeURIComponent(token)}`, `publicAlbum(slug, id)` = `/t/${slug}/${id}/album`.
- `src/App.tsx`: lazy routes - public `/lens/:token` -> LensUploadPage, `/t/:slug/:id/album` -> PublicAlbumPage (public block, above catch-all); manager child route `lens` under `/tournaments/:id`.
- `computeNavItems.ts`: opsMode operations array gets `{key: 'lens', label: t('Guest Lens'), icon: Camera}` (canManage-gated); setup-mode manage array gets the same item with `...gate('ready')` so it shows locked until fixtures are done. Sidebar.tsx untouched.

### 4.2 LensConsolePage (manager, `/tournaments/:id/lens`)

Full-width ops container (`flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8`), `.page-title`, local-state tabs (LiveViewerPage TABS pattern): **Campaign | Cards | Moderate | Awards**.

- Pre-open state: hero panel explaining the feature + "Open campaign" (disabled with hint until `fixtures_ready`); settings inline (cap stepper h-9, category chips editor, instructions/consent textareas). Supabase-dense: `.panel`/`.panel-header`, h-9 controls, 18px heading cap, gap-3.
- Campaign tab: open/close/reopen (Dialog confirm), settings PATCH form, stat band (photos pending/approved, passes active, font-tabular).
- Cards tab: passes table (institution, status, photos used X/N tabular, last minted) -> stacked cards on mobile via `useBreakpoint().isMobile`. "Generate cards" (mint) / per-row "Regenerate" / "Revoke" (Dialog). Mint/rotate response held in React state -> banner "Cards ready to print - links are shown once" + **print sheet**: hidden-on-screen? No - render a preview grid of pass cards (tournament name, tagline "36 Shots Challenge" style, institution name, QR `<img src={qr_data_uri}>`, short how-to, consent note) with `print:` classes (chrome `print:hidden`, cards `print:break-inside-avoid`, roughly A6 2x2 per A4) + "Print cards" -> `window.print()` + per-card "Copy link" buttons. Brand violet accents, tokens only on screen (print side may use fixed ink-safe styles).
- Moderate tab: filter chips (Pending N / Approved / Hidden) + institution Select; responsive thumb grid (lazy `<img loading="lazy">` of thumb_url); click -> Dialog lightbox (full url, caption, institution, approve/hide buttons, prev/next keyboard nav); approve = one tap; hide = Dialog with optional reason; toasts on success; invalidate `qk.lensPhotos`.
- Awards tab: one panel per campaign category showing current winner (photo + institution) + "Choose winner" -> opens approved-grid picker Dialog; clear action. Empty state if no categories.
- Share strip: copy public album link (`routes.publicAlbum`).

### 4.3 LensUploadPage (public, `/lens/:token`)

Mobile-first, PublicShell; `useQuery(qk.lensPass(token))`, 404 -> Centered "This link is not valid" state; closed campaign -> Centered closed state (photos still listed read-only).

- Header: tournament name, institution name chip, campaign title/tagline.
- Quota band: "12 of 36 photos used" (font-tabular) + progress bar (bg-primary).
- Consent note rendered prominently (muted panel).
- Upload: `<input type="file" accept="image/*" multiple>` (camera-friendly), per-file: `compressImage(file, {preferJpeg: true})` -> FormData -> `lensApi.upload` with `newEventId()` per file, sequential loop with a visible per-file list (name, spinner/done/error states) - NOT a single busy boolean; disable picker while running; cap remaining enforced client-side too (slice selection, toast when trimmed).
- My photos grid: thumbs + status chip (Pending review / In album / Removed) + delete (pending only, Dialog confirm).
- All strings `t()`, no dashes/arrows, WCAG AA.

### 4.4 PublicAlbumPage (public, `/t/:slug/:id/album`)

Sports-product feel (FotMob not dashboard): PublicShell wide; hero (campaign title, tagline, tournament name, photo count); award winners strip (if any) - horizontal cards with category label + winning school; filter chips (All + per-category + optional school Select); responsive masonry-ish grid (CSS columns: `columns-2 sm:columns-3 lg:columns-4 gap-3`, `break-inside-avoid`), `<img loading="lazy">` thumbs, tap -> accessible lightbox Dialog (full image, school name, caption, award chip, prev/next + arrow keys, focus trapped); empty state ("The album opens when the host approves the first photos"). ShareButton + ThemeToggle chrome like LiveViewerPage. No login anywhere.

### 4.5 Frontend tests (vitest, no MSW - `vi.mock('@/api/lens', importOriginal)`, mount under QueryClientProvider(retry:false)+ToastProvider+MemoryRouter, `useAuthStore.setState` for manager auth; ControlRoomPage.test.tsx is the template)

- `LensConsolePage.test.tsx`: renders pre-open state w/ disabled CTA when not fixtures_ready; open flow calls api + toast; moderate tab approve/hide invalidates + toasts; mint renders print sheet with QR imgs; award assignment.
- `LensUploadPage.test.tsx`: invalid token state; quota render; upload happy path (mock compressImage); closed state; delete own pending.
- `PublicAlbumPage.test.tsx`: grid renders approved photos; category filter; winners strip; empty state.

## 5. Rollout order (workflow lanes)

1. Lane BE (backend agent): 3.1-3.5, run `ruff` + lens tests + full backend suite. `makemigrations lens` only - NO `migrate` (prod DB!).
2. Lane FE (frontend agent, parallel): 4.1-4.5 with hand-written types, run new tests + `type-check` + `lint`.
3. Integration agent (after both): `spectacular --file backend/schema.yml --validate` (give lens views unique operation ids if collisions), `npm run gen:types`, ensure tsc still clean, run FULL backend pytest + frontend vitest, fix all breakage incl. any nav/test snapshot fallout.
4. Review fleet (parallel): security (public surface), invariants/house-style, UX/design-system+a11y -> fixer agent applies confirmed findings, reruns suites.
5. Main session: prod deploy (owner-role migrate with live-tournament check, FE build, systemd restart, smoke: album endpoint + bundle hash), commit + push.

## 6. Invariant checklist (reviewer aid)

UUIDv7 PKs; organization FK + cross-org tests on every endpoint; event_id idempotency on every mutation; append-only moderation timestamps + emit_audit everywhere; state guards (fixtures gate, campaign open, pass active); i18n t() + no dashes; tokens-only styling, h-9 density, custom Select/Dialog/toast; SSE/WS untouched; UTC storage, render local; session auth + CSRF (public endpoints AllowAny + throttle); media two-tier (public approved vs quarantined hidden); no new deps (Pillow + qrcode already installed; no FE QR lib - data URIs).
