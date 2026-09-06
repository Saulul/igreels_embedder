#!/usr/bin/env bash
# igreels-embedder deploy hook.
#
# Invoked as the forced command for the GitHub Actions deploy key in
# /root/.ssh/authorized_keys, so that key can do this and nothing else --
# the client's requested command arrives in SSH_ORIGINAL_COMMAND and is
# only ever parsed, never executed.
#
#   over ssh:   deploy [<40-hex commit>]
#   as root:    igreels-deploy [<40-hex commit>]
#
# With no commit it deploys the tip of origin/main.
set -euo pipefail

REPO_URL="https://github.com/Saulul/igreels_embedder.git"
APP_DIR="/opt/igreels-embedder"
APP_USER="igreels"
SERVICE="igreels-embedder"
BRANCH="main"
HEALTH_URL="http://127.0.0.1:8080/healthz"
HEALTH_TRIES=15

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

as_app() { runuser -u "$APP_USER" -- "$@"; }

# --- Parse the request -------------------------------------------------
# Anything that is not "deploy" or "deploy <sha>" is rejected outright.
target=""
req="${SSH_ORIGINAL_COMMAND:-}"
# Run by hand as root, a bare sha is accepted too: igreels-deploy <sha>
if [ -z "$req" ] && [ "$#" -gt 0 ]; then req="deploy $1"; fi
case "$req" in
  ""|"deploy")   target="" ;;
  "deploy "*)    target="${req#deploy }" ;;
  *)             die "refusing unrecognised command: ${req}" ;;
esac
if [ -n "$target" ] && ! printf '%s' "$target" | grep -qE '^[0-9a-f]{40}$'; then
  die "not a commit sha: ${target}"
fi

# --- First run: adopt the hand-copied tree as a git checkout -----------
if [ ! -d "$APP_DIR/.git" ]; then
  log "no git checkout in $APP_DIR - initialising one in place"
  install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
  as_app git init -q -b "$BRANCH" "$APP_DIR"
  as_app git -C "$APP_DIR" remote add origin "$REPO_URL"
fi

as_app git -C "$APP_DIR" remote set-url origin "$REPO_URL"

log "fetching origin/$BRANCH"
as_app git -C "$APP_DIR" fetch --quiet --prune origin "$BRANCH"

if [ -z "$target" ]; then
  target="$(as_app git -C "$APP_DIR" rev-parse FETCH_HEAD)"
fi

previous="$(as_app git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
if [ "$previous" = "$target" ]; then
  log "already at ${target:0:8} - restarting anyway to pick up unit/env changes"
fi

as_app git -C "$APP_DIR" cat-file -e "${target}^{commit}" 2>/dev/null \
  || die "commit ${target} is not in origin/${BRANCH}"

# --- Roll out ----------------------------------------------------------
checkout() {
  as_app git -C "$APP_DIR" reset --hard --quiet "$1"
  node --check "$APP_DIR/server.js"
}

healthy() {
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

log "checking out ${target:0:8}"
# A commit that doesn't parse must not be left in the working tree: the
# running process is fine (the old code is already in memory), but the next
# restart -- an unattended one, at reboot -- would crash-loop on it.
if ! checkout "$target"; then
  if [ -n "$previous" ]; then
    log "restoring ${previous:0:8}"
    checkout "$previous" || true
  fi
  die "commit ${target:0:8} does not parse; nothing was restarted"
fi

log "restarting $SERVICE"
systemctl restart "$SERVICE"

if healthy; then
  log "healthy: $(curl -fsS -m 3 "$HEALTH_URL")"
  log "deployed ${target:0:8} ($(as_app git -C "$APP_DIR" log -1 --pretty=%s))"
  exit 0
fi

# --- Roll back ---------------------------------------------------------
log "service did not come back healthy after ${HEALTH_TRIES}s"
if [ -z "$previous" ] || [ "$previous" = "$target" ]; then
  systemctl --no-pager --lines=30 status "$SERVICE" >&2 || true
  die "no previous commit to roll back to - service is DOWN"
fi

log "rolling back to ${previous:0:8}"
checkout "$previous"
systemctl restart "$SERVICE"
if healthy; then
  die "deploy of ${target:0:8} failed; rolled back to ${previous:0:8} and service is healthy"
fi
systemctl --no-pager --lines=30 status "$SERVICE" >&2 || true
die "deploy of ${target:0:8} failed AND rollback to ${previous:0:8} failed - service is DOWN"
