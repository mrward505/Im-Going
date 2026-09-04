# I'm Going — MVP

Location-based social app: announce where you're going tonight, see who's going where, confirm,
check in by GPS, earn a 1–5★ reputation. **This repo is the MVP build.**

**Status: Slice 1 complete & verified** (scaffold + backend foundation; migration applies, server
boots, health passes, 25 tests green incl. a live smoke run against real Postgres). Pushed to the
owner's GitHub repo `mrward505/Im-Going`. Source of truth: `/home/team/shared/product-spec.md`
(spec §4 data model, §2 flows, §5 star math).

## Stack

| Layer    | Choice |
|----------|--------|
| API      | TypeScript on **Bun** (Node 22 compatible), **Fastify 5**, **zod** validation |
| Database | **PostgreSQL 16** (local cluster via `apt`), `pg` driver, SQL-file migrations |
| Auth     | Phone + 6-digit SMS OTP (JWT HS256 tokens, no external auth dep in slice 1) |
| Client   | `client/` placeholder this slice — iOS SwiftUI app is Slice 4 |

No secrets in code. All configuration is env-var driven (`server/.env`, template
`server/.env.example`). Dev-only values live in the git-ignored `.env`.

## Layout

```
mvp/
  README.md
  scripts/dev-db.sh        # idempotent local Postgres bootstrap (role + db)
  server/                  # REST API (Fastify + pg)
    migrations/*.sql       # schema migrations (applied in order, tracked in schema_migrations)
    src/
      index.ts             # bootstrap: fastify, routes, error handler, shutdown
      env.ts               # env loading (.env w/ portable fallback) + typed Config
      db/pool.ts, migrate.ts
      lib/                 # pure logic: reputation, trending, geofence, otp, tokens, sms, limits, errors
      routes/              # health, auth, spots, events
    test/                  # bun test suites (spec math locked)
  client/                  # iOS app placeholder (Slice 4)
```

## Run it (dev)

Prereqs: **bun ≥ 1.3**, **PostgreSQL 16** (Debian/Ubuntu: `sudo apt-get install -y postgresql postgresql-client`).

```bash
# 1. Bootstrap the dev database (creates role "imgoing" + db "imgoing" if missing, starts the cluster)
bash scripts/dev-db.sh

# 2. Configure
cd server
cp .env.example .env          # fill DATABASE_URL + AUTH_JWT_SECRET (dev defaults are fine locally)

# 3. Install & migrate
bun install
bun run migrate               # applies server/migrations/*.sql

# 4. Boot the API (dev mode, watch)
bun run dev                   # → http://127.0.0.1:8081 (default; see the env table)

# 5. Prove it's alive
curl http://127.0.0.1:8081/health
# → {"status":"ok","service":"imgoing-api","version":"0.1.0","db":"ok",...}
```

Other commands (all from `server/`): `bun test`, `bun run typecheck`, `bun run migrate:status`.

## API smoke test (dev — OTP code prints to the server log)

```bash
B=localhost:8080
# request a code  → response includes dev_code when OTP_PROVIDER=console
curl -s -X POST $B/api/v1/auth/otp/request -H 'content-type: application/json' \
  -d '{"phone":"+16025550123"}'

# verify the printed code → { type: "signup", signup_token } (first time) or login token
curl -s -X POST $B/api/v1/auth/otp/verify -H 'content-type: application/json' \
  -d '{"phone":"+16025550123","code":"123456"}'

# complete signup (server enforces 18+; UNDERAGE rejection otherwise)
curl -s -X POST $B/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"signup_token":"<signup_token>","display_name":"Ethan","username":"ethan_t","dob":"2002-05-14"}'
# → { token, user }

# authenticated calls (Bearer token from register/login)
curl -s $B/api/v1/me -H 'authorization: Bearer <token>'
curl -s -X POST $B/api/v1/spots -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"name":"Ethan house party","address":"1200 E Apache Blvd","lat":33.4122,"lon":-111.9218,"category":"house"}'
curl -s -X POST $B/api/v1/events -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"spot_id":"<spot_id>","start_at":"2026-09-05T21:00:00Z","note":"Same lineup as last week"}'
curl -s -X POST $B/api/v1/events/<event_id>/going -H 'authorization: Bearer <token>'   # confirm
curl -s -X DELETE $B/api/v1/events/<event_id>/going -H 'authorization: Bearer <token>'  # cancel (≥2h = free)
```

## Environment variables (`server/.env`)

