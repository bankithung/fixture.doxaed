# Adversarial Verification A — Login endpoint DRF throttle

## Finding under review
- severity: high
- area: auth / rate limiting
- file: backend/apps/accounts/views.py:197
- title: "Login endpoint has no explicit DRF throttle class — brute-force relies solely on axes"
- evidence: "Missing Rate Limits: Login endpoint has no explicit DRF throttle class"

## Verdict: NOT REAL (as framed) — severity wrong (downgrade to info)

The literal sub-claim ("no explicit DRF throttle class on login") is TRUE, but the
load-bearing conclusion ("brute-force relies solely on axes") is FALSE, and the
"high" severity is unwarranted. The endpoint has TWO independent brute-force layers.

## Evidence from the real code

### 1. login_view has no `@throttle_classes` decorator (literal claim — TRUE)
`backend/apps/accounts/views.py:194-197`:
```
194  @extend_schema(request=LoginSerializer, responses={200: None}, tags=["accounts"])
195  @api_view(["POST"])
196  @permission_classes([AllowAny])
197  def login_view(request: Request) -> Response:
```
No `@throttle_classes(...)`. Contrast signup, which DOES opt in —
`views.py:89`: `@throttle_classes([SignupRateThrottle])`. So the *decorator* is
genuinely absent on login.

### 2. A default DRF throttle DOES apply (conclusion — FALSE)
`backend/fixture/settings/base.py:160-169`:
```
160  "DEFAULT_THROTTLE_CLASSES": [
161      "rest_framework.throttling.AnonRateThrottle",
162      "rest_framework.throttling.UserRateThrottle",
163  ],
164  "DEFAULT_THROTTLE_RATES": {
165      "anon": "60/min",
166      "user": "240/min",
167      "signup": "3/hour",
168  },
```
DRF applies `DEFAULT_THROTTLE_CLASSES` to every view that does not override them.
login_view is `AllowAny` and hit by anonymous clients, so `AnonRateThrottle`
(60/min/IP) automatically governs it. The throttling module docstring itself
acknowledges this — `backend/apps/accounts/throttling.py:7-10`:
"The default DRF ``AnonRateThrottle`` from ``settings.base.py`` is 60/min".
So brute-force does NOT "rely solely on axes."

### 3. axes is also configured and tested
`backend/fixture/settings/base.py:179-183`:
```
180  AXES_FAILURE_LIMIT = 10            # PRD §2.9
181  AXES_COOLOFF_TIME = 0.25           # 15 min
182  AXES_LOCKOUT_PARAMETERS = ["ip_address", "username"]
183  AXES_RESET_ON_SUCCESS = True
```
Middleware/backend wired: `base.py:70` (`axes.middleware.AxesMiddleware`),
`base.py:124` (`axes.backends.AxesStandaloneBackend`).
Passing test: `backend/apps/accounts/tests/test_login_flow.py:86`
`test_axes_locks_out_after_failure_limit` — verifies 403 lockout after the
failure limit.

## Net assessment
The login endpoint has layered brute-force defense:
- DRF `AnonRateThrottle` @ 60/min/IP (default, inherited — no decorator needed), AND
- django-axes 10-failure → 15-min lockout per (ip, username), tested.

The finding's framing inverts reality (claims "solely axes" when in fact axes is
the SECONDARY layer on top of the default DRF throttle). The only defensible
residual point is a hardening nuance: 60/min/IP is loose for a credential-stuffing
budget, and login is not pinned to a tighter dedicated scope the way signup is
(3/hr). That is an INFO-level hardening suggestion, not a HIGH missing-control.

is_real: false
corrected_severity: info
confidence: 0.9
