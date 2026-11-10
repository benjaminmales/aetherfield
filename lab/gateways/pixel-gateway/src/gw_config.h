/*
 * Per-gateway configuration.
 *
 * Static addressing, deliberately. On a dedicated event LAN with four
 * gateways per server there is no DHCP server worth depending on at 3am, and
 * a fixed address means "which gateway is that" is answerable from a switch
 * port. The last octet is the gateway number, so gw-01 is .11, gw-02 is .12.
 *
 * Override any of these at build time without editing the file:
 *   west build -- -DCONFIG_... no; these are plain defines, so use:
 *   -DEXTRA_CFLAGS="-DGW_INDEX=2"
 */
#ifndef GW_CONFIG_H
#define GW_CONFIG_H

/* 1..4 within a server's group. Sets the IP and the HELLO name. */
#ifndef GW_INDEX
#define GW_INDEX 1
#endif

/* Server (the Beelink) and the port aetherfield-pixel listens on. */
#define GW_SERVER_IP    "10.10.0.1"
#define GW_SERVER_PORT  9000

/* This gateway. */
#define GW_IP_PREFIX    "10.10.0."
#define GW_IP_BASE      10          /* + GW_INDEX  ->  10.10.0.11 for gw-01 */
#define GW_NETMASK      "255.255.255.0"
#define GW_ROUTER       "10.10.0.254"

/* Local TCP source port. Distinct per gateway only to make packet captures
 * easier to read; the server does not care. */
#define GW_LOCAL_PORT   (50000 + GW_INDEX)

/*
 * Link timings, from docs/PROTOCOL.md.
 *   PING when idle so NAT and switch state stay alive and both ends get a
 *   liveness signal; reconnect forever, because the server never dials out
 *   and a gateway that gives up is gone until someone power-cycles it.
 */
#define GW_PING_INTERVAL_MS   25000
#define GW_RECONNECT_MIN_MS   500
#define GW_RECONNECT_MAX_MS   15000

/* Outbound line buffer. Beacons at 10 s across a few hundred devices is a
 * few hundred bytes a second, so this is generous. */
#define GW_TXQ_BYTES          4096
#define GW_LINE_MAX           256

#endif /* GW_CONFIG_H */
