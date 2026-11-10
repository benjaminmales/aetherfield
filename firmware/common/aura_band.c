/*
 * aura_band.c - shared Aetherfield v2 band layer. See aura_band.h.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/logging/log.h>
#include <nrf_802154.h>
#include <string.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(aura_band, LOG_LEVEL_INF);

#define ANIM_FRAME_MS      40      /* 25 Hz - still smooth, half the bus traffic */
#define RX_QUEUE_DEPTH     8
/*
 * Beacon jitter, as a fraction of the period: +/- 1/8, so a spread of a
 * quarter of the interval.
 *
 * This used to be `g_addr % 64`, which does not de-correlate anything. It is
 * CONSTANT for a given device, so every device beaconed on a fixed period of
 * (period + its own offset), and only 64 distinct periods existed across the
 * whole fleet. At 3,000 devices that is ~47 devices sharing each exact period
 * and around 70,000 pairs with identical ones. Two such devices drift into
 * phase, and then — having identical periods — they STAY there and collide on
 * every beacon indefinitely. Not a burst of bad luck: a standing wave.
 *
 * That failure is invisible in an average. Per-beacon delivery looks normal
 * because most of the fleet is fine, while a handful of devices are never
 * heard at all. Detection maths assumes a device's successive beacons fail
 * independently; for a locked pair they are perfectly correlated, so the
 * chance of being missed does not fall off with more attempts. Concentrated
 * loss, which is the worse kind and the kind an average hides.
 *
 * 64 ms was also only 2% of a 3 s interval, so even as a one-shot phase spread
 * it was far too narrow.
 *
 * Re-drawn on every beacon now, zero-mean so the average rate is unchanged.
 */
#define BEACON_JITTER_DIV  8

/*
 * A small per-device PRNG.
 *
 * Deliberately not sys_rand32_get(): this runs on five build targets and a
 * local xorshift has no Kconfig dependency to get wrong on any of them. The
 * quality needed here is only "two devices do not produce the same sequence",
 * and a seed mixing the device address with boot timing gives that.
 */
static uint32_t g_rng = 1;

static uint32_t rnd32(void)
{
	g_rng ^= g_rng << 13;
	g_rng ^= g_rng >> 17;
	g_rng ^= g_rng << 5;
	return g_rng;
}

/*
 * When to send the next beacon, in ms from now.
 *
 * Zero-mean about `period`: the fleet's offered load is exactly what the
 * commanded interval says, while no two devices keep a fixed relationship.
 */
static uint32_t beacon_delay(uint32_t period)
{
	uint32_t j = period / BEACON_JITTER_DIV;

	if (j < 2) {
		return period;
	}
	return period - (j / 2) + (rnd32() % j);
}
#define CONTACT_MAX_PEERS  16

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;

/* Antenna select. Boards without an RF switch simply don't have the node. */
#define RFSW_CTL_NODE DT_NODELABEL(rfsw_ctl)
#if DT_NODE_EXISTS(RFSW_CTL_NODE)
static const struct gpio_dt_spec rfsw_gpio = {
	.port = DEVICE_DT_GET(DT_GPIO_CTLR(RFSW_CTL_NODE, enable_gpios)),
	.pin = DT_GPIO_PIN(RFSW_CTL_NODE, enable_gpios),
	.dt_flags = DT_GPIO_FLAGS(RFSW_CTL_NODE, enable_gpios),
};
#endif

static void antenna_select(bool external)
{
#if DT_NODE_EXISTS(RFSW_CTL_NODE)
	/* Raw level, matching the gateway: the node is ACTIVE_LOW with
	 * regulator-boot-on, so the logical sense is inverted and easy to get
	 * backwards. Physical 1 = external, physical 0 = onboard. */
	if (gpio_is_ready_dt(&rfsw_gpio)) {
		gpio_pin_configure(rfsw_gpio.port, rfsw_gpio.pin, GPIO_OUTPUT);
		gpio_pin_set_raw(rfsw_gpio.port, rfsw_gpio.pin, external ? 1 : 0);
		LOG_INF("antenna: %s", external ? "external (u.FL)" : "onboard");
	} else {
		LOG_WRN("rfsw_ctl not ready - antenna left at boot default");
	}
#else
	ARG_UNUSED(external);
#endif
}

static struct aura_band_cfg g_cfg;
static uint16_t g_addr;
static uint8_t  g_mac_seq;
static uint8_t  g_channel = AURA_CHANNEL_DEFAULT;

/* Commanded state. Starts dark and NORMAL so an un-commanded device is
 * quiet and invisible rather than doing something arbitrary. */
