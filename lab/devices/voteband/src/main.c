/*
 * Aetherfield voteband - minimal 802.15.4 voting beacon
 * Target: Seeed XIAO nRF52840  (board: xiao_ble)
 *
 * Periodically broadcasts a v1 BEACON (see ../../include/aura_radio.h and
 * PROTOCOL.md). The beacon's gesture byte carries the vote state, sourced
 * from a momentary button (D0 -> GND). This is the cheapest possible band:
 * an nRF52840 + one button, no IMU/mic/edgeai.
 *
 * Verify with the AURA sniffer (promiscuous hex dump): you should see a
 * 16-byte frame starting 41 88 .. 7f ae ff ff <src_lo> <src_hi> a7 11 ..
 * appear ~1x/sec, with the gesture byte flipping 00<->01 as you hold D0 low.
 */
#include <zephyr/kernel.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/sys/util.h>
#include <nrf_802154.h>
#include <hal/nrf_ficr.h>
#include <stdint.h>

#include "aura_radio.h"

/* Gesture classes carried in the BEACON gesture byte. */
#define VOTE_GESTURE_IDLE   0
#define VOTE_GESTURE_VOTE   1

/* This board's capabilities: button-only band (cheapest build). */
#define VOTEBAND_CAPS       (AURA_CAP_BUTTON)

#define BEACON_INTERVAL_MS  1000

/* Full frame: MAC header + app header + beacon body. */
#define FRAME_LEN  (AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN)

static const struct device *radio_dev =
	DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;

/* Onboard user LED as a TX heartbeat (provided by the board). */
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* Vote button is optional - firmware still beacons if it's absent. */
#define HAVE_VOTE_BTN DT_NODE_EXISTS(DT_ALIAS(votesw))
#if HAVE_VOTE_BTN
static const struct gpio_dt_spec vote_btn =
	GPIO_DT_SPEC_GET(DT_ALIAS(votesw), gpios);
#endif

/* The 16-bit MAC short address IS this band's identity (FICR-derived). */
static uint16_t my_addr;

/* Raw-mode L2 needs these symbols even for a TX-only app. */
enum net_verdict ieee802154_handle_ack(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);
	ARG_UNUSED(pkt);
	return NET_DROP;
}

int net_recv_data(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);
	if (pkt) {
		net_pkt_unref(pkt);
	}
	return 0;
}

static uint16_t derive_my_addr(void)
{
#if NRF_FICR_HAS_DEVICE_ID || NRF_FICR_HAS_INFO_DEVICE_ID
	uint32_t id0 = nrf_ficr_deviceid_get(NRF_FICR, 0U);
	uint32_t id1 = nrf_ficr_deviceid_get(NRF_FICR, 1U);
	return aura_band_addr_from_deviceid(id0, id1);
#else
	/* No FICR device id: fall back to a fixed band address. */
	return AURA_ADDR_BAND_BASE;
#endif
}

static uint8_t read_vote_gesture(void)
{
#if HAVE_VOTE_BTN
	/* Button is GPIO_ACTIVE_LOW, so gpio_pin_get_dt() returns 1 when held. */
	return gpio_pin_get_dt(&vote_btn) > 0 ? VOTE_GESTURE_VOTE : VOTE_GESTURE_IDLE;
#else
	return VOTE_GESTURE_IDLE;
#endif
}

static void send_beacon(uint8_t seq, uint8_t gesture)
{
	static uint8_t frame[FRAME_LEN] __aligned(4);

	uint8_t *payload = aura_mhr_write(frame, seq, AURA_ADDR_BROADCAST, my_addr);
	aura_hdr_write(payload, AURA_MSG_BEACON, seq);

	uint8_t *body = payload + AURA_HDR_LEN;
	body[0] = VOTEBAND_CAPS;
	body[1] = AURA_BATTERY_UNKNOWN;
	body[2] = gesture;
	body[3] = 0; /* flags reserved */

	struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);
	if (!pkt) {
		return;
	}
	if (net_pkt_alloc_buffer_raw(pkt, FRAME_LEN, K_NO_WAIT) < 0) {
		net_pkt_unref(pkt);
		return;
	}
	net_pkt_cursor_init(pkt);
	if (net_pkt_write(pkt, frame, FRAME_LEN) != 0) {
		net_pkt_unref(pkt);
		return;
	}

	(void)radio_api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, pkt->buffer);
	net_pkt_unref(pkt);
}

int main(void)
{
	my_addr = derive_my_addr();

	if (gpio_is_ready_dt(&led)) {
		gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	}
#if HAVE_VOTE_BTN
	if (gpio_is_ready_dt(&vote_btn)) {
		gpio_pin_configure_dt(&vote_btn, GPIO_INPUT);
	}
#endif

	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	__ASSERT_NO_MSG(radio_api);

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif
	nrf_802154_tx_power_set(AURA_TX_POWER_DBM);

	radio_api->set_channel(radio_dev, AURA_CHANNEL_DEFAULT);
	radio_api->start(radio_dev);

	uint8_t seq = 0;
	while (1) {
		uint8_t gesture = read_vote_gesture();

		send_beacon(seq++, gesture);

		/* Heartbeat: solid while voting, brief blink otherwise. */
		if (gpio_is_ready_dt(&led)) {
			if (gesture == VOTE_GESTURE_VOTE) {
				gpio_pin_set_dt(&led, 1);
			} else {
				gpio_pin_set_dt(&led, 1);
				k_msleep(15);
				gpio_pin_set_dt(&led, 0);
			}
		}

		k_msleep(BEACON_INTERVAL_MS);
	}
	return 0;
}
