#!/bin/bash
# Services woken by traffic from other services (the activator stand-in).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

log "=== Internal wake (activator) ==="

require_activator_image

service_field() {
  json_get "$(api "$BASE_URL/api/services/$1")" "$2"
}

deploy_and_wait() {
  local SERVICE_ID=$1
  local DEPLOY_ID
  DEPLOY_ID=$(wait_for_service_deployment_id "$SERVICE_ID" 30 1 || true)
  if [ -z "$DEPLOY_ID" ] || [ "$DEPLOY_ID" = "null" ]; then
    DEPLOY_ID=$(require_field "$(api -X POST "$BASE_URL/api/services/$SERVICE_ID/deploy")" '.deploymentId' "deploy") || fail "Deploy failed"
  fi
  wait_for_deployment "$DEPLOY_ID" 90 || fail "Deployment of $SERVICE_ID failed"
}

network_of() {
  local CONTAINER_ID
  CONTAINER_ID=$(service_field "$1" '.latestDeployment.containerId')
  remote "docker inspect --format '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}}{{end}}' $CONTAINER_ID"
}

diagnose() {
  local SERVICE_ID=$1
  local HOST=$2
  echo "--- activator logs ---" >&2
  remote "docker logs frost-activator-$SERVICE_ID 2>&1 | tail -20" >&2 || true
  echo "--- DNS for $HOST ---" >&2
  remote "docker run --rm --network $NET alpine:3 nslookup $HOST 2>&1 | tail -6" >&2 || true
  echo "--- containers ---" >&2
  remote "docker ps -a --filter label=frost.service.id=$SERVICE_ID --format '{{.Names}} {{.Status}}'" >&2 || true
}

sleep_and_expect_activator() {
  local SERVICE_ID=$1
  api -X POST "$BASE_URL/api/services/$SERVICE_ID/sleep" > /dev/null || fail "Sleep failed"
  [ "$(service_field "$SERVICE_ID" '.runtimeStatus')" = "sleeping" ] || fail "Expected sleeping"
  for _ in $(seq 1 20); do
    if [ "$(remote "docker inspect -f '{{.State.Status}}' frost-activator-$SERVICE_ID 2>/dev/null" || true)" = "running" ]; then
      return 0
    fi
    sleep 0.5
  done
  fail "Activator for $SERVICE_ID did not start"
}

PROJECT=$(api -X POST "$BASE_URL/api/projects" -d '{"name":"e2e-internal-wake"}')
PROJECT_ID=$(require_field "$PROJECT" '.id' "create project") || fail "Failed to create project"
trap 'api -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" > /dev/null 2>&1 || true' EXIT
ENV_ID=$(get_default_environment "$PROJECT_ID") || fail "Failed to get environment"

# --- HTTP service with no domain, called by another container ---
WEB_ID=$(require_field "$(api -X POST "$BASE_URL/api/environments/$ENV_ID/services" \
  -d '{"name":"web","deployType":"image","imageUrl":"nginx:alpine","containerPort":80,"drainTimeout":0}')" '.id' "create web") || fail "Create web failed"
deploy_and_wait "$WEB_ID"
WEB_HOST="$(service_field "$WEB_ID" '.hostname').frost.internal"
NET=$(network_of "$WEB_ID")
log "web is $WEB_HOST on $NET"

log "Test 1: internal HTTP request wakes a sleeping service"
sleep_and_expect_activator "$WEB_ID"
RESULT=$(remote "docker run --rm --network $NET curlimages/curl -sS -m 90 -w '\n%{http_code} %{time_total}' http://$WEB_HOST/" 2>&1 || true)
CODE=$(echo "$RESULT" | tail -n1 | cut -d' ' -f1)
if ! echo "$RESULT" | grep -q "Welcome to nginx"; then
  diagnose "$WEB_ID" "$WEB_HOST"
  fail "Unexpected response: $RESULT"
fi
[ "$CODE" = "200" ] || fail "Expected 200, got $CODE"
[ "$(service_field "$WEB_ID" '.runtimeStatus')" = "online" ] || fail "web not online after internal wake"
log "Test 1 passed (cold request took $(echo "$RESULT" | tail -n1 | cut -d' ' -f2)s)"

log "Test 2: 100 concurrent internal requests during a cold start"
sleep_and_expect_activator "$WEB_ID"
CODES=$(remote "docker run --rm --network $NET curlimages/curl sh -c 'seq 100 | xargs -P 100 -I{} curl -s -m 90 -o /dev/null -w \"%{http_code}\n\" http://$WEB_HOST/'")
OK=$(echo "$CODES" | grep -c '^200$' || true)
[ "$OK" = "100" ] || fail "Only $OK/100 concurrent requests succeeded: $(echo "$CODES" | sort | uniq -c | tr '\n' ' ')"
log "Test 2 passed (100/100)"

log "Test 3: activator hands over and exits"
GONE=0
for _ in $(seq 1 60); do
  if ! remote "docker inspect frost-activator-$WEB_ID > /dev/null 2>&1"; then GONE=1; break; fi
  sleep 1
done
[ "$GONE" = "1" ] || fail "Activator still running after 60s"
remote "docker run --rm --network $NET curlimages/curl -sf -m 10 -o /dev/null http://$WEB_HOST/" || fail "web unreachable after activator exit"
log "Test 3 passed"

# --- Postgres as an app service, woken by a psql client ---
log "Test 4: psql connection wakes a sleeping Postgres"
DB_ID=$(require_field "$(api -X POST "$BASE_URL/api/environments/$ENV_ID/services" \
  -d '{"name":"pg","deployType":"image","imageUrl":"postgres:17-alpine","containerPort":5432,"drainTimeout":0,"envVars":[{"key":"POSTGRES_PASSWORD","value":"e2e-pass"}]}')" '.id' "create pg") || fail "Create pg failed"
deploy_and_wait "$DB_ID"
DB_HOST="$(service_field "$DB_ID" '.hostname').frost.internal"
sleep_and_expect_activator "$DB_ID"
ANSWER=$(remote "docker run --rm --network $NET -e PGPASSWORD=e2e-pass -e PGCONNECT_TIMEOUT=90 postgres:17-alpine psql -h $DB_HOST -U postgres -tAc 'select 40 + 2'" 2>&1 || true)
[ "$(echo "$ANSWER" | tr -d '[:space:]')" = "42" ] || fail "psql through activator failed: $ANSWER"
[ "$(service_field "$DB_ID" '.runtimeStatus')" = "online" ] || fail "pg not online after psql wake"
log "Test 4 passed"

pass