static struct aura_cmd g_state = {
	.seq = 0, .group = AURA_GROUP_ALL,
	.anim_mode = AURA_ANIM_OFF, .anim_param = 0,
	.op_mode = AURA_OP_NORMAL, .op_param = 0,
	.r = 0, .g = 0, .b = 0, .bright = 255, .dev_flags = 0,
};
static struct k_mutex g_state_mutex;

static bool     g_have_cmd;          /* have we ever had a valid CMD? */
static uint8_t  g_last_cmd_seq;      /* echoed in every beacon */
static bool     g_seq_valid;
static atomic_t g_flags = ATOMIC_INIT(0);

/* Shared clock. epoch_base is the gateway time that corresponded to
 * local_base on our own uptime clock. */
static uint32_t g_epoch_base;
static uint32_t g_local_base;
static bool     g_synced;
static uint8_t  g_wave_step;

static uint32_t g_last_downlink_ms;   /* for the channel-loss fallbacks */
static uint8_t  g_chan_scan_idx;

static uint8_t  g_hop_channel;
static uint8_t  g_hop_countdown;

/* IDENTIFY overrides the show until the next CMD that isn't IDENTIFY. */
static bool g_identify;
/* Identify stops on its own. Otherwise a device that never hears another
 * command flashes white until its cell is flat, which is the opposite of
 * what a recovery tool should do. */
static uint32_t g_identify_until;
#define IDENTIFY_MS 30000

/* ------------------------------------------------------------------ */
/* RX hand-off                                                         */
/*                                                                     */
/* net_recv_data() is called by the 802.15.4 driver, NOT from a thread  */
/* we control. Taking a mutex or sleeping there is illegal and faults   */
/* the CPU. Roll-call slotting in particular wants to sleep for up to a */
/* few seconds before answering - absolutely not something to do in a   */
/* receive callback. So the callback only copies the frame into a queue */
/* and the radio thread does all the real work.                        */
/* ------------------------------------------------------------------ */

struct rx_item {
	uint8_t  kind;      /* AURA_MSG_* */
	uint16_t src;
	int8_t   rssi;
	union {
		struct aura_cmd  cmd;
		struct aura_sync sync;
	} u;
};

K_MSGQ_DEFINE(rx_q, sizeof(struct rx_item), RX_QUEUE_DEPTH, 4);

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

uint32_t aura_band_now_ms(void)
{
	uint32_t local = k_uptime_get_32();

	return g_synced ? (g_epoch_base + (local - g_local_base)) : local;
}

bool aura_band_is_synced(void) { return g_synced; }
uint16_t aura_band_addr(void)  { return g_addr; }

const struct aura_cmd *aura_band_state(void) { return &g_state; }

void aura_band_set_flag(uint8_t flag, bool on)
{
	if (on) {
		atomic_or(&g_flags, flag);
	} else {
		atomic_and(&g_flags, ~(atomic_val_t)flag);
	}
}

/* ------------------------------------------------------------------ */
/* TX                                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* TX                                                                  */
/*                                                                     */
/* Same net_pkt path the gateway uses. NOTE: this is currently the      */
/* VICTIM of a memory corruption, not the cause - see the note at the   */
/* top of this file. Do not "fix" it by switching to                    */
/* nrf_802154_transmit_raw(): Zephyr's ieee802154_nrf5 driver already   */
/* defines nrf_802154_transmitted_raw() and friends, so an app-level    */
/* definition is a duplicate symbol and will not link.                  */
/* ------------------------------------------------------------------ */

/* DIRECT unless a scale test asks otherwise. See aura_band_tx_csma(). */
static bool g_tx_csma;

/*
 * One transmitter at a time.
 *
 * tx_raw() does three things that must not interleave: allocate a packet,
 * hand it to radio_api->tx(), and put the radio back into receive. Two
 * threads doing that at once can have one call nrf_802154_receive() while the
 * other is still transmitting, which parks the radio state machine: the device
 * keeps sending beacons and silently stops hearing anything. A band that
 * transmits but never receives a command again looks like a crash and is not.
 *
 * This was always reachable — aura_band_send_event() is documented as callable
 * from any thread while the internal radio thread beacons — but it needs
 * microseconds of overlap, so at one beacon a second it essentially never
 * happened. A load generator calling aura_band_beacon_as() hundreds of times a
 * second finds it within minutes.
 *
 * The lock is held across the transmit, which is around a millisecond at
 * 250 kbps. Nothing here is latency-critical to that degree.
 */
static K_MUTEX_DEFINE(tx_lock);

void aura_band_tx_csma(bool on)
{
	g_tx_csma = on;
}

