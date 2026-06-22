# NexCare API

> **Live API:** https://nexcare-api-production.up.railway.app

Backend HMIS/EHR platform powering Elara Healthcare's clinical operations.

**Stack:** Node.js 20 LTS · TypeScript (strict, ESM/NodeNext) · Express 5 ·
Prisma + PostgreSQL 16 · Zod · Vitest + Supertest · argon2id · pino. See
`CLAUDE.md` for the full engineering baseline and conventions.

## Local development

```bash
cp .env.example .env          # fill DATABASE_URL + JWT_ACCESS_SECRET
docker compose up -d          # PostgreSQL 16
pnpm install
pnpm prisma migrate dev       # apply migrations
pnpm db:seed                  # synthetic dev data (refuses in production)
pnpm dev                      # tsx watch on http://localhost:3000
```

Health probe: `GET /api/v1/health` → `{ "status": "ok", ... }`.

## Quality gates

```bash
pnpm lint        # ESLint (no warnings allowed)
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # Vitest + Supertest against a real Postgres test DB
pnpm build       # prisma generate + tsc -p tsconfig.build.json -> dist/
```

## Deployment (Railway)

The service deploys to Railway from the `Dockerfile` (multi-stage,
`node:20-slim` so Prisma's OpenSSL-dependent engine loads cleanly). Railway
config lives in `railway.json`:

- **build:** `DOCKERFILE`
- **preDeployCommand:** `pnpm prisma migrate deploy` — applies committed
  migrations against the production database *before* the new version serves.
- **healthcheckPath:** `/api/v1/health`
- **restartPolicyType:** `ON_FAILURE`

### Required environment variables (set in the Railway service)

| Variable            | Value                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `NODE_ENV`          | `production`                                                      |
| `JWT_ACCESS_SECRET` | a long random secret — generate with `openssl rand -base64 48`     |
| `DATABASE_URL`      | reference the Railway Postgres service (e.g. `${{ Postgres.DATABASE_URL }}`) |
| `PORT`              | **auto-injected by Railway** — do not set it manually             |

Env is validated at boot by `src/config/env.ts` (Zod); a missing or malformed
value fails the process on startup rather than at first request.

### Deploy

Push to the deploy branch (or `railway up`). On each deploy Railway:

1. builds the image from `Dockerfile`,
2. runs the preDeploy migration: `pnpm prisma migrate deploy`,
3. starts the container (`node dist/index.js`),
4. waits for `GET /api/v1/health` to return 200 before routing traffic.

### Bootstrap the first admin (one-off)

The dev seed refuses to run in production, so the first production admin is
created with the dedicated, idempotent one-off script. Set `ADMIN_EMAIL` and
`ADMIN_PASSWORD` (the password must satisfy the policy: ≥12 chars with lower,
upper, digit, and symbol) on the service, then run once:

```bash
pnpm create-admin:prod
```

Run it from the Railway service shell, or as a one-off command on the service.
It creates a single `ADMIN` user via the user service (argon2id + password
policy) and exits cleanly if that email already exists, so re-running it is a
safe no-op. `ADMIN_EMAIL` / `ADMIN_PASSWORD` are used **only** by this script.

### Smoke test

After a deploy, confirm the service is live:

```bash
scripts/smoke-test.sh https://<your-service>.up.railway.app
```

It curls `/api/v1/health`, asserts HTTP 200 and a JSON `status` of `"ok"`, and
exits non-zero otherwise.
