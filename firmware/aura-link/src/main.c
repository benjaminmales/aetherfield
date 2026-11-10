/*
 * Aetherfield Pixel gateway - protocol v2
 *
 * Seeed XIAO nRF54LM20A + WIZnet W5500 Ethernet.
 *
 * Ported from GATEWAY/nrf54-firmware. Two changes, both mechanical:
 *   - telemetry goes through gw_emit() instead of gw_emit(), which mirrors it
 *     to the console AND queues the completed line for the server;
 *   - link_init() starts the TCP thread.
 * The radio path is byte-for-byte the firmware that already works. The W5500
 * runs its own TCP stack in silicon precisely so that stays true - see
 * README.md.
 *
 * Original notes follow.
 *
 * Seeed XIAO nRF54L15. Hardware PAN/address filtering (PAN 0xAE7F,
 * addr 0x0001). RX BEACON / EVENT / CONTACT / NODE_RELAY, TX CMD and SYNC.
 *
 * ------------------------------------------------------------------------
 * Host interface
 * ------------------------------------------------------------------------
 *
 * Two line formats go out of the console, deliberately:
 *
 *   "<..." / ">..."   v2 structured lines. Machine-parseable by splitting on
 *                     spaces and then on '=', and still readable in CoolTerm.
 *                     '<' is something we received, '>' something we sent.
 *
 *   "NODE: id=..."    the legacy line pi-bridge's parseTelemetryLine() greps.
 *                     Kept because migration order is gateway FIRST - the Pi
 *                     must keep working while the bands are still on v0.
 *                     Delete once pi-bridge speaks the '<' format.
 *
 * ------------------------------------------------------------------------
 * Unicast
 * ------------------------------------------------------------------------
 *
 * CMD is normally broadcast, but the MAC header has a dst field and devices
 * run hardware address filtering - so addressing one device costs nothing and
 * needs no protocol change. That is how IDENTIFY targets a single band.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>
#include <nrf_802154.h>
#include <stdlib.h>
#include <string.h>

#include "aura_radio.h"
#include "link.h"
#include "status.h"
#include "link_cfg.h"
/* GW_INDEX and GW_CMD_STAGGER_MS. Without this the '#if GW_INDEX > 1' below
 * evaluates an undefined macro as 0, the stagger compiles out silently, and
 * thirty gateways transmit on the same millisecond exactly as before. */
#include "gw_config.h"

LOG_MODULE_REGISTER(app, CONFIG_LOG_DEFAULT_LEVEL);

#define MAX_FRAME_LEN     127
#define CMD_REPEAT_GAP_MS 25
#define HOP_ANNOUNCE_GAP_MS 100

#define RFSW_CTL_NODE DT_NODELABEL(rfsw_ctl)
#define RFSW_EXTERNAL_LEVEL 0

/*
 * The nRF54L15 XIAO carries an antenna switch and aliases it to rfsw_ctl.
 * Whether the LM20A board does is a board fact, not an assumption worth
 * baking in - so this compiles out entirely when the node is absent, and
 * 'ant' says so rather than silently doing nothing.
 */
#define HAVE_RFSW DT_NODE_EXISTS(RFSW_CTL_NODE)

#if HAVE_RFSW
static const struct gpio_dt_spec rfsw_gpio = {
	.port = DEVICE_DT_GET(DT_GPIO_CTLR(RFSW_CTL_NODE, enable_gpios)),
	.pin = DT_GPIO_PIN(RFSW_CTL_NODE, enable_gpios),
	.dt_flags = DT_GPIO_FLAGS(RFSW_CTL_NODE, enable_gpios),
};
#endif

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;

/* Current commanded state. The gateway is the authority: every CMD carries
 * the complete device state, so this struct IS what the fleet is doing. */
static struct aura_cmd g_state = {
	.seq = 0,
	.group = AURA_GROUP_ALL,
	.anim_mode = AURA_ANIM_STEADY,
	.anim_param = 0,
	.op_mode = AURA_OP_NORMAL,
	.op_param = 0,
	.r = 0, .g = 0, .b = 0,
	.bright = 255,
	.dev_flags = 0,
};

static uint8_t  g_mac_seq = 0;
static uint8_t  g_channel = AURA_CHANNEL_DEFAULT;
static uint32_t g_rx_count = 0;
static uint32_t g_rx_v2_count = 0;
static uint32_t g_rx_v0_count = 0;
static bool     g_promiscuous = false;
static bool     g_sync_enabled = true;
static uint8_t  g_wave_step = 0;

/* ------------------------------------------------------------------ */
/* Fleet table                                                         */
/*                                                                     */
/* Populated passively from beacons - there is no discovery handshake.  */
/* Its real job is the delivery statistic: every beacon echoes the last */
/* CMD seq that device acted on, so comparing against g_state.seq tells */
/* us what fraction of the fleet is actually current. On an             */
/* unacknowledged broadcast protocol this is the only visibility there  */
/* is, and it is the difference between "the show looked wrong" and     */
/* "that section lost 40% of its commands".                             */
/* ------------------------------------------------------------------ */

