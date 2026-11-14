#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

log "=== Service update + redeploy ==="

log "Creating project and service..."
PROJECT=$(api -X POST "$BASE_URL/api/projects" -d '{"name":"e2e-update"}')
PROJECT_ID=$(require_field "$PROJECT" '.id' "create project") || fail "Failed to create project: $PROJECT"

ENV_ID=$(get_default_environment "$PROJECT_ID") || fail "Failed to get environment"
log "Using environment: $ENV_ID"
log "Created project: $PROJECT_ID"

SERVICE=$(api -X POST "$BASE_URL/api/environments/$ENV_ID/services" \
  -d '{"name":"updatetest","deployType":"image","imageUrl":"nginx:alpine","containerPort":80,"drainTimeout":0,"shutdownTimeout":1}')
SERVICE_ID=$(require_field "$SERVICE" '.id' "create service") || fail "Failed to create service: $SERVICE"
log "Created service: $SERVICE_ID"

log "Waiting for v1 deployment..."
sleep 1
DEPLOYS=$(api "$BASE_URL/api/services/$SERVICE_ID/deployments")
DEPLOY_ID=$(require_field "$DEPLOYS" '.[0].id' "get v1 deploy") || fail "No v1 deployment: $DEPLOYS"
wait_for_deployment "$DEPLOY_ID" || fail "v1 deployment failed"

DEPLOY_DATA=$(api "$BASE_URL/api/deployments/$DEPLOY_ID")
HOST_PORT=$(require_field "$DEPLOY_DATA" '.hostPort' "get v1 hostPort") || fail "No v1 hostPort: $DEPLOY_DATA"
RESPONSE1=$(service_curl "$HOST_PORT")
echo "$RESPONSE1" | grep -q "nginx" || fail "v1 not responding correctly"
log "v1 (nginx) deployed"

log "Updating to httpd and redeploying..."
api -X PATCH "$BASE_URL/api/services/$SERVICE_ID" \
  -d '{"imageUrl":"httpd:alpine","containerPort":80}' > /dev/null

DEPLOY2=$(api -X POST "$BASE_URL/api/services/$SERVICE_ID/deploy")
DEPLOY2_ID=$(require_field "$DEPLOY2" '.deploymentId' "trigger v2 deploy") || fail "Failed to trigger v2: $DEPLOY2"
wait_for_deployment "$DEPLOY2_ID" || fail "v2 deployment failed"

DEPLOY2_DATA=$(api "$BASE_URL/api/deployments/$DEPLOY2_ID")
HOST_PORT2=$(require_field "$DEPLOY2_DATA" '.hostPort' "get v2 hostPort") || fail "No v2 hostPort: $DEPLOY2_DATA"
RESPONSE2=$(service_curl "$HOST_PORT2")
echo "$RESPONSE2" | grep -q "It works" || fail "v2 not responding correctly"
log "v2 (httpd) deployed"

log "Waiting for v1 deployment to stop..."
OLD_CONTAINER_ID=$(json_get "$DEPLOY_DATA" '.containerId // empty')
OLD_STATUS=""
for _ in $(seq 1 20); do
  OLD_STATUS=$(json_get "$(api "$BASE_URL/api/deployments/$DEPLOY_ID")" '.status')
  [ "$OLD_STATUS" = "stopped" ] && break
  sleep 1
done
[ "$OLD_STATUS" = "stopped" ] || fail "Expected v1 status 'stopped', got '$OLD_STATUS'"

if [ -n "$OLD_CONTAINER_ID" ] && [ "$OLD_CONTAINER_ID" != "null" ]; then
  OLD_RUNNING=$(remote "docker inspect $OLD_CONTAINER_ID --format '{{.State.Running}}' 2>/dev/null || echo missing" 2>&1 | tr -d '\r\n[:space:]')
  [ -z "$OLD_RUNNING" ] || [ "$OLD_RUNNING" = "false" ] || [ "$OLD_RUNNING" = "missing" ] || fail "v1 container still running: $OLD_RUNNING"
fi
log "v1 stopped and its container is gone"

log "Cleanup..."
api -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" > /dev/null

pass
