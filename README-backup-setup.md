# NexCare API — Offsite Database Backup & Restore Drill

Automated, encrypted, offsite backups of the production PostgreSQL database,
plus a local restore-drill to prove the backups are recoverable and to measure
the RTO (recovery time objective).

Patient data is involved, so this is operated under the Kenya Data Protection
Act, 2019. Backups are **encrypted at rest** before leaving the runner.

---

## Design

| Concern        | Choice |
|----------------|--------|
| Schedule       | Daily at **02:00 UTC** (GitHub Actions `cron: "0 2 * * *"`) + manual run |
| Dump           | `pg_dump -Fc` (custom format) from the production `DATABASE_URL` |
| Client version | `postgresql-client-16` installed from the official **PGDG** apt repo so `pg_dump` matches the PostgreSQL 16 server |
| Encryption     | `gpg --symmetric --cipher-algo AES256`; passphrase fed via file descriptor, never logged |
| Offsite store  | Cloudflare **R2** bucket `nexcare-backups` (S3-compatible), via the AWS CLI with `--endpoint-url` and `AWS_DEFAULT_REGION=auto` |
| Naming         | `nexcare-<YYYYMMDDTHHMMSSZ>.dump.gpg` |
| Plaintext      | The unencrypted `.dump` is deleted after upload and **never uploaded** |

Workflow file: `.github/workflows/backup.yml`. Each run:

1. Installs the PostgreSQL 16 client from PGDG.
2. Dumps the DB to `nexcare-<timestamp>.dump` (custom format).
3. Encrypts it to `nexcare-<timestamp>.dump.gpg` (AES-256).
4. Uploads **only** the `.gpg` to `s3://nexcare-backups/`.
5. Deletes the local plaintext dump.

Any failing step fails the job (`set -euo pipefail`).

> **Scheduled runs only fire from the default branch.** This workflow must be
> merged to `main` before the nightly schedule will run. You can always trigger
> it early from the Actions tab via **Run workflow** (`workflow_dispatch`).

---

## Required GitHub repository secrets

These must already exist (values not shown here):

| Secret | Purpose |
|--------|---------|
| `DATABASE_URL` | Production Postgres connection string (the dump source) |
| `BACKUP_PASSPHRASE` | Symmetric passphrase for GPG encryption/decryption |
| `R2_ENDPOINT` | Cloudflare R2 S3 API endpoint URL |
| `R2_ACCESS_KEY_ID` | R2 access key (mapped to `AWS_ACCESS_KEY_ID`) |
| `R2_SECRET_ACCESS_KEY` | R2 secret key (mapped to `AWS_SECRET_ACCESS_KEY`) |

Keep `BACKUP_PASSPHRASE` somewhere safe and separate from the repo. **Without
it, the backups are unrecoverable** — there is no recovery path by design.

---

## Restore drill (local)

Run this periodically to confirm a real backup restores cleanly and to record
the RTO. It restores into a **throwaway scratch database**, never production.

### 1. Download an encrypted backup from R2

```bash
aws s3 ls s3://nexcare-backups/ --endpoint-url "$R2_ENDPOINT"
aws s3 cp s3://nexcare-backups/nexcare-<timestamp>.dump.gpg . \
  --endpoint-url "$R2_ENDPOINT"
```

### 2. Start a scratch Postgres 16 on port 5433

```bash
docker run -d --name nexcare-scratch \
  -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_DB=nexcare_scratch \
  -p 5433:5432 \
  postgres:16
```

### 3. Export the required vars

```bash
export BACKUP_PASSPHRASE='<the same passphrase used for backups>'
export SCRATCH_DATABASE_URL='postgres://postgres:scratch@localhost:5433/nexcare_scratch'
```

### 4. Run the drill

```bash
./scripts/restore-drill.sh nexcare-<timestamp>.dump.gpg
```

The script decrypts to a private temp file, restores with
`pg_restore --no-owner --clean --if-exists`, prints the **RTO in seconds**, and
prints row counts for `patients`, `appointments`, and `users` as a sanity
check. The decrypted temp file is deleted on exit (even on failure).

### 5. Record the RTO

Note the printed `RTO: <n>s` value in your operational log / restore-drill
record. This is your evidence that the backup is recoverable and how long it
takes.

### 6. Tear down

```bash
docker rm -f nexcare-scratch
```

---

## Security notes

- The passphrase is never echoed and never passed as a visible CLI argument —
  it is fed to GPG over a file descriptor in both the workflow and the script.
- The unencrypted dump is deleted after upload and is never uploaded to R2.
- The decrypted dump during a drill lives only in a `umask 077` temp file that
  is removed by a `trap` on exit.

---

## Next steps (not yet built)

- **R2 lifecycle rule** to auto-delete backups older than 30 days.
- A **"pull a local encrypted copy"** companion script for quick offline copies.
- A **monthly automated restore-drill** workflow that restores into a scratch
  DB in CI and asserts the row counts are non-zero.
