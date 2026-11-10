/*
 * K7 Beacon (nRF54L15) - Aetherfield AURA firmware (low-power build)
 *
 * Power model for a non-rechargeable ~800 mAh lanyard tag:
 *
 *   - Default state is System OFF (~0.8 uA). The radio receiver is NOT left
 *     on continuously (continuous RX is ~3.2 mA and would flatten the cell in
 *     ~10 days).
 *   - The KEY button (P0.02) is the wake source. Pressing it boots the chip
 *     and starts a short ACTIVE SESSION.
 *   - During an active session the tag beacons its presence (protocol v1) and
 *     optionally listens for indication / LED commands. The RGB LED is used
 *     for brief indication only.
 *   - After K7_ACTIVE_WINDOW_S with no button press and no received command,
 *     the tag returns to System OFF.
 *
 * Average current is therefore dominated by how often/long the tag is woken,
 * not by an always-on radio. See the notes block at the bottom of the file.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/led.h>
#include <zephyr/sys/poweroff.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <nrf_802154.h>
#include <nrfx.h>
#include <string.h>

#include <aura_radio.h>

LOG_MODULE_REGISTER(k7_aura, LOG_LEVEL_INF);

/* ----------------------------- tunables ---------------------------------- */

/* How long to stay awake after a wake / last activity before deep sleep. */
#define K7_ACTIVE_WINDOW_S      15

/* Beacon cadence while active. */
#define K7_BEACON_INTERVAL_MS   1000

/* TX power. The shared protocol default (AURA_TX_POWER_DBM) is +8 dBm / 10 mA.
 * For a tag that lives near a gateway, 0 dBm roughly halves TX energy and is
 * plenty of range. Raise if you need it. */
#define K7_TX_POWER_DBM         0

/* Brief LED indication on wake (ms). Kept short on purpose - the LED is the
 * single most power-hungry thing on the board if left on. */
#define K7_WAKE_BLINK_MS        80

/* ----------------------------- RGB LED ----------------------------------- */

#define LED_RED   0
#define LED_GREEN 1
#define LED_BLUE  2

static const struct device *const leds = DEVICE_DT_GET(DT_NODELABEL(pwmleds));

static void set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	if (!device_is_ready(leds)) {
		return;
	}
	led_set_brightness(leds, LED_RED,   (uint8_t)((r * 100U) / 255U));
	led_set_brightness(leds, LED_GREEN, (uint8_t)((g * 100U) / 255U));
	led_set_brightness(leds, LED_BLUE,  (uint8_t)((b * 100U) / 255U));
}

static void led_indicate(uint8_t r, uint8_t g, uint8_t b, uint32_t ms)
{
	set_rgb(r, g, b);
	k_msleep(ms);
	set_rgb(0, 0, 0);
}

/* ----------------------------- button ------------------------------------ */
/* The button is driven directly (not via the input subsystem) so the same pin
 * can be reconfigured as the System OFF wake source. */
static const struct gpio_dt_spec btn = GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios);

static bool button_pressed(void)
{
	return gpio_pin_get_dt(&btn) > 0; /* active-low handled by DT flags */
}

/* --------------------------- activity clock ------------------------------ */
/* Updated whenever something happens that should keep the tag awake. */
static int64_t last_activity_ms;

static void mark_active(void)
{
	last_activity_ms = k_uptime_get();
}

/* ------------------------------- radio ----------------------------------- */

static const struct device *const radio_dev =
	DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;
static uint16_t g_band_addr = AURA_ADDR_UNASSIGNED;

#define AURA_BEACON_FRAME_LEN (AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN)

static void send_beacon(uint8_t *mac_seq, uint8_t *app_seq)
{
	static uint8_t frame[AURA_BEACON_FRAME_LEN] __aligned(4);
	uint8_t *p = aura_mhr_write(frame, (*mac_seq)++,
				    AURA_ADDR_BROADCAST, g_band_addr);

	aura_hdr_write(p, AURA_MSG_BEACON, (*app_seq)++);
	p += AURA_HDR_LEN;
	p[0] = AURA_CAPS_K7;
	p[1] = AURA_BATTERY_UNKNOWN;
	p[2] = 0; /* gesture (none) */
	p[3] = 0; /* flags */

	struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);

	if (!pkt) {
		return;
	}
	if (net_pkt_alloc_buffer_raw(pkt, AURA_BEACON_FRAME_LEN, K_NO_WAIT) < 0) {
		net_pkt_unref(pkt);
		return;
	}
	net_pkt_cursor_init(pkt);
	if (net_pkt_write(pkt, frame, AURA_BEACON_FRAME_LEN) != 0) {
		net_pkt_unref(pkt);
		return;
	}

	struct net_buf *frag = pkt->buffer;
	int err = radio_api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, frag);

	if (err) {
		LOG_WRN("beacon tx failed: %d", err);
	}
	net_pkt_unref(pkt);
}

/* Raw-mode L2 hooks. */
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
	uint16_t src, dst;

	if (length < AURA_MHR_LEN + AURA_HDR_LEN ||
	    !aura_mhr_parse(psdu, (uint8_t)length, &src, &dst)) {
		goto out;
	}
	if (dst != AURA_ADDR_BROADCAST && dst != g_band_addr) {
		goto out;
	}

	uint8_t seq;
	int type = aura_hdr_parse(psdu + AURA_MHR_LEN,
				  (uint8_t)(length - AURA_MHR_LEN), &seq);

	if (type < 0) {
		goto out;
	}

	if (type == AURA_MSG_CMD) {
		static int last_cmd_seq = -1;

		if ((int)seq == last_cmd_seq) {
			goto out;
		}
		last_cmd_seq = seq;

		const uint8_t *pos = psdu + AURA_MHR_LEN + AURA_HDR_LEN;
		const uint8_t *end = psdu + length;
		struct aura_tlv t;

		while ((pos = aura_tlv_next(pos, end, &t)) != NULL) {
			if (t.tag == AURA_TLV_LED && t.len == AURA_TLV_LED_LEN) {
				/* Indication only: show the commanded colour
				 * briefly, then let it fall back to off. */
				led_indicate(t.value[2], t.value[3],
					     t.value[4], 150);
				mark_active(); /* a command keeps us awake */
			}
		}
	}