| Var | Default (dev) | Purpose |
|-----|---------------|---------|
| `DATABASE_URL` | — (required) | Postgres connection string |
| `PORT` / `HOST` | `8081` / `127.0.0.1` | API listen address (set `HOST=0.0.0.0` for device testing). Port `8080` is reserved on the team dev box by an unrelated local service |
| `LOG_LEVEL` | `info` | pino level |
| `OTP_PROVIDER` | `console` | `console` prints codes to server log; `twilio` uses real SMS (later slice) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` | empty | needed only when `OTP_PROVIDER=twilio` |
| `OTP_TTL_SECONDS` / `OTP_MAX_ATTEMPTS` | `300` / `5` | OTP expiry and attempts |
| `AUTH_JWT_SECRET` | — (required) | HS256 signing secret — **production must be a strong random string** |
| `SESSION_TTL_DAYS` / `SIGNUP_TOKEN_TTL_MINUTES` | `30` / `15` | token lifetimes |
| `STORAGE_PROVIDER` / `STORAGE_BUCKET` / `STORAGE_LOCAL_DIR` | `local` / empty / `./data/uploads` | object storage placeholders (uploads are later slices) |
| `LAUNCH_CITY` | `Tempe` | MVP single city |

## What's stubbed / deferred (end of slice 1)

- **SMS**: `SmsProvider` interface + console provider (prints codes). Twilio stub exists but throws
  until `OTP_PROVIDER=twilio` + real credentials are wired (later slice).
- **Object storage**: no upload endpoints yet; `STORAGE_*` are placeholders.
- **Geofence / check-in**: haversine + radius-resolution lib is implemented and tested; the
  check-in endpoint, event-window logic, passive tracking, and spoofing caps land in Slice 3.
- **Trending feed**: per-user contribution formula is implemented + tested; the SQL feed endpoint
  (top 20, spec §2c) is Slice 3.
- **Reputation settlement**: star math implemented + tested; the no-show settlement cron, ledger
  writes, and `first_checkin` marker are Slice 3. (Until then, cancelling < 2 h before start
  returns `settlement: "soft_no_show"` but does **not** yet write the −30 ledger row.)
- **Venue seed** (~1,000 real Tempe/ASU venues with coords/geofence/category): Slice 2.
- **Multi-announcer event snapping** (same spot+date snap to one event): Slice 3.
- **iOS app**: Slice 4. Moderation queue + analytics: Slice 5. Share rate-limit columns exist on
  `users` (`shares_today`, `shares_date`), enforcement is Slice 3.

## Spec fidelity notes

- Field names match spec §4 exactly. `category`, `reason`, `kind` "enums" are `TEXT` + `CHECK`
  constraints (evolve more easily than Postgres enum types); app-level zod mirrors them.
- **Star derivation**: `star_rating = round1(clamp(1 + points/250, 1, 5))`, displayed to one
  decimal. Spec §5 examples are hand-approximated — by the exact formula 740 pts → **4.0★**
  (spec prose says 3.9★) and 320 pts → 2.3★. The formula is authoritative.
- **New-account cap**: stars capped at 3.0★ until the first verified check-in
  (`effectiveStars()` in `src/lib/reputation.ts`, used by all API projections).
- **CheckIn↔Post is 1–1 max** (`UNIQUE (check_in_id)` on `posts`) per spec §4 relationships.
  If the product wants multiple posts per event-attendance, drop the unique constraint (Slice 3+).
- **Custom-spot privacy**: custom (unverified) spots return `address: null` +
  `masked_address` in search; the exact address **and pin** are returned only to users who have
  confirmed "I'm going" on the event (implements the spec §2b owner rule server-side).
- **Geofence radius**: custom spots → 100 m (server-derived, client can't choose);
  verified POI → stored radius (seed will set 150 m, 400 m for `is_large_venue`).
- `reputation_ledger` is append-only by convention; Slice 3 will add DB-enforced guards.
- `phone_otp_requests` table is auth infrastructure (not a spec entity), supporting §2a OTP flow.

## Slice roadmap

1. ✅ **This slice** — scaffold, schema + migrations, auth stub, libs, boot.
2. Provision serverless Postgres (Neon) or harden local; run migrations; **seed ~1,000 Tempe/ASU venues**.
3. Core API endpoints — announce/event snapping, trending feed, confirm/cancel, check-in +
   geofence window, posts (verified-check-in gate), reputation settlement cron, share limit.
4. iOS app (SwiftUI) per spec §3.
5. Moderation tooling + funnels analytics.