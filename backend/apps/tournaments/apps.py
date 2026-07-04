from django.apps import AppConfig


class TournamentsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tournaments"
    label = "tournaments"
    verbose_name = "Tournaments"

    def ready(self):
        from django.db.models.signals import pre_migrate

        pre_migrate.connect(_block_migrations_while_live, sender=self)


def _block_migrations_while_live(sender, using, **kwargs):
    """PRD §5 deploy pre-flight, now ENFORCED (audit gap: it was
    documentation-only): schema migrations are refused while any tournament
    is live. Override deliberately with FIXTURE_ALLOW_LIVE_MIGRATE=1."""
    import os

    if os.environ.get("FIXTURE_ALLOW_LIVE_MIGRATE") == "1":
        return
    try:
        from apps.tournaments.models import Tournament, TournamentStatus

        live = Tournament.objects.using(using).filter(
            status=TournamentStatus.LIVE, deleted_at__isnull=True
        ).count()
    except Exception:
        return  # fresh/empty DB (test creation, first install): nothing live
    if live:
        raise SystemExit(
            f"migrate blocked: {live} tournament(s) are LIVE (PRD 5). "
            "Set FIXTURE_ALLOW_LIVE_MIGRATE=1 to override deliberately."
        )
