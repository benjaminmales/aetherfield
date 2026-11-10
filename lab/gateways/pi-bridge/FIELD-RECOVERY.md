# Field recovery — setup AP + captive portal

How to reconfigure a gateway's Wi‑Fi in the field with **no screen or keyboard**.

## How it works

The Pi 5 has a **single Wi‑Fi radio**, so it can't be a client and an access point
at the same time. The recovery service handles this:

- A timer checks connectivity ~20 s after boot, then every 60 s.
- When the gateway is **offline**, it drops the client Wi‑Fi, frees the radio, and
  raises a setup AP: **`AURA-GATEWAY-<last 6 of short code>`** (default password
  `aetherfield-setup`).
- Once the AP is up it is **held for 5 min** even if Wi‑Fi flickers back, so an
  operator mid‑config isn't kicked off.
- A **captive portal** (DNS hijack + `:80→:3000` redirect) makes phones auto‑open
  the setup page on join. If it doesn't pop, browse to `http://10.42.0.1/`.
- When the gateway is **online**, the AP is torn down so the radio is free.

## Operator flow in the field

1. Power‑cycle the unit (or hold the config button, once the HAT has one).
2. Within ~20 s, join Wi‑Fi **`AURA-GATEWAY-XXXXXX`** from a phone/laptop.
3. The setup page opens automatically (or go to `http://10.42.0.1/`).
4. Enter the venue Wi‑Fi and Save. The gateway joins it and the AP drops.

## Touring / regulatory

The country code is **not hardcoded**:

- The setup AP runs on **2.4 GHz channel 6**, which is permitted in essentially
  every country. A reg domain is set (config `wifiRegion`, default `GB`) only so the
  radio is allowed to *beacon* — the world domain `00` blocks AP beaconing on most
  kernels, which is a common "AP never appears" cause.
- The **venue Wi‑Fi link adopts the local country automatically via 802.11d**, so the
  client connection is always compliant wherever you tour.
- Change the AP's region per tour leg under **Setup → Advanced → Wi‑Fi region** only
  in the rare case the AP itself misbehaves in a new country.

## Install (once per Pi)

```bash
cd ~/aetherfield-platform/GATEWAY/pi-bridge
sudo bash scripts/install-field-recovery.sh
```

This installs a **scoped sudoers** rule (passwordless for only `ap-helper.sh`),
the systemd service + timer, and enables NetworkManager's dnsmasq for captive DNS.
Idempotent — safe to re‑run after a `git pull`.

## Test / debug

```bash
sudo systemctl start aura-ap-fallback.service
journalctl -u aura-ap-fallback -n 20 --no-pager
nmcli connection show --active        # look for 'aura-setup-ap'
iw reg get                            # confirm the reg domain is set
```
