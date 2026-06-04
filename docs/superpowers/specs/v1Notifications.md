# v1Notifications.md — Notifications subsystem (deep design)

> **Status:** Implementation-ready design. Notifications app does **not** exist yet
> (`apps/notifications/` is not in `backend/apps/`). This is a Phase-1B-adjacent
> chassis feature: the *delivery* surface (in-app bell + SSE + email + cron) is
> sport-agnostic and can ship before the football vertical, but most *producers*
> of notifications (match scheduling, lineup deadlines, scoring) are Phase 1B.
> Build the engine now; wire producers as each Phase-1B app lands.
>
> **Canonical sources** (read before editing):
> - PRD `docs/superpowers/specs/2026-04-30-fixture-platform-prd.md`
>   **§5.14** (the canonical notifications spec — architecture, recipient table,
>   grouping, self-suppression, preferences, retention), **§5.19** (account
>   compromise / security notifications), **§7.2** (live transport split — bell is
>   SSE on `user:<uuid>:notifications`), **§7.3** (`transaction.on_commit` domain
>   hooks that fire notifications), **§6** (NFRs: 90d/1y retention,
>   `Notification(user_id, read_at, created_at DESC)` index).
> - v1Users.md **§1.6** (Super-admin verbs → always-on security notifications),
>   **§1.8 Audit** (impersonation → `impersonation_session_started`),
>   **Appendix A.2** (`personal.notification_prefs` module — already in the catalog).
> - This doc owns the notification-specific decisions; fold stable ones into
>   PRD §14 in a batch later.

---

## 0. Design principles & invariant alignment

| Invariant | How notifications honours it |
|-----------|------------------------------|
| **1 UUID v7 PK** | `Notification`, `NotificationPreference`, `NotificationGroup` all use `uuid7()` from `apps.accounts.models`. |
| **2 Multi-tenancy** | `Notification.organization` FK (nullable for platform-level account/security events). Bell SSE channel is **per-user** (`user:<uuid>:notifications`), so cross-org leak is structurally impossible — a notification belongs to exactly one recipient `User`. Org-scoped queries still filter; isolation test asserts user A in Org X never receives a notification row addressed to user B. |
| **3 Idempotent writes** | Every dispatch carries a `dedup_key` (deterministic per `(event_type, recipient, source_object, source_version)`) with a **unique constraint** on `(recipient, dedup_key)`. Re-firing the same domain event (retry, double `on_commit`, replayed webhook) is a no-op that returns the existing row. Mutation API endpoints (mark-read, archive) accept a client `event_id`. |
| **4 DB-first; Redis publish in on_commit** | The `Notification` row is the system of record. SSE push to Redis (`user:<uuid>:notifications`) happens in `transaction.on_commit`, **never** inline. If Redis is down, the row still exists and the bell shows it on next poll/reconnect. |
| **5 Append-only audit** | Notification **dispatch** is itself audit-logged (`event_type="notification_dispatched"`) via `emit_audit()` — PRD §5.15 lists "notification dispatch" as a captured event. Notification rows themselves are **mutable** (read_at, archived_at) — they are NOT audit rows; do not put them on the append-only table. |
| **6 State machines** | `Notification` has a small lifecycle (`unread → read → archived`) enforced in the service layer, not boolean soup. Delivery has its own per-channel status (`pending → sent → failed`). |
| **10 inputs_hash + manual edit** | N/A directly, but grouping reuses the spirit: a collapsed group stores the member event ids so "view details" can expand. |
| **11 SSE one-way / WS two-way** | Bell is **SSE only** (`user:<uuid>:notifications`). Never a WebSocket. Marking-read is a normal DRF POST, not a WS message. |
| **12 Module RBAC default-deny** | `personal.notification_prefs` (already in `permissions/fixtures/modules.json`, default-on for all 6 in-org roles) gates the **preferences** UI. The bell + list itself needs no module — any authenticated user with a `User` row can read **their own** notifications (it is personal data, not an org surface). |
| **13 i18n + a11y** | Notification copy is rendered from a **template registry** keyed by `event_type`, each template a `gettext`-wrapped format string. The bell dropdown and `/notifications` page are WCAG 2.1 AA (live-region announce on new unread, keyboard-navigable list, focus management). |
| **14 UTC** | `created_at` stored UTC; rendered in viewer TZ in the SPA with a tournament-TZ tooltip where the notification references a match. |
| **15 Session auth no-JWT** | SSE endpoint authenticates via the session cookie (same-origin); mutation endpoints use DRF session auth + CSRF header, identical to the rest of the chassis. |

**Self-suppression (PRD §5.14):** a user never receives a notification about *their own* action. Enforced centrally in the dispatcher: `if recipient_id == actor_user_id: skip` — **except** for always-on security events where the actor may *be* the affected user via a third party (handled below).

---

## 1. Data model (`apps/notifications/models.py`)