out:
	net_pkt_unref(pkt);
	return 0;
}

static void radio_setup(void)
{
	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	__ASSERT_NO_MSG(radio_api);

	g_band_addr = aura_band_addr_from_deviceid(NRF_FICR->INFO.DEVICEID[0],
						   NRF_FICR->INFO.DEVICEID[1]);

	const uint8_t pan_le[2] = { AURA_PAN_ID & 0xFF, AURA_PAN_ID >> 8 };
	const uint8_t short_le[2] = {
		(uint8_t)(g_band_addr & 0xFF), (uint8_t)(g_band_addr >> 8)
	};
	const uint8_t ext_addr[8] = {
		(uint8_t)(g_band_addr & 0xFF), (uint8_t)(g_band_addr >> 8),
		0xAE, 0x7F, 0xAE, 0x7F, 0xAE, 0x7F
	};

	nrf_802154_pan_id_set(pan_le);
	nrf_802154_short_address_set(short_le);
	nrf_802154_extended_address_set(ext_addr);

	struct ieee802154_config config = { .promiscuous = false };

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	nrf_802154_promiscuous_set(false);
	radio_api->set_channel(radio_dev, AURA_CHANNEL_DEFAULT);
	nrf_802154_tx_power_set(K7_TX_POWER_DBM);

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif
}

/* ---------------------------- deep sleep --------------------------------- */

static void enter_deep_sleep(void)
{
	/* Everything off, then arm the button as the wake source and power down.
	 * sys_poweroff() does not return; the chip cold-boots on the next press. */
	set_rgb(0, 0, 0);

	if (radio_api != NULL) {
		radio_api->stop(radio_dev); /* drop the receiver before powering down */
	}

	gpio_pin_configure_dt(&btn, GPIO_INPUT);
	gpio_pin_interrupt_configure_dt(&btn, GPIO_INT_LEVEL_ACTIVE);

	LOG_INF("entering System OFF (press KEY to wake)");
	sys_poweroff();
}

/* ------------------------------- main ------------------------------------ */

int main(void)
{
	LOG_INF("K7 wake: starting active session");

	(void)gpio_pin_configure_dt(&btn, GPIO_INPUT);

	/* Brief green blink to confirm wake (indication only). */
	led_indicate(0, 255, 0, K7_WAKE_BLINK_MS);

	if (!device_is_ready(radio_dev)) {
		LOG_ERR("radio not ready");
		enter_deep_sleep();
	}

	radio_setup();

	/* Receiver on for the (short) session so indication/LED commands and
	 * beacon TX both work. It is stopped again in enter_deep_sleep(). */
	radio_api->start(radio_dev);

	uint8_t mac_seq = 0;
	uint8_t app_seq = 0;
	bool last_btn = false;

	mark_active();

	while (1) {
		send_beacon(&mac_seq, &app_seq);

		/* Button press (edge) extends the active window. */
		bool now_btn = button_pressed();

		if (now_btn && !last_btn) {
			mark_active();
		}
		last_btn = now_btn;

		if (k_uptime_get() - last_activity_ms >=
		    (K7_ACTIVE_WINDOW_S * 1000)) {
			break;
		}

		/* Idle until the next beacon. The CPU is in WFI here; if RX is
		 * enabled the radio stays in receive across this gap. */
		k_msleep(K7_BEACON_INTERVAL_MS);
	}

	enter_deep_sleep();
	return 0; /* unreachable */
}

/*
 * ----------------------------------------------------------------------------
 * Power budget (nRF54L15 datasheet figures @ 3.0 V, 800 mAh cell)
 *
 *   System OFF (button wake) .............. ~0.8 uA
 *   System ON idle (RTC, RAM retained) .... ~2.6 uA
 *   Radio RX (listening) .................. ~3.2 mA
 *   Radio TX @ +8 dBm ..................... ~10 mA   (~4-5 mA @ 0 dBm)
 *
 *   1-year target average current ......... ~91 uA
 *   3-year (factory claim) ................ ~30 uA
 *
 * This firmware spends almost the entire year in System OFF (~0.8 uA), which
 * is ~7 mAh/year - negligible. Battery life is then set by how much you wake:
 *
 *   - An active session keeps the receiver on (~3.2 mA) for
 *     K7_ACTIVE_WINDOW_S seconds per wake.
 *   - Example: sessions of 15 s, 20 times/day
 *       = 20 * 15 s * 3.2 mA = ~0.27 mAh/day = ~97 mAh/year  -> >1 yr easily,
 *     and the ~7 mAh/year System OFF floor is in the noise.
 *
 * Knobs, cheapest first:
 *   1. Shorten K7_ACTIVE_WINDOW_S (linear saving on every wake).
 *   2. Lower K7_TX_POWER_DBM (already 0 dBm here).
 *   3. Keep CONFIG_LOG/serial off in production (see prj.conf vs debug.conf).
 *   4. For a true TX-only build (never receives), replace radio start() with
 *      per-beacon transmit + nrf_802154_sleep() so the receiver is never on.
 *   5. For a periodic heartbeat instead of button-only wake, use a GRTC/RTC
 *      timer wake (System ON idle, ~2.6 uA) rather than System OFF.
 * ----------------------------------------------------------------------------
 */
