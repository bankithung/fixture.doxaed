# API Contract sync

The backend's DRF serializers are the **single source of truth** for every
HTTP shape on the wire. The frontend consumes them via `openapi-typescript`,
which converts `backend/schema.yml` (emitted by `drf-spectacular`) into
`frontend/src/types/api.generated.ts`.

This eliminates the contract-drift class of bugs (e.g. `org_id` vs
`organization_id`, `role` vs `roles[]`, `memberships[]` shape mismatches)
that bit Phase 1A: a backend serializer change becomes a frontend
type-check failure on the very next regeneration.

---

## When to regenerate

Whenever a backend serializer, view, or URL changes (i.e. anything that can
alter the OpenAPI schema), run the two-step regeneration:

### 1. Regenerate `schema.yml` (from `backend/`)

```pwsh
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py spectacular --file schema.yml --validate
```

`--validate` runs OpenAPI 3 schema validation; the command should exit with
zero warnings before you proceed.

### 2. Regenerate TypeScript types (from `frontend/`)

```pwsh
cd frontend
npm run gen:types
```

This runs `openapi-typescript ../backend/schema.yml -o src/types/api.generated.ts`.
The output is a single `.d.ts`-style file with no runtime weight.

### 3. Type-check

```pwsh
cd frontend
npm run type-check
```

Drift surfaces here as TypeScript errors. Fix the callsites, **don't**
hand-edit `api.generated.ts` (it is regenerated on every run).

### 4. Commit both files together

```pwsh
git add backend/schema.yml frontend/src/types/api.generated.ts
```

Both files are committed so production builds (which do **not** run
`gen:types`) always have up-to-date types and reviewers can see the
contract delta in the diff.

---

## Why `gen:types` is NOT wired into `prebuild`

It would couple `npm run build` to the backend's working tree (and on CI to
a Python runtime + virtualenv). If `schema.yml` is missing or stale the
build would fail in confusing ways. Instead:

- **Devs run `npm run gen:types` manually** after pulling backend changes
  or editing serializers locally.
- **Production builds use the checked-in `api.generated.ts`** verbatim.
- **CI** (when added) should run `gen:types` plus `type-check` as a
  contract-drift gate, separate from the build.

---

## File layout

| File | Owner | Commit? |
|---|---|---|
| `backend/schema.yml` | `drf-spectacular` (machine-managed) | yes |
| `frontend/src/types/api.generated.ts` | `openapi-typescript` (machine-managed) | yes |
| `frontend/src/types/generated.ts` | hand-written ergonomic re-exports | yes |
| `frontend/src/types/user.ts` | hand-written domain types (legacy, being phased out) | yes |

`api.generated.ts` is **never** to be hand-edited. Add it to a CODEOWNER /
review-required path if you want extra friction; do **not** add it to
`.gitignore` (we want the diff visible on every backend change).

---

## Incremental migration plan

1. New API hooks added to `src/api/*.ts` should import `ApiX` from
   `@/types/generated` rather than from `@/types/user`.
2. Existing callsites can be migrated piecewise — `getMe` is the canary
   (its return type is already aliased to `GetMeResponse` in
   `src/api/auth.ts`, ready to flip to `ApiUser` once the backend
   `MeSerializer` widens).
3. **Known deferral:** `MeSerializer` currently does **not** expose
   `memberships[]`, `last_active_org_slug`, or `is_superuser`, even though
   the hand-written `User` type and SPA already consume them via a separate
   path. Once the backend serializer is widened (and a
   `MembershipSummary` nested serializer is added), regenerate and replace
   the hand-written `User` / `OrgMembership` types with the generated
   aliases.

---

## Troubleshooting

- **`schema.yml` is missing**: run step 1. Spectacular writes the file
  fresh; there is nothing to merge.
- **`npm install` complains about a `typescript` peer-dep conflict**:
  `openapi-typescript` 7.x lists TS 5.x as a peer, but the project uses
  TS 6.x. The runtime usage is fine (the tool only parses TS at build
  time). Use `npm install --legacy-peer-deps` until the upstream peer
  range is widened.
- **Generated file is suspiciously short**: check that `schema.yml`
  actually contains `components.schemas` (count with `grep -c '^    [A-Z]' ../backend/schema.yml`).
  An empty schema is usually a spectacular validation failure that exited
  before writing.