#define FLEET_MAX 48

struct fleet_entry {
	uint16_t addr;
	uint8_t  caps;
	uint8_t  battery;
	uint8_t  flags;
	uint8_t  last_cmd_seq;
	int8_t   rssi;
	uint8_t  node_id;      /* 0 = heard directly */
	uint32_t last_seen_ms;
	uint32_t beacons;
};

static struct fleet_entry g_fleet[FLEET_MAX];
static uint8_t g_fleet_n;

static struct fleet_entry *fleet_find(uint16_t addr)
{
	for (uint8_t i = 0; i < g_fleet_n; i++) {
		if (g_fleet[i].addr == addr) {
			return &g_fleet[i];
		}
	}
	if (g_fleet_n < FLEET_MAX) {
		struct fleet_entry *e = &g_fleet[g_fleet_n++];

		memset(e, 0, sizeof(*e));
		e->addr = addr;
		return e;
	}
	return NULL;
}

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

/* Only the legacy line spells a gesture out; the '<EVT' line sends the code. */
#if GW_LEGACY_NODE_LINE
static const char *gesture_name_from_code(uint8_t code)
{
	switch (code) {
	case 0: return "idle";
	case 1: return "unknown";
	case 2: return "clap";
	default: return "gesture";
	}
}

/* Legacy line for pi-bridge. Compiled out unless GW_LEGACY_NODE_LINE. */
static void print_legacy_node(uint8_t node_id, uint16_t addr, int rssi,
			      uint8_t caps, uint8_t battery, uint8_t gesture)
{
	gw_emit("NODE: id=%u UUID: 0x%08X RSSI: %d Caps: 0x%02X Batt: %u Gesture: %s (%u)\n",
	       (unsigned int)node_id, (unsigned int)addr, rssi,
	       (unsigned int)caps, (unsigned int)battery,
	       gesture_name_from_code(gesture), (unsigned int)gesture);
}
#endif

/* ------------------------------------------------------------------ */
/* RX                                                                  */
/* ------------------------------------------------------------------ */

static void handle_beacon(uint16_t addr, uint8_t node_id, int rssi,
			  const uint8_t *p, int len)
{
	if (len < AURA_BEACON_LEN) {
		return;
	}
	uint8_t caps  = p[AURA_BEACON_OFF_CAPS];
	uint8_t batt  = p[AURA_BEACON_OFF_BATT];
	uint8_t flags = p[AURA_BEACON_OFF_FLAGS];
	uint8_t lseq  = p[AURA_BEACON_OFF_LASTSEQ];

	struct fleet_entry *e = fleet_find(addr);

	if (e) {
		e->caps = caps;
		e->battery = batt;
		e->flags = flags;
		e->last_cmd_seq = lseq;
		e->rssi = (int8_t)rssi;
		e->node_id = node_id;
		e->last_seen_ms = k_uptime_get_32();
		e->beacons++;
	}

	gw_emit("<BCN a=%04X n=%u r=%d caps=%02X batt=%u fl=%02X cseq=%u\n",
	       addr, node_id, rssi, caps, batt, flags, lseq);

#if GW_LEGACY_NODE_LINE
	/* gesture byte for the legacy consumer: derive from flags */
	uint8_t gesture = (flags & AURA_FLAG_CLAP) ? 2 :
			  (flags & AURA_FLAG_HAND_RAISED) ? 1 : 0;

	print_legacy_node(node_id, addr, rssi, caps, batt, gesture);
#endif
}

static void handle_event(uint16_t addr, uint8_t node_id, int rssi,
			 const uint8_t *p, int len)
{
	if (len < AURA_EVENT_LEN) {
		return;
	}
	uint8_t type = p[AURA_EVENT_OFF_TYPE];
	uint8_t val  = p[AURA_EVENT_OFF_VALUE];
	uint8_t str  = p[AURA_EVENT_OFF_STRENGTH];
	const char *tn = type == AURA_EVENT_GESTURE ? "gesture" :
			 type == AURA_EVENT_BUTTON  ? "button"  :
			 type == AURA_EVENT_NFC     ? "nfc"     :
			 type == AURA_EVENT_MOTION  ? "motion"  : "?";

	gw_emit("<EVT a=%04X n=%u r=%d t=%s v=%u s=%u\n",
	       addr, node_id, rssi, tn, val, str);

#if GW_LEGACY_NODE_LINE
	if (type == AURA_EVENT_GESTURE) {
		print_legacy_node(node_id, addr, rssi, 0, AURA_BATTERY_UNKNOWN, val);
	}
#endif
}

