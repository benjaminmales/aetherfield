#!/usr/bin/env bash
#
# Privileged helper for the field-recovery AP. This is the ONLY command the
# bridge user is granted passwordless sudo for, so the broad operations
# (rfkill / iw / iptables / the dnsmasq-shared conf) live behind one auditable
# entry point instead of sprinkling sudo across ap-fallback.sh.
#
set -euo pipefail

CAPTIVE_CONF="/etc/NetworkManager/dnsmasq-shared.d/aura-captive.conf"
AP_IP="10.42.0.1"

cmd="${1:-}"
case "$cmd" in
  radio)
    # Unblock the radio and set a reg domain that PERMITS AP beaconing.
    region="${2:-GB}"
    rfkill unblock wifi 2>/dev/null || true
    iw reg set "$region" 2>/dev/null || true
    ;;
  captive-on)
    iface="${2:-wlan0}"; port="${3:-3000}"
    install -d -m 755 "$(dirname "$CAPTIVE_CONF")"
    printf 'address=/#/%s\n' "$AP_IP" > "$CAPTIVE_CONF"
    iptables -t nat -C PREROUTING -i "$iface" -p tcp --dport 80 -j REDIRECT --to-ports "$port" 2>/dev/null \
      || iptables -t nat -A PREROUTING -i "$iface" -p tcp --dport 80 -j REDIRECT --to-ports "$port"
    ;;
  captive-off)
    iface="${2:-wlan0}"; port="${3:-3000}"
    rm -f "$CAPTIVE_CONF" 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "$iface" -p tcp --dport 80 -j REDIRECT --to-ports "$port" 2>/dev/null || true
    ;;
  clients)
    # Number of stations associated to the AP (needs root for station dump).
    iface="${2:-wlan0}"
    iw dev "$iface" station dump 2>/dev/null | grep -c '^Station' || true
    ;;
  *)
    echo "usage: ap-helper.sh {radio <REGION>|captive-on <IFACE> <PORT>|captive-off <IFACE> <PORT>|clients <IFACE>}" >&2
    exit 2
    ;;
esac