static int tx_raw(const uint8_t *frame, uint8_t len)
{
	k_mutex_lock(&tx_lock, K_FOREVER);

	struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);

	if (!pkt) {
		k_mutex_unlock(&tx_lock);
		return -ENOMEM;
	}
	if (net_pkt_alloc_buffer_raw(pkt, len, K_NO_WAIT) < 0) {
		net_pkt_unref(pkt);
		k_mutex_unlock(&tx_lock);
		return -ENOMEM;
	}
	net_pkt_cursor_init(pkt);
	if (net_pkt_write(pkt, frame, len) != 0) {
		net_pkt_unref(pkt);
		k_mutex_unlock(&tx_lock);
		return -EIO;
	}
	int err = radio_api->tx(radio_dev,
				g_tx_csma ? IEEE802154_TX_MODE_CSMA_CA
					  : IEEE802154_TX_MODE_DIRECT,
				pkt, pkt->buffer);

	net_pkt_unref(pkt);
	nrf_802154_receive();
	k_mutex_unlock(&tx_lock);
	return err;
}

/*
 * Beacon on behalf of another address. See aura_band.h.
 *
 * Deliberately built with the same two writers send_beacon() uses, so the
 * frames cannot drift apart: if the beacon format ever changes, both change
 * together or neither compiles.
 */
void aura_band_beacon_as(uint16_t addr, uint8_t caps, uint8_t battery_pct,
			 uint8_t flags, uint8_t last_cmd_seq)
{
	uint8_t frame[AURA_MHR_LEN + AURA_BEACON_LEN];

	/* g_mac_seq is shared with the radio thread's own send_beacon(). A torn
	 * increment only costs a duplicate MAC sequence number, but it is free
	 * to do properly. */
	k_mutex_lock(&tx_lock, K_FOREVER);
	uint8_t seq = g_mac_seq++;
	k_mutex_unlock(&tx_lock);

	uint8_t *p = aura_mhr_write(frame, seq, AURA_ADDR_GATEWAY, addr);

	aura_beacon_write(p, caps, battery_pct, flags, last_cmd_seq);
	tx_raw(frame, AURA_MHR_LEN + AURA_BEACON_LEN);
}

/* Every uplink goes through here, so LISTEN_ONLY is enforced in exactly one
 * place. Show mode means silent - not "mostly silent". */
static bool uplink_allowed(void)
{
	return g_state.op_mode != AURA_OP_LISTEN_ONLY &&
	       g_state.op_mode != AURA_OP_SLEEP;
}

static void send_beacon(void)
{
	uint8_t frame[AURA_MHR_LEN + AURA_BEACON_LEN];
	uint8_t *p = aura_mhr_write(frame, g_mac_seq++, AURA_ADDR_GATEWAY, g_addr);
	uint8_t batt = g_cfg.battery_pct ? g_cfg.battery_pct() : AURA_BATTERY_UNKNOWN;
	uint8_t flags = (uint8_t)atomic_get(&g_flags);

	aura_beacon_write(p, g_cfg.caps, batt, flags,
			  g_seq_valid ? g_last_cmd_seq : 0);
	tx_raw(frame, AURA_MHR_LEN + AURA_BEACON_LEN);

	/* CLAP is an edge, not a state: clear it once reported so the gateway
	 * sees one clap per clap rather than a latched flag forever. */
	atomic_and(&g_flags, ~(atomic_val_t)AURA_FLAG_CLAP);
}

void aura_band_send_event(uint8_t type, uint8_t value, uint8_t strength)
{
	if (!uplink_allowed()) {
		return;
	}
	uint8_t frame[AURA_MHR_LEN + AURA_EVENT_LEN];
	uint8_t *p = aura_mhr_write(frame, g_mac_seq++, AURA_ADDR_GATEWAY, g_addr);

	aura_event_write(p, type, value, strength);
	tx_raw(frame, AURA_MHR_LEN + AURA_EVENT_LEN);
}

void aura_band_send_contact(uint16_t peer, int rssi_dbm, uint8_t event)
{
	if (!uplink_allowed()) {
		return;
	}
	uint8_t frame[AURA_MHR_LEN + AURA_CONTACT_LEN];
	uint8_t *p = aura_mhr_write(frame, g_mac_seq++, AURA_ADDR_GATEWAY, g_addr);

	aura_contact_write(p, peer, rssi_dbm, event);
	tx_raw(frame, AURA_MHR_LEN + AURA_CONTACT_LEN);
}

/* ------------------------------------------------------------------ */
/* SOCIAL: contact tracking                                            */
/*                                                                     */
/* Report transitions, not neighbours. A device in a busy room hears    */
/* dozens of peers; streaming that would be a biased trickle and would  */
/* eat the uplink budget that op_mode exists to protect. Open once when */
/* a peer crosses the threshold and holds, close once when it drops.    */
/* ------------------------------------------------------------------ */

