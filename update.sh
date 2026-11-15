#!/bin/bash
set -e

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

FROST_DIR="/opt/frost"
FROST_REPO="https://github.com/elitan/frost"
UPDATE_MARKER="$FROST_DIR/data/.update-requested"
UPDATE_LOG="$FROST_DIR/data/.update-log"
UPDATE_RESULT="$FROST_DIR/data/.update-result"
BACKUP_DIR="$FROST_DIR/.backup"
FROST_UNIT="/etc/systemd/system/frost.service"
UPDATE_UNIT="/etc/systemd/system/frost-update.service"
# Must match the line install.sh writes into frost.service
FROST_UPDATE_HOOK="ExecStartPre=-/bin/sh -c 'test ! -f $UPDATE_MARKER || systemctl start --no-block frost-update.service'"
# Pinned bun version (keep in sync with install.sh)
FROST_BUN_VERSION="1.4.4"
HEALTH_TIMEOUT_SEC="${FROST_UPDATE_HEALTH_TIMEOUT:-90}"

log() {
  echo -e "${YELLOW}$1${NC}"
}

error() {
  echo -e "${RED}$1${NC}"
}

success() {
  echo -e "${GREEN}$1${NC}"
}

get_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  local line
  line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
  if [ -z "$line" ]; then
    return 0
  fi
  echo "${line#*=}"
}

ensure_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [ ! -f "$file" ]; then
    touch "$file"
  fi
  if grep -qE "^${key}=" "$file"; then
    return 0
  fi
  echo "${key}=${value}" >> "$file"
}

resolve_command_path() {
  local name="$1"
  local candidate

  if command -v "$name" > /dev/null 2>&1; then
    command -v "$name"
    return 0
  fi

  for candidate in \
    "/usr/local/sbin/$name" \
    "/usr/local/bin/$name" \
    "/usr/sbin/$name" \
    "/usr/bin/$name" \
    "/sbin/$name" \
    "/bin/$name"
  do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

replace_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped_value
  escaped_value=$(printf '%s\n' "$value" | sed 's/[&|]/\\&/g')
  sed -i "s|^${key}=.*$|${key}=${escaped_value}|" "$file"
}

ensure_env_value_if_blank() {
  local file="$1"
  local key="$2"
  local value="$3"
  local current

  if [ -z "$value" ]; then
    return 0
  fi

  current=$(get_env_value "$file" "$key")
  if [ -n "$current" ]; then
    return 0
  fi

  if [ ! -f "$file" ]; then
    touch "$file"
  fi

  if grep -qE "^${key}=" "$file"; then
    replace_env_value "$file" "$key" "$value"
    return 0
  fi

  echo "${key}=${value}" >> "$file"
}

ensure_cleanup_script_executable() {
  if [ -f "$FROST_DIR/cleanup.sh" ]; then
    chmod +x "$FROST_DIR/cleanup.sh"
  fi
}

# Frost loads Caddy's config through the admin API. Older units started Caddy
# from the static IP-only Caddyfile, dropping every domain route on restart,
# and ExecReload force-reloaded that Caddyfile over the API config. Migrate to
# `--resume` (Caddy's autosave of the last loaded config, Caddyfile only as
# first-boot fallback) and drop ExecReload. Idempotent; never restarts Caddy:
# the running process keeps its config and picks up the unit on next start.
migrate_caddy_unit() {
  local unit=/etc/systemd/system/caddy.service
  local changed=0
  [ -f "$unit" ] || return 0

  if grep -q '^ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile$' "$unit"; then
    sed -i 's|^ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile$|ExecStart=/usr/bin/caddy run --environ --resume --config /etc/caddy/Caddyfile|' "$unit"
    changed=1
  fi
  if grep -q '^ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile' "$unit"; then
    sed -i '\|^ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile|d' "$unit"
    changed=1
  fi

  if [ "$changed" -eq 1 ]; then
    log "Migrated Caddy unit to resume autosaved config on restart"
    systemctl daemon-reload 2>/dev/null || true
  fi
}

ensure_cleanup_api_key() {
  local env_file="$FROST_DIR/.env"
  local jwt_secret
  local data_dir

  jwt_secret=$(get_env_value "$env_file" "FROST_JWT_SECRET")
  if [ -z "$jwt_secret" ]; then
    error "FROST_JWT_SECRET missing; cannot provision cleanup API key"
    return 1
  fi

  data_dir=$(get_env_value "$env_file" "FROST_DATA_DIR")
  if [ -z "$data_dir" ]; then
    data_dir="$FROST_DIR/data"
  fi

  if [ -f "$FROST_DIR/scripts/ensure-cleanup-api-key.ts" ]; then
    (
      cd "$FROST_DIR" && FROST_JWT_SECRET="$jwt_secret" \
        FROST_DATA_DIR="$data_dir" bun scripts/ensure-cleanup-api-key.ts
    )
    return
  fi

  if [ -f "$FROST_DIR/apps/app/scripts/ensure-cleanup-api-key.ts" ]; then
    (
      cd "$FROST_DIR" && FROST_JWT_SECRET="$jwt_secret" \
        FROST_DATA_DIR="$data_dir" bun --cwd apps/app scripts/ensure-cleanup-api-key.ts
    )
    return
  fi

  log "Cleanup API key provisioner not found; skipping for older install"
  return 0
}

