"""End-to-end demo: organizer -> tournament -> 10 schools / 20 teams / players ->
assign scorer+referee roles -> generate fixtures -> record real scores -> standings.

Runs against the configured DB (dev). Idempotent on the demo users; creates a
fresh tournament per run. Usage:
    python manage.py run_e2e_demo [--players 11] [--seed 2026] [--name "..."]
"""
from __future__ import annotations

import random

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.fixtures.services.generate import generate_round_robin
from apps.matches.models import Match, MatchStatus
from apps.matches.services.scoring import assign_scorer, record_score
from apps.matches.services.standings import compute_standings
from apps.teams.models import Team
from apps.teams.services.registration import register_school
from apps.tournaments.models import (
    TournamentMembership,
    TournamentMembershipRole,
    TournamentMembershipStatus,
)
from apps.tournaments.services.create import create_tournament

User = get_user_model()

SCHOOLS = [
    "Mount Hermon School", "Don Bosco Kohima", "Carmel Higher Secondary",
    "G. Rio School", "Christ King College", "Northfield School",
    "Holy Cross Dimapur", "Pranab Vidyapith", "Loyola Jakhama",
    "Modern School Kohima",
]
POSITIONS = ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "AM", "RW", "ST", "LW"]
FIRST = ["Mhonbeni", "Imkong", "Temjen", "Kevi", "Vikho", "Neikhrietuo", "Aien",
         "Toshi", "Bendang", "Kekhrie", "Sao", "Lima", "Along", "Vese", "Thejas",
         "Akok", "Moa", "Renben", "Khriezo", "Yanpvuo"]
LAST = ["Kikon", "Jamir", "Ao", "Angami", "Lotha", "Sema", "Kire", "Chang",
        "Konyak", "Patton", "Zhimomi", "Yanthan", "Ezung", "Tep", "Rhakho",
        "Murry", "Longkumer", "Sangtam", "Phom", "Odyuo"]


def _verified(email: str, name: str) -> User:
    user = User.objects.filter(email=email).first()
    if user is None:
        user = User.objects.create_user(email=email, password="FixtureDemo2026!", name=name, is_active=True)
    user.is_active = True
    if user.email_verified_at is None:
        user.email_verified_at = timezone.now()
    user.save()
    return user


class Command(BaseCommand):
    help = "Run a complete end-to-end tournament demo with real scores + standings."

    def add_arguments(self, parser):
        parser.add_argument("--players", type=int, default=11)
        parser.add_argument("--seed", type=int, default=2026)
        parser.add_argument("--name", default="Nagaland Schools Cup")

    def handle(self, *args, **opts):
        rng = random.Random(opts["seed"])
        w = self.stdout.write

        organizer = _verified("organizer@demo.test", "Demo Organizer")
        scorer = _verified("scorer@demo.test", "Demo Scorer")
        referee = _verified("referee@demo.test", "Demo Referee")

        t = create_tournament(user=organizer, name=opts["name"])
        w("")
        w(f"=== TOURNAMENT: {t.name}  (workspace={t.organization.slug}) ===")
        w(f"Organizer: {organizer.email}")

        for u, role in [
            (scorer, TournamentMembershipRole.MATCH_SCORER),
            (referee, TournamentMembershipRole.REFEREE),
        ]:
            TournamentMembership.objects.get_or_create(
                user=u, tournament=t, role=role,
                defaults={"status": TournamentMembershipStatus.ACTIVE, "assigned_by": organizer},
            )
        w(f"Assigned roles: {scorer.email}=match_scorer, {referee.email}=referee")

        n_players = opts["players"]
        total_players = 0
        for school in SCHOOLS:
            teams = []
            for ti in range(2):  # one school -> two teams
                players = []
                for j in range(n_players):
                    players.append({
                        "full_name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                        "jersey_no": j + 1,
                        "position": POSITIONS[j % len(POSITIONS)],
                        "is_goalkeeper": j == 0,
                        "captain": j == n_players - 1,
                        "dob_year": rng.randint(2007, 2010),
                    })
                teams.append({"name": f"{school} {chr(ord('A') + ti)}", "players": players})
                total_players += len(players)
            register_school(tournament=t, school_name=school, teams=teams, submitted_by=organizer)

        n_teams = Team.objects.filter(tournament=t).count()
        w(f"Registered {len(SCHOOLS)} schools, {n_teams} teams, {total_players} players (via the register-school flow).")

        matches = generate_round_robin(tournament=t, group_size=5)
        w(f"Generated {len(matches)} fixtures (round-robin within groups).")

        done = 0
        for m in Match.objects.filter(tournament=t).order_by("match_no"):
            assign_scorer(match=m, user=scorer, by=organizer)
            record_score(
                match=m, home_score=rng.randint(0, 5), away_score=rng.randint(0, 5), by=scorer
            )
            done += 1
        completed = Match.objects.filter(tournament=t, status=MatchStatus.COMPLETED).count()
        w(f"Scorer recorded {done} results ({completed} matches completed).")

        labels = sorted(
            set(Match.objects.filter(tournament=t).values_list("group_label", flat=True))
        )
        for label in labels:
            w("")
            w(f"-- {label} --")
            w(f"{'#':>2}  {'Team':30} {'P':>2} {'W':>2} {'D':>2} {'L':>2} {'GF':>3} {'GA':>3} {'GD':>4} {'Pts':>4}")
            for i, r in enumerate(compute_standings(t, group_label=label), 1):
                w(f"{i:>2}. {r['name'][:30]:30} {r['P']:>2} {r['W']:>2} {r['D']:>2} {r['L']:>2} {r['GF']:>3} {r['GA']:>3} {r['GD']:>4} {r['Pts']:>4}")

        w("")
        w(f"=== E2E COMPLETE: {len(SCHOOLS)} schools, {n_teams} teams, {total_players} players, {done} matches scored. ===")
        w(f"View it: log in as {organizer.email} / FixtureDemo2026! -> /tournaments")
