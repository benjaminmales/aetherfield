#!/usr/bin/env bash
# Raspberry Pi OS Bookworm (NetworkManager): create a Wi‑Fi hotspot for field setup.
# Usage: sudo ./enable-ap-nmcli.sh [SSID] [PASSWORD] [IFACE]
# Default IFACE wlan0. Hotspot IP is often 10.42.0.1 — run: ip -4 route | grep wlan0

set -euo pipefail

SSID="${1:-AURA-GW-setup}"
PASS="${2:-}"
IFACE="${3:-wlan0}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo"
  exit 1
fi

if [[ -z "$PASS" ]] || [[ ${#PASS} -lt 8 ]]; then
  echo "Set a WPA password (8+ chars) as second argument, e.g."
  echo "  sudo $0 AURA-GW-mygw 'your-long-pass'"
  exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "nmcli not found. Install NetworkManager or use hostapd/dnsmasq (see README)."
  exit 1
fi

nmcli connection down Hotspot 2>/dev/null || true
nmcli device wifi hotspot ifname "$IFACE" ssid "$SSID" password "$PASS"

echo ""
echo "Hotspot SSID: $SSID"
echo "Open field setup: http://$(ip -4 addr show "$IFACE" 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1):3000/field-setup.html"
echo "(If IP is empty, try http://10.42.0.1:3000/field-setup.html — common NM hotspot address.)"
