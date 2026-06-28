#!/usr/bin/env bash
#
# pull-local-copy.sh — download the most recent ENCRYPTED NexCare backup from
# Cloudflare R2 to a local folder, keeping it encrypted.
#
# This is a convenience tool for keeping a quick offline copy of the latest
# offsite backup. It NEVER decrypts: the local copy stays as a `.dump.gpg`
# ciphertext blob, useless without BACKUP_PASSPHRASE. To actually restore,
# use scripts/restore-drill.sh (see README-backup-setup.md).
#
# Usage:
#   export R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
#   # optional: override the destination folder (default ~/nexcare-backups-local)
#   export LOCAL_BACKUP_DIR="$HOME/nexcare-backups-local"
#   ./scripts/pull-local-copy.sh
#
# Compliance: the local copy is encrypted at rest (AES-256 via GPG) and is
# written into a private (chmod 700) directory. Copies older than 30 days are
# pruned on each run. R2 credentials come from the "r2-backup" AWS profile and
# are never printed.

set -euo pipefail

# --- Configuration ----------------------------------------------------------

BUCKET="nexcare-backups"
AWS_PROFILE_NAME="r2-backup"
RETENTION_DAYS=30
DEST_DIR="${LOCAL_BACKUP_DIR:-$HOME/nexcare-backups-local}"

: "${R2_ENDPOINT:?Set R2_ENDPOINT (the Cloudflare R2 S3 API endpoint URL) in the environment}"

# R2 is region-agnostic; the AWS CLI still wants a region set.
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

# --- Private destination folder --------------------------------------------

mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"

# --- Find the latest encrypted backup in R2 --------------------------------
# Backups are named nexcare-<YYYYMMDDTHHMMSSZ>.dump.gpg, so the lexically last
# .gpg key is also the most recent. `aws s3 ls` sorts ascending by key.

echo "Listing s3://$BUCKET/ ..."
LATEST_KEY="$(
  aws s3 ls "s3://$BUCKET/" \
    --profile "$AWS_PROFILE_NAME" \
    --endpoint-url "$R2_ENDPOINT" \
  | awk '{ print $NF }' \
  | grep '\.gpg$' \
  | sort \
  | tail -n 1
)"

if [[ -z "$LATEST_KEY" ]]; then
  echo "Error: no .gpg backups found in s3://$BUCKET/" >&2
  exit 1
fi

# --- Download ONLY that object (still encrypted) ---------------------------

DEST_FILE="$DEST_DIR/$LATEST_KEY"
echo "Pulling $LATEST_KEY ..."
aws s3 cp "s3://$BUCKET/$LATEST_KEY" "$DEST_FILE" \
  --profile "$AWS_PROFILE_NAME" \
  --endpoint-url "$R2_ENDPOINT"

# Keep the local copy private too.
chmod 600 "$DEST_FILE"

# --- Retention: prune local copies older than RETENTION_DAYS ----------------
# Only ever touches *.dump.gpg files in DEST_DIR; nothing is decrypted.

find "$DEST_DIR" -maxdepth 1 -type f -name '*.dump.gpg' \
  -mtime +"$RETENTION_DAYS" -print -delete \
  | sed 's/^/Pruned (older than '"$RETENTION_DAYS"' days): /' || true

# --- Report ----------------------------------------------------------------

COPY_COUNT="$(find "$DEST_DIR" -maxdepth 1 -type f -name '*.dump.gpg' | wc -l | tr -d ' ')"

echo "----------------------------------------"
echo "Pulled:       $LATEST_KEY"
echo "Destination:  $DEST_FILE"
echo "Local copies: $COPY_COUNT (encrypted, in $DEST_DIR)"
echo "----------------------------------------"
echo "Done. The local copy stays encrypted; use scripts/restore-drill.sh to restore."