All models live in the new `apps/notifications/` app. PK = `uuid7()` imported from
`apps.accounts.models` (same pattern as `audit/models.py` line 19).

### 1.1 `NotificationEventType` (TextChoices — canonical taxonomy)

Locked enum mirroring PRD §5.14's recipient table + v1Users always-on events.
Centralised so the preferences matrix, recipient resolver, and template registry
all key off one source of truth.

```python
class NotificationCategory(models.TextChoices):
    TOURNAMENTS = "tournaments", _("Tournaments")
    MATCHES = "matches", _("Matches")
    ACCOUNT = "account", _("Account")
    DISPUTES = "disputes", _("Disputes")
    ROLES = "roles", _("Roles")          # invitations / role assign / revoke
    SECURITY = "security", _("Security") # always-on subset of Account

class NotificationEventType(models.TextChoices):
    # --- roles / membership ---
    INVITATION_RECEIVED       = "invitation_received", _("Invitation received")
    ROLE_ASSIGNED             = "role_assigned", _("Role assigned")
    ROLE_REVOKED              = "role_revoked", _("Role revoked")
    ACCOUNT_APPROVED          = "account_approved", _("Account approved")
    MEMBER_INVITE_ACCEPTED    = "member_invite_accepted", _("Invite accepted")   # v1Users §609
    MEMBER_INVITE_DECLINED    = "member_invite_declined", _("Invite declined")   # v1Users §617
    ORG_OWNERSHIP_OFFERED     = "org_ownership_offered", _("Ownership offered")   # v1Users §510
    ORG_OWNER_AUTO_PROMOTED   = "org_owner_auto_promoted", _("Auto-promoted to admin/owner")
    # --- tournaments ---
    TOURNAMENT_CREATED        = "tournament_created", _("Tournament created")
    ASSIGNED_TO_TOURNAMENT    = "assigned_to_tournament", _("Assigned to tournament")
    TOURNAMENT_PUBLISHED      = "tournament_published", _("Tournament published")
    TOURNAMENT_LOCKED         = "tournament_locked", _("Tournament locked")
    BRACKET_LOCKED            = "bracket_locked", _("Bracket locked")
    RULE_AMEND_PROPOSED       = "rule_amend_proposed", _("Rule amendment proposed")
    RULE_AMEND_EFFECTIVE      = "rule_amend_effective", _("Rule amendment effective")
    # --- teams ---
    TEAM_INVITED              = "team_invited", _("Team invited")
    TEAM_REGISTERED           = "team_registered", _("Team registered")
    TEAM_APPROVED             = "team_approved", _("Team approved")
    TEAM_REJECTED             = "team_rejected", _("Team rejected")
    # --- matches (Phase 1B producers) ---
    ASSIGNED_AS_SCORER        = "assigned_as_scorer", _("Assigned as scorer")
    ASSIGNED_AS_REFEREE       = "assigned_as_referee", _("Assigned as referee")
    MATCH_SCHEDULED           = "match_scheduled", _("Match scheduled")
    MATCH_RESCHEDULED         = "match_rescheduled", _("Match rescheduled")
    MATCH_POSTPONED           = "match_postponed", _("Match postponed")
    MATCH_CANCELLED           = "match_cancelled", _("Match cancelled")
    LINEUP_DEADLINE_APPROACHING = "lineup_deadline_approaching", _("Lineup deadline approaching")  # T-2h, cron
    LINEUP_DEADLINE_PASSED    = "lineup_deadline_passed", _("Lineup deadline passed")              # cron/T-0
    MATCH_STARTING_SOON       = "match_starting_soon", _("Match starting soon")                    # T-15m, cron
    SCORE_PENDING_APPROVAL    = "score_pending_approval", _("Score pending approval")
    SCORE_APPROVED            = "score_approved", _("Score approved")
    SCORE_REJECTED            = "score_rejected", _("Score rejected")
    MATCH_ENDED               = "match_ended", _("Match ended")
    YOUR_TEAM_ADVANCED        = "your_team_advanced", _("Your team advanced")
    YOUR_TEAM_ELIMINATED      = "your_team_eliminated", _("Your team eliminated")
    YOUR_NEXT_MATCH_SET       = "your_next_match_set", _("Your next match set")
    # --- disputes ---
    DISPUTE_RAISED            = "dispute_raised", _("Dispute raised")
    DISPUTE_RESOLVED          = "dispute_resolved", _("Dispute resolved")
    # --- ALWAYS-ON security (non-disableable) ---
    ACCOUNT_SECURITY_ALERT      = "account_security_alert", _("Security alert")          # v1Users §1.6
    IMPERSONATION_SESSION_STARTED = "impersonation_session_started", _("Impersonation started")  # v1Users §1.8
    EMAIL_CHANGED               = "email_changed", _("Email changed")                    # PRD §5.19 (to OLD email)
    PASSWORD_CHANGED            = "password_changed", _("Password changed")
    NEW_2FA_DEVICE              = "new_2fa_device", _("New 2FA device enrolled")
    FORCED_LOGOUT_ALL           = "forced_logout_all", _("All sessions logged out")
```