static void handle_contact(uint16_t addr, uint8_t node_id, int rssi,
			   const uint8_t *p, int len)
{
	if (len < AURA_CONTACT_LEN) {
		return;
	}
	uint16_t peer = (uint16_t)(p[AURA_CONTACT_OFF_PEER] |
				   (p[AURA_CONTACT_OFF_PEER + 1] << 8));
	int peer_rssi = aura_rssi_decode(p[AURA_CONTACT_OFF_RSSI]);
	uint8_t ev = p[AURA_CONTACT_OFF_EVENT];

	gw_emit("<CON a=%04X n=%u r=%d peer=%04X pr=%d ev=%s\n",
	       addr, node_id, rssi, peer, peer_rssi,
	       ev == AURA_CONTACT_OPEN ? "open" : "close");
}

static bool process_v2_frame(const uint8_t *frame, uint8_t len, int8_t rssi)
{
	uint16_t src, dst;

	if (!aura_mhr_parse(frame, len, &src, &dst)) {
		return false;
	}

	/* Hardware filtering already dropped foreign PANs, but in promiscuous
	 * debug mode we see everything - so check the destination ourselves. */
	if (dst != AURA_ADDR_GATEWAY && dst != AURA_ADDR_BROADCAST) {
		return false;
	}

	const uint8_t *p = frame + AURA_MHR_LEN;
	int plen = (int)len - AURA_MHR_LEN;

	if (plen < 2 || p[1] != AURA_VER) {
		return false;
	}

	g_rx_v2_count++;

	switch (p[0]) {
	case AURA_MSG_BEACON:
		handle_beacon(src, 0, rssi, p, plen);
		return true;
	case AURA_MSG_EVENT:
		handle_event(src, 0, rssi, p, plen);
		return true;
	case AURA_MSG_CONTACT:
		handle_contact(src, 0, rssi, p, plen);
		return true;
	case AURA_MSG_NODE_RELAY: {
		if (plen < AURA_NODE_RELAY_HDR_LEN || !aura_addr_is_node(src)) {
			break;
		}
		uint16_t band = (uint16_t)(p[AURA_NODE_RELAY_OFF_ADDR] |
					   (p[AURA_NODE_RELAY_OFF_ADDR + 1] << 8));
		int at_node = aura_rssi_decode(p[AURA_NODE_RELAY_OFF_RSSI]);
		uint8_t node_id = (uint8_t)(src - AURA_ADDR_NODE_BASE + 1);
		const uint8_t *inner = p + AURA_NODE_RELAY_HDR_LEN;
		int ilen = plen - AURA_NODE_RELAY_HDR_LEN;

		if (ilen < 2) {
			break;
		}
		switch (inner[0]) {
		case AURA_MSG_BEACON:  handle_beacon(band, node_id, at_node, inner, ilen); return true;
		case AURA_MSG_EVENT:   handle_event(band, node_id, at_node, inner, ilen);  return true;
		case AURA_MSG_CONTACT: handle_contact(band, node_id, at_node, inner, ilen); return true;
		default: break;
		}
		break;
	}
	default:
		break;
	}
	return false;
}

#if AURA_ACCEPT_V0_AT_GATEWAY
/* Legacy v0. PAN 0x1234 and the malformed FCF mean these are only reachable
 * with `promisc 1` - hardware filtering rejects them otherwise. That is the
 * point of v2, but during migration we still want to SEE them. */
static bool process_v0_frame(const uint8_t *frame, uint8_t len, int8_t rssi)
{
	if (len < AURA_MHR_LEN + 4) {
		return false;
	}
	const uint8_t *p = frame + AURA_MHR_LEN;

	if (p[0] == AURA_V0_PAYLOAD_UUID_BC) {
		uint16_t id = (uint16_t)(p[1] | (p[2] << 8));
		uint8_t flags = p[3];

		g_rx_v0_count++;
		gw_emit("<V0 a=%04X n=0 r=%d fl=%02X\n", id, rssi, flags);
#if GW_LEGACY_NODE_LINE
		print_legacy_node(0, id, rssi, 0, AURA_BATTERY_UNKNOWN,
				  (flags & 0x02) ? 2 : (flags & 0x04) ? 1 : 0);
#endif
		return true;
	}
	return false;
}
#endif

enum net_verdict ieee802154_handle_ack(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);
	ARG_UNUSED(pkt);
	return NET_DROP;
}

int net_recv_data(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);

	if (!pkt || net_pkt_is_empty(pkt)) {
		return -EINVAL;
	}

	uint8_t *psdu = net_buf_frag_last(pkt->buffer)->data;
	size_t length = net_buf_frags_len(pkt->buffer);
	int8_t rssi = net_pkt_ieee802154_rssi_dbm(pkt);

	g_rx_count++;

	if (length <= MAX_FRAME_LEN) {
		bool done = process_v2_frame(psdu, (uint8_t)length, rssi);

		if (done) {
			status_rx();
		}

#if AURA_ACCEPT_V0_AT_GATEWAY
		if (!done) {
			done = process_v0_frame(psdu, (uint8_t)length, rssi);
		}
#endif
		if (!done && g_promiscuous) {
			gw_emit("<RAW len=%u r=%d ", (unsigned int)length, rssi);
			for (size_t i = 0; i < length; i++) {
				gw_emit("%02X", psdu[i]);
			}
			gw_emit("\n");
		}
	}

	net_pkt_unref(pkt);
	return 0;
}

