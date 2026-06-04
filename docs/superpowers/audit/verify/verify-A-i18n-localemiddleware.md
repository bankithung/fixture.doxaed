# Adversarial Verify A — Invariant 13 (i18n): no LocaleMiddleware / LOCALE_PATHS / catalogs

**Finding under test:** `backend/fixture/settings/base.py:59` — "Backend: no LocaleMiddleware,
no LOCALE_PATHS, no catalogs (gettext is inert)" — severity **high**.

**Verdict: REAL (factual claims confirmed). Severity adjusted high -> medium.**

## Evidence (read in real code)

- `USE_I18N = True` — `backend/fixture/settings/base.py:131`. Also `LANGUAGE_CODE` default
  `"en-us"` (line 129), `USE_TZ = True` (line 132).
- MIDDLEWARE list `base.py:60-74` contains 11 middlewares; **no**
  `django.middleware.locale.LocaleMiddleware`. (Verified by reading lines 60-74.)
- Project-wide grep for `LocaleMiddleware|LOCALE_PATHS|^LANGUAGES|i18n_patterns|set_language`
  across `backend/` returns ZERO matches in project code — only `gettext_lazy` import lines
  in 6 model files. So no `LOCALE_PATHS`, no `LANGUAGES`, no `i18n_patterns`, no
  `set_language` view anywhere.
- No project-level `locale/` dir: glob `backend/**/locale/**` returns only
  `backend/.venv/Lib/site-packages/django/conf/locale/...` (Django's own bundled catalogs).
  Project `backend/locale/` and per-app `apps/*/locale/` do not exist.
- `dev.py` adds CORS/CSRF/logging only — no i18n config (read in full, 50 lines).
- Only project settings files are `__init__.py`, `base.py`, `dev.py` (glob
  `backend/**/settings*.py` shows no `prod.py`/`test.py` in project; other hits are `.venv`).
- gettext markup IS pervasive: `_(` appears 74 times across 10 project files
  (models in accounts/audit/organizations/permissions/sadmin/sports, plus
  permissions.py, middleware.py, factories, tests). Confirms "markers exist but
  infrastructure to serve translations does not."

## Why severity downgraded high -> medium

The finding's facts are all correct, but two points temper the impact:

1. **Overstated reasoning.** The finding says "even Django's/DRF's built-in translations
   never activate." Inaccurate: with `USE_I18N=True`, Django activates the default
   `LANGUAGE_CODE` (en-us) catalog without `LocaleMiddleware`; `LocaleMiddleware` only adds
   *per-request* language negotiation (Accept-Language / cookie / URL). Django's bundled
   en/admin catalogs still resolve. So gettext is not fully "inert."

2. **No runtime impact in v1.** v1 ships English-only; English is the source language, so
   `gettext("Foo")` returns `"Foo"` unchanged regardless of middleware/catalogs. No user
   sees a broken/missing string today.

The real defect is **incomplete forward-readiness for Invariant 13**: the markers honor the
"wrap every string" half of the invariant, but the activation + catalog half (LocaleMiddleware
+ LOCALE_PATHS + `makemessages`/`compilemessages` catalogs) is absent, so adding a second
language later is blocked until that infra lands. That is a correctness/architecture gap worth
fixing, but it is latent, not a live failure -> **medium**, not high.

Confidence: high (direct file reads + exhaustive project grep).