struct peer_slot {
	uint16_t addr;
	uint32_t first_seen_ms;
	uint32_t last_seen_ms;
	bool     open;
};

static struct peer_slot g_peers[CONTACT_MAX_PEERS];

static void social_saw(uint16_t peer, int rssi)
{
	if (g_state.op_mode != AURA_OP_SOCIAL) {
		return;
	}

	int threshold = aura_rssi_decode(g_state.op_param);
	uint32_t now = k_uptime_get_32();
	struct peer_slot *slot = NULL, *free_slot = NULL;

	for (int i = 0; i < CONTACT_MAX_PEERS; i++) {
		if (g_peers[i].addr == peer) {
			slot = &g_peers[i];
			break;
		}
		if (!free_slot && g_peers[i].addr == 0) {
			free_slot = &g_peers[i];
		}
	}
	if (!slot) {
		if (rssi < threshold || !free_slot) {
			return;
		}
		slot = free_slot;
		slot->addr = peer;
		slot->first_seen_ms = now;
		slot->open = false;
	}
	slot->last_seen_ms = now;

	/* Hysteresis so a peer hovering at the boundary doesn't flap the
	 * gateway with open/close pairs. */
	if (!slot->open) {
		if (rssi >= threshold &&
		    (now - slot->first_seen_ms) >= AURA_CONTACT_HOLD_MS) {
			slot->open = true;
			aura_band_send_contact(peer, rssi, AURA_CONTACT_OPEN);
		}
	} else if (rssi < threshold - AURA_CONTACT_HYST_DB) {
		slot->open = false;
		slot->addr = 0;
		aura_band_send_contact(peer, rssi, AURA_CONTACT_CLOSE);
	}
}

static void social_expire(void)
{
	uint32_t now = k_uptime_get_32();

	for (int i = 0; i < CONTACT_MAX_PEERS; i++) {
		struct peer_slot *s = &g_peers[i];

		if (s->addr && (now - s->last_seen_ms) > (AURA_CONTACT_HOLD_MS * 3)) {
			if (s->open) {
				aura_band_send_contact(s->addr, -128, AURA_CONTACT_CLOSE);
			}
			s->addr = 0;
			s->open = false;
		}
	}
}

/* ------------------------------------------------------------------ */
/* RX                                                                  */
/* ------------------------------------------------------------------ */

static void apply_cmd(const struct aura_cmd *c)
{
	/* Dedupe: the gateway repeats every CMD, so ignore a sequence we have
	 * already acted on. Still refresh the downlink timer - a repeat is
	 * proof the gateway is there even if we ignore its content. */
	g_last_downlink_ms = k_uptime_get_32();

	if (!aura_group_match(c->group, g_cfg.group_mask)) {
		return;
	}
	if (g_seq_valid && c->seq == g_last_cmd_seq) {
		return;
	}

	k_mutex_lock(&g_state_mutex, K_FOREVER);
	g_state = *c;
	k_mutex_unlock(&g_state_mutex);

	g_last_cmd_seq = c->seq;
	g_seq_valid = true;
	g_have_cmd = true;

	/* Carrier sense is fleet configuration carried in dev_flags, so one
	 * broadcast switches every device at the same instant. */
	g_tx_csma = (c->dev_flags & AURA_DEV_FLAG_TX_CSMA) != 0;
	g_identify = (c->op_mode == AURA_OP_IDENTIFY);
	if (g_identify) {
		g_identify_until = k_uptime_get_32() + IDENTIFY_MS;
	}

	if (c->op_mode == AURA_OP_ROLL_CALL) {
		/* Respond in our own slot. Deterministic from our address, so
		 * the fleet spreads with no coordination and no state. Safe to
		 * sleep here because this now runs on the radio thread, not in
		 * the driver's receive callback. */
		k_msleep(aura_rollcall_delay_ms(g_addr, c->op_param));
		send_beacon();
	}
}