**Always-on set** (cannot be disabled in preferences; bypass self-suppression
where a third party acts on the user):
`{account_security_alert, impersonation_session_started, email_changed,
password_changed, new_2fa_device, forced_logout_all}` plus, per PRD §5.14,
**"a dispute affecting your team"** (`dispute_raised` / `dispute_resolved` where
the recipient is a TM/player of an involved team). Codified as a frozenset
`ALWAYS_ON_EVENT_TYPES` in `apps/notifications/constants.py`.

**Category map:** module-level dict `EVENT_CATEGORY: dict[NotificationEventType, NotificationCategory]`
in `constants.py` so the SPA filter tabs and the preferences grouping share it.

### 1.2 `Notification` (one row per recipient per event)

```python
class Notification(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE, related_name="notifications")
    organization = models.ForeignKey("organizations.Organization",
        null=True, blank=True, on_delete=models.CASCADE, related_name="+")
        # null = platform-level (account/security) notification

    event_type = models.CharField(max_length=48, choices=NotificationEventType.choices, db_index=True)
    category   = models.CharField(max_length=16, choices=NotificationCategory.choices, db_index=True)

    # Self-suppression / "who did this" provenance (NOT shown if == recipient)
    actor_user = models.ForeignKey(settings.AUTH_USER_MODEL,
        null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    # Generic target pointer (no GenericForeignKey to avoid contenttypes coupling)
    target_type = models.CharField(max_length=48, blank=True)   # "tournament" | "match" | "team" | "dispute" | "user" | "organization"
    target_id   = models.UUIDField(null=True, blank=True)
    tournament_id = models.UUIDField(null=True, blank=True, db_index=True)  # for category=tournaments/matches filtering
    match_id      = models.UUIDField(null=True, blank=True, db_index=True)

    # Rendered-at-read-time, NOT stored as prose: store the template key + context.
    context = models.JSONField(default=dict, blank=True)  # {"tournament_name": "...", "team_name": "...", "deep_link": "/t/.../m/..."}

    # Idempotency (invariant 3)
    dedup_key = models.CharField(max_length=200, db_index=True)
    # Grouping (PRD §5.14 ≥5 same event_type / user / 1 min)
    group = models.ForeignKey("NotificationGroup", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="members")

    # Lifecycle (invariant 6)
    read_at     = models.DateTimeField(null=True, blank=True)
    seen_at     = models.DateTimeField(null=True, blank=True)  # bell opened (clears unread badge) vs. read (opened the item)
    archived_at = models.DateTimeField(null=True, blank=True)

    is_always_on = models.BooleanField(default=False)  # denormalised from ALWAYS_ON_EVENT_TYPES at create time
    priority = models.CharField(max_length=8, default="normal")  # "normal" | "high" (security/disputes) — drives bell styling

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "notification"
        constraints = [
            models.UniqueConstraint(fields=["recipient", "dedup_key"],
                name="uq_notification_recipient_dedup"),
        ]
        indexes = [
            # PRD §6 mandated index:
            models.Index(fields=["recipient", "read_at", "-created_at"],
                name="notif_recipient_read_created_idx"),
            models.Index(fields=["recipient", "archived_at", "-created_at"],
                name="notif_recipient_arch_created_idx"),
            models.Index(fields=["recipient", "category", "-created_at"],
                name="notif_recipient_cat_created_idx"),
        ]
```

**Why store `context` + `event_type` instead of rendered text:** i18n (invariant 13)
— the message is composed at read time via the template registry in the user's
locale. Also lets us re-render if copy changes. Mirrors how `audit` stores
`payload_after` rather than prose.

### 1.3 `NotificationGroup` (collapse ≥5 same-type within 1 min)

```python
class NotificationGroup(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    event_type = models.CharField(max_length=48, choices=NotificationEventType.choices)
    organization = models.ForeignKey("organizations.Organization", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    tournament_id = models.UUIDField(null=True, blank=True)
    window_start = models.DateTimeField()       # the 1-min bucket start
    count = models.PositiveIntegerField(default=0)
    summary_context = models.JSONField(default=dict)  # {"tournament_name": "...", "count": 5}
    read_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "notification_group"
        indexes = [models.Index(fields=["recipient", "-created_at"], name="notifgroup_recip_created_idx")]
```

Grouping rule (in dispatcher): when creating notification N for `(recipient,
event_type, tournament)`, look for ≥4 existing **unread** members of the same
`(recipient, event_type, tournament)` within the last 60s. If found, attach N to
(or create) the `NotificationGroup`, increment `count`, and the bell renders the
group summary row ("5 matches scheduled in Inter-College Cup 2026") instead of 5
rows. Individual members remain queryable for the "view details" expansion.
**Always-on notifications are never grouped** (each security alert stands alone).