/* ------------------------------------------------------------------ */
/* TX                                                                  */
/* ------------------------------------------------------------------ */

static int aura_tx_raw(const uint8_t *frame, uint8_t len)
{
	struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);

	if (!pkt) {
		return -ENOMEM;
	}
	if (net_pkt_alloc_buffer_raw(pkt, len, K_NO_WAIT) < 0) {
		net_pkt_unref(pkt);
		return -ENOMEM;
	}
	net_pkt_cursor_init(pkt);
	if (net_pkt_write(pkt, frame, len) != 0) {
		net_pkt_unref(pkt);
		return -EIO;
	}

	int err = radio_api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, pkt->buffer);

	net_pkt_unref(pkt);
	return err;
}

/* Send the current state. dst is normally broadcast; a unicast address
 * targets one device using the MAC filter that is already running. */
static void send_cmd(uint16_t dst)
{
	uint8_t frame[AURA_MHR_LEN + AURA_CMD_LEN];

	g_state.seq++;

	/*
	 * Wait our turn.
	 *
	 * Every gateway gets the server's line at the same instant and would
	 * otherwise transmit on the same millisecond. At thirty gateways that
	 * is a self-inflicted denial of service at the exact moment the show
	 * needs to change — see GW_CMD_STAGGER_MS.
	 *
	 * Costs (GW_INDEX-1)*3 ms of latency, which nobody can see, and buys
	 * a downlink that does not collide with itself.
	 */
	if (link_cfg()->index > 1) {
		k_msleep((link_cfg()->index - 1) * GW_CMD_STAGGER_MS);
	}

	status_tx();
	for (int i = 0; i < AURA_CMD_REPEAT; i++) {
		uint8_t *p = aura_mhr_write(frame, g_mac_seq++, dst,
					    AURA_ADDR_GATEWAY);
		aura_cmd_write(p, &g_state);

		int err = aura_tx_raw(frame, AURA_MHR_LEN + AURA_CMD_LEN);

		if (err) {
			gw_emit("TX failed (%d/%d): %d\n", i + 1, AURA_CMD_REPEAT, err);
		}
		if (i < AURA_CMD_REPEAT - 1) {
			k_msleep(CMD_REPEAT_GAP_MS);
		}
	}
	nrf_802154_receive();

	gw_emit(">CMD seq=%u grp=%02X anim=%02X/%u op=%02X/%u rgb=%02X%02X%02X br=%u df=%02X dst=%04X\n",
	       g_state.seq, g_state.group, g_state.anim_mode, g_state.anim_param,
	       g_state.op_mode, g_state.op_param, g_state.r, g_state.g, g_state.b,
	       g_state.bright, g_state.dev_flags, dst);
}

static void send_sync(uint8_t hop_channel, uint8_t countdown, bool verbose)
{
	uint8_t frame[AURA_MHR_LEN + AURA_SYNC_LEN];
	struct aura_sync s = {
		/* Until the Server exists, the gateway's own uptime IS the master
		 * clock. Real deployments take it from the wired controller so
		 * multiple gateways share one timebase. */
		.epoch_ms = k_uptime_get_32(),
		.hop_channel = hop_channel,
		.hop_countdown = countdown,
		.wave_step = g_wave_step,
	};
	uint8_t *p = aura_mhr_write(frame, g_mac_seq++, AURA_ADDR_BROADCAST,
				    AURA_ADDR_GATEWAY);

	aura_sync_write(p, &s);
	aura_tx_raw(frame, AURA_MHR_LEN + AURA_SYNC_LEN);
	nrf_802154_receive();

	/* The automatic heartbeat is every few seconds now, so printing it
	 * would bury the telemetry it exists to support. Only announce a SYNC
	 * that someone asked for, or one carrying a channel hop. */
	if (verbose || hop_channel) {
		gw_emit(">SYNC epoch=%u hop=%u/%u wave=%u\n",
		       s.epoch_ms, hop_channel, countdown, g_wave_step);
	}
}