get_sqlite_db_path() {
  local env_file="$FROST_DIR/.env"
  local db_path
  local data_dir

  db_path=$(get_env_value "$env_file" "FROST_DB_PATH")
  if [ -n "$db_path" ]; then
    echo "$db_path"
    return 0
  fi

  data_dir=$(get_env_value "$env_file" "FROST_DATA_DIR")
  if [ -z "$data_dir" ]; then
    data_dir="$FROST_DIR/data"
  fi

  echo "$data_dir/frost.db"
}

backup_sqlite_db() {
  local db_path
  local backup_dir
  local suffix

  db_path=$(get_sqlite_db_path)
  backup_dir="$BACKUP_DIR/sqlite"

  rm -rf "$backup_dir"
  mkdir -p "$backup_dir"
  printf "%s" "$db_path" > "$backup_dir/db-path"

  if [ ! -f "$db_path" ]; then
    touch "$backup_dir/missing"
    log "No SQLite database found to back up"
    return 0
  fi

  for suffix in "" "-wal" "-shm"; do
    if [ -f "$db_path$suffix" ]; then
      cp -p "$db_path$suffix" "$backup_dir/frost.db$suffix"
    fi
  done

  log "SQLite database backup created"
}

restore_sqlite_db_backup() {
  local backup_dir="$BACKUP_DIR/sqlite"
  local db_path
  local suffix

  if [ ! -d "$backup_dir" ]; then
    return 0
  fi

  db_path=$(cat "$backup_dir/db-path" 2>/dev/null || true)
  if [ -z "$db_path" ]; then
    rm -rf "$backup_dir"
    return 0
  fi

  log "Restoring SQLite database backup..."
  mkdir -p "$(dirname "$db_path")" 2>/dev/null || true
  rm -f "$db_path" "$db_path-wal" "$db_path-shm" 2>/dev/null || true

  if [ ! -f "$backup_dir/missing" ]; then
    for suffix in "" "-wal" "-shm"; do
      if [ -f "$backup_dir/frost.db$suffix" ]; then
        cp -p "$backup_dir/frost.db$suffix" "$db_path$suffix" 2>/dev/null || true
      fi
    done
  fi

  rm -rf "$backup_dir"
}

count_non_empty_lines() {
  echo "$1" | awk 'NF {c++} END {print c+0}'
}

