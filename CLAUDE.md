# CLAUDE.md — NexCare API project conventions for Claude Code

This file is read automatically by Claude Code on every session in this repo. It encodes the working conventions for the NexCare API so you (Claude Code) do not need to be re-briefed each time.

---

## 1. Project identity

- **Product:** NexCare API — the backend HIMS/EHR platform that powers Elara Healthcare's clinical operations.
- **Public brand:** Elara Healthcare. Patient-visible copy and user-facing error responses use **Elara Healthcare** wording. Internal logs, code comments, engineering docs, and the platform name itself use **NexCare**.
- **Operator (data controller):** Elara Healthcare, a Kenyan clinic chain operated by Kibet.
- **Owner / lead clinician:** Kibet (`Kibet-JC`), a registered and licensed Clinical Officer in Kenya with established hospital partners.
- **Status:** Active commercial development. Modules go live progressively as they pass per-module readiness gates defined in `COMPLIANCE.md` §12.
- **Not:** an educational demo, a portfolio toy, a research project, or a synthetic-data sandbox.

---

## 2. Framing rules (non-negotiable)

Do **not** add or suggest any of the following anywhere in this repo — code comments, README copy, error responses, log messages, commit messages, PR descriptions, issue replies:

- "Educational project" / "for educational purposes only"
- "Not for clinical use" / "not a medical device"
- "Demo only" / "synthetic data only" / "no real patient data"
- A `DISCLAIMER.md` file
- Any caveat that frames NexCare or Elara Healthcare as anything less than a real clinical product

Use **production compliance framing** instead:

- Reference `COMPLIANCE.md`, `PRIVACY.md`, `SECURITY.md` (present in repo root).
- Reference Kenya Data Protection Act, 2019 and the Office of the Data Protection Commissioner (ODPC) where relevant.
- Reference Health Act, 2017 and Clinical Officers Council standards where relevant.
- For data safety, reference the per-module **go-live readiness gates** in `COMPLIANCE.md` §12.

---

## 3. Repository conventions

### 3.1 Branch naming

`<type>/<issue-number>-<short-slug>` — e.g., `feature/5-patient-model`, `chore/1-initialize-repo`.

Types: `feature/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`, `perf/`, `security/`.

### 3.2 Commit messages (Conventional Commits)

`<type>(<scope>): <subject in imperative mood, lowercase, no period>`

Scopes for this repo: `api`, `db`, `auth`, `audit`, `consent`, `config`, `ci`, `deploy`, `test`, `repo`, `docs`.

Body explains **why**, not what. Reference the issue: `Closes #N`.

### 3.3 PR workflow

One issue → one branch → one PR → one merge. If a PR grows past ~300 lines of code or touches more than one architectural concern, split it. Read every diff before merging.

### 3.4 Files Claude Code must NOT modify without explicit instruction

- `COMPLIANCE.md`, `PRIVACY.md`, `SECURITY.md`, `LICENSE` — specific legal and clinical phrasing; link to them but never paraphrase.
- `prisma/migrations/*` — committed migrations are immutable history. If a migration needs to change, write a **new** migration that supersedes it; never edit prior migration SQL.
- `.github/workflows/*` — CI/CD changes require explicit review.
- `.env` and `.env.*` (production secrets).

---

## 4. Engineering baseline

### 4.1 General

- Server-side validation on every external boundary (HTTP body, query, params, headers). Never trust the client.
- Parameterized queries via Prisma only — no raw SQL with user input.
- Secrets via environment variables; `.env` is in `.gitignore` from commit #1. Production secrets in Railway env, never in source.
- All patient data accesses by authenticated users are logged to the `AuditLog` table via middleware. No exceptions.
- No `console.log` in production code paths — use the `pino` logger.
- Never log: passwords, raw tokens, full patient records, national IDs, or any field marked PII in the data model. Log identifiers only (e.g., `patientId`).

### 4.2 This repo specifically (`nexcare-api`)

