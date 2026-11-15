#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# The wake server listens on the Frost host's loopback; Caddy routes a
# sleeping service's domains there with the wake header. These tests call it
# the same way Caddy does.
WAKE_PORT="${FROST_WAKE_PORT:-3090}"

log "=== Scale to zero ==="

wake_curl() {
  local SERVICE=$1
  local URL_PATH=${2:-/}
  remote "curl -s --max-time 90 -o /dev/stdout -w '\n%{http_code}' -H 'Host: stz.example.test' -H 'X-Frost-Wake-Service: $SERVICE' 'http://127.0.0.1:$WAKE_PORT$URL_PATH'"
}

container_state() {
  remote "docker inspect --format '{{.State.Status}}' $1 2>/dev/null || echo missing" | tr -d '[:space:]'
}

service_field() {
  local RESPONSE
  RESPONSE=$(api "$BASE_URL/api/services/$SERVICE_ID")
  json_get "$RESPONSE" "$1"
}

wait_for_runtime_status() {
  local EXPECTED=$1
  local MAX=${2:-30}
  local STATUS=""
  for _ in $(seq 1 "$MAX"); do
    STATUS=$(service_field '.runtimeStatus')
    if [ "$STATUS" = "$EXPECTED" ]; then
      return 0
    fi
    sleep 2
  done
  echo "  runtimeStatus stayed '$STATUS', expected '$EXPECTED'" >&2
  return 1
}

PROJECT=$(api -X POST "$BASE_URL/api/projects" -d '{"name":"e2e-scale-to-zero"}')
PROJECT_ID=$(require_field "$PROJECT" '.id' "create project") || fail "Failed to create project: $PROJECT"
trap 'api -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" > /dev/null 2>&1 || true' EXIT
ENV_ID=$(get_default_environment "$PROJECT_ID") || fail "Failed to get environment"

SERVICE=$(api -X POST "$BASE_URL/api/environments/$ENV_ID/services" \
  -d '{"name":"stz","deployType":"image","imageUrl":"nginx:alpine","containerPort":80,"drainTimeout":0}')
SERVICE_ID=$(require_field "$SERVICE" '.id' "create service") || fail "Failed to create service: $SERVICE"

DEPLOY_ID=$(wait_for_service_deployment_id "$SERVICE_ID" 30 1 || true)
if [ -n "$DEPLOY_ID" ] && [ "$DEPLOY_ID" != "null" ]; then
  wait_for_deployment "$DEPLOY_ID" || fail "Initial deployment failed"
fi

# --- Test 1: setting is validated, saved and captured by the next deploy ---
log "Test 1: enable scale to zero"
BAD=$(E2E_FAIL_ON_5XX=0 api -X PATCH "$BASE_URL/api/services/$SERVICE_ID" -d '{"scaleToZeroMinutes":0}' 2>/dev/null || true)
[ "$(json_get "$BAD" '.scaleToZeroMinutes // empty')" = "" ] || fail "scaleToZeroMinutes=0 should be rejected: $BAD"

UPDATED=$(api -X PATCH "$BASE_URL/api/services/$SERVICE_ID" -d '{"scaleToZeroMinutes":1}')
[ "$(json_get "$UPDATED" '.scaleToZeroMinutes')" = "1" ] || fail "scaleToZeroMinutes not saved: $UPDATED"

DEPLOY=$(api -X POST "$BASE_URL/api/services/$SERVICE_ID/deploy")
DEPLOY_ID=$(require_field "$DEPLOY" '.deploymentId' "deploy") || fail "Deploy failed: $DEPLOY"
wait_for_deployment "$DEPLOY_ID" || fail "Deployment with scale to zero failed"
DEPLOYMENT=$(api "$BASE_URL/api/deployments/$DEPLOY_ID")
[ "$(json_get "$DEPLOYMENT" '.scaleToZeroMinutes')" = "1" ] || fail "Deployment did not capture scaleToZeroMinutes: $DEPLOYMENT"
[ "$(service_field '.runtimeStatus')" = "online" ] || fail "Expected online after deploy"

REPLICAS=$(api "$BASE_URL/api/deployments/$DEPLOY_ID/replicas")
CONTAINER_ID=$(json_get "$REPLICAS" '.[0].containerId')
HOST_PORT=$(json_get "$REPLICAS" '.[0].hostPort')
[ -n "$CONTAINER_ID" ] && [ "$CONTAINER_ID" != "null" ] || fail "No replica container"
log "Test 1 passed (container ${CONTAINER_ID:0:12}, port $HOST_PORT)"

# --- Test 2: manual sleep stops (but keeps) the container ---
log "Test 2: sleep on demand"
api -X POST "$BASE_URL/api/services/$SERVICE_ID/sleep" > /dev/null || fail "Sleep request failed"
[ "$(service_field '.runtimeStatus')" = "sleeping" ] || fail "Expected sleeping after /sleep"
[ "$(service_field '.sleepingSince')" != "null" ] || fail "sleepingSince not set"
STATE=$(container_state "$CONTAINER_ID")
[ "$STATE" = "exited" ] || fail "Expected stopped container, got '$STATE'"
log "Test 2 passed"

