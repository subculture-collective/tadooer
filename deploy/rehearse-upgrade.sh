#!/usr/bin/env bash
# The node -e snippets use JavaScript template literals, not shell expansion.
# shellcheck disable=SC2016
# Upgrade and rollback rehearsal on disposable data (#37): current binary ->
# backup -> candidate upgrade -> restore backup -> current binary again.
# Prints counts and statuses only; the generated password stays in a 0600
# file under a 0700 temporary directory that is removed on exit.
# Usage: deploy/rehearse-upgrade.sh <current-image> <candidate-image> [port]
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <current-image> <candidate-image> [port]" >&2
  exit 2
fi
old="$1"
new="$2"
port="${3:-18991}"
origin="http://127.0.0.1:${port}"
work="$(mktemp -d /tmp/rehearse-upgrade.XXXXXX)"
chmod 700 "$work"
data="$work/data"
mkdir -m 700 "$data"
secret="$work/password"
(umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=' >"$secret")
name="rehearse-upgrade-${port}"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf -- "$work"; }
trap cleanup EXIT

run() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --read-only --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp:size=16m,mode=1777 \
    -v "$data:/data" -p "127.0.0.1:${port}:8080" \
    -e SUITE_CREDENTIAL_KEY_PATH=/data/credential.key \
    -e BAIKAL_ENDPOINT=http://127.0.0.1:9/dav.php/ \
    -e SUITE_PUBLIC_ORIGIN="$origin" "$1" >/dev/null
  for _ in $(seq 1 60); do
    if curl -fs "$origin/api/ready" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "not ready: $1" >&2
  docker logs --tail 20 "$name" >&2
  return 1
}
state() {
  local build ready
  build="$(curl -fs "$origin/api/build")"
  ready="$(curl -fs "$origin/api/ready")"
  node -e 'const b=JSON.parse(process.argv[1]),r=JSON.parse(process.argv[2]);console.log(`${process.argv[3]}: revision=${String(b.revision).slice(0,7)} version=${b.version} ready=${r.status} migrations=${r.migrationCount}`)' "$build" "$ready" "$1"
}
login() {
  local jar="$work/cookies"
  rm -f "$jar"
  curl -fs -c "$jar" -H "Origin: $origin" -H 'Content-Type: application/json' \
    -d "{\"username\":\"rehearsal\",\"password\":\"$(cat "$secret")\"}" \
    "$origin/api/auth/login" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).csrfToken))'
}
tasks() {
  curl -fs -b "$work/cookies" "$origin/api/tasks" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);const t=b.tasks??b;console.log(`${process.argv[1]}: tasks=${t.length} rehearsalTask=${t.some(x=>x.title==="Rehearsal task")}`)})' "$1"
}

run "$old"
state "1 production binary, empty volume"
curl -fs -o /dev/null -H "Origin: $origin" -H 'Content-Type: application/json' \
  -d "{\"username\":\"rehearsal\",\"displayName\":\"Rehearsal\",\"password\":\"$(cat "$secret")\"}" \
  "$origin/api/setup"
csrf="$(login)"
curl -fs -o /dev/null -b "$work/cookies" -H "Origin: $origin" -H "X-CSRF-Token: $csrf" -H "Idempotency-Key: rehearsal-task-0001" \
  -H 'Content-Type: application/json' -d '{"title":"Rehearsal task"}' "$origin/api/tasks"
tasks "1 production binary after seed"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker exec "$name" node /app/server/cli.mjs backup "/data/backups/suite-${stamp}.sqlite" >/dev/null
docker exec "$name" sh -eu -c 'cp /data/credential.key "/data/backups/$1"; chmod 600 "/data/backups/$1"' sh "suite-${stamp}.key"
sha256sum "$data/backups/suite-${stamp}.sqlite" "$data/backups/suite-${stamp}.key" | awk '{print "2 backup set: " substr($1,1,12) " " $2}' | sed "s|$data/||"

run "$new"
state "3 candidate on the migrated volume"
login >/dev/null
tasks "3 candidate after upgrade"
docker restart "$name" >/dev/null
for _ in $(seq 1 60); do curl -fs "$origin/api/ready" >/dev/null 2>&1 && break; sleep 1; done
state "3 candidate after restart"

docker rm -f "$name" >/dev/null
set +e
docker run -d --name "$name" --read-only --user 1000:1000 --tmpfs /tmp:size=16m,mode=1777 \
  -v "$data:/data" -p "127.0.0.1:${port}:8080" \
  -e SUITE_CREDENTIAL_KEY_PATH=/data/credential.key -e BAIKAL_ENDPOINT=http://127.0.0.1:9/dav.php/ \
  -e SUITE_PUBLIC_ORIGIN="$origin" "$old" >/dev/null
sleep 8
ready="$(curl -s "$origin/api/ready")"
running="$(docker inspect --format '{{.State.Running}}' "$name")"
echo "4 production binary on the candidate database without restore: running=${running} ready=$(node -e 'try{const r=JSON.parse(process.argv[1]);console.log(r.status+"/"+(r.checks?.migrations??"?"))}catch{console.log("no-response")}' "$ready")"
set -e
docker rm -f "$name" >/dev/null

cp "$data/backups/suite-${stamp}.sqlite" "$data/suite.sqlite"
cp "$data/backups/suite-${stamp}.key" "$data/credential.key"
chmod 600 "$data/credential.key"
rm -f "$data/suite.sqlite-shm" "$data/suite.sqlite-wal"
run "$old"
state "5 production binary after restoring the backup set"
login >/dev/null
tasks "5 production binary after restore"
echo "rehearsal complete"