static void apply_sync(const struct aura_sync *s)
{
	g_last_downlink_ms = k_uptime_get_32();

	g_epoch_base = s->epoch_ms;
	g_local_base = k_uptime_get_32();
	g_synced = true;
	g_wave_step = s->wave_step;

	if (s->hop_channel) {
		g_hop_channel = s->hop_channel;
		g_hop_countdown = s->hop_countdown;
	}
}

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
	size_t len = net_buf_frags_len(pkt->buffer);
	int8_t rssi = net_pkt_ieee802154_rssi_dbm(pkt);
	uint16_t src, dst;

	if (len >= AURA_MHR_LEN && aura_mhr_parse(psdu, (uint8_t)len, &src, &dst)) {
		const uint8_t *p = psdu + AURA_MHR_LEN;
		uint8_t plen = (uint8_t)(len - AURA_MHR_LEN);

		if (plen >= 2 && p[1] == AURA_VER) {
			struct rx_item it = { .kind = p[0], .src = src, .rssi = rssi };
			bool queue = false;

			switch (p[0]) {
			case AURA_MSG_CMD:
				if ((dst == AURA_ADDR_BROADCAST || dst == g_addr) &&
				    aura_cmd_parse(p, plen, &it.u.cmd)) {
					queue = true;
				}
				break;
			case AURA_MSG_SYNC:
				if (aura_sync_parse(p, plen, &it.u.sync)) {
					queue = true;
				}
				break;
			case AURA_MSG_BEACON:
				/* Another band. Only interesting in SOCIAL. */
				queue = true;
				break;
			default:
				break;
			}

			/* K_NO_WAIT: never block the driver. Dropping a frame is
			 * fine - downlink is repeated and beacons are periodic. */
			if (queue) {
				(void)k_msgq_put(&rx_q, &it, K_NO_WAIT);
			}
		}
	}

	net_pkt_unref(pkt);
	return 0;
}

/* ------------------------------------------------------------------ */
/* Animation                                                           */
/*                                                                     */
/* Pure function of the shared clock, so two devices that agree on the  */
/* time agree on the frame by construction. No per-command phase.       */
/* ------------------------------------------------------------------ */

static uint8_t scale8(uint8_t v, uint8_t s)
{
	return (uint8_t)(((uint16_t)v * (uint16_t)s) / 255u);
}

/* Triangle wave 0..255 across the period - cheap stand-in for a sine,
 * indistinguishable once it is driving an LED. */
static uint8_t tri(uint32_t phase, uint32_t period)
{
	uint32_t half = period / 2u;

	if (half == 0) {
		return 255;
	}
	if (phase < half) {
		return (uint8_t)((phase * 255u) / half);
	}
	return (uint8_t)(((period - phase) * 255u) / half);
}

static void hsv_hue(uint8_t h, uint8_t *r, uint8_t *g, uint8_t *b)
{
	uint8_t region = h / 43u;
	uint8_t rem = (uint8_t)((h - (region * 43u)) * 6u);

	switch (region) {
	case 0:  *r = 255;      *g = rem;      *b = 0;        break;
	case 1:  *r = 255 - rem; *g = 255;     *b = 0;        break;
	case 2:  *r = 0;        *g = 255;      *b = rem;      break;
	case 3:  *r = 0;        *g = 255 - rem; *b = 255;     break;
	case 4:  *r = rem;      *g = 0;        *b = 255;      break;
	default: *r = 255;      *g = 0;        *b = 255 - rem; break;
	}
}

static void anim_frame(uint32_t now, struct aura_cmd *c,
		       uint8_t *r, uint8_t *g, uint8_t *b)
{
	/* NOTE: an "alive but never commanded" breathing indication was tried
	 * here and REVERTED. It looked useful - a band sitting dark because no
	 * gateway has spoken to it is hard to tell from a dead one - but it
	 * made the pixel module render continuously from boot, and continuous
	 * WS2812 traffic is exactly what that board cannot currently survive.
	 *
	 * Do not re-add it until AURA/pixel-xiao-nRF54 is proven stable under a
	 * real animation. The wristband would be fine; the pixel would not, and
	 * a shared layer must not carry a behaviour only some boards tolerate.
	 */

	uint32_t period = AURA_ANIM_PERIOD_MS(c->anim_param);
	uint32_t t = now + aura_phase_offset_ms(g_cfg.group_mask, g_wave_step);
	uint32_t phase = period ? (t % period) : 0;
	uint8_t level = 0;

	switch (c->anim_mode) {
	case AURA_ANIM_OFF:
		*r = *g = *b = 0;
		return;

	case AURA_ANIM_STEADY:
		level = 255;
		break;

	case AURA_ANIM_FLASH:
		level = (phase < period / 2u) ? 255 : 0;
		break;

	case AURA_ANIM_PULSE:
		level = tri(phase, period);
		break;

	case AURA_ANIM_HEARTBEAT: {
		/* Same 20/12/10/58 split the v0 wristband used, so the look
		 * survives the migration. */
		uint32_t t1 = period * 20u / 100u;
		uint32_t t2 = period * 32u / 100u;
		uint32_t t3 = period * 42u / 100u;

		if (phase < t1)       level = 255;
		else if (phase < t2)  level = 0;
		else if (phase < t3)  level = 128;
		else                  level = 0;
		break;
	}

	case AURA_ANIM_RAMP:
		level = period ? (uint8_t)((phase * 255u) / period) : 255;
		break;

	case AURA_ANIM_STROBE:
		level = (phase < 40u) ? 255 : 0;
		break;

	case AURA_ANIM_RAINBOW: {
		uint8_t hr, hg, hb;
		uint8_t hue = period ? (uint8_t)((phase * 255u) / period) : 0;

		hsv_hue(hue, &hr, &hg, &hb);
		*r = scale8(hr, c->bright);
		*g = scale8(hg, c->bright);
		*b = scale8(hb, c->bright);
		return;
	}

	default:
		/* Unknown mode: hold steady rather than fail dark mid-show. */
		level = 255;
		break;
	}

	/* bright is applied last, so the gateway can dim the whole room
	 * without recomputing colours. */
	uint8_t m = scale8(level, c->bright);

	*r = scale8(c->r, m);
	*g = scale8(c->g, m);
	*b = scale8(c->b, m);
}

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