static void do_hop(uint8_t new_channel)
{
	for (int i = AURA_HOP_ANNOUNCE; i > 0; i--) {
		send_sync(new_channel, (uint8_t)i, true);
		k_msleep(HOP_ANNOUNCE_GAP_MS);
	}
	g_channel = new_channel;
	radio_api->set_channel(radio_dev, g_channel);
	nrf_802154_receive();
	gw_emit(">HOP done ch=%u\n", g_channel);
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

static uint8_t u8arg(const char *s) { return (uint8_t)strtoul(s, NULL, 0); }

static int c_cmd(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 10) {
		shell_print(sh, "Usage: aura cmd <grp> <anim> <animp> <op> <opp> <r> <g> <b> <br> [devflags] [dst]");
		return -EINVAL;
	}
	g_state.group      = u8arg(argv[1]);
	g_state.anim_mode  = u8arg(argv[2]);
	g_state.anim_param = u8arg(argv[3]);
	g_state.op_mode    = u8arg(argv[4]);
	g_state.op_param   = u8arg(argv[5]);
	g_state.r          = u8arg(argv[6]);
	g_state.g          = u8arg(argv[7]);
	g_state.b          = u8arg(argv[8]);
	g_state.bright     = u8arg(argv[9]);
	if (argc > 10) {
		g_state.dev_flags = u8arg(argv[10]);
	}
	uint16_t dst = (argc > 11) ? (uint16_t)strtoul(argv[11], NULL, 16)
				   : AURA_ADDR_BROADCAST;
	send_cmd(dst);
	return 0;
}

static int c_anim(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 6) {
		shell_print(sh, "Usage: aura anim <mode> <param> <r> <g> <b> [bright]");
		return -EINVAL;
	}
	g_state.anim_mode  = u8arg(argv[1]);
	g_state.anim_param = u8arg(argv[2]);
	g_state.r = u8arg(argv[3]);
	g_state.g = u8arg(argv[4]);
	g_state.b = u8arg(argv[5]);
	if (argc > 6) {
		g_state.bright = u8arg(argv[6]);
	}
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_op(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 2) {
		shell_print(sh, "Usage: aura op <mode> [param]   0=normal 1=listen 2=rollcall 3=social 4=lowpwr 5=sleep 6=identify");
		return -EINVAL;
	}
	g_state.op_mode  = u8arg(argv[1]);
	g_state.op_param = (argc > 2) ? u8arg(argv[2]) : 0;
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_color(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 4) {
		shell_print(sh, "Usage: aura color <r> <g> <b>");
		return -EINVAL;
	}
	g_state.r = u8arg(argv[1]);
	g_state.g = u8arg(argv[2]);
	g_state.b = u8arg(argv[3]);
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_bright(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh);
	ARG_UNUSED(argc);
	g_state.bright = u8arg(argv[1]);
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_group(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh);
	ARG_UNUSED(argc);
	g_state.group = u8arg(argv[1]);
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

/* Show mode: fleet stops transmitting entirely. Uplink is the capacity
 * constraint at scale, so this is the single most important operational
 * control the gateway has. */
static int c_show(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh); ARG_UNUSED(argc); ARG_UNUSED(argv);
	g_state.op_mode = AURA_OP_LISTEN_ONLY;
	g_state.op_param = 0;
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_live(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh); ARG_UNUSED(argc); ARG_UNUSED(argv);
	g_state.op_mode = AURA_OP_NORMAL;
	g_state.op_param = 0;
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_rollcall(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t window = (argc > 1) ? u8arg(argv[1]) : 20; /* 2.0 s */

	g_fleet_n = 0;
	g_state.op_mode = AURA_OP_ROLL_CALL;
	g_state.op_param = window;
	send_cmd(AURA_ADDR_BROADCAST);
	shell_print(sh, "roll-call: %u ms window, %u slots",
		    window * 100u, (window * 100u) / AURA_SLOT_MS);
	return 0;
}

static int c_social(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 2) {
		shell_print(sh, "Usage: aura social <rssi_dbm>  e.g. aura social -60");
		return -EINVAL;
	}
	int dbm = atoi(argv[1]);

	g_state.op_mode = AURA_OP_SOCIAL;
	g_state.op_param = aura_rssi_encode(dbm);
	send_cmd(AURA_ADDR_BROADCAST);
	return 0;
}

static int c_sleep(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 2) {
		shell_print(sh, "Usage: aura sleep <seconds>  (duty-cycled; never unbounded)");
		return -EINVAL;
	}
	g_state.op_mode = AURA_OP_SLEEP;
	g_state.op_param = u8arg(argv[1]);
	send_cmd(AURA_ADDR_BROADCAST);
	shell_print(sh, "sleeping fleet: %us off, %ums RX window each wake",
		    g_state.op_param, AURA_SLEEP_RX_WINDOW_MS);
	return 0;
}

static int c_identify(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 2) {
		shell_print(sh, "Usage: aura identify <addr hex>  e.g. aura identify 1A2C");
		return -EINVAL;
	}
	uint16_t addr = (uint16_t)strtoul(argv[1], NULL, 16);
	uint8_t save_op = g_state.op_mode, save_p = g_state.op_param;

	g_state.op_mode = AURA_OP_IDENTIFY;
	g_state.op_param = 0;
	send_cmd(addr);              /* unicast - MAC filtering does the work */
	g_state.op_mode = save_op;
	g_state.op_param = save_p;
	return 0;
}

