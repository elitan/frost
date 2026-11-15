#!/bin/bash
# EXPERIMENT: scale-to-zero Postgres (main) behind the resident proxy.
# Uses the real scheduler; set FROST_DATABASE_POLICY_INTERVAL_MS low (the
# managed e2e runner uses 5s). Takes ~5 minutes: idle checks need real minutes.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

log "=== Database scale to zero (proxy) ==="

ACTIVATOR_IMAGE="${FROST_ACTIVATOR_IMAGE:-frost-activator:dev}"
if ! remote "docker image inspect $ACTIVATOR_IMAGE > /dev/null 2>&1"; then
  log "Activator image $ACTIVATOR_IMAGE not present; skipping (build apps/activator first)"
  pass
  exit 0
fi

PROJECT=$(api -X POST "$BASE_URL/api/projects" -d '{"name":"e2e-db-scale-to-zero"}')
PROJECT_ID=$(require_field "$PROJECT" '.id' "create project") || fail "Failed to create project"
SESSIONS=""
cleanup() {
  for s in $SESSIONS; do remote "docker rm -f $s > /dev/null 2>&1" || true; done
  api -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" > /dev/null 2>&1 || true
}
trap cleanup EXIT

DB_CREATE=$(api -X POST "$BASE_URL/api/projects/$PROJECT_ID/databases" -d '{"name":"appdb","engine":"postgres"}')
DB_ID=$(require_field "$DB_CREATE" '.database.id' "create database") || fail "Create database failed: $DB_CREATE"
MAIN_ID=$(require_field "$DB_CREATE" '.target.id' "main target") || fail "No main target"
REF=$(json_get "$DB_CREATE" '.target.providerRefJson')
PGUSER=$(echo "$REF" | jq -r 'if type=="string" then fromjson else . end | .username')
PGPASS=$(echo "$REF" | jq -r 'if type=="string" then fromjson else . end | .password')
PGDB=$(echo "$REF" | jq -r 'if type=="string" then fromjson else . end | .database')
HOST="appdb.frost.internal"

status() {
  json_get "$(api "$BASE_URL/api/databases/$DB_ID/branches/$MAIN_ID/runtime")" '.lifecycleStatus'
}

wait_status() {
  local WANT=$1 TRIES=$2
  for _ in $(seq 1 "$TRIES"); do
    [ "$(status)" = "$WANT" ] && return 0
    sleep 2
  done
  return 1
}

log "Enabling scale to zero on main"
api -X PATCH "$BASE_URL/api/databases/$DB_ID/branches/$MAIN_ID" -d '{"scaleToZeroMinutes":1}' > /dev/null \
  || fail "Enabling scale to zero on main failed"
PROXY="frost-dbproxy-$MAIN_ID"
[ "$(remote "docker inspect -f '{{.State.Running}}' $PROXY 2>/dev/null" || true)" = "true" ] || fail "Proxy not running"
NET=$(remote "docker inspect --format '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' $PROXY" | awk '{print $1}')
[ -n "$NET" ] || fail "Proxy has no network"
log "Proxy $PROXY on $NET"

psql_internal() {
  remote "docker run --rm --network $NET -e PGPASSWORD='$PGPASS' -e PGCONNECT_TIMEOUT=90 postgres:17-alpine psql 'host=$HOST user=$PGUSER dbname=$PGDB sslmode=require' -X -tAc \"$1\""
}

# A long-lived session (like a pooled connection) we can feed statements to.
open_session() {
  local NAME="e2e-dbsession-$(openssl rand -hex 4)"
  SESSIONS="$SESSIONS $NAME"
  remote "docker run -d --name $NAME --network $NET -e PGPASSWORD='$PGPASS' postgres:17-alpine sh -c 'mkfifo /in && (sleep 3600 > /in &) && psql \"host=$HOST user=$PGUSER dbname=$PGDB sslmode=require\" -X -tA < /in > /out 2>&1'" > /dev/null
  echo "$NAME"
}
session_send() { remote "docker exec $1 sh -c 'echo \"$2\" > /in'"; }

log "Test 1: internal TLS connection through the proxy"
[ "$(psql_internal "select ssl from pg_stat_ssl where pid = pg_backend_pid()")" = "t" ] || fail "Internal TLS query failed"
log "Test 1 passed"

log "Test 2: steady short-lived internal connections keep it awake (no idle sessions left)"
for _ in $(seq 1 6); do
  psql_internal "select 1" > /dev/null || fail "Internal query failed"
  sleep 14
done
[ "$(status)" = "active" ] || fail "Slept while used by short-lived internal connections"
log "Test 2 passed"

log "Test 3: an open transaction keeps it awake"
TXN=$(open_session)
session_send "$TXN" "begin; select 'txn-open';"
sleep 80
[ "$(status)" = "active" ] || fail "Slept with a transaction open"
session_send "$TXN" "commit; select 'txn-done';"
sleep 1
remote "docker exec $TXN cat /out" | grep -q "txn-done" || fail "Transaction session broken: $(remote "docker exec $TXN cat /out")"
remote "docker rm -f $TXN > /dev/null"
log "Test 3 passed"

log "Test 4: sleeps under an idle session"
IDLE=$(open_session)
session_send "$IDLE" "select 'warm';"
wait_status stopped 60 || fail "Did not sleep under an idle session (status $(status))"
[ "$(remote "docker inspect -f '{{.State.Running}}' $PROXY")" = "true" ] || fail "Proxy gone after sleep"
log "Test 4 passed"

log "Test 5: an internal connection wakes it"
START=$(date +%s)
[ "$(psql_internal "select 40 + 2")" = "42" ] || fail "Wake through proxy failed"
log "Test 5 passed (cold query $(( $(date +%s) - START ))s)"
[ "$(status)" = "active" ] || fail "Not active after wake"

log "Test 6: disabling scale to zero hands hostnames back to the database"
api -X PATCH "$BASE_URL/api/databases/$DB_ID/branches/$MAIN_ID" -d '{"scaleToZeroMinutes":null}' > /dev/null \
  || fail "Disabling scale to zero failed"
remote "docker inspect $PROXY > /dev/null 2>&1" && fail "Proxy still present"
[ "$(psql_internal "select 'direct'")" = "direct" ] || fail "Direct connection failed"
log "Test 6 passed"

pass
