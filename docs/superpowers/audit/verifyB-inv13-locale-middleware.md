# Adversarial Verify B — Invariant 13 (i18n): no LocaleMiddleware / LOCALE_PATHS / catalogs

## Verdict: REAL (factually confirmed); severity DOWNGRADED high -> medium

## Finding under test
> Backend: no LocaleMiddleware, no LOCALE_PATHS, no catalogs (gettext is inert).
> `backend/fixture/settings/base.py:59`, claimed severity = high.

## What I actually saw

### 1. `USE_I18N = True` but no LocaleMiddleware — CONFIRMED
`backend/fixture/settings/base.py:131`:
```
USE_I18N = True
```
`MIDDLEWARE` block at `base.py:60-74` (note: finding said line 59; the list
literal opens at line 60, comment header at 59). Full list:
```
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_htmx.middleware.HtmxMiddleware",
    "axes.middleware.AxesMiddleware",
    "waffle.middleware.WaffleMiddleware",
    "apps.sadmin.middleware.SadminIPAllowlistMiddleware",
]
```
`django.middleware.locale.LocaleMiddleware` is NOT present.
Grep for `LocaleMiddleware` across `backend/` (excluding .venv): NO MATCHES.

### 2. No LOCALE_PATHS / LANGUAGES — CONFIRMED
Grep for `LOCALE_PATHS|LANGUAGES\s*=|USE_L10N` across `backend/`: NO MATCHES.
The I18n block (`base.py:128-132`) sets only `LANGUAGE_CODE`, `TIME_ZONE`,
`USE_I18N`, `USE_TZ`. dev.py (`backend/fixture/settings/dev.py`) adds neither
middleware nor LOCALE_PATHS.

### 3. No project locale/ catalog dir — CONFIRMED
Glob `backend/**/locale/**` and `backend/**/*.po` return ONLY files under
`backend/.venv/...` (third-party Django + lib catalogs, ignored per ROE).
There is no app-level or project-level `locale/` directory and no `.po`/`.mo`
authored by this project.

### 4. gettext markers really are in use (so markup is "decorative") — CONFIRMED
`from django.utils.translation import gettext_lazy as _` appears in 6 app
model files:
- `backend/apps/accounts/models.py:25`
- `backend/apps/organizations/models.py:24`
- `backend/apps/permissions/models.py:21`
- `backend/apps/audit/models.py:17`
- `backend/apps/sadmin/models.py:17`
- `backend/apps/sports/models.py:19`

So strings ARE wrapped (invariant 13's "wrap every string in gettext/t()" is
partially honored), but with no middleware to activate a non-default language
and no compiled catalogs, those markers resolve to the source (English) string
at runtime. The claim that the markup is presently inert/decorative is accurate.

## Why severity is medium, not high
All four technical claims are TRUE. But the impact framing is overstated:

- v1 ships English ONLY (CLAUDE.md invariant 13: "only English ships v1").
  Without catalogs, `gettext_lazy` falls back to the literal source string — it
  does NOT raise; the app is fully functional and renders correct English.
- There is no functional break, no security exposure, no data risk, and no
  cross-org/isolation impact. Nothing a user can hit in v1 is degraded.
- The honored half of invariant 13 (markers in source so future translation is
  cheap) is in fact done. The missing half is the *activation* plumbing
  (LocaleMiddleware + LOCALE_PATHS + `LANGUAGES` + compiled `.mo`), which only
  becomes load-bearing when a 2nd language ships (post-v1).
- "gettext does nothing — even Django's/DRF's built-in translations never
  activate" is technically correct but moot while the only active language is
  the source language (en).

Net: a real, correctly-located i18n-readiness gap that should be fixed before a
second locale is added, but it carries no v1 user-facing or security impact.
Medium is the calibrated severity; high implies a present functional/safety
break that does not exist.

## Confidence: 0.9
