from django.apps import AppConfig


class PermissionsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.permissions"
    label = "permissions_app"  # avoid collision with django.contrib.auth's "permissions"
    verbose_name = "RBAC modules"
