#!/usr/bin/env bash
# Offsite backup sync (H7): encrypt the newest dump + media tarball and push
# them as release assets to a DEDICATED PRIVATE GitHub repo. Runs from
# backup.sh's offsite hook after every successful local backup.
#
# Threat model: protects against loss of this box (disk death, deletion,
# region loss). Encryption is symmetric (gpg AES256); the passphrase lives in
# ~/backups/.offsite-passphrase (0600) and in deploy/CREDENTIALS-PROD.md
# (never in git) — copy it somewhere OFF this machine too, or the offsite
# copy is unreadable exactly when you need it.
#
# Install: cp deploy/offsite-sync.sh /home/ubuntu/backups/offsite-sync.sh && chmod +x it
set -euo pipefail

BACKUP_DIR="${1:-/home/ubuntu/backups/fixture}"
# The app repo is private; encrypted backups ride its releases under the
# backup-* tag prefix (the gh token cannot create new repos).
REPO="${OFFSITE_REPO:-bankithung/fixture.doxaed}"
PASSFILE="${OFFSITE_PASSFILE:-/home/ubuntu/backups/.offsite-passphrase}"
KEEP_RELEASES="${OFFSITE_KEEP:-14}"

[ -r "$PASSFILE" ] || { echo "offsite: missing $PASSFILE" >&2; exit 1; }

latest_dump="$(ls -1t "$BACKUP_DIR"/fixturedb_*.dump 2>/dev/null | head -1)"
latest_media="$(ls -1t "$BACKUP_DIR"/media_*.tar.gz 2>/dev/null | head -1)"
[ -n "$latest_dump" ] || { echo "offsite: no dump found" >&2; exit 1; }

stamp="$(date -u +%Y-%m-%d_%H%M)"
tag="backup-${stamp}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

enc() {
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file "$PASSFILE" -o "$2" "$1"
}

enc "$latest_dump" "$work/$(basename "$latest_dump").gpg"
[ -n "$latest_media" ] && enc "$latest_media" "$work/$(basename "$latest_media").gpg"

gh release create "$tag" --repo "$REPO" \
  --title "Fixture backup $stamp" \
  --notes "Encrypted nightly backup (db dump + media). Decrypt: gpg -d --passphrase-file .offsite-passphrase <file>.gpg" \
  "$work"/*.gpg

# Offsite rotation: keep the newest N releases.
# Rotation touches ONLY backup-* tags — never the app's real releases.
gh release list --repo "$REPO" --limit 200 --json tagName,createdAt \
  --jq '[.[] | select(.tagName | startswith("backup-"))] | sort_by(.createdAt) | reverse | .['"$KEEP_RELEASES"':] | .[].tagName' |
while read -r old; do
  [ -n "$old" ] && gh release delete "$old" --repo "$REPO" --yes --cleanup-tag
done

echo "offsite: pushed $tag to $REPO"
