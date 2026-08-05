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

docker compose stop suite
docker compose run --rm --no-deps --entrypoint sh suite -eu -c '
  backup_path="/data/backups/$1"
  test -f "$backup_path"
  if [ -f /data/suite.sqlite ]; then
    cp /data/suite.sqlite "/data/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  fi
  cp "$backup_path" /data/suite.sqlite
  rm -f /data/suite.sqlite-shm /data/suite.sqlite-wal
' sh "$backup_name"
docker compose up -d --wait suite
echo "Restored $backup_name and retained a pre-restore copy in /data/backups"