/* The radio thread runs the whole nRF 802.15.4 TX path (net_pkt alloc,
 * driver tx, receive re-arm) and the anim thread runs an SPI transfer on
 * WS2812 boards. Both were sized optimistically at first; a stack overflow
 * here faults silently on a build with logging disabled and looks exactly
 * like "the radio doesn't work". Cheap insurance. */
#define ANIM_STACK   4096
#define RADIO_STACK  2048

K_THREAD_STACK_DEFINE(anim_stack, ANIM_STACK);
K_THREAD_STACK_DEFINE(radio_stack, RADIO_STACK);
static struct k_thread anim_thread_data;
static struct k_thread radio_thread_data;

static void anim_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	while (1) {
		if (g_cfg.render) {
			struct aura_cmd snap;

			k_mutex_lock(&g_state_mutex, K_FOREVER);
			snap = g_state;
			k_mutex_unlock(&g_state_mutex);

			/* Lost the gateway for a minute: fade out. A band left
			 * at full brightness with nobody driving it just flattens
			 * its cell. */
			uint32_t since = k_uptime_get_32() - g_last_downlink_ms;

			if (g_have_cmd && since > AURA_SHOW_LOST_MS) {
				snap.bright = 0;
			}

			uint8_t r, g2, b2;

			anim_frame(aura_band_now_ms(), &snap, &r, &g2, &b2);

			/*
			 * IDENTIFY overrides whatever the show is doing.
			 *
			 * g_identify was set by apply_cmd and then read by
			 * nothing at all, so 'aura identify <addr>' was a no-op
			 * on every device: the gateway transmitted, the device
			 * accepted the command, and nothing lit. It is the one
			 * command whose entire purpose is to be seen.
			 *
			 * Deliberately not an animation mode. Identify has to be
			 * unmistakable against whatever the fleet is already
			 * doing, including a fleet mid-flash in the same colour,
			 * so it is a hard 4 Hz white square wave at full
			 * brightness rather than anything the show can imitate.
			 */
			if (g_identify) {
				uint32_t t = k_uptime_get_32();

				if ((int32_t)(t - g_identify_until) >= 0) {
					g_identify = false;
				} else {
					bool on = (t / 125u) & 1u;

					r = g2 = b2 = on ? 255 : 0;
				}
			}

			g_cfg.render(r, g2, b2);
		}
		k_msleep(ANIM_FRAME_MS);
	}
}

