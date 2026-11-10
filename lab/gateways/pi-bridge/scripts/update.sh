#!/usr/bin/env bash
#
# Pi-side auto-update for the AURA gateway bridge.
#
# What it does:
#   1. Refuses to run if the working tree has uncommitted changes (safety).
#   2. Fetches origin and fast-forwards the branch (default: main).
#   3. Updates submodules (e.g. NODE/node-firmware).
#   4. Reinstalls bridge deps ONLY if package-lock.json changed.
#   5. Restarts the systemd service (default: aura-pi-bridge).
#   6. Hits /health to confirm the bridge came back up.
#
# Usage:
#   ./scripts/update.sh
#
# Overridable via env:
#   AURA_SERVICE   systemd unit name      (default: aura-pi-bridge)
#   AURA_BRANCH    branch to track        (default: main)
#   HTTP_PORT      health-check port      (default: 3000)
#
set -euo pipefail

SERVICE="${AURA_SERVICE:-aura-pi-bridge}"
BRANCH="${AURA_BRANCH:-main}"
PORT="${HTTP_PORT:-3000}"

log() { printf '\033[1;36m[update]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[update]\033[0m %s\n' "$*" >&2; }

# Resolve repo root from this script's own location (no hardcoded paths).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BRIDGE_DIR="$REPO_ROOT/GATEWAY/pi-bridge"
LOCK_FILE="$BRIDGE_DIR/package-lock.json"

cd "$REPO_ROOT"

# 1) Safety: never clobber local edits on the Pi.
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Uncommitted changes in $REPO_ROOT — refusing to update."
  git status --short
  err "Commit or stash them first (e.g. 'git stash'), then re-run."
  exit 1
fi

# 2) Fetch and compare.
log "Fetching origin/$BRANCH ..."
git fetch --prune origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Already up to date ($LOCAL)."
else
  BEFORE="$( [ -f "$LOCK_FILE" ] && sha1sum "$LOCK_FILE" | awk '{print $1}' || echo none )"

  log "Updating ${LOCAL:0:9} -> ${REMOTE:0:9}"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"

  # 3) Keep submodules in lockstep with the commit pointers.
  log "Syncing submodules ..."
  git submodule update --init --recursive

  # 4) Only reinstall if the lockfile actually changed.
  AFTER="$( [ -f "$LOCK_FILE" ] && sha1sum "$LOCK_FILE" | awk '{print $1}' || echo none )"
  if [ "$BEFORE" != "$AFTER" ]; then
    log "Dependencies changed — installing ..."
    ( cd "$BRIDGE_DIR" && (npm ci --omit=dev || npm install) )
  else
    log "No dependency changes — skipping npm."
  fi
fi

# 5) Restart the bridge if the unit exists.
#
# `systemctl list-unit-files` only sees unit FILES under the standard search
# paths, so it misses a unit that was symlinked or runtime-linked into place —
# which is how this gateway is installed. `systemctl cat` resolves the loaded
# unit whatever its provenance.
#
# Getting this wrong is quiet and expensive: the pull succeeds, the restart is
# silently skipped, and the health check below then reports the OLD process as
# healthy. You walk away believing you deployed.
RESTARTED=0
if systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
  log "Restarting ${SERVICE} ..."
  sudo systemctl restart "$SERVICE"
  RESTARTED=1
  sleep 1
  systemctl --no-pager --lines=0 status "$SERVICE" || true
else
  err "Service ${SERVICE}.service not found — NOT restarted."
  err "New code is on disk; the running process is still the old one."
  err "Find the real unit:  sudo ss -lptn 'sport = :${PORT}'"
  err "Then re-run:         AURA_SERVICE=<unit-name> $0"
fi

# 6) Health check.
if command -v curl >/dev/null 2>&1; then
  log "Health check on :${PORT} ..."
  if curl -fsS "http://127.0.0.1:${PORT}/health"; then
    echo
    if [ "$RESTARTED" = "1" ]; then
      log "Bridge is up."
    else
      err "Responding — but this is the OLD process. See above."
    fi
  else
    err "No /health response yet — service may still be starting. Check: journalctl -u ${SERVICE} -f"
  fi
fi

log "Done."
