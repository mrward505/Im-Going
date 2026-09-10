# I'm Going API — production deploy (free-tier testing phase)

Target: **Render free web service (Docker)** + **Neon free Postgres**, for the
Tempe beta (50–200 users). Owner decision (2026-09-08): free hosting now,
switch to paid always-on before launch night. Everything here is portable:
config is 100% env-driven, no host-specific paths in code.

## 1. Production env contract

Set these in the Render dashboard (service → Environment). Never commit secrets.

| Var | Required | Purpose | Example |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | Neon Postgres connection string | `postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/imgoing?sslmode=require` |
| `AUTH_JWT_SECRET` | yes | Signs sessions; ≥16 chars; boot refuses the dev default in prod | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | yes | Bearer token for admin invite endpoints (`POST /admin/invites`, `GET /admin/invites`); without it prod returns 403 | `openssl rand -hex 32` |
| `NODE_ENV` | yes | `production` → binds `0.0.0.0`, enforces `ADMIN_TOKEN` + real `AUTH_JWT_SECRET` | `production` |
| `OTP_PROVIDER` | yes | `console` for the test beta (codes print to logs); `twilio` later | `console` |
| `LAUNCH_CITY` | no (default `Tempe`) | Single-city scope | `Tempe` |
| `PORT` | no (Render injects) | Listen port; default `8081` | (Render sets automatically) |
| `HOST` | no (default `0.0.0.0` when `NODE_ENV=production`, else `127.0.0.1`) | Bind address; leave unset on Render | — |
| `LOG_LEVEL` | no (default `info`) | `debug`/`info`/`warn`/`error` | `info` |
| `CORS_ORIGINS` | no | Comma-separated extra browser origins allowed CORS headers (prod allow-list; localhost dev defaults are always on) | `https://<your-web-preview-host>` |
| `OTP_TTL_SECONDS` | no (300) | OTP lifetime | `300` |
| `OTP_MAX_ATTEMPTS` | no (5) | OTP guess limit | `5` |
| `SESSION_TTL_DAYS` | no (30) | Session token lifetime | `30` |
| `SIGNUP_TOKEN_TTL_MINUTES` | no (15) | Signup token lifetime | `15` |
| `STORAGE_PROVIDER` | no (`local`) | Upload backend (`local` for now) | `local` |
| `STORAGE_BUCKET` | no | Only used when `STORAGE_PROVIDER` is object storage (later) | — |
| `STORAGE_LOCAL_DIR` | no (`./data/uploads`) | Local upload dir. **Ephemeral on Render free** (lost on restart/redeploy) — fine for testing; fix before launch night (see §6) | `./data/uploads` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` | only when `OTP_PROVIDER=twilio` | Real SMS (later phase) | — |

## 2. Boot order

1. Render builds the image from `server/Dockerfile` (`dockerContext: ./server`).
2. At container start `docker-entrypoint.sh` runs **`bun run migrate`** (applies
   `server/migrations/*.sql` in order, tracked in `schema_migrations` — safe to
   re-run on every boot), then **`exec bun src/index.ts`**.
3. `GET /health` returns 200 with `{"status":"ok","db":"ok",…}` and is the
   Render health check (`healthCheckPath: /health`).

## 3. One-time setup against prod

From your machine, pointing at the Neon DB (get `DATABASE_URL` from the Neon
dashboard — use the pooled connection string if offered):

```sh
cd server
DATABASE_URL='<neon-string>' bun run migrate:status  # expect: all pending
DATABASE_URL='<neon-string>' bun run migrate         # apply
DATABASE_URL='<neon-string>' bun run seed:check      # report only, no writes
DATABASE_URL='<neon-string>' bun run seed            # apply the Phoenix-metro seed — 981 Tempe anchor + 1,829 metro venues, grouped city counts (idempotent)
curl https://<your-render-service>.onrender.com/health  # expect 200 {"status":"ok","db":"ok",...}
```

Run the seed **once**; it is idempotent (name+address match, else fuzzy
name-similarity ≥ 0.87 within 200 m), so re-running only updates in place.

## 4. Render free-tier behaviour (testing only — acceptable per owner)

- The service **sleeps after ~15 min idle**; the first request after sleep takes
  **~30 s** (cold start: container boot + migrate check + first queries). Fine
  for the beta; testers should expect one slow first load.
- Free Postgres (Neon) has its own idle-sleep + storage/row limits — fine for
  50–200 users, not for launch night.
- Ephemeral filesystem: local uploads vanish on restart — acceptable while
  posts are test-only.

## 5. CORS note

- **Native iOS (TestFlight/EAS):** `fetch` from the app is not a browser — no
  CORS involved. Nothing to configure.
- **Expo web preview:** the API only sends CORS headers to origins in
  `CORS_ORIGINS` plus localhost dev defaults (`src/index.ts`). If you point a
  hosted web preview at the Render URL, add its origin to `CORS_ORIGINS` in the
  Render dashboard (comma-separated, no trailing slash) and redeploy. No code
  change needed.
- The app reads `EXPO_PUBLIC_API_URL` **at bundle time** — after the Render URL
  exists, rebuild the app (EAS) with that URL to point the beta at prod.

## 6. Switching to paid before launch night (no code changes)

1. Render: change the web service plan free → Starter (or higher) — same
   service, same env; deploys stay automatic on `main`.
2. Neon: upgrade to a paid plan (or move to any managed Postgres) — only
   `DATABASE_URL` changes.
3. Uploads: switch `STORAGE_PROVIDER` to object storage (or attach a Render
   persistent disk and set `STORAGE_LOCAL_DIR` to its mount path).
4. OTP: set `OTP_PROVIDER=twilio` + the three `TWILIO_*` vars (see §7) so users
   get real SMS codes instead of log lines.
5. Re-run `bun run migrate` (automatic on boot anyway) and `bun run seed`
   against the new DB if it is fresh.

## 7. OTP note (owner-known open decision)

`OTP_PROVIDER=console` prints one-time codes to the server log instead of
sending SMS. Acceptable for the small test beta where the team relays codes to
testers directly from the Render logs. **Twilio is the later fix** (before any
public launch): set `OTP_PROVIDER=twilio` plus `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`. No code change required —
the provider switch is already wired (`src/env.ts` asserts the Twilio vars at
boot when selected).