static void radio_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	/* Do NOT transmit immediately.
	 *
	 * Two reasons, one of which is a real crash. MPSL brings the radio up
	 * asynchronously behind nrf_802154, and transmitting a few hundred
	 * microseconds after radio_api->start() faulted inside MPSL's own
	 * TX-power-split path - a precise data bus error in the FEM layer, on
	 * a thread that had done nothing but call send_beacon(). The gateway
	 * never hit it only because its first transmit is seconds after start,
	 * when a human types a command.
	 *
	 * The second reason matters at scale: a crate of bands powered on
	 * together would otherwise all beacon on the same millisecond forever.
	 * The offset is derived from our own address, so the fleet de-
	 * correlates itself with no coordination.
	 */
	uint32_t next_beacon = k_uptime_get_32() + 250u + (g_addr % 750u);

	while (1) {
		uint32_t now = k_uptime_get_32();

		/* --- drain anything the RX callback queued -------------- */
		struct rx_item it;

		while (k_msgq_get(&rx_q, &it, K_NO_WAIT) == 0) {
			switch (it.kind) {
			case AURA_MSG_CMD:   apply_cmd(&it.u.cmd);   break;
			case AURA_MSG_SYNC:  apply_sync(&it.u.sync); break;
			case AURA_MSG_BEACON: social_saw(it.src, it.rssi); break;
			default: break;
			}
			now = k_uptime_get_32();
		}

		/* --- pending channel hop ------------------------------- */
		if (g_hop_channel && g_hop_countdown <= 1) {
			g_channel = g_hop_channel;
			g_hop_channel = 0;
			radio_api->set_channel(radio_dev, g_channel);
			nrf_802154_receive();
		} else if (g_hop_countdown) {
			g_hop_countdown--;
		}

		/* --- channel-loss fallback -----------------------------
		 *
		 * Dwell a full AURA_CHANNEL_DWELL_MS per channel. That is longer
		 * than one SYNC interval on purpose: hop faster than the
		 * gateway's heartbeat and the band can never be listening when
		 * it lands, so it hunts forever next to a healthy gateway.
		 *
		 * Keep beaconing while hunting - a band that has lost downlink
		 * may still be heard, and that is exactly when the gateway most
		 * wants to know it exists.
		 */
		if (g_have_cmd && (now - g_last_downlink_ms) > AURA_CHANNEL_LOST_MS) {
			static const uint8_t chans[] = AURA_CHANNEL_LIST;

			g_chan_scan_idx = (uint8_t)((g_chan_scan_idx + 1) %
						    AURA_CHANNEL_COUNT);
			g_channel = chans[g_chan_scan_idx];
			radio_api->set_channel(radio_dev, g_channel);
			nrf_802154_receive();
			LOG_INF("no downlink for %us, listening on channel %u",
				(now - g_last_downlink_ms) / 1000u, g_channel);

			uint32_t until = k_uptime_get_32() + AURA_CHANNEL_DWELL_MS;

			while (k_uptime_get_32() < until) {
				/* Re-acquired? apply_cmd/apply_sync refresh the
				 * timer from the radio thread's own queue drain,
				 * so check it and bail out immediately. */
				struct rx_item it;

				while (k_msgq_get(&rx_q, &it, K_NO_WAIT) == 0) {
					switch (it.kind) {
					case AURA_MSG_CMD:  apply_cmd(&it.u.cmd);   break;
					case AURA_MSG_SYNC: apply_sync(&it.u.sync); break;
					default: break;
					}
				}
				if ((k_uptime_get_32() - g_last_downlink_ms) <
				    AURA_CHANNEL_LOST_MS) {
					LOG_INF("re-acquired on channel %u", g_channel);
					break;
				}
				send_beacon();
				k_msleep(500);
			}
			continue;
		}

		/* --- op_mode --------------------------------------------- */
		struct aura_cmd snap;

		k_mutex_lock(&g_state_mutex, K_FOREVER);
		snap = g_state;
		k_mutex_unlock(&g_state_mutex);

		switch (snap.op_mode) {
		case AURA_OP_LISTEN_ONLY:
		case AURA_OP_ROLL_CALL:
			/* Silent. ROLL_CALL already answered once in apply_cmd. */
			k_msleep(200);
			break;

		case AURA_OP_SLEEP: {
			/* ALWAYS duty-cycled. op_param seconds dark and deaf,
			 * then a receive window long enough to catch a repeated
			 * CMD. There is deliberately no way to sleep forever. */
			uint32_t off_s = snap.op_param ? snap.op_param : 1u;

			radio_api->stop(radio_dev);
			k_sleep(K_SECONDS(off_s));
			radio_api->start(radio_dev);
			nrf_802154_receive();
			k_msleep(AURA_SLEEP_RX_WINDOW_MS);
			break;
		}

		case AURA_OP_SOCIAL:
			social_expire();
			if (now >= next_beacon) {
				send_beacon();
				next_beacon = now +
					beacon_delay(AURA_BEACON_DEFAULT_MS);
			}
			k_msleep(100);
			break;

		case AURA_OP_LOW_POWER: {
			uint32_t period = (snap.op_param ? snap.op_param : 10u) * 1000u;

			if (now >= next_beacon) {
				send_beacon();
				next_beacon = now + beacon_delay(period);
			}
			k_msleep(500);
			break;
		}

		case AURA_OP_NORMAL:
		case AURA_OP_IDENTIFY:
		default: {
			uint32_t period = snap.op_param ? (snap.op_param * 100u)
						       : AURA_BEACON_DEFAULT_MS;

			if (now >= next_beacon) {
				send_beacon();
				/* Re-drawn every beacon. A fixed per-device offset
				 * spreads the fleet once and then locks it. */
				next_beacon = now + beacon_delay(period);
			}
			k_msleep(50);
			break;
		}
		}
	}
}

