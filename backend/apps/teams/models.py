"""Teams domain — Person ↔ Player split (invariant #8), Team, Player.

MVP of v1Teams.md: the sport-agnostic core needed to register schools' teams +
players and feed the fixture generator. Person is platform-scoped (no org FK)
so career stats roll up across tournaments; Team/Player are org-scoped
(invariant #2). DOB is stored coarsely as `dob_year` here; full Fernet-encrypted
DOB (v1Teams §7.3) is a follow-up.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q, UniqueConstraint
from django.utils.translation import gettext_lazy as _

from apps.accounts.models import uuid7


class TeamStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    PENDING_APPROVAL = "pending_approval", _("Pending approval")
    REGISTERED = "registered", _("Registered")
    REJECTED = "rejected", _("Rejected")
    WITHDRAWN = "withdrawn", _("Withdrawn")
    DISQUALIFIED = "disqualified", _("Disqualified")


class Person(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    full_name = models.CharField(max_length=200)
    display_name = models.CharField(max_length=120, blank=True)
    dob_year = models.PositiveSmallIntegerField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="persons_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_person"
        indexes = [models.Index(fields=["full_name"], name="person_full_name_idx")]

    def __str__(self) -> str:  # pragma: no cover
        return self.full_name


class InstitutionKind(models.TextChoices):
    SCHOOL = "school", _("School")
    COLLEGE = "college", _("College")
    UNIVERSITY = "university", _("University")
    CLUB = "club", _("Club")
    ACADEMY = "academy", _("Academy")
    OTHER = "other", _("Other")


class InstitutionStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    INVITED = "invited", _("Invited")
    REGISTERED = "registered", _("Registered")
    WITHDRAWN = "withdrawn", _("Withdrawn")
    REJECTED = "rejected", _("Rejected")


class SchoolProfile(models.Model):
    """Canonical PLATFORM-level school/college identity (P2, master plan S5).

    The spine that lets one school's appearances across organizers'
    tournaments and across years roll up to a single durable record.
    Tournament-scoped Institution rows FK here (backfilled by normalized
    name + region), and a claimed operator Organization points here too.
    Deliberately NOT org-scoped: identity crosses tenants; an admin merge
    console (P4) resolves near-duplicates via ``merged_into``.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    name = models.CharField(max_length=200)
    normalized_name = models.CharField(max_length=200, db_index=True)
    region = models.CharField(max_length=120, blank=True)
    kind = models.CharField(
        max_length=16, choices=InstitutionKind.choices,
        default=InstitutionKind.SCHOOL,
    )
    merged_into = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="merged_from",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_school_profile"
        indexes = [
            models.Index(
                fields=["normalized_name", "region"],
                name="school_profile_ident_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return self.name


class Season(models.Model):
    """Org-scoped academic-year container (P2): one school year's annual
    meet, inter-house leagues and inter-class knockouts roll up here (house
    points, season records)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="seasons",
    )
    label = models.CharField(max_length=32)  # e.g. "2026-27"
    starts_on = models.DateField(null=True, blank=True)
    ends_on = models.DateField(null=True, blank=True)
    is_current = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_season"
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "label"],
                name="unique_season_label_per_org",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return self.label


class TeamGroupKind(models.TextChoices):
    HOUSE = "house", _("House")
    CLASS = "class", _("Class")
    FORM = "form", _("Form")
    DEPARTMENT = "department", _("Department")


class TeamGroup(models.Model):
    """A house / class / form — the INTRA-institution participant grouping
    (P2). In an inter-school tournament the school is the participant; on a
    sports day the HOUSE is — participant grouping is generic (owner: intra-
    and inter-school competition are both first-class)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="team_groups",
    )
    season = models.ForeignKey(
        Season, on_delete=models.CASCADE, related_name="groups",
    )
    kind = models.CharField(
        max_length=16, choices=TeamGroupKind.choices,
        default=TeamGroupKind.HOUSE,
    )
    # Free text, always: the host calls their houses whatever they call them.
    name = models.CharField(max_length=120)
    colour = models.CharField(max_length=16, blank=True)  # house colour token
    attributes = models.JSONField(default=dict, blank=True)
    # Soft delete (spec 2026-08-16): a house that has already played is part of
    # the season's point history and an append-only ledger references it, so it
    # is retired, never removed. The uniqueness rule below frees the name again.
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_team_group"
        constraints = [
            models.UniqueConstraint(
                fields=["season", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_group_name_per_season",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return self.name


class RosterMemberKind(models.TextChoices):
    """Who a school declares. Students compete; teachers travel with them and
    can only be in one place at a time — which is a scheduling fact, not an
    administrative one (owner 2026-08-15: "the teacher in-charges of the school
    cannot be in two courts")."""

    STUDENT = "student", _("Student")
    TEACHER = "teacher", _("Teacher in charge")


class RosterMemberStatus(models.TextChoices):
    ACTIVE = "active", _("Active")
    WITHDRAWN = "withdrawn", _("Withdrawn")


class RosterMember(models.Model):
    """One person a school has declared for a tournament, BEFORE any team
    exists (spec 2026-08-17).

    The layer that removes a guess. Until now a player's identity was inferred
    from a typed string — ``register_school`` reused a ``Person`` by
    ``full_name__iexact`` within the institution — so "Imliyanger Jamir" typed
    two ways became two people, and the scheduler cheerfully double-booked the
    child. Teams now PICK from this list, so ``Player.person`` is chosen rather
    than matched, and "is this student in two sports?" is answerable exactly.

    Per tournament + institution. ``Person`` stays the thin cross-tournament
    identity; everything a school knows a child by (class, roll number, DOB,
    documents) is per-event and lives here.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="roster_members",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="roster_members",
    )
    # String reference: Institution is declared further down this module.
    institution = models.ForeignKey(
        "teams.Institution", on_delete=models.CASCADE,
        related_name="roster_members",
    )
    # Within-school events: which house this person belongs to. Null in an
    # inter-school event, where the institution IS the competitor.
    group = models.ForeignKey(
        TeamGroup, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="roster_members",
    )
    person = models.ForeignKey(
        Person, on_delete=models.PROTECT, related_name="roster_entries",
    )
    kind = models.CharField(
        max_length=16, choices=RosterMemberKind.choices,
        default=RosterMemberKind.STUDENT, db_index=True,
    )
    # School-internal identity — what a school actually knows a child by.
    class_section = models.CharField(max_length=32, blank=True)
    roll_no = models.CharField(max_length=32, blank=True)
    gender = models.CharField(max_length=16, blank=True)
    date_of_birth = models.DateField(null=True, blank=True)
    # Contact details matter for teachers (they are the escort a scheduler
    # needs to reach); optional for students.
    contact_email = models.EmailField(blank=True)
    contact_phone = models.CharField(max_length=32, blank=True)
    # Free-form bag for anything else a tournament asks for, FET-style —
    # the generated form's extra questions land here rather than growing
    # columns per event.
    attributes = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=16, choices=RosterMemberStatus.choices,
        default=RosterMemberStatus.ACTIVE, db_index=True,
    )
    # The submission that declared this person (bare UUID, no FK — avoids a
    # teams -> forms cycle, mirroring Institution.source_response_id).
    source_response_id = models.UUIDField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="roster_members_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_roster_member"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "institution", "person"],
                condition=Q(deleted_at__isnull=True),
                name="unique_roster_person_per_institution",
            ),
        ]
        indexes = [
            models.Index(
                fields=["tournament", "institution", "kind"],
                name="roster_trn_inst_kind_idx",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return f"{self.person_id} ({self.kind})"


class TeamStaff(models.Model):
    """A teacher in charge of a team (spec 2026-08-17).

    Many-per-team on purpose: one is the common case, but a school that sends
    two teachers can legitimately run two courts at once — and a single FK
    would have quietly forbidden that. Two teams sharing a staff member is the
    edge the scheduler reads to keep their matches apart.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="team_staff",
    )
    team = models.ForeignKey(
        "teams.Team", on_delete=models.CASCADE, related_name="staff",
    )
    member = models.ForeignKey(
        RosterMember, on_delete=models.PROTECT, related_name="teams_in_charge",
    )
    role = models.CharField(max_length=32, blank=True, default="in_charge")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_team_staff"
        constraints = [
            UniqueConstraint(
                fields=["team", "member"], name="unique_staff_per_team",
            ),
        ]
        indexes = [
            models.Index(fields=["member"], name="team_staff_member_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return f"{self.member_id} in charge of {self.team_id}"


class TournamentHouse(models.Model):
    """Which of the season's houses take part in ONE tournament (spec
    2026-08-16 §D4).

    Houses belong to the school year, not to an event — that is what lets a
    year's sports day, inter-house league and march-past sum into a single
    house table. But not every house necessarily enters every event, and
    nothing before this could answer "which houses play in this tournament".
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="tournament_houses",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="houses",
    )
    group = models.ForeignKey(
        TeamGroup, on_delete=models.CASCADE, related_name="tournament_entries",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_tournament_house"
        constraints = [
            models.UniqueConstraint(
                fields=["tournament", "group"], name="unique_house_per_tournament",
            ),
        ]
        indexes = [
            models.Index(fields=["tournament"], name="tournament_house_trn_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return f"{self.group_id} in {self.tournament_id}"


class TeamGroupMembershipRole(models.TextChoices):
    MANAGER = "manager", _("House manager")


class TeamGroupMembership(models.Model):
    """A user who may register students FOR one house (spec 2026-08-16 §D5).

    The owner's flow: "the admin will add members so that the members who are
    in the respective house can add students". Every existing scoping dimension
    in the system is (user × org) or (user × tournament) — a `team_manager`
    today can edit ANY institution's teams — so this is the first membership
    that narrows a person to one competitor.

    Season-scoped like the group itself, so a house captain appointed for the
    year does not have to be re-added for each event.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="team_group_memberships",
    )
    group = models.ForeignKey(
        TeamGroup, on_delete=models.CASCADE, related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="team_group_memberships",
    )
    role = models.CharField(
        max_length=16, choices=TeamGroupMembershipRole.choices,
        default=TeamGroupMembershipRole.MANAGER,
    )
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="house_assignments_made",
    )
    revoked_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_team_group_membership"
        constraints = [
            models.UniqueConstraint(
                fields=["group", "user"],
                condition=Q(revoked_at__isnull=True),
                name="unique_active_house_member",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "revoked_at"], name="house_member_user_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover - repr sugar
        return f"{self.user_id} manages {self.group_id}"


class HousePointSource(models.TextChoices):
    RESULT = "result", _("Result")
    JUDGED = "judged", _("Judged")


class HousePointEntry(models.Model):
    """APPEND-ONLY house-points ledger (P2): result-derived rows AND judged
    injections (march past, drill, discipline shields) sum into the season
    house table. Rows are never updated — a correction appends a
    compensating row, mirroring the event-sourced scoring discipline."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="house_point_entries",
    )
    season = models.ForeignKey(
        Season, on_delete=models.CASCADE, related_name="point_entries",
    )
    group = models.ForeignKey(
        TeamGroup, on_delete=models.CASCADE, related_name="point_entries",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="house_point_entries",
    )
    points = models.IntegerField()
    reason = models.CharField(max_length=200)
    source = models.CharField(
        max_length=16, choices=HousePointSource.choices,
        default=HousePointSource.JUDGED,
    )
    awarded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="house_points_awarded",
    )
    # Invariant 3: idempotent writes (unique client event id when present).
    event_id = models.UUIDField(null=True, blank=True, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_house_point_entry"
        indexes = [
            models.Index(fields=["season", "group"], name="house_points_season_idx"),
        ]


class Institution(models.Model):
    """A participant entity (school / college / club) that owns many Teams —
    the new level in Organization → Tournament → Institution → Team → Player
    (spec 2026-06-08 §1). Org + tournament scoped like Team/Player. Promotes the
    old free-text ``Team.school`` into a first-class row so Stage-2 team
    registration can attach teams to a chosen institution.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="institutions",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="institutions",
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    kind = models.CharField(
        max_length=16, choices=InstitutionKind.choices, default=InstitutionKind.SCHOOL,
    )
    region = models.CharField(max_length=120, blank=True)
    contact_name = models.CharField(max_length=200, blank=True)
    contact_email = models.EmailField(blank=True)
    contact_phone = models.CharField(max_length=32, blank=True)
    status = models.CharField(
        max_length=16, choices=InstitutionStatus.choices,
        default=InstitutionStatus.REGISTERED, db_index=True,
    )
    # Free-form labels the constraint engine keys off (e.g. {"campus": "north"}),
    # FET-style (mirrors Tournament.rules/constraints "everything is data").
    attributes = models.JSONField(default=dict, blank=True)
    # Optional pointer to the Stage-1 form response that created this row (bare
    # UUID, no FK — avoids a teams→forms cycle; mirrors audit scope columns).
    source_response_id = models.UUIDField(null=True, blank=True)
    # P2: pointer into the canonical platform identity (SchoolProfile) —
    # the spine for cross-tournament, cross-year school records. Nullable;
    # backfilled by normalized name + region, resolved via the merge console.
    school_profile = models.ForeignKey(
        SchoolProfile, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="institutions",
    )
    # Team-registration access code (emailed to the contact when Stage 2
    # opens). The Argon2id hash is what VERIFICATION reads, always — a DB leak
    # of this column alone exposes nothing usable.
    team_code_hash = models.TextField(blank=True, default="")
    team_code_sent_at = models.DateTimeField(null=True, blank=True)
    # The same code encrypted (reversible), so the host can read it back and
    # hand it over by phone when the email did not arrive (owner 2026-08-19).
    # A convenience mirror only: nothing authenticates against this column, and
    # it is never carried by a public or member-gated serializer. Empty for
    # codes minted before this existed — those are hashes and gone for good.
    team_code_enc = models.TextField(blank=True, default="")
    # Rotation grace: the code we just replaced keeps verifying until this
    # moment, so re-issuing to make a code readable never strands a school
    # that is holding the emailed one.
    team_code_prev_hash = models.TextField(blank=True, default="")
    team_code_prev_until = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="institutions_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_institution"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"],
                name="unique_institution_slug_per_tournament",
            ),
            UniqueConstraint(
                fields=["tournament", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_institution_name_per_tournament",
            ),
        ]
        indexes = [
            models.Index(fields=["tournament", "status"], name="inst_trn_status_idx"),
            models.Index(fields=["organization"], name="inst_org_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.name


class Team(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="teams"
    )
    institution = models.ForeignKey(
        Institution, null=True, blank=True, on_delete=models.PROTECT,
        related_name="teams",
    )
    # P2: the intra-institution grouping (house/class) this team plays FOR
    # in an operator org's own events; None in inter-school tournaments.
    group = models.ForeignKey(
        TeamGroup, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="teams",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="teams"
    )
    slug = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    short_name = models.CharField(max_length=40, blank=True)
    school = models.CharField(max_length=200, blank=True)
    region = models.CharField(max_length=120, blank=True)
    pool = models.CharField(max_length=80, blank=True)  # display label (group/category)
    # Structural competition binding (spec 2026-06-10 §3): the sport key and
    # the category-leaf key ("football.u15.girls.5v5") this team registered
    # into. `pool` stays as the human-readable label; these are the machine
    # references fixtures/scoring scope by. Blank = uncategorized.
    sport = models.CharField(max_length=40, blank=True)
    leaf_key = models.CharField(max_length=160, blank=True, db_index=True)
    seed = models.PositiveSmallIntegerField(null=True, blank=True)
    status = models.CharField(
        max_length=24, choices=TeamStatus.choices, default=TeamStatus.REGISTERED,
        db_index=True,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="teams_created",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_team"
        constraints = [
            UniqueConstraint(
                fields=["tournament", "slug"], name="unique_team_slug_per_tournament"
            ),
            # Names are unique PER COMPETITION (leaf), not per tournament — a
            # school legitimately reuses "Kikon A" across its sports/categories
            # (owner 2026-06-10: the per-tournament constraint silently ate a
            # multi-category registration). Direct adds without a leaf share
            # the "" bucket.
            UniqueConstraint(
                fields=["tournament", "leaf_key", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_team_name_per_competition",
            ),
        ]
        indexes = [
            models.Index(fields=["tournament", "status"], name="team_trn_status_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.school})" if self.school else self.name


class Player(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="players"
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE, related_name="players"
    )
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="players")
    person = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="players")
    jersey_no = models.PositiveSmallIntegerField(null=True, blank=True)
    position = models.CharField(max_length=16, blank=True)
    captain = models.BooleanField(default=False)
    is_goalkeeper = models.BooleanField(default=False)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="players_added",
    )
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams_player"
        constraints = [
            UniqueConstraint(
                fields=["team", "jersey_no"],
                condition=Q(deleted_at__isnull=True, jersey_no__isnull=False),
                name="unique_jersey_per_team",
            ),
            # W2-D: one entry per TEAM (not per tournament) — a student may
            # legitimately play U15 football AND badminton singles. The
            # scheduler treats teams sharing a person as linked (their
            # matches never overlap); same-leaf double-entry is blocked in
            # register_school.
            UniqueConstraint(
                fields=["team", "person"],
                condition=Q(deleted_at__isnull=True),
                name="unique_person_per_team",
            ),
            UniqueConstraint(
                fields=["team"],
                condition=Q(captain=True, deleted_at__isnull=True),
                name="unique_captain_per_team",
            ),
        ]
        indexes = [
            models.Index(fields=["team"], name="player_team_idx"),
            models.Index(fields=["person"], name="player_person_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"#{self.jersey_no} {self.person_id}"


class RegistrationLink(models.Model):
    """A shareable token an organizer hands out so schools self-register their
    teams + players (no account needed). Plaintext token is shown once; only the
    sha256 hash is stored (same pattern as invitations)."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE,
        related_name="registration_links",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament", on_delete=models.CASCADE,
        related_name="registration_links",
    )
    token_hash = models.CharField(max_length=128, db_index=True)
    label = models.CharField(max_length=120, blank=True)
    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    max_submissions = models.PositiveIntegerField(null=True, blank=True)
    submission_count = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="registration_links_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "teams_registration_link"

    def __str__(self) -> str:  # pragma: no cover
        return f"RegistrationLink({self.tournament_id})"