static int c_fleet(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	uint32_t now = k_uptime_get_32();
	uint8_t current = 0;

	shell_print(sh, "addr  node rssi caps batt fl cseq age(s) beacons");
	for (uint8_t i = 0; i < g_fleet_n; i++) {
		struct fleet_entry *e = &g_fleet[i];

		if (e->last_cmd_seq == g_state.seq) {
			current++;
		}
		shell_print(sh, "%04X  %-4u %-4d %02X   %-4u %02X %-4u %-6u %u",
			    e->addr, e->node_id, e->rssi, e->caps, e->battery,
			    e->flags, e->last_cmd_seq,
			    (now - e->last_seen_ms) / 1000u, e->beacons);
	}
	shell_print(sh, "%u devices, %u current at cmd seq %u (%u%% delivery)",
		    g_fleet_n, current, g_state.seq,
		    g_fleet_n ? (100u * current) / g_fleet_n : 0u);
	return 0;
}

static int c_sync(const struct shell *sh, size_t argc, char **argv)
{
	if (argc > 1) {
		g_wave_step = u8arg(argv[1]);
	}
	shell_print(sh, "wave_step=%u (%s)", g_wave_step,
		    g_wave_step ? "wave" : "unison");
	send_sync(0, 0, true);
	return 0;
}

static int c_autosync(const struct shell *sh, size_t argc, char **argv)
{
	if (argc > 1) {
		g_sync_enabled = u8arg(argv[1]) != 0;
	}
	shell_print(sh, "autosync=%d (every %ums)", g_sync_enabled,
		    AURA_SYNC_INTERVAL_MS);
	return 0;
}

static int c_hop(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	uint8_t ch = u8arg(argv[1]);

	if (ch < 11 || ch > 26) {
		shell_print(sh, "channel must be 11..26");
		return -EINVAL;
	}
	do_hop(ch);
	return 0;
}

static int c_chan(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	uint8_t ch = u8arg(argv[1]);

	if (ch < 11 || ch > 26) {
		shell_print(sh, "channel must be 11..26");
		return -EINVAL;
	}
	g_channel = ch;
	radio_api->set_channel(radio_dev, g_channel);
	nrf_802154_receive();
	shell_print(sh, "local channel %u (fleet NOT moved - use hop)", g_channel);
	return 0;
}

static int c_promisc(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	g_promiscuous = u8arg(argv[1]) != 0;
	struct ieee802154_config config = { .promiscuous = g_promiscuous };

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	nrf_802154_promiscuous_set(g_promiscuous);
	nrf_802154_receive();
	shell_print(sh, "promiscuous=%d (debug only - v2 relies on hw filtering)",
		    g_promiscuous);
	return 0;
}

static int c_ant(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	int level = u8arg(argv[1]) ? 1 : 0;

	if (!strcmp(argv[1], "ext")) {
		level = 1;
	} else if (!strcmp(argv[1], "onboard")) {
		level = 0;
	}
#if HAVE_RFSW
	if (gpio_is_ready_dt(&rfsw_gpio)) {
		gpio_pin_set_raw(rfsw_gpio.port, rfsw_gpio.pin, level);
	}
	shell_print(sh, "antenna level %d (%s)", level, level ? "external" : "onboard");
#else
	ARG_UNUSED(level);
	shell_warn(sh, "no rfsw_ctl node on this board - antenna is fixed");
#endif
	return 0;
}

static int c_mirror(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	long n = strtol(argv[1], NULL, 0);

	gw_mirror_limit((int32_t)n);
	if (n < 0) {
		shell_print(sh, "console mirror OFF — the server still gets everything");
	} else {
		shell_print(sh, "console mirror budget %ld lines/s "
			    "(115200 baud carries roughly 90 short lines/s)", n);
	}
	return 0;
}

static int c_stats(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	shell_print(sh, "rx total=%u  v2=%u  v0=%u  fleet=%u",
		    g_rx_count, g_rx_v2_count, g_rx_v0_count, g_fleet_n);
	return 0;
}

static int c_info(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	shell_print(sh, "Aetherfield gateway  proto v%u", AURA_VER);
	shell_print(sh, "PAN=%04X addr=%04X ch=%u txpwr=%ddBm promisc=%d",
		    AURA_PAN_ID, AURA_ADDR_GATEWAY, g_channel,
		    AURA_TX_POWER_DBM, g_promiscuous);
	shell_print(sh, "state: grp=%02X anim=%02X/%u op=%02X/%u rgb=%02X%02X%02X br=%u df=%02X seq=%u",
		    g_state.group, g_state.anim_mode, g_state.anim_param,
		    g_state.op_mode, g_state.op_param,
		    g_state.r, g_state.g, g_state.b, g_state.bright,
		    g_state.dev_flags, g_state.seq);
	return 0;
}