### 1.4 `NotificationPreference` (matrix `(event_type × channel) → enabled`)

```python
class NotificationChannel(models.TextChoices):
    IN_APP = "in_app", _("In-app")
    EMAIL  = "email", _("Email")     # v1: dispatch only for always-on; UI "Coming soon" for the rest
    # v2+: WHATSAPP, SMS

class NotificationPreference(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notification_prefs")
    event_type = models.CharField(max_length=48, choices=NotificationEventType.choices)
    channel = models.CharField(max_length=12, choices=NotificationChannel.choices)
    enabled = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notification_preference"
        constraints = [
            models.UniqueConstraint(fields=["user", "event_type", "channel"],
                name="uq_notifpref_user_event_channel"),
        ]
```

**Default-on, sparse storage:** a missing `(user, event_type, channel)` row means
**enabled** (sensible default — opt-out model). Only opt-outs are persisted. The
resolver `is_enabled(user, event_type, channel)`:
1. If `event_type in ALWAYS_ON_EVENT_TYPES` → **always True** (cannot be disabled).
2. If `channel == EMAIL` and `event_type not in ALWAYS_ON` and not v2 → **False** in v1 (email only for security events in v1).
3. Else look up the row; absent → default True.

### 1.5 `NotificationDelivery` (per-channel send audit, optional but recommended)

For email (and v2 channels) we need a delivery ledger to retry failures and avoid
double-send. In-app does not need a delivery row (the `Notification` row *is* the
in-app delivery). Keep it lean:

```python
class NotificationDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    notification = models.ForeignKey(Notification, on_delete=models.CASCADE, related_name="deliveries")
    channel = models.CharField(max_length=12, choices=NotificationChannel.choices)
    status = models.CharField(max_length=12, default="pending")  # pending|sent|failed|skipped
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.TextField(blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notification_delivery"
        constraints = [
            models.UniqueConstraint(fields=["notification", "channel"],
                name="uq_notifdelivery_notif_channel"),
        ]
```

---

## 2. Service layer (`apps/notifications/services/`)

Mirrors the audit service pattern (`apps/audit/services.py`): **the only way** to
create notifications is `dispatch()`. No model `.objects.create()` in producers.

### 2.1 `dispatch.py` — `notify()`

```python
def notify(
    *,
    event_type: NotificationEventType,
    recipients: Iterable[User] | Iterable[uuid.UUID],   # resolved by caller OR via resolve_recipients()
    actor_user: User | None,
    context: dict,                  # template context (names, deep_link)
    organization_id: uuid.UUID | None = None,
    tournament_id: uuid.UUID | None = None,
    match_id: uuid.UUID | None = None,
    target_type: str = "",
    target_id: uuid.UUID | None = None,
    dedup_scope: str | None = None, # extra discriminator for dedup_key (e.g. match version)
    request: HttpRequest | None = None,
) -> list[Notification]:
```

Algorithm:
1. Resolve recipients to user ids; **drop the actor** unless `event_type` is
   always-on (self-suppression, PRD §5.14).
2. For each recipient, compute `dedup_key = f"{event_type}:{target_type}:{target_id}:{dedup_scope or ''}"`.
3. Resolve per-channel enablement (`is_enabled`). In-app row is **always created**
   if `IN_APP` enabled OR event is always-on (so the bell shows it); email
   `NotificationDelivery` created only if email enabled.
4. `bulk_create(..., ignore_conflicts=True)` on `Notification` (the unique
   `(recipient, dedup_key)` makes re-fires idempotent — invariant 3). Re-query to
   get the rows (created or pre-existing).
5. Run grouping pass (§1.3).
6. `emit_audit(event_type="notification_dispatched", target_type="notification",
   target_id=<batch sentinel or per-row>, payload_after={"event_type":..., "recipients": n})`
   — PRD §5.15 captures notification dispatch.
7. **`transaction.on_commit`**: publish to Redis `user:<uuid>:notifications` for
   each in-app recipient (SSE fan-out — invariant 4) and enqueue email sends.

> **Critical:** `notify()` must be called *inside* the producer's DB transaction so
> the notification row and the domain change commit atomically; the Redis/email
> side-effects run on commit. This matches PRD §7.3 exactly.

### 2.2 `recipients.py` — `resolve_recipients(event_type, **scope)`