# --- Test 3: the deployment reconciler leaves a sleeping service alone ---
log "Test 3: reconciler keeps the sleeping deployment"
sleep 20
[ "$(json_get "$(api "$BASE_URL/api/deployments/$DEPLOY_ID")" '.status')" = "running" ] || fail "Reconciler marked the sleeping deployment stopped"
[ "$(service_field '.currentDeploymentId')" = "$DEPLOY_ID" ] || fail "Sleeping service lost its current deployment"
[ "$(container_state "$CONTAINER_ID")" = "exited" ] || fail "Container should still be stopped"
log "Test 3 passed"

# --- Test 4: a request through the wake server wakes it and is answered ---
log "Test 4: wake on request"
RESULT=$(wake_curl "$SERVICE_ID" "/")
CODE=$(echo "$RESULT" | tail -n1)
BODY=$(echo "$RESULT" | sed '$d')
[ "$CODE" = "200" ] || fail "Wake request returned HTTP $CODE: $BODY"
echo "$BODY" | grep -q "Welcome to nginx" || fail "Wake request body unexpected: $BODY"
[ "$(container_state "$CONTAINER_ID")" = "running" ] || fail "Container not running after wake"
[ "$(service_field '.runtimeStatus')" = "online" ] || fail "Expected online after wake"
[ "$(service_field '.sleepingSince')" = "null" ] || fail "sleepingSince not cleared"
service_curl "$HOST_PORT" > /dev/null || fail "Service port not answering after wake"
log "Test 4 passed"

# --- Test 5: wake server edge cases ---
log "Test 5: wake server rejects unknown requests"
NO_HEADER=$(remote "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$WAKE_PORT/'")
[ "$NO_HEADER" = "404" ] || fail "Expected 404 without wake header, got $NO_HEADER"
UNKNOWN=$(wake_curl "svc-does-not-exist" "/" | tail -n1)
[ "$UNKNOWN" = "503" ] || fail "Expected 503 for unknown service, got $UNKNOWN"
log "Test 5 passed"

# --- Test 6: an idle service sleeps on its own ---
log "Test 6: sleeps after 1 idle minute"
wait_for_runtime_status "sleeping" 90 || fail "Service did not scale to zero when idle"
[ "$(container_state "$CONTAINER_ID")" = "exited" ] || fail "Idle container not stopped"
log "Test 6 passed"

# --- Test 7: wake via API ---
log "Test 7: wake via API"
api -X POST "$BASE_URL/api/services/$SERVICE_ID/wake" > /dev/null || fail "Wake API failed"
[ "$(service_field '.runtimeStatus')" = "online" ] || fail "Expected online after API wake"
service_curl "$HOST_PORT" > /dev/null || fail "Service not answering after API wake"
log "Test 7 passed"

# --- Test 8: deploying a sleeping service brings it online ---
log "Test 8: redeploy while sleeping"
api -X POST "$BASE_URL/api/services/$SERVICE_ID/sleep" > /dev/null || fail "Sleep request failed"
[ "$(service_field '.runtimeStatus')" = "sleeping" ] || fail "Expected sleeping before redeploy"
DEPLOY2=$(api -X POST "$BASE_URL/api/services/$SERVICE_ID/deploy")
DEPLOY2_ID=$(require_field "$DEPLOY2" '.deploymentId' "redeploy") || fail "Redeploy failed: $DEPLOY2"
wait_for_deployment "$DEPLOY2_ID" || fail "Redeploy of sleeping service failed"
[ "$(service_field '.runtimeStatus')" = "online" ] || fail "Expected online after redeploy"
[ "$(service_field '.sleepingSince')" = "null" ] || fail "sleepingSince not cleared by deploy"
NEW_PORT=$(json_get "$(api "$BASE_URL/api/deployments/$DEPLOY2_ID/replicas")" '.[0].hostPort')
service_curl "$NEW_PORT" > /dev/null || fail "New deployment not answering"
log "Test 8 passed"

# --- Test 9: disabling it stops auto sleep ---
log "Test 9: disable scale to zero"
api -X PATCH "$BASE_URL/api/services/$SERVICE_ID" -d '{"scaleToZeroMinutes":null}' > /dev/null
DEPLOY3=$(api -X POST "$BASE_URL/api/services/$SERVICE_ID/deploy")
DEPLOY3_ID=$(require_field "$DEPLOY3" '.deploymentId' "redeploy") || fail "Redeploy failed: $DEPLOY3"
wait_for_deployment "$DEPLOY3_ID" || fail "Redeploy without scale to zero failed"
[ "$(json_get "$(api "$BASE_URL/api/deployments/$DEPLOY3_ID")" '.scaleToZeroMinutes')" = "null" ] || fail "Deployment should not have scaleToZeroMinutes"
log "Test 9 passed"

pass
