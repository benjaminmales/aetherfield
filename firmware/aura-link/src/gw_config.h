/*
 * Per-gateway configuration.
 *
 * Static addressing, deliberately. On a dedicated event LAN there is no DHCP
 * server worth depending on at 3am, and a fixed address means "which gateway
 * is that" is answerable from a switch port. The last octet is the gateway
 * number plus ten, so gw-01 is .11 and gw-30 is .40.
 *
 * Override any of these at build time without editing the file:
 *   west build -- -DCONFIG_... no; these are plain defines, so use:
 *   -DEXTRA_CFLAGS="-DGW_INDEX=2"
 */
#ifndef GW_CONFIG_H
#define GW_CONFIG_H

/*
 * 1..30 within a server's group. Sets the IP, the HELLO name, the source port
 * and the downlink stagger slot.
 *
 * Set it with a Kconfig fragment — gw01.conf .. gw30.conf — so every gateway
 * builds from identical source and nothing has to be edited between flashes.
 * The plain -DGW_INDEX= route still works for a one-off from the command line.
 */
#ifndef GW_INDEX
#ifdef CONFIG_GW_INDEX
#define GW_INDEX CONFIG_GW_INDEX
#else
#define GW_INDEX 1
#endif
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

/*
 * Downlink stagger.
 *
 * The server broadcasts one command and every gateway receives it within a
 * few milliseconds of every other. Each then transmits AURA_CMD_REPEAT frames.
 * At three gateways that is invisible; at thirty it is 90 frames inside 75 ms
 * from thirty transmitters that can all hear each other, so they collide with
 * each other AND jam every device beacon in the building — at precisely the
 * moment the show is trying to change colour.
 *
 * Each gateway therefore waits (GW_INDEX - 1) * this before its first frame.
 * At 30 gateways that spreads transmission over 87 ms, which is below the
 * threshold at which a crowd reads a colour change as anything but
 * simultaneous.
 *
 * Better still, and the reason SYNC carries epoch_ms: send the apply-time
 * with the command so devices act together regardless of which gateway
 * reached them and when. The stagger fixes the collisions; the epoch fixes
 * the simultaneity. They are complementary, not alternatives.
 */
#define GW_CMD_STAGGER_MS     3

/*
 * Outbound line buffer.
 *
 * 4096 was sized for "a few hundred devices at 10 s", which is a few hundred
 * bytes a second. A gateway hearing 3,000 devices emits a '<BCN' and its
 * legacy 'NODE:' twin per beacon — around 86 kB/s at 675 beacons/s — and 4 kB
 * is then 48 ms of slack. Any hiccup longer than that starts discarding
 * telemetry, and because the drop policy is oldest-first the loss is silent.
 *
 * 16 kB is ~190 ms at that rate: enough to ride out a command's transmit
 * gaps and a slow socket write, and still trivial against this SoC's RAM.
 */
#define GW_TXQ_BYTES          16384
#define GW_LINE_MAX           256

/*
 * Console mirror budget, in lines per second.
 *
 * gw_emit() mirrors every telemetry line to the UART so a human on USB sees
 * what the server sees. At 115200 baud that is about 90 short lines a second,
 * full stop — and a gateway hearing 3,000 devices produces many times that.
 * printk() then blocks the radio receive thread and the gateway drops frames,
 * which looks exactly like RF saturation and is not.
 *
 * Above this budget the mirror starts dropping lines and says so once a
 * second. The LINK is never throttled: the server still gets everything. Only
 * the human's view degrades, which is the correct thing to sacrifice.
 */
#define GW_MIRROR_MAX_LPS     40

/*
 * The legacy 'NODE: id=...' twin.
 *
 * Every beacon used to emit two lines: the structured '<BCN' the pixel server
 * parses, and this one, which exists for pi-bridge's parseTelemetryLine().
 * The pixel and stress servers both speak v2 and explicitly discard NODE:
 * lines, so on this deployment the twin is pure cost — and it is not a small
 * one. It doubles the vsnprintk work on the 802.15.4 receive thread, doubles
 * the bytes through the txq, and doubles what the socket has to carry. At
 * 3,000 devices that is the difference between ~43 kB/s and ~86 kB/s, and the
 * txq overruns that produced 'line too long' disconnects were half this line.
 *
 * Off by default. Set to 1 for a deployment that still runs pi-bridge.
 */
#ifndef GW_LEGACY_NODE_LINE
#define GW_LEGACY_NODE_LINE   0
#endif

/* Reported in HELLO and on the console banner. */
#define GW_FW_VERSION         "aura-link-1.2.0"

#endif /* GW_CONFIG_H */