/* ------------------------------------------------------------------
 * Legacy `aura <mode> <rate> <r> <g> <b>`
 *
 * pi-bridge/server.js line 410 writes exactly this string, and migration
 * order is gateway FIRST - so the Pi keeps speaking v0 shell syntax for a
 * while yet. Runs as the `aura` parent handler, i.e. only when the first
 * argument is not a known subcommand. Delete when pi-bridge is updated.
 * ------------------------------------------------------------------ */

static const uint8_t v0_anim_map[8] = {
	AURA_ANIM_STEADY,     /* 0 v0 steady    */
	AURA_ANIM_HEARTBEAT,  /* 1 v0 heartbeat */
	AURA_ANIM_FLASH,      /* 2 v0 flash     */
	AURA_ANIM_RAMP,       /* 3 v0 build-up  */
	AURA_ANIM_PULSE,      /* 4 v0 chaser - no 1-source equivalent, pulse is closest */
	AURA_ANIM_RAINBOW,    /* 5 v0 rainbow   */
	AURA_ANIM_STEADY,     /* 6 v0 gesture - local sensing, not an animation in v2 */
	AURA_ANIM_STEADY,     /* 7 v0 mic     - ditto */
};

static int c_aura_legacy(const struct shell *sh, size_t argc, char **argv)
{
	if (argc != 6) {
		shell_print(sh, "Usage: aura <subcommand> | aura <mode> <rate> <r> <g> <b>  (legacy)");
		shell_print(sh, "Subcommands: cmd anim op color bright group show live rollcall social sleep identify fleet");
		return -EINVAL;
	}
	uint8_t v0mode = u8arg(argv[1]);

	g_state.anim_mode  = v0_anim_map[v0mode & 0x07];
	g_state.anim_param = u8arg(argv[2]);
	g_state.r = u8arg(argv[3]);
	g_state.g = u8arg(argv[4]);
	g_state.b = u8arg(argv[5]);
	send_cmd(AURA_ADDR_BROADCAST);
	shell_print(sh, "(legacy v0 mode %u -> anim %u)", v0mode, g_state.anim_mode);
	return 0;
}

/* pi-bridge also has an /api/led path in some builds. */
static int c_led(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	g_state.r = u8arg(argv[1]);
	g_state.g = u8arg(argv[2]);
	g_state.b = u8arg(argv[3]);
	send_cmd(AURA_ADDR_BROADCAST);
	ARG_UNUSED(sh);
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_aura,
	SHELL_CMD_ARG(cmd,      NULL, "Full state: <grp> <anim> <animp> <op> <opp> <r> <g> <b> <br> [df] [dst]", c_cmd, 10, 2),
	SHELL_CMD_ARG(anim,     NULL, "<mode> <param> <r> <g> <b> [bright]", c_anim, 6, 1),
	SHELL_CMD_ARG(op,       NULL, "<mode> [param]", c_op, 2, 1),
	SHELL_CMD_ARG(color,    NULL, "<r> <g> <b>", c_color, 4, 0),
	SHELL_CMD_ARG(bright,   NULL, "<0-255>", c_bright, 2, 0),
	SHELL_CMD_ARG(group,    NULL, "<mask>", c_group, 2, 0),
	SHELL_CMD_ARG(show,     NULL, "Listen-only: zero uplink", c_show, 1, 0),
	SHELL_CMD_ARG(live,     NULL, "Back to normal beaconing", c_live, 1, 0),
	SHELL_CMD_ARG(rollcall, NULL, "[window/100ms] census in address slots", c_rollcall, 1, 1),
	SHELL_CMD_ARG(social,   NULL, "<rssi_dbm> proximity detection", c_social, 2, 0),
	SHELL_CMD_ARG(sleep,    NULL, "<seconds> duty-cycled sleep", c_sleep, 2, 0),
	SHELL_CMD_ARG(identify, NULL, "<addr hex> unicast locate", c_identify, 2, 0),
	SHELL_CMD_ARG(fleet,    NULL, "Known devices + delivery rate", c_fleet, 1, 0),
	SHELL_SUBCMD_SET_END
);

SHELL_CMD_ARG_REGISTER(led, NULL, "Set colour: led <R> <G> <B>", c_led, 4, 0);
SHELL_CMD_REGISTER(aura, &sub_aura, "Aetherfield v2 control", c_aura_legacy);
SHELL_CMD_ARG_REGISTER(sync, NULL, "Send SYNC now: sync [wave_step]", c_sync, 1, 1);
SHELL_CMD_ARG_REGISTER(autosync, NULL, "autosync <0|1>", c_autosync, 1, 1);
SHELL_CMD_ARG_REGISTER(hop, NULL, "Move whole network: hop <11-26>", c_hop, 2, 0);
SHELL_CMD_ARG_REGISTER(chan, NULL, "Local channel only: chan <11-26>", c_chan, 2, 0);
SHELL_CMD_ARG_REGISTER(promisc, NULL, "promisc <0|1>", c_promisc, 2, 0);
SHELL_CMD_ARG_REGISTER(ant, NULL, "ant <onboard|ext>", c_ant, 2, 0);
SHELL_CMD_ARG_REGISTER(stats, NULL, "RX statistics", c_stats, 1, 0);
SHELL_CMD_ARG_REGISTER(mirror, NULL, "Console mirror budget: mirror <lines/s | -1 off>", c_mirror, 2, 0);
SHELL_CMD_ARG_REGISTER(info, NULL, "Radio + commanded state", c_info, 1, 0);