Encapsulates the **canonical recipient table** (PRD §5.14). E.g.
`match_scheduled → both TMs + Scorer + Referee + Game coordinator`. Returns a
deduplicated list of `User`. This is the one place that reads
`OrganizationMembership` + (Phase 1B) `TournamentMembership` /
`MatchAssignment` / `TeamMembership` to compute the audience. Until Phase 1B
models exist, only the Phase-1A event types (`invitation_received`,
`role_assigned`, `role_revoked`, `tournament_created`, account/security) have live
resolvers; Phase-1B branches raise `NotImplementedError` guarded behind a feature
check (or simply aren't called yet). **Multi-tenancy:** resolver only returns
users with an active membership in the relevant org → no cross-org recipient.

### 2.3 `templates.py` — render registry

```python
TEMPLATES: dict[str, NotificationTemplate] = {
    "invitation_received": NotificationTemplate(
        title=_("You've been invited to {org_name}"),
        body=_("{actor_name} invited you to join {org_name} as {role}."),
        deep_link="/invitations/{token}",
        icon="mail",            # lucide icon name for the SPA
    ),
    ...
}
def render(notification, locale) -> {"title", "body", "deep_link", "icon"}
```

All strings `gettext`-wrapped (invariant 13). Render is **lazy** (at API
serialization / read), so changing copy or locale re-renders existing rows.

### 2.4 `security.py` — always-on helpers

Thin wrappers so the accounts/sadmin apps call a named function rather than
hand-building `notify()`:
`notify_security_alert(user, reason, request)`,
`notify_impersonation_started(impersonated_user, impersonator)`,
`notify_email_changed(user, old_email)`, `notify_password_changed(user)`,
`notify_new_2fa_device(user, device)`, `notify_forced_logout(user)`.
Each forces `is_always_on=True`, `priority="high"`, **email channel forced on**
(security mail always goes out regardless of preferences), and bypasses
self-suppression. These integrate at:
- `apps/sadmin/...` verbs: `suspend_user`, `force_logout_all_sessions`,
  `force_disable_2fa`, `impersonate_user` (v1Users §1.6 / §1.8).
- `apps/accounts/services/password_reset.py` `complete_password_reset` →
  `notify_password_changed`.
- `apps/accounts/services/twofa.py` enroll → `notify_new_2fa_device`.
- Email-change flow (PRD §5.19) → `notify_email_changed` to the **old** address.

### 2.5 `read.py` — lifecycle mutations

`mark_read(user, ids)`, `mark_all_read(user, category=None)`,
`mark_seen(user)` (bell opened — clears badge), `archive(user, ids)`,
`unread_count(user)`. All scoped to `recipient=user` (cannot touch another user's
rows — isolation). Accept optional client `event_id` for idempotency on the
write endpoints.

---

## 3. SSE delivery (`apps/notifications/sse.py` + `apps/live/` shared)

Per invariant 11 / PRD §7.2 the bell is **SSE**, channel `user:<uuid>:notifications`.

- **Transport:** Django **async view** (StreamingHttpResponse, `text/event-stream`),
  not a Channels consumer (consumers are reserved for the bidirectional
  scorer/referee WS rooms). The SSE view subscribes to Redis pub/sub on
  `user:<recipient_id>:notifications` and streams `event: notification` frames.
- **Auth:** session cookie (same-origin, invariant 15). The view reads
  `request.user`; a user can only open their **own** channel
  (`user:<request.user.id>:notifications`) — the channel name is derived from the
  session, never from a query param, so there is no IDOR path to another user's
  stream.
- **Endpoint:** `GET /api/notifications/stream/` (no id in URL — it's always "me").
- **Publish side:** `dispatch.notify()` `on_commit` callback does
  `redis.publish(f"user:{uid}:notifications", json.dumps({"type": "notification", "unread_count": n, "preview": {...}}))`.
- **Heartbeat:** comment-line ping every 25s to defeat proxy idle timeouts.
- **Reconnect:** client sends `Last-Event-ID`; on reconnect the view replays any
  rows created after that id (bounded to last N) so a dropped connection doesn't
  lose a notification. The DB is the source of truth (invariant 4), so even with
  zero SSE the bell is correct after a manual refresh.
- **Phase-1A fallback:** `CHANNEL_LAYERS`/cache is `InMemoryChannelLayer` + locmem
  today (`settings/base.py:186`). For real cross-process pub/sub the engine needs
  Redis. Until Redis lands, SSE degrades to **poll** (client refetches
  `unread_count` every 30s) — the bell still works, just not sub-second. Wire
  `channels_redis` + a `REDIS_URL` setting as part of this app's settings PR
  (Phase 1B prod already requires Redis per CLAUDE.md stack).

---

## 4. Email channel (`apps/notifications/services/email.py`)

- Reuses Django `send_mail` exactly like
  `apps/accounts/services/password_reset.py:101` (`DEFAULT_FROM_EMAIL`,
  `fail_silently=True`, console backend in dev — `settings/dev.py:24`).
- v1 scope (PRD §5.14): **email fires only for always-on / security events** and
  for transactional account flows that already send mail (invite, approval,
  ownership). All other event types show "Email — Coming soon" (grayed) in
  preferences and create **no** `NotificationDelivery(email)` row.
- Each email send updates its `NotificationDelivery` row (`status`, `attempts`,
  `sent_at`/`last_error`). A management command `retry_failed_email_deliveries`
  (run by cron) retries `status=failed, attempts<3`.
- Email body rendered from the same template registry (§2.3) plus an HTML wrapper.

---

## 5. Scheduled notifications (cron) (`apps/notifications/management/commands/`)

PRD §5.14 + match state table (§5.5) require **time-triggered** notifications.
Implemented as idempotent management commands run by **systemd timer** (prod;
`notif-cron` is named in PRD §7.1 deployment box, line 830) and invokable in dev.

| Command | Cadence | Fires |
|---------|---------|-------|
| `notify_due` | every 1 min | Scans Phase-1B `Match` rows for time-relative triggers: `lineup_deadline_approaching` (T-2h), `lineup_deadline_passed` (T-0), `match_starting_soon` (T-15m for TMs, T-30m extra ping for referee per v1Users §1559). Each fire carries a `dedup_key` including the trigger window so a re-run within the minute is idempotent. |
| `purge_notifications` | daily | Retention (PRD §5.14 / §6): archive (set `archived_at`) notifications older than **90 days**; hard-delete older than **1 year**. Always-on/security rows follow the same retention (they are not audit rows). |
| `retry_failed_email_deliveries` | every 5 min | Retry `NotificationDelivery(status=failed, attempts<3)`. |

**Idempotency of cron:** because `notify()` dedups on `(recipient, dedup_key)`, a
cron job that runs late / twice never double-notifies. The `dedup_key` for
time-triggers = `f"{event_type}:{match_id}:{trigger_window_iso}"`.

> **Dependency:** `notify_due` is inert until the `matches` app (Phase 1B) exists.
> Ship the command with a guard `if not apps.is_installed("apps.matches"): return`
> so the cron is safe to schedule from day one.

---

## 6. API surface (`apps/notifications/views.py`, `urls.py`)

DRF `APIView`s, session auth + CSRF, cursor pagination copied from
`apps/audit/views.py` (the `_encode_cursor`/`_decode_cursor`/`-created_at,-id`
pattern is directly reusable — factor it into a shared
`apps/common/cursor.py` or duplicate per existing convention).

| Method & path | Purpose | Permission | Notes |
|---------------|---------|-----------|-------|
| `GET /api/notifications/` | Paginated list of **my** notifications | `IsAuthenticated` | Query params: `cursor`, `limit` (≤200), `category` (filter tab), `unread=true`, `archived=true`. Returns rendered title/body/deep_link/icon + group rollups. Always `recipient=request.user`. |
| `GET /api/notifications/unread_count/` | `{unread, by_category}` | `IsAuthenticated` | Cheap; backs the bell badge poll-fallback. |
| `POST /api/notifications/mark_seen/` | Clears unread **badge** (bell opened) | `IsAuthenticated` | Sets `seen_at` on currently-unread rows. |
| `POST /api/notifications/mark_read/` | `{ids:[], event_id?}` | `IsAuthenticated` | Idempotent; only own rows. |
| `POST /api/notifications/mark_all_read/` | `{category?, event_id?}` | `IsAuthenticated` | Bulk. |
| `POST /api/notifications/archive/` | `{ids:[], event_id?}` | `IsAuthenticated` | Bulk archive. |
| `GET /api/notifications/stream/` | SSE stream (§3) | `IsAuthenticated` | `text/event-stream`; own channel only. |
| `GET /api/notifications/preferences/` | Full `(event_type × channel)` matrix with defaults + role-default annotations + `always_on` flag + `coming_soon` flag per channel | `IsAuthenticated` + `HasModule("personal.notification_prefs")` | Shape mirrors permissions matrix endpoint (`permissions/views.py:206`). |
| `PUT /api/notifications/preferences/` | `{cells:{<event_type>:{<channel>:bool}}, event_id?}` | `IsAuthenticated` + `HasModule("personal.notification_prefs")` | Persists **only opt-outs** (sparse). Rejects edits to always-on rows (400). |

**Serializers** (`serializers.py`): `NotificationSerializer` (renders template),
`NotificationGroupSerializer`, `NotificationListResponseSerializer`
(`{results, next_cursor, previous_cursor}` — same shape as `AuditEventListResponse`),
`NotificationPreferenceMatrixSerializer`.

URLs registered under `apps/notifications/urls.py` and included in the project URL
conf alongside `audit`/`permissions`.

---

## 7. Frontend (SPA) (`frontend/src/`)

Reuse existing patterns: `api/client.ts` wrapper, TanStack Query, feature folders
(`features/auth`, `features/orgs`, `features/permissions`), shadcn/ui + lucide +
framer-motion (locked overhaul decision).

### 7.1 API client — `frontend/src/api/notifications.ts`
Mirror `api/audit.ts`: typed wrappers `list`, `unreadCount`, `markSeen`,
`markRead`, `markAllRead`, `archive`, `getPreferences`, `putPreferences`. Types
from `@/types/api.generated` (drf-spectacular).

### 7.2 Bell component — `frontend/src/features/notifications/NotificationBell.tsx`
- Lives in the app shell header (`features/layout`).
- shadcn `DropdownMenu`/`Popover`; lucide `Bell` icon with an unread badge.
- Shows **10 most recent** (PRD §5.14) + "View all" → `/notifications`.
- Subscribes to SSE via a `useNotificationStream()` hook (`EventSource('/api/notifications/stream/', {withCredentials})`); on `notification` event, invalidates the `["notifications","unread_count"]` and list queries (TanStack Query). Poll-fallback (30s) when SSE unsupported/Redis-less.
- a11y: `aria-live="polite"` region announces "N new notifications"; badge has `aria-label`; dropdown is keyboard-navigable; opening the bell calls `mark_seen` (badge clears) without marking individual items read.
- framer-motion: subtle badge pop + list item slide-in.

### 7.3 Full page — `frontend/src/features/notifications/NotificationsPage.tsx` (route `/notifications`)
- Filter tabs by category (Tournaments / Matches / Account / Disputes / Roles / Security) — PRD §5.14.
- **Date grouping** (Today / Yesterday / This week / Earlier), infinite scroll (cursor) via `useInfiniteQuery`.
- Bulk select → mark read / archive. Group rows ("5 matches scheduled…") expandable.
- Empty state: "You're all caught up" (PRD §3, line 588).
- Each row: lucide icon (from template), title, relative time (viewer TZ, tournament-TZ tooltip per invariant 14), unread dot, click → `deep_link`.

### 7.4 Preferences — `frontend/src/features/notifications/NotificationPreferences.tsx` (route `/settings/notifications`)
- Matrix table `(event_type rows × channel columns)` grouped by category — reuse the **permissions matrix** UI component pattern from `features/permissions`.
- `in_app` column toggleable; `email`/others grayed "Coming soon" (PRD §5.14).
- Always-on rows render a **locked** toggle with tooltip "Required for your security — can't be turned off."
- Gated by `personal.notification_prefs` module (hide nav item if module absent).
- Optimistic update + `event_id` for idempotent save.

---

## 8. Tests to write (TDD — tests-first per CLAUDE.md)

### Backend (`apps/notifications/tests/`)
1. **`test_dispatch.py`** — `notify()` creates one row per recipient; renders correct category; sets `is_always_on`/`priority`.
2. **`test_idempotency.py`** — re-firing the same `(event_type, target, recipient)` returns the existing row, no duplicate (invariant 3). Concurrent `bulk_create(ignore_conflicts=True)` path.
3. **`test_self_suppression.py`** — actor never receives their own non-always-on notification; **does** receive always-on ones triggered by a third party.
4. **`test_always_on.py`** — security event types ignore preference opt-outs; preference PUT rejecting an always-on cell returns 400.
5. **`test_preferences_resolver.py`** — sparse default-on; opt-out persisted; email default-off in v1 for non-security.
6. **`test_grouping.py`** — ≥5 same-type/user/1-min collapse into one `NotificationGroup`; always-on never grouped; details expandable.
7. **`test_multitenancy_isolation.py`** *(not optional — CLAUDE.md)* — user A in Org X cannot list/mark/archive/stream user B's notifications; recipient resolver never returns out-of-org users; SSE channel derived from session not param (no IDOR).
8. **`test_api_list.py`** — cursor pagination, category filter, unread filter; only own rows.
9. **`test_mark_read_archive.py`** — lifecycle transitions; idempotent `event_id`; cannot mutate another user's rows (404/403).
10. **`test_sse_auth.py`** — stream requires auth; opens only `user:<self>` channel; reconnect via `Last-Event-ID` replays missed rows.
11. **`test_audit_on_dispatch.py`** — dispatch emits `notification_dispatched` AuditEvent (PRD §5.15).
12. **`test_on_commit_publish.py`** — Redis publish + email enqueue happen on commit, not before; rollback → no publish, no row.
13. **`test_cron_notify_due.py`** — T-2h/T-0/T-15m fires correct event types & recipients; idempotent across double runs (dedup window). *(Phase 1B once `matches` exists; ship a guarded stub test now.)*
14. **`test_retention_purge.py`** — archive ≥90d, hard-delete ≥1y.
15. **`test_security_integrations.py`** — `complete_password_reset`, 2FA enroll, sadmin `suspend_user`/`force_logout`/`impersonate` each fire the right always-on notification + email.

### Frontend (`frontend/src/features/notifications/__tests__/`)
- `NotificationBell.test.tsx` — badge count, SSE event invalidates queries, mark_seen on open, a11y live region.
- `NotificationsPage.test.tsx` — category filter, infinite scroll, bulk actions, empty state, group expansion.
- `NotificationPreferences.test.tsx` — toggle persists, always-on locked, email "Coming soon" disabled, optimistic + idempotent save.

### Permission matrix
- Extend `apps/permissions/tests/test_module_matrix.py` parametrization to assert `personal.notification_prefs` gates the preferences endpoint per role (default-on for the 6 in-org roles per `modules.json:140`).

---

## 9. Build / migration order

1. **Settings PR** — add `apps.notifications` to `INSTALLED_APPS`; add `REDIS_URL` +
   switch `CHANNEL_LAYERS`/`CACHES` to Redis-backed (env-gated; keep locmem default
   for tests). (`settings/base.py:186-196`.)
2. **`0001_initial`** — `Notification`, `NotificationGroup`, `NotificationPreference`,
   `NotificationDelivery` + indexes/constraints (no Postgres-role migration — these
   tables are mutable, unlike `audit`).
3. **constants + taxonomy** (`constants.py`: enums, `ALWAYS_ON_EVENT_TYPES`,
   `EVENT_CATEGORY`) — pure Python, tested first.
4. **service layer** (`dispatch`, `recipients` [Phase-1A subset], `templates`,
   `security`, `read`, `email`) — TDD.
5. **API views + serializers + urls** — TDD; cursor util shared from audit.
6. **SSE async view** + Redis publish in `on_commit`; poll-fallback.
7. **cron management commands** (`notify_due` guarded, `purge_notifications`,
   `retry_failed_email_deliveries`) + systemd timer units in deploy config.
8. **Integrations** — wire always-on calls into `accounts` (password/2FA/email-change)
   and `sadmin` verbs; wire `tournament_created`/`role_assigned`/`invitation_received`
   producers into `organizations`/`permissions` flows (these Phase-1A producers can
   land now).
9. **Frontend** — `api/notifications.ts`, bell in shell, `/notifications` page,
   `/settings/notifications` prefs; SSE hook.
10. **Phase-1B wiring** (later) — `matches`/`teams`/`disputes`/`fixtures` producers
    call `notify()` from their `transaction.on_commit` domain hooks (PRD §7.3);
    `notify_due` cron activates.

---

## 10. Reused chassis (citations)

| Reused piece | Source | Use |
|--------------|--------|-----|
| `uuid7()` PK helper | `apps/accounts/models.py:30` | All notification PKs (invariant 1). |
| `emit_audit()` service pattern | `apps/audit/services.py:24` | Dispatch is audit-logged; the "service layer is the only writer" discipline is copied. |
| Idempotency-key pattern | `apps/audit/services.py:45-48`, model `idempotency_key` unique | `Notification.dedup_key` unique constraint (invariant 3). |
| `transaction.on_commit` deferral | `apps/audit/services.py:80-87` (`emit_audit_on_commit`) | Redis publish + email after commit (invariant 4). |
| Cursor pagination | `apps/audit/views.py:62-200` (`_encode_cursor`/`_decode_cursor`, `-created_at,-id`) | Notification list + infinite scroll. |
| `send_mail` email pattern | `apps/accounts/services/password_reset.py:101-111` | Email channel + security mail. |
| Cache-backed rate limit | `apps/accounts/services/password_reset.py:45-59` | (Optional) throttle SSE reconnect / preference writes. |
| `ScopedQuerySetMixin` | `apps/organizations/scope.py:21` | Org-scoped recipient resolution; isolation. |
| `HasModule()` permission factory | `apps/permissions/permissions.py:30` | Gate preferences endpoint with `personal.notification_prefs`. |
| `personal.notification_prefs` module | `apps/permissions/fixtures/modules.json:136` | Already in catalog, default-on for 6 roles — no new module needed. |
| Matrix endpoint shape | `apps/permissions/views.py:187,206` & `services/matrix.py` | Preferences `(event_type × channel)` matrix request/response shape. |
| Frontend API wrapper | `frontend/src/api/client.ts`, `api/audit.ts` | `api/notifications.ts`. |
| Channels installed, ASGI app | `settings/base.py:38,186`, `fixture/asgi.py` | SSE async view runs on the existing ASGI stack (no consumer needed for bell). |

---

## 11. Open questions (move to PRD §13/§14 when settled)

1. **Cursor util location** — extract `apps/common/cursor.py` shared by audit +
   notifications, or duplicate? (Lean: extract.)
2. **SSE vs poll for v1 ship** — if Redis pub/sub isn't wired when the bell ships,
   ship poll-only (30s) and add SSE when Redis lands. Bell correctness does not
   depend on SSE (DB is source of truth).
3. **Digest emails (v1.5)** — daily/weekly rollup email of in-app notifications;
   schema (`NotificationDelivery` + a digest cron) is ready; defer behaviour.
4. **`seen` vs `read` semantics** — confirmed split: opening the bell = `seen`
   (clears badge); opening an item = `read`. PRD §5.14 says "unread count" — `seen`
   drives the badge, `read` drives the row dot.
5. **Per-tournament mute** (v2) — "mute this tournament" preference beyond the
   `(event_type × channel)` matrix. Out of scope v1.
