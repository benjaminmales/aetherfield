#!/usr/bin/env bash
#
# Sets this gateway's hostname to aura-gw-<shortcode> so it is individually
# reachable on a shared LAN at http://aura-gw-<shortcode>.local:3000 (avahi/mDNS
# publishes <hostname>.local automatically). The short code matches the serial
# etched on the case, so an operator reads the SN and browses straight to it.
#
# Run once on the Pi:  sudo bash scripts/set-gateway-hostname.sh
# Safe to re-run; idempotent.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Derive the short code (config override wins, else from the Pi CPU serial).
SHORT="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).gatewayShortCode||""))}catch(e){}' "$APP_DIR/config.local.json" 2>/dev/null || true)"
[ -z "$SHORT" ] && SHORT="$(node "$APP_DIR/scripts/gen-hardware-id.js" --short 2>/dev/null || true)"
if [ -z "$SHORT" ]; then
  echo "Could not determine short code." >&2
  exit 1
fi

NAME="aura-gw-$(printf '%s' "$SHORT" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')"
CURRENT="$(hostnamectl --static 2>/dev/null || hostname)"

if [ "$CURRENT" = "$NAME" ]; then
  echo "Hostname already $NAME — nothing to do."
else
  hostnamectl set-hostname "$NAME"
  # keep /etc/hosts consistent so sudo/local lookups stay fast
  if grep -qE '^\s*127\.0\.1\.1\s' /etc/hosts; then
    sed -i "s/^\s*127\.0\.1\.1\s.*/127.0.1.1\t$NAME/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$NAME" >> /etc/hosts
  fi
  echo "Hostname set to $NAME"
fi

# Make sure avahi is running so <hostname>.local resolves.
systemctl enable --now avahi-daemon 2>/dev/null || true
systemctl restart avahi-daemon 2>/dev/null || true

echo "Reachable at: http://$NAME.local:3000/field-setup.html"
