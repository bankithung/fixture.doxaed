from django.apps import AppConfig


class SAdminConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.sadmin"
    label = "sadmin"
    verbose_name = "Super-admin console"
