# Runbook — Database Backup & Restore (H-3)

How NexCare's production PostgreSQL is backed up offsite, and the exact, tested
procedure for proving a backup restores. Patient data is involved, so this is
operated under the Kenya Data Protection Act, 2019 (see `COMPLIANCE.md`).

Full design and secret list: [`README-backup-setup.md`](../../README-backup-setup.md).

---

## What runs, and where

| Concern | Value |
|---|---|
| Schedule | Nightly **02:00 UTC** (GitHub Actions `cron: "0 2 * * *"`) + manual `workflow_dispatch` |
| Job | [`.github/workflows/backup.yml`](../../.github/workflows/backup.yml) |
| Dump | `pg_dump -Fc` (custom format) from production `DATABASE_URL`, PostgreSQL 18 client |
| Encryption | `gpg --symmetric --cipher-algo AES256`; passphrase via file descriptor, never logged |
| Offsite store | Cloudflare **R2** bucket `nexcare-backups` (S3-compatible) |
| Naming | `nexcare-<YYYYMMDDTHHMMSSZ>.dump.gpg` |
| Retention | **30-day R2 lifecycle rule** (objects auto-expire after 30 days) |
| Restore proof | [`scripts/restore-drill.sh`](../../scripts/restore-drill.sh) |

> Railway native backups / PITR are **Pro-plan only** and are **not** used. Our
> recovery path is the offsite encrypted dump above, which is plan-independent and
> stored outside the Railway account.

The unencrypted dump is deleted after upload and is **never** uploaded to R2.
Without `BACKUP_PASSPHRASE` the backups are unrecoverable by design — keep it
stored safely and separately from the repo.

---

## ⚠️ Destructive-restore warning

**Never run a restore against the production `DATABASE_URL`.**
`pg_restore --clean` **drops and recreates** objects — pointing it at production
**destroys live patient data**.

`scripts/restore-drill.sh` restores **only** into `SCRATCH_DATABASE_URL` and
**refuses to run** if `SCRATCH_DATABASE_URL` equals `DATABASE_URL`. Always drill
against the throwaway scratch database below — never production.

---

## Restore drill (the tested procedure)

Run this periodically to prove a real backup restores cleanly and to record the
RTO (recovery time objective). Every command is copy-paste runnable.

### 1. Start a scratch PostgreSQL 18 on port 5433

Match the production major version (18) so `pg_restore` loads cleanly.

```bash
docker run -d --name nexcare-scratch \
  -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_DB=nexcare_scratch \
  -p 5433:5432 \
  postgres:18
```

### 2. Download the latest encrypted backup from R2

Credentials come from the `r2-backup` AWS CLI profile; the R2 S3 endpoint is
supplied via `R2_ENDPOINT`.

```bash
export R2_ENDPOINT='<your Cloudflare R2 S3 API endpoint URL>'

# List backups (newest sorts last) and copy the most recent .gpg locally:
aws s3 ls s3://nexcare-backups/ --profile r2-backup --endpoint-url "$R2_ENDPOINT"

LATEST=$(aws s3 ls s3://nexcare-backups/ --profile r2-backup --endpoint-url "$R2_ENDPOINT" \
  | awk '{print $NF}' | grep '\.gpg$' | sort | tail -n 1)

aws s3 cp "s3://nexcare-backups/$LATEST" "$LATEST" \
  --profile r2-backup --endpoint-url "$R2_ENDPOINT"
```

> Shortcut: `scripts/pull-local-copy.sh` pulls that same latest `.gpg` into a
> private local folder if you just want an offline copy (it never decrypts).

### 3. Run the restore drill into the scratch DB

```bash
export BACKUP_PASSPHRASE='<the same passphrase used for backups>'
export SCRATCH_DATABASE_URL='postgres://postgres:scratch@localhost:5433/nexcare_scratch'

./scripts/restore-drill.sh "$LATEST"
```

The script decrypts to a `umask 077` temp file (deleted on exit, even on
failure), restores with `pg_restore --no-owner --clean --if-exists`, prints the
**RTO in seconds**, and prints row counts for `patients`, `appointments`, and
`users` as a sanity check.

### 4. Record the RTO

Note the printed `RTO: <n>s` in your operational log.

- **Most recent measured RTO: ~0s** (the current production DB is near-empty —
  early in go-live, so the restore completes almost instantly). Re-measure as the
  dataset grows; this number is the metric that matters under real recovery.

### 5. Tear down (no stray patient-data copies)

KDPA data-minimisation — remove the scratch DB and any local dump when done.

```bash
docker rm -f nexcare-scratch
rm -f "$LATEST"
```

---

## Real incident — recovering production

If production data is lost or corrupted, **do not** restore over the live DB.
Recover into a fresh database, verify it, then cut over:

1. Provision a **new, empty** Postgres 18 database (new Railway Postgres service
   or a fresh instance). Do **not** reuse the damaged one as the restore target.
2. Set `SCRATCH_DATABASE_URL` to the **new** database's connection string and run
   `scripts/restore-drill.sh <latest .gpg>` against it (it still refuses to touch
   `DATABASE_URL`).
3. Verify row counts and `_prisma_migrations` history are intact.
4. Repoint the app's `DATABASE_URL` to the verified database and redeploy.
5. Retire the damaged database only after the new one is confirmed serving.

Retention and data-handling obligations: see `COMPLIANCE.md` (KDPA).
