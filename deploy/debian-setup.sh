#!/usr/bin/env bash
#
# One-shot provisioning for an Aetherfield Pixel event server on Debian 13 (trixie); also works on 12.
# Idempotent — safe to re-run after a git pull or a config change.
#
#   sudo bash deploy/debian-setup.sh
#   sudo bash deploy/debian-setup.sh --server-id srv-2 --gateway-nic enp2s0
#
# What it does:
#   - installs Node 20 (NodeSource) and git
#   - creates the unprivileged `pixel` user
#   - installs the app to /opt/aetherfield-pixel
#   - writes .env if missing (never overwrites an existing one)
#   - installs + enables the systemd unit
#   - opens the gateway and console ports in nftables
#
# What it deliberately does NOT do:
#   - configure IP addresses. Static addressing for the gateway NIC is a
#     site decision; the script prints the exact commands instead.

set -euo pipefail

SERVER_ID="srv-1"
GATEWAY_NIC=""
APP_DIR="/opt/aetherfield-pixel"
SVC_USER="pixel"
GW_PORT=9000
HTTP_PORT=3000

while [ $# -gt 0 ]; do
  case "$1" in
    --server-id)   SERVER_ID="$2"; shift 2 ;;
    --gateway-nic) GATEWAY_NIC="$2"; shift 2 ;;
    --app-dir)     APP_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say "Packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git nftables >/dev/null
note "curl, git, nftables"

say "Node.js"
node_major() { command -v node >/dev/null 2>&1 && node -v | cut -c2- | cut -d. -f1 || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  # Debian 13 (trixie) ships Node 20 in main — prefer it over a third-party
  # repo. Only fall back to NodeSource on older releases where it's too old.
  apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
  if [ "$(node_major)" -lt 20 ]; then
    note "distro node too old — adding NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
fi
note "$(node -v)  npm $(npm -v 2>/dev/null || echo '-')"

say "Service user"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  note "created $SVC_USER"
else
  note "$SVC_USER exists"
fi

say "Application"
mkdir -p "$APP_DIR"
# Copy everything except VCS, deps and local state. Not a git clone: the box may
# be offline, and the operator may be deploying a tested working tree.
tar -C "$SRC_DIR" \
    --exclude=.git --exclude=node_modules --exclude='*.log' --exclude=data \
    -cf - . | tar -C "$APP_DIR" -xf -
mkdir -p "$APP_DIR/server/data"

say "Dependencies"
cd "$APP_DIR/server"
npm install --omit=dev --no-audit --no-fund --silent
note "installed into $APP_DIR/server/node_modules"

say "Configuration"
ENV_FILE="$APP_DIR/server/.env"
if [ -f "$ENV_FILE" ]; then
  note ".env exists — left untouched"
else
  GW_HOST="0.0.0.0"
  if [ -n "$GATEWAY_NIC" ]; then
    GW_HOST="$(ip -4 -o addr show "$GATEWAY_NIC" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
    [ -n "$GW_HOST" ] || { echo "No IPv4 on $GATEWAY_NIC — assign one first." >&2; exit 1; }
  fi
  cat > "$ENV_FILE" <<EOF
HTTP_PORT=$HTTP_PORT
HTTP_HOST=0.0.0.0
GATEWAY_PORT=$GW_PORT
GATEWAY_HOST=$GW_HOST
SERVER_ID=$SERVER_ID
CLOUD_URL=
CLOUD_TOKEN=
EOF
  note "wrote .env (SERVER_ID=$SERVER_ID, GATEWAY_HOST=$GW_HOST)"
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
chmod 640 "$ENV_FILE"

say "Firewall"
if ! nft list table inet filter >/dev/null 2>&1; then
  nft add table inet filter
  nft add chain inet filter input '{ type filter hook input priority 0; policy accept; }'
fi
for p in "$GW_PORT" "$HTTP_PORT" 22; do
  if ! nft list chain inet filter input 2>/dev/null | grep -q "dport $p accept"; then
    nft add rule inet filter input tcp dport "$p" accept
  fi
done
mkdir -p /etc/nftables.d
nft list ruleset > /etc/nftables.conf
systemctl enable --now nftables >/dev/null 2>&1 || true
note "TCP $GW_PORT (gateways), $HTTP_PORT (console), 22 (ssh) allowed"

say "Service"
install -m 0644 "$APP_DIR/deploy/aetherfield-pixel.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable aetherfield-pixel >/dev/null
systemctl restart aetherfield-pixel
sleep 2

if systemctl is-active --quiet aetherfield-pixel; then
  note "running"
else
  echo "    FAILED — journalctl -u aetherfield-pixel -n 40" >&2
  exit 1
fi

IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

Ready.

  Console      http://$IP:$HTTP_PORT/
  Gateways     tcp://$IP:$GW_PORT   (SERVER_ID=$SERVER_ID)
  Logs         journalctl -u aetherfield-pixel -f
  Restart      systemctl restart aetherfield-pixel

Test it without hardware:
  node $APP_DIR/tools/sim-gateway.js --host $IP --id gw-01 --devices 10

EOF

if [ -z "$GATEWAY_NIC" ]; then
  cat <<'EOF'
Next: put the gateways on their own subnet.

  ip -br link                                  # find the two i226 NICs
  nmcli con add type ethernet ifname enp2s0 con-name gateways \
        ipv4.method manual ipv4.addresses 10.10.0.1/24 ipv4.never-default yes
  nmcli con up gateways

`never-default` matters: it stops the gateway subnet from stealing the default
route from the internet-facing NIC. Then re-run this script with
--gateway-nic enp2s0 to bind the listener to that interface only.
EOF
fi