/* ------------------------------------------------------------------ */

/* Set by aura_band_addr_override() before init; 0 = derive from FICR. */
static uint16_t g_addr_override;

void aura_band_addr_override(uint16_t addr)
{
	g_addr_override = addr;
}

static uint16_t derive_addr(void)
{
	uint8_t uid[16] = {0};
	ssize_t n = hwinfo_get_device_id(uid, sizeof(uid));

	if (n <= 0) {
		return AURA_ADDR_BAND_BASE + 1;
	}

	uint32_t id0 = 0, id1 = 0;

	for (int i = 0; i < 4 && i < n; i++) {
		id0 |= (uint32_t)uid[i] << (8 * i);
	}
	for (int i = 4; i < 8 && i < n; i++) {
		id1 |= (uint32_t)uid[i] << (8 * (i - 4));
	}
	return aura_band_addr_from_deviceid(id0, id1);
}

int aura_band_init(const struct aura_band_cfg *cfg)
{
	if (!cfg) {
		return -EINVAL;
	}
	g_cfg = *cfg;
	k_mutex_init(&g_state_mutex);
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_ENTERED); }

	g_addr = g_addr_override ? g_addr_override : derive_addr();

	/*
	 * Seed the jitter PRNG. The address separates devices that boot at the
	 * same instant — a crate of lanyards switched on together — and the
	 * uptime separates two boards that somehow share an address. Must never
	 * be zero: xorshift stays at zero forever.
	 */
	g_rng = (uint32_t)g_addr * 2654435761u
		^ (k_uptime_get_32() << 8)
		^ 0x9E3779B9u;
	if (g_rng == 0) {
		g_rng = 1;
	}
	g_last_downlink_ms = k_uptime_get_32();
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_ADDR); }

	if (!device_is_ready(radio_dev)) {
		LOG_ERR("radio device not ready");
		return -ENODEV;
	}
	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	if (!radio_api) {
		LOG_ERR("no radio api");
		return -ENODEV;
	}
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_RADIO_DEV); }

	antenna_select(g_cfg.antenna_external);
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_ANTENNA); }

	/* STATIC, not stack. The gateway does the same and the reason is the
	 * same: these are handed to the radio driver's PIB and must stay valid
	 * for the life of the program. Stack copies go out of scope the moment
	 * this function returns. */
	static uint8_t pan_le[2], short_le[2], ext_addr[8];

	pan_le[0] = AURA_PAN_ID & 0xFF;  pan_le[1] = AURA_PAN_ID >> 8;
	short_le[0] = g_addr & 0xFF;     short_le[1] = g_addr >> 8;
	ext_addr[0] = g_addr & 0xFF;     ext_addr[1] = g_addr >> 8;
	ext_addr[2] = 0xAE; ext_addr[3] = 0x7F; ext_addr[4] = 0xAE;
	ext_addr[5] = 0x7F; ext_addr[6] = 0xAE; ext_addr[7] = 0x7F;

	nrf_802154_pan_id_set(pan_le);
	nrf_802154_short_address_set(short_le);
	nrf_802154_extended_address_set(ext_addr);

	struct ieee802154_config config = { .promiscuous = false };

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	nrf_802154_promiscuous_set(false);
#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_PIB); }

	radio_api->set_channel(radio_dev, g_channel);
	nrf_802154_tx_power_set(AURA_TX_POWER_DBM);
	radio_api->start(radio_dev);
	nrf_802154_receive();
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_STARTED); }

	LOG_INF("aura band v%u addr=0x%04X caps=0x%02X group=0x%02X ch=%u pan=0x%04X",
		AURA_VER, g_addr, g_cfg.caps, g_cfg.group_mask, g_channel,
		AURA_PAN_ID);

	/* Signalled BEFORE the threads exist, deliberately. From the moment the
	 * animation thread starts it owns the light, and any progress callback
	 * firing after that would put a second thread into the same SPI path.
	 * On a WS2812 board that is a real fault, not a cosmetic race. */
	if (g_cfg.progress) { g_cfg.progress(AURA_INIT_THREADS); }

	k_thread_create(&anim_thread_data, anim_stack, ANIM_STACK,
			anim_thread, NULL, NULL, NULL, 7, 0, K_NO_WAIT);
	k_thread_name_set(&anim_thread_data, "aura_anim");

	k_thread_create(&radio_thread_data, radio_stack, RADIO_STACK,
			radio_thread, NULL, NULL, NULL, 6, 0, K_NO_WAIT);
	k_thread_name_set(&radio_thread_data, "aura_radio");

	return 0;
}
