# StudyFlow backend (Supabase)

Project `studyflow`, ref `fshdvzqsyzqvsvodxxwh`, eu-central-1, free plan.
URL `https://fshdvzqsyzqvsvodxxwh.supabase.co`. The data contract is
[`docs/SCHEMA.md`](../docs/SCHEMA.md); change it together with a new migration.

There are **no accounts**. The app sends the publishable key (role `anon`) plus the header
`x-sf-key: <personal key>`. Every table policy is `to anon using (private.key_ok())`, so a
request without the right key sees nothing and can write nothing.

## What exists

### Migrations (`migrations/`, applied in this order; never edit an applied file)

| File | What it does |
|---|---|
| `0000_owner_guard` | (applied from the dashboard earlier, no file) schema `private`, rejects every sign-up except Mathieu's Gmail. `auth` is otherwise unused. |
| `0001_core.sql` | `pgcrypto`, `private.app_keys`, `private.function_tokens`, `private.key_ok()`, `private.touch()`, all content and log tables, touch triggers, RLS, explicit grants (auto-expose is off). |
| `0002_storage.sql` | Private bucket `slides` (WebP only, 4 MB max), no client policies. |
| `0003_functions.sql` | `public.card_states()` (Leitner fold) and `public.sf_token_ok(kind, hash)` (token check for the Edge Functions, service role only). |
| `0004_seed.sql` | The 6 courses, `settings` (`goals`, `defaults`, `profile`), the `pipeline_status` row. |
| `0005_advisor_fixes.sql` | Advisor fixes: `rls_auto_enable()` not callable by clients; the fold as a PL/pgSQL loop. |
| `0006_sessions_quizzes.sql` | `chapters.status`, `study_sessions`, `quizzes`, "no quizzes for BE" checks, the `quiz_attempts.scope` format, and `public.sf_add_session(payload)`. |

### Edge Functions (`functions/`, both `verify_jwt = false`)

- **`ingest`** (PC only, header `x-ingest-token`): `sign_upload`, `upsert_slides`, `remove`.
- **`media`** (header `x-sf-key` from the app, or `x-routine-token` from the cloud routine):
  `sign_download` → signed image URLs. CORS for `https://sathoni.github.io` and
  `http://localhost:*`.

Deploy a change with the Supabase connector (`deploy_edge_function`, `verify_jwt: false`),
passing the file from `functions/<name>/index.ts`.

### Secrets

`C:\Users\User\.studyflow\tokens.json` (outside OneDrive and git) holds `INGEST_TOKEN`,
`ROUTINE_TOKEN` and `APP_KEY`. The database stores **only their SHA-256**:
`APP_KEY` in `private.app_keys` (label `iphone-1`), the two tokens in
`private.function_tokens`. The functions hash the header and ask `public.sf_token_ok`.
They are not stored as function secrets (that would need Mathieu to type them into the
dashboard); if a function secret `INGEST_TOKEN` / `ROUTINE_TOKEN` is ever set, it is
accepted too, with a constant-time compare.

The app's public settings (URL and publishable key) are in `app/src/lib/server-config.ts`.
The publishable key is public by design; without `x-sf-key` it reads nothing.

## The write path for cards

Course projects and the routine call, through the Supabase connector (runs as `postgres`):

```sql
select public.sf_add_session($json$ { "session_key": "SCM-H3:2026-10-24:121-135", ... } $json$::jsonb);
```

It validates everything, writes the session, cards and quiz items in one transaction, makes
the session quiz (not for BE, not for `kind: "import"`), and returns ids, counts and
warnings. Re-sending the same payload changes nothing. The chapter must already exist in
`public.chapters`. Full rules: `docs/SCHEMA.md`, "The write path".

## How to verify (Claude runs these)

Read the key without printing it:
`K=$(python -c "import json;print(json.load(open(r'C:\Users\User\.studyflow\tokens.json'))['APP_KEY'])")`

| Check | Expected |
|---|---|
| `curl -s "$URL/rest/v1/courses?select=id" -H "apikey: $PUBLISHABLE"` | `[]` |
| same with `-H "x-sf-key: $K"` | 6 rows |
| `POST /rest/v1/reviews` without `x-sf-key` | 401, row-level security |
| `POST /rest/v1/rpc/sf_add_session` as anon | permission denied |
| `POST /functions/v1/media` with a wrong `x-sf-key` | 401 |
| same with `$K` and `{"action":"sign_download","paths":["SCM-H3/p006.webp"]}` | `expires_in: 3600` and a URL (or an error per path if the image is not uploaded yet) |
| `POST /functions/v1/ingest` with a wrong token | 401 |
| Supabase connector `get_advisors(security)` | only the intended items: `card_states()` callable by anon (guarded by `key_ok()` inside), and "RLS without policy" on `private.app_keys`, `private.function_tokens`, `public.pipeline_runs` (server-only on purpose) |

## Rotating the personal key (a leaked link)

1. Make a new key with Python (32 random bytes, base64url without `=`), put it in
   `tokens.json` as `APP_KEY` (keep the old one under another name until step 4).
2. Add its hash (connector, `execute_sql`):
   `insert into private.app_keys (hash, label) values (decode('<sha256 hex of the new key>', 'hex'), 'iphone-2');`
3. Give Mathieu the new link `https://sathoni.github.io/studyflow/?k=<new key>`; he opens
   it in Safari and adds it to his home screen again (remove the old icon).
4. Revoke the old one:
   `update private.app_keys set revoked_at = now() where label = 'iphone-1';`
   From then on the old link sees nothing. Remove the old key from `tokens.json`.

Rotating `INGEST_TOKEN` / `ROUTINE_TOKEN`: new value in `tokens.json`, then
`update private.function_tokens set hash = decode('<sha256 hex>', 'hex'), created_at = now() where name = 'INGEST_TOKEN';`
(the routine's copy of `ROUTINE_TOKEN` must be updated as well).

## Never

- Touch the other Supabase project (`pewmmxhmrutpeamtkajb`, Andrea & Mathieu).
- Put a token, the personal key or a secret key in git, OneDrive or a report.
- Give `anon` update/delete on the log tables (`reviews`, `quiz_attempts`, `card_flags`,
  `instrument_reviews`): they are append-only.
