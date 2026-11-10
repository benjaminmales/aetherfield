#!/usr/bin/env bash
#
# One-time installer for the gateway's field-recovery AP + captive portal.
# Run on the Pi:   sudo bash scripts/install-field-recovery.sh
#
# It:
#   - installs a scoped sudoers rule so the bridge user can run ONLY ap-helper.sh
#     (rfkill/iw/iptables/dnsmasq-shared conf) without a password,
#   - installs the systemd service + timer (templated to this repo path/user),
#   - enables NetworkManager's dnsmasq for 'shared' connections (captive DNS),
#   - starts the recovery timer.
#
# Idempotent — safe to re-run after a git pull.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$APP_DIR/scripts"
RUN_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
AP_PASSWORD="${AP_PASSWORD:-aetherfield-setup}"

echo "Repo:  $APP_DIR"
echo "User:  $RUN_USER"

chmod +x "$SCRIPTS/ap-fallback.sh" "$SCRIPTS/ap-helper.sh"

# 1. Scoped sudoers — passwordless for ONLY the helper.
cat > /etc/sudoers.d/aura-ap <<EOF
# Allow the gateway bridge user to run the AP privileged helper without a password.
$RUN_USER ALL=(root) NOPASSWD: $SCRIPTS/ap-helper.sh
EOF
chmod 0440 /etc/sudoers.d/aura-ap
visudo -cf /etc/sudoers.d/aura-ap >/dev/null && echo "sudoers: installed (helper only)"

# 2. NetworkManager: use dnsmasq for shared connections so captive DNS works.
install -d -m 755 /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/00-aura-dns.conf <<'EOF'
[main]
dns=dnsmasq
EOF
install -d -m 755 /etc/NetworkManager/dnsmasq-shared.d

# 3. systemd units (templated path + user + AP password): supervisor service,
#    timer, and the boot-window service.
sed -e "s#^ExecStart=.*#ExecStart=$SCRIPTS/ap-fallback.sh#" \
    -e "s#^Environment=AP_PASSWORD=.*#Environment=AP_PASSWORD=$AP_PASSWORD#" \
    "$SCRIPTS/aura-ap-fallback.service" > /etc/systemd/system/aura-ap-fallback.service

sed -e "s#^ExecStart=.*#ExecStart=$SCRIPTS/ap-fallback.sh boot#" \
    -e "s#^Environment=AP_PASSWORD=.*#Environment=AP_PASSWORD=$AP_PASSWORD#" \
    "$SCRIPTS/aura-ap-boot.service" > /etc/systemd/system/aura-ap-boot.service

# both run as the bridge user (so config.local.json + nmcli session match)
for u in aura-ap-fallback aura-ap-boot; do
  if ! grep -q '^User=' /etc/systemd/system/$u.service; then
    sed -i "/^\[Service\]/a User=$RUN_USER" /etc/systemd/system/$u.service
  fi
done
cp "$SCRIPTS/aura-ap-fallback.timer" /etc/systemd/system/aura-ap-fallback.timer

systemctl daemon-reload
systemctl enable aura-ap-boot.service
systemctl enable --now aura-ap-fallback.timer
systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager || true

echo
echo "✓ Field recovery installed. The setup AP will appear within ~20s of boot whenever"
echo "  the gateway is offline. Run a check now with:"
echo "    sudo systemctl start aura-ap-fallback.service && journalctl -u aura-ap-fallback -n 20 --no-pager"