**Stack** (locked — see Phase 2 memory):
- Node.js 20 LTS
- TypeScript (strict mode); `tsx` for dev, `tsc` for build
- Express 5 with `helmet`, `cors`, `cookie-parser`, `express-rate-limit`
- Prisma + PostgreSQL 18 (Railway production runs 18.x; Postgres via Docker locally — match the major version)
- Zod for all input + env validation
- Vitest + Supertest for tests (integration tests against a real Postgres test database — **no mocks**)
- argon2id for password hashing
- Auth: HttpOnly Secure SameSite=Lax refresh-token cookie (7d, rotated) + 15-minute JWT access token (HS256)
- pino for structured JSON logging
- Errors: RFC 7807 Problem Details JSON; no stack traces in responses

**Conventions:**
- Dates as Postgres `TIMESTAMPTZ`; clinical dates always carry timezone.
- Phone numbers stored as E.164 strings (e.g., `+254712345678`).
- Soft-delete via `deletedAt` on `Patient` and `Appointment` only. `AuditLog` and `ConsentRecord` are never deleted.
- Database transactions for any operation that writes to multiple tables (e.g., booking writes `Appointment` + `ConsentRecord` + `AuditLog`).
- API versioned at `/api/v1/...`.
- JSON in camelCase. FHIR mapping happens at integration boundaries, not in the public API.

**Prisma model names vs. raw SQL table names (`@@map`):**

This repo uses Prisma `@@map`, so model names and database table names differ. Respect the split:

- In Prisma schema and TypeScript code, use the **model** names: `User`, `Patient`, `Appointment`, `AuditLog`, `RefreshToken`.
- In raw `psql`, use the **mapped** table names — lowercase, plural, unquoted: `users`, `patients`, `appointments`, `audit_logs`, `refresh_tokens`.
- Column names keep their camelCase form and **do** need double quotes in `psql`, e.g. `"passwordHash"`, `"tokenHash"`, `"entityId"`.
- Never write raw `psql` like `FROM "User"` or `FROM "AuditLog"` — those quoted PascalCase names do not exist. If a query errors with `relation ... does not exist`, run `\dt` to list the real tables, then query the correct name.
- When adding the `RefreshToken` model (#11), map it with `@@map("refresh_tokens")` to keep this convention.

**Commands to prefer:**
- `tsx watch src/index.ts` — dev server
- `pnpm test` — Vitest
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint
- `npx prisma migrate dev --name <name>` — local migrations
- `npx prisma migrate deploy` — production migration
- `npx prisma studio` — DB inspector (dev only)

**Commands denied via `.claude/settings.json`:**
- `prisma migrate reset` (destroys data)
- `prisma db push --force-reset`
- `prisma db push` without `--accept-data-loss=false` confirmation

### 4.3 Quality bars

- Test coverage ≥ 80% on business logic (handlers, services, validators).
- `tsc --noEmit` passes with `strict: true`.
- ESLint clean; no warnings allowed in CI.
- No new package added without a one-line justification in the PR.
- Every endpoint that mutates writes an `AuditLog` entry.

---

## 5. How to work with Kibet

- He is a Clinical Officer learning full-stack engineering through real production work. Explain new concepts briefly when you introduce them, but do not over-teach.
- He prefers direct, execution-focused responses with tables, checklists, and code blocks. No motivational essays.
- He runs the **Task → Context → Reference → Evaluate → Iterate** prompt structure. Match it.
- He reviews every diff. Keep PRs small and the **why** explicit.
- For any change touching clinical workflow, patient-visible copy, or data retention, propose first and wait for sign-off; do not assume.
- Pushing back on engineering risks (security, data loss, audit gaps, race conditions in concurrent writes) is welcome. Pushing back on clinical scope or claims is not — Kibet is the clinical authority.
- When the right answer to a design question is genuinely "either is fine," say so and let him pick.

---

## 6. Pointers

- Roadmap and module ladder: `~/Documents/Claude/Projects/CodeOps Lab/NEXCARE_90_DAY_ROADMAP.md`
- Compliance and template files: `~/Documents/Claude/Projects/CodeOps Lab/templates/`
- Phase 2 issue bootstrap script: `~/Documents/Claude/Projects/CodeOps Lab/scripts/bootstrap-nexcare-api-issues.sh`
- Locked Phase 2 stack decisions: see Cowork memory `project_phase2_stack.md`
- Brand split (Elara public / NexCare platform): see Cowork memory `project_elara_nexcare_brand.md`

When in doubt, ask Kibet rather than guess. When asking, propose two concrete options and recommend one.