detect_zfs_pool() {
  local dataset_base="$1"
  local zpool_cmd
  zpool_cmd=$(resolve_command_path "zpool" || true)
  if [ -z "$zpool_cmd" ]; then
    return 0
  fi
  local pools
  local count
  pools=$("$zpool_cmd" list -H -o name 2>/dev/null | awk 'NF {print}')
  count=$(count_non_empty_lines "$pools")
  if [ "$count" -eq 1 ]; then
    echo "$pools"
    return 0
  fi

  local zfs_cmd
  zfs_cmd=$(resolve_command_path "zfs" || true)
  if [ -z "$dataset_base" ] || [ -z "$zfs_cmd" ]; then
    return 0
  fi

  local matches
  matches=$("$zfs_cmd" list -H -o name 2>/dev/null | awk -v suffix="/$dataset_base" '
    NF && length($0) > length(suffix) && substr($0, length($0) - length(suffix) + 1) == suffix {
      print substr($0, 1, length($0) - length(suffix))
    }
  ' | awk 'NF && !seen[$0]++ {print}')
  count=$(count_non_empty_lines "$matches")
  if [ "$count" -eq 1 ]; then
    echo "$matches"
  fi
}

ensure_zfs_branching_setup() {
  local zfs_cmd
  local zpool_cmd
  zfs_cmd=$(resolve_command_path "zfs" || true)
  zpool_cmd=$(resolve_command_path "zpool" || true)

  if [ -z "$zfs_cmd" ] || [ -z "$zpool_cmd" ]; then
    log "Installing zfsutils-linux..."
    apt-get -o DPkg::Lock::Timeout=600 update -qq || true
    apt-get -o DPkg::Lock::Timeout=600 install -y -qq zfsutils-linux > /dev/null || true
    zfs_cmd=$(resolve_command_path "zfs" || true)
    zpool_cmd=$(resolve_command_path "zpool" || true)
  fi

  local env_file="$FROST_DIR/.env"
  local detected_pool
  local pool
  local dataset_base
  local mount_base
  local base_dataset

  dataset_base=$(get_env_value "$env_file" "FROST_POSTGRES_ZFS_DATASET_BASE")
  if [ -z "$dataset_base" ]; then
    dataset_base="frost/databases"
  fi

  detected_pool=$(detect_zfs_pool "$dataset_base" || true)

  ensure_env_value_if_blank "$env_file" "FROST_POSTGRES_ZFS_POOL" "$detected_pool"
  ensure_env_value_if_blank "$env_file" "FROST_POSTGRES_ZFS_DATASET_BASE" "$dataset_base"
  ensure_env_value_if_blank "$env_file" "FROST_POSTGRES_ZFS_MOUNT_BASE" "/opt/frost/data/postgres/zfs"

  pool=$(get_env_value "$env_file" "FROST_POSTGRES_ZFS_POOL")
  dataset_base=$(get_env_value "$env_file" "FROST_POSTGRES_ZFS_DATASET_BASE")
  mount_base=$(get_env_value "$env_file" "FROST_POSTGRES_ZFS_MOUNT_BASE")

  if [ -n "$mount_base" ]; then
    mkdir -p "$mount_base"
  fi

  if [ -z "$pool" ] || [ -z "$zfs_cmd" ] || [ -z "$zpool_cmd" ]; then
    return 0
  fi

  if ! "$zpool_cmd" list -H -o name "$pool" > /dev/null 2>&1; then
    return 0
  fi

  base_dataset="$pool/$dataset_base"
  if ! "$zfs_cmd" list -H "$base_dataset" > /dev/null 2>&1; then
    "$zfs_cmd" create -p "$base_dataset" > /dev/null 2>&1 || true
  fi
}


# Wake proxy for scale to zero (internal wake, Postgres). Source installs
# build it from this checkout; releases pull the image published with the
# release. Not fatal: without it, services wake only through their domains and
# Postgres branches sleep without a proxy. Keep in sync with install.sh.
ensure_activator_image() {
  local env_file="$FROST_DIR/.env"
  sed -i '/^FROST_ACTIVATOR_IMAGE=frost-activator:source$/d' "$env_file" 2>/dev/null || true
  if [ -f "$FROST_DIR/apps/activator/Dockerfile" ]; then
    if docker build -q -t frost-activator:source "$FROST_DIR/apps/activator" > /dev/null; then
      echo "FROST_ACTIVATOR_IMAGE=frost-activator:source" >> "$env_file"
    else
      log "Warning: could not build the wake proxy image; internal wake disabled"
    fi
    return 0
  fi
  local version
  version=$(grep '"version"' "$FROST_DIR/package.json" 2>/dev/null | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
  if [ -n "$version" ] && docker pull -q "ghcr.io/elitan/frost-activator:$version" > /dev/null 2>&1; then
    return 0
  fi
  log "Warning: could not pull ghcr.io/elitan/frost-activator:$version; Frost retries on first use"
}

get_package_version() {
  local file="$1"
  grep '"version"' "$file" 2>/dev/null | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
}

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------

render_update_unit() {
  cat << EOF
[Unit]
Description=Frost self-update
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$FROST_DIR
Environment=HOME=/root
ExecStart=/bin/bash $FROST_DIR/update.sh --apply
TimeoutStartSec=3600
EOF
}

# Idempotently migrate units to the frost-update.service mechanism:
# - frost-update.service (oneshot) runs update.sh --apply outside frost's cgroup,
#   so it can stop/start frost, health check, and roll back.
# - frost.service's ExecStartPre only enqueues frost-update.service when an
#   update marker exists (compat for app versions that write the marker and
#   restart frost). It no longer downloads anything.
migrate_systemd_units() {
  local changed=false
  local desired
  local current

  if ! command -v systemctl > /dev/null 2>&1; then
    return 0
  fi

  desired=$(render_update_unit)
  current=$(cat "$UPDATE_UNIT" 2>/dev/null || true)
  if [ "$current" != "$desired" ]; then
    printf '%s\n' "$desired" > "$UPDATE_UNIT"
    changed=true
    log "Installed $UPDATE_UNIT"
  fi

  if [ -f "$FROST_UNIT" ]; then
    if grep -q '^ExecStartPre=' "$FROST_UNIT"; then
      if ! grep -qxF "$FROST_UPDATE_HOOK" "$FROST_UNIT"; then
        # Replace legacy hooks (curl …/main/update.sh | bash, or local
        # update.sh --pre-start) with the enqueue-only hook
        grep -v '^ExecStartPre=.*update' "$FROST_UNIT" > "$FROST_UNIT.tmp" || true
        mv "$FROST_UNIT.tmp" "$FROST_UNIT"
        changed=true
      fi
    fi
    if ! grep -qxF "$FROST_UPDATE_HOOK" "$FROST_UNIT"; then
      awk -v hook="$FROST_UPDATE_HOOK" '
        /^ExecStart=/ && !done { print hook; done=1 }
        { print }
      ' "$FROST_UNIT" > "$FROST_UNIT.tmp"
      mv "$FROST_UNIT.tmp" "$FROST_UNIT"
      changed=true
      log "Migrated $FROST_UNIT update hook"
    fi
  fi

  if [ "$changed" = true ]; then
    systemctl daemon-reload 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Release downloads + verification
# ---------------------------------------------------------------------------

release_url() {
  echo "$FROST_REPO/releases/download/v$1/$2"
}

fetch_latest_version() {
  curl -fsSL "$FROST_REPO/releases/latest" -o /dev/null -w '%{url_effective}' 2>/dev/null |
    sed 's|.*/v||' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true
}

# verify_sha256 <SHA256SUMS> <file> <name-in-sums>
verify_sha256() {
  local sums="$1"
  local file="$2"
  local name="$3"
  local expected
  local actual

  expected=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$sums")
  if [ -z "$expected" ]; then
    error "No checksum for $name in SHA256SUMS"
    return 1
  fi
  actual=$(sha256sum "$file" | awk '{print $1}')
  if [ "$expected" != "$actual" ]; then
    error "Checksum mismatch for $name (expected $expected, got $actual)"
    return 1
  fi
  log "Verified $name (sha256 $actual)"
}

# fetch_verified <version> <asset> <dest>
fetch_verified() {
  local version="$1"
  local asset="$2"
  local dest="$3"

  if [ ! -s "$STAGE_DIR/SHA256SUMS" ]; then
    if ! curl -fsSL "$(release_url "$version" SHA256SUMS)" -o "$STAGE_DIR/SHA256SUMS"; then
      rm -f "$STAGE_DIR/SHA256SUMS"
      FAIL_REASON="Release v$version has no SHA256SUMS; refusing unverified update"
      return 1
    fi
  fi

  if ! curl -fsSL "$(release_url "$version" "$asset")" -o "$dest"; then
    FAIL_REASON="Failed to download $asset for v$version"
    return 1
  fi

  if ! verify_sha256 "$STAGE_DIR/SHA256SUMS" "$dest" "$asset"; then
    FAIL_REASON="Checksum verification failed for $asset (v$version)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Bun (pinned)
# ---------------------------------------------------------------------------

ensure_pinned_bun() {
  local current=""

  if [ -x "$BUN_INSTALL/bin/bun" ]; then
    current=$("$BUN_INSTALL/bin/bun" --version 2>/dev/null || true)
  fi

  if [ "$current" = "$FROST_BUN_VERSION" ]; then
    log "Bun $current already installed"
  else
    log "Installing bun $FROST_BUN_VERSION (current: ${current:-none})..."
    if ! curl -fsSL https://bun.sh/install 2>/dev/null | bash -s "bun-v$FROST_BUN_VERSION" > /dev/null 2>&1; then
      if [ -n "$current" ]; then
        error "Failed to install bun $FROST_BUN_VERSION; continuing with bun $current"
      else
        FAIL_REASON="Failed to install bun $FROST_BUN_VERSION"
        return 1
      fi
    fi
  fi

  if [ -f "$BUN_INSTALL/bin/bun" ]; then
    mkdir -p /usr/local/bin
    ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  else
    FAIL_REASON="Bun not found at $BUN_INSTALL/bin/bun"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

health_url() {
  local host
  local port
  host=$(get_env_value "$FROST_DIR/.env" "HOSTNAME")
  port=$(get_env_value "$FROST_DIR/.env" "PORT")
  case "$host" in
    "" | 0.0.0.0 | "::" | "[::]" | localhost | 127.0.0.1) host="127.0.0.1" ;;
    \[*\]) ;;
    *:*) host="[$host]" ;;
  esac
  echo "http://$host:${port:-3000}/api/health"
}

# wait_for_healthy <expected-version|""> <timeout-seconds>
wait_for_healthy() {
  local expected="$1"
  local timeout="$2"
  local url
  local body
  local deadline
  local streak=0

  url=$(health_url)
  deadline=$((SECONDS + timeout))
  log "Waiting up to ${timeout}s for $url${expected:+ to report v$expected}..."

  while [ "$SECONDS" -lt "$deadline" ]; do
    body=$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)
    if echo "$body" | grep -q '"ok": *true' &&
      { [ -z "$expected" ] || echo "$body" | grep -qF "\"version\":\"$expected\""; }; then
      streak=$((streak + 1))
      # Require two consecutive healthy responses to catch immediate crash loops
      if [ "$streak" -ge 2 ]; then
        success "Frost is healthy: $body"
        return 0
      fi
    else
      streak=0
    fi
    sleep 3
  done

  error "Health check failed (last response: ${body:-none})"
  return 1
}

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------

restore_tarball_backup() {
  local item
  local base

  log "Restoring previous version files..."
  # Only clear $FROST_DIR once every original item was moved into the backup
  # and the new tarball started extracting; otherwise originals still live here
  if [ "$TARBALL_EXTRACTING" = true ]; then
    for item in "$FROST_DIR"/* "$FROST_DIR"/.[!.]*; do
      [ -e "$item" ] || continue
      base=$(basename "$item")
      case "$base" in
        data | .backup | .env) continue ;;
      esac
      rm -rf "$item"
    done
  fi
  for item in "$BACKUP_DIR/code"/* "$BACKUP_DIR/code"/.[!.]*; do
    [ -e "$item" ] || continue
    mv "$item" "$FROST_DIR/"
  done
  if [ -f "$BACKUP_DIR/.env" ]; then
    cp -p "$BACKUP_DIR/.env" "$FROST_DIR/.env"
  fi
}

restore_git_backup() {
  local prev_commit
  local prev_branch

  prev_commit=$(cat "$BACKUP_DIR/commit" 2>/dev/null || true)
  prev_branch=$(cat "$BACKUP_DIR/branch" 2>/dev/null || true)
  if [ -z "$prev_commit" ]; then
    return 0
  fi

  cd "$FROST_DIR"
  log "Restoring previous commit $prev_commit..."
  if [ -n "$prev_branch" ]; then
    git checkout -f "$prev_branch" 2>/dev/null || true
    git reset --hard "$prev_commit" 2>/dev/null || true
  else
    git checkout -f --detach "$prev_commit" 2>/dev/null || true
  fi
  if ! rebuild_restored_git_version; then
    error "Failed to rebuild previous version after rollback"
  fi
}

rebuild_restored_git_version() {
  log "Restoring dependencies for previous version..."
  bun install --frozen-lockfile 2>&1 || return 1

  log "Rebuilding previous version..."
  NEXT_TELEMETRY_DISABLED=1 bun run build 2>&1 || return 1
}

# rollback <reason>: restore code + DB if they were touched, write a failed
# result, and bring the previous version back up.
rollback() {
  local reason="$1"
  IN_ROLLBACK=true
  set +e

  error "Update failed: $reason"

  if [ "$FROST_STOPPED" = true ]; then
    log "Stopping Frost..."
    systemctl stop frost 2>/dev/null
  fi

  if [ "$DB_BACKED_UP" = true ]; then
    restore_sqlite_db_backup
  fi

  if [ "$CODE_BACKED_UP" = true ]; then
    if [ "$GIT_MODE" = true ]; then
      restore_git_backup
    else
      restore_tarball_backup
    fi
  fi
  rm -rf "$BACKUP_DIR"

  # The old version reads this file on startup (it only understands "failed"),
  # and the reason is the last "Update failed:" line in the update log.
  echo "failed" > "$UPDATE_RESULT"

  if [ "$FROST_STOPPED" = true ]; then
    log "Starting previous version..."
    systemctl start frost 2>/dev/null
    if wait_for_healthy "" "$HEALTH_TIMEOUT_SEC"; then
      success "Previous version restored"
    else
      error "Previous version did not become healthy; check: journalctl -u frost"
    fi
  fi

  error "Update failed: $reason"
}

on_exit() {
  local rc=$?
  if [ "$IN_ROLLBACK" != true ] && [ "$FINISHED" != true ] && [ "$rc" -ne 0 ] && [ "$ROLLBACK_ON_EXIT" = true ]; then
    rollback "${FAIL_REASON:-update.sh exited with status $rc}"
  fi
  if [ -n "$STAGE_DIR" ] && [ "$KEEP_STAGE" != true ]; then
    rm -rf "$STAGE_DIR"
  fi
  if [ -n "$FROST_UPDATE_SELF" ] && [ "$KEEP_STAGE" != true ]; then
    rm -f "$FROST_UPDATE_SELF"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

MODE="apply"
case "${1:-}" in
  --pre-start) MODE="pre-start" ;;
  --apply | "") MODE="apply" ;;
  *)
    echo "Usage: $0 [--apply]"
    exit 1
    ;;
esac

GIT_MODE=false
FROST_STOPPED=false
CODE_BACKED_UP=false
DB_BACKED_UP=false
TARBALL_EXTRACTING=false
FINISHED=false
IN_ROLLBACK=false
ROLLBACK_ON_EXIT=false
KEEP_STAGE=false
FAIL_REASON=""
STAGE_DIR="${FROST_UPDATE_STAGE:-}"

trap on_exit EXIT

if [ "$EUID" -ne 0 ]; then
  error "Please run as root (sudo)"
  exit 1
fi

if [ ! -d "$FROST_DIR" ]; then
  error "Frost not found at $FROST_DIR"
  echo "Run install.sh first"
  exit 1
fi

# Single update at a time (fd 9 is inherited across re-exec)
if [ -z "${FROST_UPDATE_LOCKED:-}" ]; then
  exec 9> /run/frost-update.lock
  if command -v flock > /dev/null 2>&1 && ! flock -w 60 9; then
    error "Another update is already running"
    exit 1
  fi
  export FROST_UPDATE_LOCKED=1
fi

if [ -z "${FROST_UPDATE_LOGGING:-}" ]; then
  : > "$UPDATE_LOG"
  exec > >(tee -a "$UPDATE_LOG") 2>&1
  export FROST_UPDATE_LOGGING=1
fi

# Run from a private copy: the update replaces files under $FROST_DIR
if [ "$MODE" = "apply" ] && [ -z "${FROST_UPDATE_SELF:-}" ] && [ -f "$0" ]; then
  FROST_UPDATE_SELF=$(mktemp /tmp/frost-update.XXXXXX)
  cp "$0" "$FROST_UPDATE_SELF"
  export FROST_UPDATE_SELF
  KEEP_STAGE=true
  exec /bin/bash "$FROST_UPDATE_SELF" "$@"
fi

if [ -z "$STAGE_DIR" ]; then
  STAGE_DIR=$(mktemp -d /tmp/frost-update-stage.XXXXXX)
fi

if [ -z "${FROST_UPDATE_HANDOFF:-}" ]; then
  success "Frost Update Script"
  echo ""
fi

export HOME="${HOME:-/root}"
export BUN_INSTALL="$HOME/.bun"
export PATH="/usr/local/bin:$BUN_INSTALL/bin:$PATH"

cd "$FROST_DIR"

# Target version: handoff env > UI marker > latest release
TARGET_VERSION="${FROST_UPDATE_TARGET:-}"
UPDATE_REQUESTED="${FROST_UPDATE_REQUESTED:-false}"
if [ -z "$TARGET_VERSION" ] && [ -f "$UPDATE_MARKER" ]; then
  TARGET_VERSION=$(tr -d '[:space:]' < "$UPDATE_MARKER")
  UPDATE_REQUESTED=true
  log "Update triggered from UI (target: ${TARGET_VERSION:-unknown})"
fi
TARGET_VERSION="${TARGET_VERSION#v}"

if [ -d "$FROST_DIR/.git" ]; then
  git config --global --add safe.directory "$FROST_DIR" 2>/dev/null || true
  if git rev-parse HEAD > /dev/null 2>&1 ||
    git rev-parse -q --verify origin/main > /dev/null 2>&1 ||
    { [ -n "$TARGET_VERSION" ] && git rev-parse -q --verify "refs/tags/v$TARGET_VERSION" > /dev/null 2>&1; }; then
    GIT_MODE=true
  fi
fi

# ---------------------------------------------------------------------------
# Legacy ExecStartPre path: old units run `curl …/main/update.sh | bash -s --
# --pre-start` before frost starts. We cannot health check from there, so we
# migrate the units, stage the target release's verified update.sh, enqueue
# frost-update.service, and let the current version start normally.
# ---------------------------------------------------------------------------
if [ "$MODE" = "pre-start" ]; then
  log "Legacy pre-start update hook: migrating to frost-update.service"

  if [ "$GIT_MODE" = false ]; then
    if [ -z "$TARGET_VERSION" ]; then
      TARGET_VERSION=$(fetch_latest_version)
    fi
    if [ -z "$TARGET_VERSION" ] ||
      ! fetch_verified "$TARGET_VERSION" update.sh "$STAGE_DIR/update.sh"; then
      error "Update failed: ${FAIL_REASON:-could not determine latest release}"
      echo "failed" > "$UPDATE_RESULT"
      rm -f "$UPDATE_MARKER"
      exit 0
    fi
    install -m 0755 "$STAGE_DIR/update.sh" "$FROST_DIR/update.sh"
  else
    log "Git mode: frost-update.service will use the checked-out update.sh"
  fi

  if [ -n "$TARGET_VERSION" ]; then
    printf '%s' "$TARGET_VERSION" > "$UPDATE_MARKER"
  fi
  migrate_systemd_units
  systemctl start --no-block frost-update.service
  log "Update queued; Frost will restart once it is applied"
  exit 0
fi

rm -f "$UPDATE_MARKER" "$UPDATE_RESULT"
CURRENT_VERSION=""
if [ "$GIT_MODE" = true ]; then
  CURRENT_VERSION=$(get_package_version apps/app/package.json)
else
  CURRENT_VERSION=$(get_package_version package.json)
fi
log "Current version: $CURRENT_VERSION"

# From here on any failure writes a failed result and restores what we touched
ROLLBACK_ON_EXIT=true

# Tarball mode: hand off to the target release's own (verified) update.sh
if [ "$GIT_MODE" = false ]; then
  if [ -z "$TARGET_VERSION" ]; then
    log "Checking for updates..."
    TARGET_VERSION=$(fetch_latest_version)
    if [ -z "$TARGET_VERSION" ]; then
      FAIL_REASON="Failed to fetch latest release"
      exit 1
    fi
  fi

  if [ "$CURRENT_VERSION" != "$TARGET_VERSION" ] && [ -z "${FROST_UPDATE_HANDOFF:-}" ]; then
    log "Fetching update.sh from release v$TARGET_VERSION..."
    fetch_verified "$TARGET_VERSION" update.sh "$STAGE_DIR/update.sh"
    export FROST_UPDATE_HANDOFF=1
    export FROST_UPDATE_TARGET="$TARGET_VERSION"
    export FROST_UPDATE_REQUESTED="$UPDATE_REQUESTED"
    export FROST_UPDATE_STAGE="$STAGE_DIR"
    KEEP_STAGE=true
    ROLLBACK_ON_EXIT=false
    exec /bin/bash "$STAGE_DIR/update.sh" --apply
  fi
fi

migrate_systemd_units
ensure_cleanup_script_executable

# Ensure FROST_DATA_DIR is set (required since v0.8.0 monorepo)
if [ -f "$FROST_DIR/.env" ]; then
  grep -q FROST_DATA_DIR "$FROST_DIR/.env" || echo "FROST_DATA_DIR=$FROST_DIR/data" >> "$FROST_DIR/.env"
  # Bind loopback only; Caddy proxies public traffic to localhost:3000
  grep -q '^HOSTNAME=' "$FROST_DIR/.env" || echo "HOSTNAME=127.0.0.1" >> "$FROST_DIR/.env"
fi

# Bind host comes from .env (HOSTNAME); defaults to loopback
FROST_BIND_HOST=$(grep '^HOSTNAME=' "$FROST_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)
FROST_BIND_HOST=${FROST_BIND_HOST:-127.0.0.1}

# git mode runs `next start`, which ignores HOSTNAME; pass --hostname instead
if [ -f "$FROST_UNIT" ] && grep -q '^ExecStart=/usr/local/bin/bun run start$' "$FROST_UNIT"; then
  sed -i "s|^ExecStart=/usr/local/bin/bun run start\$|ExecStart=/usr/local/bin/bun run start --hostname $FROST_BIND_HOST|" "$FROST_UNIT"
  systemctl daemon-reload 2>/dev/null || true
fi

# Ensure .env symlink exists for monorepo (apps/app needs access to root .env)
if [ -d "$FROST_DIR/apps/app" ] && [ ! -L "$FROST_DIR/apps/app/.env" ]; then
  ln -sf "$FROST_DIR/.env" "$FROST_DIR/apps/app/.env"
fi

ensure_zfs_branching_setup

ensure_pinned_bun

# Before any Caddy (re)start below, so it resumes the autosaved config
migrate_caddy_unit

# Install Caddy with DNS modules if missing (pinned; update when upgrading Caddy)
CADDY_VERSION="v2.10.2"

if ! caddy list-modules 2>/dev/null | grep -q "dns.providers.cloudflare"; then
  log "Downloading Caddy ${CADDY_VERSION} with DNS modules..."
  systemctl stop caddy 2>/dev/null || true
  rm -f /usr/bin/caddy

  ARCH=$(uname -m)
  case $ARCH in
    x86_64) CADDY_ARCH="amd64" ;;
    aarch64 | arm64) CADDY_ARCH="arm64" ;;
    *)
      FAIL_REASON="Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}&p=github.com/caddy-dns/cloudflare&version=${CADDY_VERSION}" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy

  systemctl start caddy 2>/dev/null || true
fi

# Configure Docker network pools for existing installs
DOCKER_POOLS='[{"base":"10.0.0.0/8","size":24},{"base":"172.17.0.0/12","size":24},{"base":"192.168.0.0/16","size":24}]'
DAEMON_JSON="/etc/docker/daemon.json"

if [ -f "$DAEMON_JSON" ] && grep -q "default-address-pools" "$DAEMON_JSON"; then
  : # already configured
elif command -v jq &> /dev/null; then
  log "Configuring Docker network pools..."
  if [ -f "$DAEMON_JSON" ]; then
    jq --argjson pools "$DOCKER_POOLS" '. + {"default-address-pools": $pools}' "$DAEMON_JSON" > "$DAEMON_JSON.tmp"
    mv "$DAEMON_JSON.tmp" "$DAEMON_JSON"
  else
    echo "{\"default-address-pools\": $DOCKER_POOLS}" | jq '.' > "$DAEMON_JSON"
  fi
  RUNNING_CONTAINERS=$(docker ps -q 2>/dev/null || true)
  log "Restarting Docker to apply network config..."
  systemctl restart docker
  if [ -n "$RUNNING_CONTAINERS" ]; then
    log "Restarting containers stopped by Docker restart..."
    echo "$RUNNING_CONTAINERS" | xargs -r docker start 2>/dev/null || true
  fi
fi

finish_up_to_date() {
  log "Already up to date (v$CURRENT_VERSION)"
  log "Ensuring cleanup API key..."
  ensure_cleanup_api_key
  if [ "$UPDATE_REQUESTED" = true ]; then
    echo "success:$CURRENT_VERSION" > "$UPDATE_RESULT"
  fi
  FINISHED=true
  systemctl start frost 2>/dev/null || true
  exit 0
}

stop_frost() {
  log "Stopping Frost..."
  FROST_STOPPED=true
  systemctl stop frost 2>/dev/null || true
}

if [ "$GIT_MODE" = true ]; then
  # Git mode: check out the release tag and rebuild (dev installs and CI)
  log "Git mode detected"

  CONVERTED_FROM_TARBALL=false
  if ! git rev-parse HEAD > /dev/null 2>&1; then
    CONVERTED_FROM_TARBALL=true
  fi

  log "Checking for updates..."
  if [ -n "$TARGET_VERSION" ]; then
    TARGET_REF="v$TARGET_VERSION"
    FETCH_ARGS=(--force)
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      FETCH_ARGS+=(--depth 1)
    fi
    if ! git fetch "${FETCH_ARGS[@]}" origin "refs/tags/$TARGET_REF:refs/tags/$TARGET_REF" 2>&1; then
      log "Could not fetch tag $TARGET_REF from origin; using local tag if present"
    fi
    if ! git rev-parse -q --verify "refs/tags/$TARGET_REF^{commit}" > /dev/null; then
      FAIL_REASON="Release tag $TARGET_REF not found"
      exit 1
    fi
  else
    log "No target version known (no update marker); falling back to origin/main"
    git fetch origin main 2>&1 || log "git fetch origin main failed; using existing origin/main"
    TARGET_REF="origin/main"
  fi

  REMOTE=$(git rev-parse "$TARGET_REF^{commit}")
  LOCAL=$(git rev-parse HEAD 2>/dev/null || true)

  if [ "$LOCAL" = "$REMOTE" ] && [ "$CONVERTED_FROM_TARBALL" = false ]; then
    finish_up_to_date
  fi

  if [ "$CONVERTED_FROM_TARBALL" = true ]; then
    log "Converting tarball install to git mode ($TARGET_REF)..."
  else
    log "Updating $LOCAL -> $TARGET_REF ($REMOTE)"
  fi

  stop_frost

  if [ "$CONVERTED_FROM_TARBALL" = false ]; then
    log "Backing up current commit..."
    rm -rf "$BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    echo "$LOCAL" > "$BACKUP_DIR/commit"
    git symbolic-ref -q --short HEAD > "$BACKUP_DIR/branch" 2>/dev/null || true
    CODE_BACKED_UP=true
  fi

  log "Checking out $TARGET_REF..."
  git checkout -f --detach "$REMOTE"
  ensure_cleanup_script_executable

  if [ "$CONVERTED_FROM_TARBALL" = true ]; then
    log "Cleaning old node_modules..."
    rm -rf node_modules apps/*/node_modules
    log "Creating .env symlink for monorepo..."
    ln -sf "$FROST_DIR/.env" "$FROST_DIR/apps/app/.env"
    log "Updating systemd service for git mode..."
    sed -i "s|^ExecStart=.*|ExecStart=/usr/local/bin/bun run start --hostname ${FROST_BIND_HOST:-127.0.0.1}|" "$FROST_UNIT"
    if grep -q '^TimeoutStartSec=' "$FROST_UNIT"; then
      sed -i 's|^TimeoutStartSec=.*|TimeoutStartSec=900|' "$FROST_UNIT"
    else
      sed -i '/\[Service\]/a TimeoutStartSec=900' "$FROST_UNIT"
    fi
    systemctl daemon-reload
  fi

  log "Installing dependencies..."
  bun install --frozen-lockfile 2>&1

  log "Building..."
  BUILD_OK=false
  for attempt in 1 2 3; do
    if NEXT_TELEMETRY_DISABLED=1 bun run build 2>&1; then
      BUILD_OK=true
      break
    fi
    log "Build failed (attempt $attempt/3), retrying..."
    rm -rf apps/app/.next
    sleep 2
  done
  if [ "$BUILD_OK" = false ]; then
    FAIL_REASON="Build failed after 3 attempts"
    exit 1
  fi

  NEW_VERSION=$(get_package_version apps/app/package.json)
else
  # Tarball mode: download prebuilt release, verify, extract
  if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
    finish_up_to_date
  fi

  log "Updating v$CURRENT_VERSION -> v$TARGET_VERSION"
  TARBALL_NAME="frost-v${TARGET_VERSION}.tar.gz"
  log "Downloading $TARBALL_NAME..."
  fetch_verified "$TARGET_VERSION" "$TARBALL_NAME" "$STAGE_DIR/$TARBALL_NAME"

  stop_frost

  log "Backing up current installation..."
  rm -rf "$BACKUP_DIR"
  mkdir -p "$BACKUP_DIR/code"
  cp -p "$FROST_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null || true
  CODE_BACKED_UP=true
  for item in "$FROST_DIR"/* "$FROST_DIR"/.[!.]*; do
    [ -e "$item" ] || continue
    base=$(basename "$item")
    case "$base" in
      data | .backup | .env) continue ;;
    esac
    mv "$item" "$BACKUP_DIR/code/"
  done

  log "Extracting..."
  TARBALL_EXTRACTING=true
  tar -xzf "$STAGE_DIR/$TARBALL_NAME" -C "$FROST_DIR"
  ensure_cleanup_script_executable

  log "Installing dependencies..."
  bun install --production --frozen-lockfile 2>&1

  NEW_VERSION=$(get_package_version package.json)
fi

log "Preparing the wake proxy image..."
ensure_activator_image

log "Backing up SQLite database..."
backup_sqlite_db
DB_BACKED_UP=true

log "Running migrations..."
if ! bun run migrate 2>&1; then
  FAIL_REASON="Database migration failed"
  exit 1
fi

log "Ensuring cleanup API key..."
ensure_cleanup_api_key

log "Starting Frost v$NEW_VERSION..."
systemctl start frost

if ! wait_for_healthy "$NEW_VERSION" "$HEALTH_TIMEOUT_SEC"; then
  journalctl -u frost --no-pager -n 50 2>/dev/null || true
  rollback "v$NEW_VERSION did not pass health check within ${HEALTH_TIMEOUT_SEC}s"
  exit 1
fi

rm -rf "$BACKUP_DIR"
echo "success:$NEW_VERSION" > "$UPDATE_RESULT"
FINISHED=true

echo ""
success "Update complete! v$CURRENT_VERSION → v$NEW_VERSION"
echo ""
echo "Check status: systemctl status frost"
