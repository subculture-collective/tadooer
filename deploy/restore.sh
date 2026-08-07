#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 suite-YYYYMMDDTHHMMSSZ.sqlite" >&2
  exit 2
fi

backup_name="$1"
case "$backup_name" in
  suite-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite) ;;
  *)
    echo "Backup name is not a Suite backup basename: $backup_name" >&2
    exit 2
    ;;
esac
key_name="${backup_name%.sqlite}.key"
google_name="${backup_name%.sqlite}.google-oauth.json"

docker compose stop suite
docker compose run --rm --no-deps --entrypoint sh suite -eu -c '
  backup_path="/data/backups/$1"
  key_path="/data/backups/$2"
  test -f "$backup_path"
  test -f "$key_path"
  if [ -f /data/suite.sqlite ]; then
    cp /data/suite.sqlite "/data/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  fi
  if [ -f /data/credential.key ]; then
    cp /data/credential.key "/data/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).key"
  fi
  if [ -f /data/google-oauth.json ]; then
    cp /data/google-oauth.json "/data/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).google-oauth.json"
  fi
  cp "$backup_path" /data/suite.sqlite
  cp "$key_path" /data/credential.key
  chmod 600 /data/credential.key
  google_path="/data/backups/$3"
  if [ -f "$google_path" ]; then
    cp "$google_path" /data/google-oauth.json
    chmod 600 /data/google-oauth.json
  fi
  rm -f /data/suite.sqlite-shm /data/suite.sqlite-wal
' sh "$backup_name" "$key_name" "$google_name"
docker compose up -d --wait suite
echo "Restored $backup_name with its credential key and optional Google OAuth configuration; retained pre-restore copies in /data/backups"
