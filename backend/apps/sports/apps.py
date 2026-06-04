from django.apps import AppConfig


class SportsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.sports"
    label = "sports"
    verbose_name = "Sports catalog"