/* ------------------------------------------------------------------ */

int main(void)
{
	/* First, so a Link that dies later in bring-up is at least blue. */
	status_init();

#if HAVE_RFSW
	if (gpio_is_ready_dt(&rfsw_gpio)) {
		gpio_pin_configure(rfsw_gpio.port, rfsw_gpio.pin, GPIO_OUTPUT);
		gpio_pin_set_raw(rfsw_gpio.port, rfsw_gpio.pin, RFSW_EXTERNAL_LEVEL);
	}
#endif

	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	if (!radio_api) {
		gw_emit("Failed to get radio API\n");
		return -1;
	}

	static const uint8_t pan_le[2]   = { AURA_PAN_ID & 0xFF, AURA_PAN_ID >> 8 };
	static const uint8_t short_le[2] = { AURA_ADDR_GATEWAY & 0xFF, AURA_ADDR_GATEWAY >> 8 };
	static const uint8_t ext_addr[8] = {
		AURA_ADDR_GATEWAY & 0xFF, AURA_ADDR_GATEWAY >> 8,
		0xAE, 0x7F, 0xAE, 0x7F, 0xAE, 0x7F
	};

	nrf_802154_pan_id_set(pan_le);
	nrf_802154_short_address_set(short_le);
	nrf_802154_extended_address_set(ext_addr);

	struct ieee802154_config config = { .promiscuous = false };

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	nrf_802154_promiscuous_set(false);

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif

	radio_api->set_channel(radio_dev, g_channel);
	nrf_802154_tx_power_set(AURA_TX_POWER_DBM);
	radio_api->start(radio_dev);
	nrf_802154_receive();

	gw_emit(">READY proto=%u pan=%04X addr=%04X ch=%u txpwr=%d\n",
	       AURA_VER, AURA_PAN_ID, AURA_ADDR_GATEWAY, g_channel,
	       AURA_TX_POWER_DBM);

	/*
	 * Start the server link last. The radio is already receiving by this
	 * point, so anything heard while Ethernet is still negotiating is
	 * buffered rather than lost - and if the link never comes up, the
	 * gateway still works locally over the console.
	 */
	link_cfg_init();   /* before the link thread reads it */
	link_init();

	uint32_t last_rx = 0;
	uint32_t quiet_s = 0;
	bool stall_reported = false;
	uint32_t ticks = 0;

	while (1) {
		k_msleep(1000);
		ticks++;

		if (g_sync_enabled && (ticks % (AURA_SYNC_INTERVAL_MS / 1000)) == 0) {
			send_sync(0, 0, false);   /* heartbeat - not announced */
		}

		/* Re-arm receive every second. Cheap, harmless, and covers the
		 * common case of the driver being left out of RX after a TX. */
		nrf_802154_receive();

		/* ------------------------------------------------------------
		 * RX-stall watchdog.
		 *
		 * SILENCE IS NOT A FAULT. The fleet is deliberately silent in
		 * LISTEN_ONLY - which is how a show actually runs - and it is
		 * silent in SLEEP, and it is silent when no band is in range.
		 * An earlier version restarted the radio after any 5 second gap
		 * in received frames, which meant it would have torn the radio
		 * down and back up every 5 seconds for the entire duration of a
		 * performance.
		 *
		 * So: only watch for a stall when we actually expect traffic,
		 * give it a full minute, and say it once rather than every tick.
		 * ------------------------------------------------------------ */
		bool expect_uplink = (g_state.op_mode != AURA_OP_LISTEN_ONLY &&
				      g_state.op_mode != AURA_OP_SLEEP);

		if (g_rx_count != last_rx) {
			last_rx = g_rx_count;
			quiet_s = 0;
			if (stall_reported) {
				gw_emit("<INFO rx resumed at %u\n", g_rx_count);
				stall_reported = false;
			}
			continue;
		}

		if (!expect_uplink || g_fleet_n == 0) {
			/* Nothing has ever been heard, or the fleet was told to
			 * be quiet. Either way there is nothing to diagnose. */
			continue;
		}

		if (++quiet_s >= 60 && !stall_reported) {
			stall_reported = true;
			gw_emit("<WARN no uplink for %us from %u known device(s) - "
			       "restarting radio\n", quiet_s, g_fleet_n);
			radio_api->stop(radio_dev);
			k_msleep(100);
			radio_api->start(radio_dev);
			nrf_802154_receive();
		}
	}
	return 0;
}
