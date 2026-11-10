#!/usr/bin/env bash
#
# Field recovery AP. When the gateway has no internet, raise a setup Wi-Fi AP so
# an operator can join it (no screen/keyboard needed) and open the setup page.
# When the gateway is online, take the AP down so the single radio is free.
#
# Run at boot and on a short timer (see the .timer unit). Designed for the Pi 5's
# SINGLE Wi-Fi radio, which can't be client and AP at once — so we drop the client
# connection before raising the AP, and once the AP is up we HOLD it for a window
# so an operator mid-config isn't kicked off the moment Wi-Fi flickers back.
#
# Touring-safe regulatory handling:
#   - The AP runs on 2.4GHz channel 6, which is permitted in essentially every
#     country. We set the reg domain to the configured region (config wifiRegion,
#     default GB) only so the radio is allowed to BEACON (the world domain "00"
#     blocks AP beaconing on most kernels — a common "AP never appears" cause).
#   - The CLIENT link adopts the venue's country automatically via 802.11d.
#
# Captive portal: while the AP is up we point its dnsmasq at this Pi and redirect
# inbound http :80 to the bridge, so phones auto-open the setup page.
#
# Overrides via env (set in the systemd unit): AP_PASSWORD (8+ chars), AP_IFACE,
# AP_HOLD_SECS, BRIDGE_PORT.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IFACE="${AP_IFACE:-wlan0}"
PASS="${AP_PASSWORD:-aetherfield-setup}"
AP_CON="aura-setup-ap"
BRIDGE_PORT="${BRIDGE_PORT:-3000}"
HOLD_SECS="${AP_HOLD_SECS:-300}"
BOOT_HOLD="${AP_BOOT_HOLD:-90}"  # guaranteed AP window on every boot
HOLD_FILE="/tmp/aura-ap-hold"    # user-writable; cleared on reboot (that's fine)
HELPER="$APP_DIR/scripts/ap-helper.sh"
AP_IP="10.42.0.1"   # NetworkManager 'shared' mode gateway address
MODE="${1:-check}"  # "boot" = force the boot window; default "check" = supervise

command -v nmcli >/dev/null 2>&1 || { echo "nmcli required (NetworkManager)"; exit 1; }

# Read a key from config.local.json without extra deps.
read_cfg() {
  node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c[process.argv[2]]||""))}catch(e){}' \
    "$APP_DIR/config.local.json" "$1" 2>/dev/null || true
}

SHORT="$(read_cfg gatewayShortCode)"
REGION="$(read_cfg wifiRegion)"; REGION="${REGION:-GB}"
SUFFIX="$(printf '%s' "${SHORT:-$(hostname)}" | tr -cd 'A-Za-z0-9' | tail -c 6 | tr 'a-z' 'A-Z')"
[ -z "$SUFFIX" ] && SUFFIX="SETUP"
SSID="AURA-GATEWAY-$SUFFIX"

ensure_radio() { sudo "$HELPER" radio "$REGION" 2>/dev/null || true; }
captive_on()   { sudo "$HELPER" captive-on "$IFACE" "$BRIDGE_PORT" 2>/dev/null || true; }
captive_off()  { sudo "$HELPER" captive-off "$IFACE" "$BRIDGE_PORT" 2>/dev/null || true; }

ap_active() { nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$AP_CON"; }

# A connected station means an operator is on the AP right now — never kick them.
clients_connected() {
  local n
  n="$(sudo "$HELPER" clients "$IFACE" 2>/dev/null || echo 0)"
  [ "${n:-0}" -gt 0 ]
}

# HOLD_FILE stores an absolute expiry time (epoch seconds).
set_hold() { echo $(( $(date +%s) + ${1:-$HOLD_SECS} )) > "$HOLD_FILE" 2>/dev/null || true; }
within_hold() {
  [ -f "$HOLD_FILE" ] || return 1
  [ "$(date +%s)" -lt "$(cat "$HOLD_FILE" 2>/dev/null || echo 0)" ]
}

raise_ap() {  # $1 = hold window in seconds (defaults to HOLD_SECS)
  ensure_radio
  # Free the single radio: drop any active client Wi-Fi (but not our own AP).
  while IFS=: read -r name type; do
    [ "$type" = "802-11-wireless" ] && [ "$name" != "$AP_CON" ] && nmcli connection down "$name" >/dev/null 2>&1 || true
  done < <(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null)

  # Deterministic AP profile on a globally-safe 2.4GHz channel.
  nmcli connection delete "$AP_CON" >/dev/null 2>&1 || true
  nmcli connection add type wifi ifname "$IFACE" con-name "$AP_CON" autoconnect no ssid "$SSID" >/dev/null
  nmcli connection modify "$AP_CON" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    802-11-wireless.channel 6 \
    ipv4.method shared \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$PASS" >/dev/null
  nmcli connection up "$AP_CON" >/dev/null
  captive_on
  set_hold "${1:-$HOLD_SECS}"
  echo "Setup AP '$SSID' up on $IFACE (ch6, region $REGION) → http://$AP_IP/ (password: $PASS)"
}

drop_ap() {
  captive_off
  nmcli connection down "$AP_CON" >/dev/null 2>&1 || true
  rm -f "$HOLD_FILE" 2>/dev/null || true
  echo "Setup AP down."
}

# ── Boot window ────────────────────────────────────────────────────────────
# Force the AP up immediately on power-up so an operator can always connect in
# the first few seconds — even when the saved Wi-Fi is fine. Held BOOT_HOLD secs.
if [ "$MODE" = "boot" ]; then
  ap_active || raise_ap "$BOOT_HOLD"
  echo "Boot window: setup AP up for ${BOOT_HOLD}s."
  exit 0
fi

# ── Periodic supervisor (timer) ────────────────────────────────────────────
# An operator actively connected to the AP keeps it up no matter what.
if ap_active && clients_connected; then
  set_hold 180
  echo "Operator connected to setup AP — holding."
  exit 0
fi

# AP up but its window elapsed and nobody's connected → drop it so the single
# radio can (re)join the venue Wi-Fi. We can't sense Wi-Fi while the AP owns the
# radio, so we drop first and let the next tick re-raise the AP if still offline.
if ap_active && ! within_hold; then
  drop_ap
  exit 0
fi

# AP up and still inside its window → leave it.
if ap_active; then
  echo "Holding setup AP (window active)."
  exit 0
fi

# AP not up → ordinary connectivity-based fallback.
online="$(nmcli networking connectivity 2>/dev/null || echo unknown)"
if [ "$online" = "full" ]; then
  echo "Online ($online) — no AP needed."
else
  raise_ap "$HOLD_SECS"
fi
