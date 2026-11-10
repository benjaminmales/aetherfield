#!/usr/bin/env bash
#
# ONE-TIME: flatten the auto-created firmware sub-repos into aetherfield-platform.
#
# The editor/firmware tooling left a throwaway .git in each of these folders
# (single "Initial commit", no remote). This removes those nested .git dirs so
# the files become normal tracked files of the parent repo, then commits the
# new work (AURA/, NODE/, include/, PROTOCOL.md, GATEWAY firmware edits).
#
# SAFETY: dry-run by default. Review, then re-run with --run.
# Run this on your Mac (this needs to delete files + commit; a sandbox can't).
#
set -euo pipefail

RUN=0
[ "${1:-}" = "--run" ] && RUN=1

PATHS=(
  "NODE/node-firmware"
  "AURA/K7"
  "AURA/holyiot"
  "AURA/seeedFirmware"
  "AURA/sniffer"
)

log() { printf '\033[1;36m[flatten]\033[0m %s\n' "$*"; }
do_() { printf '\033[1;33m  $\033[0m %s\n' "$*"; [ "$RUN" = 1 ] && eval "$*"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

[ "$RUN" = 1 ] || log "DRY RUN — showing commands only. Re-run with --run to apply."

# Clear stale locks that block git writes.
do_ "rm -f '$REPO_ROOT/.git/index.lock'"

for p in "${PATHS[@]}"; do
  log "Flattening $p"
  [ -e "$p/.git" ] || { log "  no nested .git — skipping"; continue; }
  # If it's tracked as a gitlink (node-firmware), drop the gitlink from the index.
  do_ "git rm -r --cached '$p' 2>/dev/null || true"
  # Remove the throwaway nested repo so the files become plain files.
  do_ "rm -rf '$p/.git'"
done

# Stage everything new and commit on the parent.
do_ "git add -A"
log "Pending changes after staging:"
[ "$RUN" = 1 ] && git status --short || true
do_ "git commit -m 'Flatten firmware into repo; add radio protocol + Pi updater'"

log "Review with: git show --stat"
log "Then push with: git push origin main"
[ "$RUN" != 1 ] && log "This was a DRY RUN. Apply with: ./scripts/flatten-firmware.sh --run"
