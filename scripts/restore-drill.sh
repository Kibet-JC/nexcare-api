#!/usr/bin/env bash
#
# restore-drill.sh — decrypt a NexCare backup and restore it into a scratch
# database to verify the backup is usable and to measure the RTO (recovery
# time objective).
#
# This is a DRILL tool. It restores into $SCRATCH_DATABASE_URL — never into
# production. Point SCRATCH_DATABASE_URL at a throwaway database (see
# README-backup-setup.md for a Docker scratch DB on port 5433).
#
# Usage:
#   export BACKUP_PASSPHRASE=...            # same passphrase used to encrypt
#   export SCRATCH_DATABASE_URL=postgres://...:5433/nexcare_scratch
#   ./scripts/restore-drill.sh path/to/nexcare-<timestamp>.dump.gpg
#
# Compliance: the decrypted dump contains patient data. It is written to a
# private temp file (umask 077) and deleted on exit via a trap, even on
# failure. The passphrase is read from the environment and passed to gpg on a
# file descriptor, so it is never echoed or visible in process arguments.

set -euo pipefail

# --- Args & required environment -------------------------------------------

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to-encrypted.dump.gpg>" >&2
  exit 2
fi

ENC="$1"

if [[ ! -f "$ENC" ]]; then
  echo "Error: file not found: $ENC" >&2
  exit 2
fi

: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE in the environment}"
: "${SCRATCH_DATABASE_URL:?Set SCRATCH_DATABASE_URL in the environment}"

# Refuse to ever target the production DATABASE_URL by accident.
if [[ -n "${DATABASE_URL:-}" && "$SCRATCH_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo "Refusing to run: SCRATCH_DATABASE_URL equals DATABASE_URL (production)." >&2
  exit 1
fi

# --- Temp decrypted dump, cleaned up on exit (even on failure) -------------

umask 077
TMP_DUMP="$(mktemp -t nexcare-restore.XXXXXX.dump)"

cleanup() {
  rm -f "$TMP_DUMP"
}
trap cleanup EXIT

# --- Decrypt ---------------------------------------------------------------

echo "Decrypting $ENC ..."
gpg --batch --yes --no-tty \
  --decrypt \
  --passphrase-fd 3 \
  --output "$TMP_DUMP" "$ENC" 3<<<"$BACKUP_PASSPHRASE"

# --- Restore into scratch, timed (this is the RTO) -------------------------

echo "Restoring into scratch database ..."
START="$(date +%s)"

pg_restore --no-owner --clean --if-exists \
  --dbname "$SCRATCH_DATABASE_URL" "$TMP_DUMP"

END="$(date +%s)"
ELAPSED=$(( END - START ))

echo "----------------------------------------"
echo "Restore complete. RTO: ${ELAPSED}s"
echo "----------------------------------------"

# --- Sanity check: row counts ----------------------------------------------
# Table names are the @@map'd lowercase plural names (see CLAUDE.md).
echo "Row counts (sanity check):"
psql "$SCRATCH_DATABASE_URL" --no-psqlrc --tuples-only --no-align <<'SQL'
SELECT 'patients     = ' || count(*) FROM patients;
SELECT 'appointments = ' || count(*) FROM appointments;
SELECT 'users        = ' || count(*) FROM users;
SQL

echo "Restore drill finished OK."
