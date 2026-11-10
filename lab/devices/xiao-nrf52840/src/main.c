/*
 * Aetherfield Xiao-nRF52840 - minimal 802.15.4 bring-up test
 *
 * Target: Seeed XIAO nRF52840 (bare board - board target `xiao_ble`, NOT the
 * `sense` variant). No IMU, no mic, no RGB LED driver chip - just three
 * discrete GPIO LEDs (led0=red, led1=green, led2=blue) provided by the board.
 *
 * Proves out:
 *  - 802.15.4 radio bring-up (TX beacon every 1s, see PROTOCOL.md /
 *    ../../include/aura_radio.h for the v1 wire format)
 *  - RX of downlink AURA_MSG_CMD frames carrying an AURA_TLV_LED block, with
 *    the three onboard LEDs approximating color by thresholding R/G/B
 *    (no PWM dimming wired up yet - this is a bring-up test, not final art)
 *
 * Verify with the AURA sniffer: you should see a 16-byte BEACON frame
 * (41 88 .. 7f ae ff ff <src_lo> <src_hi> a7 11 ..) every ~1s, and sending a
 * CMD frame with an LED TLV should change the onboard LEDs within ~1 poll.
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
#include <stdio.h>
#include <string.h>

#include "aura_radio.h"

/* Bare board: RGB approximated by 3 discrete LEDs, no IMU/mic. */
#define XIAO52_CAPS (AURA_CAP_RGB_LED)

#define AURA_BEACON_INTERVAL_MS 1000
#define AURA_BEACON_FRAME_LEN   (AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN)

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;
static uint16_t g_band_addr = AURA_ADDR_UNASSIGNED;

/* Onboard LEDs: led0=red, led1=green, led2=blue (all GPIO_ACTIVE_LOW). */
static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec led_g = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_ALIAS(led2), gpios);

static void set_led_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	/* No PWM dimming wired up yet - threshold each channel on/off. */
	gpio_pin_set_dt(&led_r, r >= 128);
	gpio_pin_set_dt(&led_g, g >= 128);
	gpio_pin_set_dt(&led_b, b >= 128);
}

/* ========================================================================
 * LED animation (subset of modes; enough to prove the command path works)
 * ======================================================================== */

typedef struct {
	uint8_t mode, rate, r, g, b;
} led_anim_cmd_t;

static led_anim_cmd_t anim_cmd = {0, 0, 0, 0, 0};
static struct k_mutex anim_cmd_mutex;
static struct k_sem anim_cmd_sem;

#define ANIM_STACK_SIZE 1024
#define ANIM_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(anim_stack, ANIM_STACK_SIZE);
static struct k_thread anim_thread_data;

static void led_animation_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	while (1) {
		k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
		led_anim_cmd_t cmd = anim_cmd;
		k_mutex_unlock(&anim_cmd_mutex);

		uint32_t interval = (uint32_t)cmd.rate * 10;
		if (interval == 0) {
			interval = 500;
		}

		switch (cmd.mode) {
		case 0: /* Steady */
			set_led_rgb(cmd.r, cmd.g, cmd.b);
			k_sem_take(&anim_cmd_sem, K_FOREVER);
			break;
		case 2: /* Flash */
			set_led_rgb(cmd.r, cmd.g, cmd.b);
			k_msleep(interval);
			set_led_rgb(0, 0, 0);
			k_msleep(interval);
			break;
		default: /* Unsupported mode in this bring-up build: LEDs off */
			set_led_rgb(0, 0, 0);
			k_sem_take(&anim_cmd_sem, K_FOREVER);
			break;
		}

		/* Drain a pending new command without blocking on the old one. */
		if (k_sem_take(&anim_cmd_sem, K_NO_WAIT) == 0) {
			continue;
		}
	}
}

static void handle_led_animation(uint8_t mode, uint8_t rate, uint8_t r, uint8_t g, uint8_t b)
{
	k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
	anim_cmd.mode = mode;
	anim_cmd.rate = rate;
	anim_cmd.r = r;
	anim_cmd.g = g;
	anim_cmd.b = b;
	k_mutex_unlock(&anim_cmd_mutex);
	k_sem_give(&anim_cmd_sem);
}

/* ========================================================================
 * Radio: TX beacon + RX command handling
 * ======================================================================== */

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
	int type = aura_hdr_parse(psdu + AURA_MHR_LEN, (uint8_t)(length - AURA_MHR_LEN), &seq);

	if (type != AURA_MSG_CMD) {
		goto out;
	}

	/* Gateway repeats each CMD; apply once per app seq. */
	static int last_cmd_seq = -1;

	if ((int)seq == last_cmd_seq) {
		goto out;
	}
	last_cmd_seq = seq;

	const uint8_t *body = psdu + AURA_MHR_LEN + AURA_HDR_LEN;
	const uint8_t *end = psdu + length;
	const uint8_t *pos = body;
	struct aura_tlv t;

	while ((pos = aura_tlv_next(pos, end, &t)) != NULL) {
		if (t.tag == AURA_TLV_LED && t.len == AURA_TLV_LED_LEN) {
			handle_led_animation(t.value[0], t.value[1], t.value[2],
					      t.value[3], t.value[4]);
			printf("LED cmd: mode=%u rate=%u rgb=%u,%u,%u\n",
			       t.value[0], t.value[1], t.value[2], t.value[3], t.value[4]);
		}
		/* Unknown tags (haptic, channel hop, ...) skipped in this test build. */
	}

out:
	net_pkt_unref(pkt);
	return 0;
}

static void send_beacon(uint8_t seq)
{
	static uint8_t frame[AURA_BEACON_FRAME_LEN] __aligned(4);

	uint8_t *p = aura_mhr_write(frame, seq, AURA_ADDR_BROADCAST, g_band_addr);

	aura_hdr_write(p, AURA_MSG_BEACON, seq);
	p += AURA_HDR_LEN;

	p[0] = XIAO52_CAPS;
	p[1] = AURA_BATTERY_UNKNOWN;
	p[2] = 0; /* gesture: none on this bring-up build */
	p[3] = 0;

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

	int err = radio_api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, pkt->buffer);

	if (err == 0) {
		static uint32_t tx_ok;

		if ((++tx_ok % 10) == 1) {
			printf("Beacon #%u OK (addr 0x%04X ch %u)\n", tx_ok, g_band_addr,
			       AURA_CHANNEL_DEFAULT);
		}
	} else {
		printf("Beacon TX failed: %d\n", err);
	}

	net_pkt_unref(pkt);
}

static uint16_t derive_band_addr(void)
{
#if NRF_FICR_HAS_DEVICE_ID || NRF_FICR_HAS_INFO_DEVICE_ID
	uint32_t id0 = nrf_ficr_deviceid_get(NRF_FICR, 0U);
	uint32_t id1 = nrf_ficr_deviceid_get(NRF_FICR, 1U);

	return aura_band_addr_from_deviceid(id0, id1);
#else
	return AURA_ADDR_BAND_BASE;
#endif
}

int main(void)
{
	printf("\nXiao-nRF52840 802.15.4 bring-up test\n");

	if (gpio_is_ready_dt(&led_r) && gpio_is_ready_dt(&led_g) && gpio_is_ready_dt(&led_b)) {
		gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
		gpio_pin_configure_dt(&led_g, GPIO_OUTPUT_INACTIVE);
		gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);
	} else {
		printf("WARNING: onboard LEDs not ready\n");
	}

	k_mutex_init(&anim_cmd_mutex);
	k_sem_init(&anim_cmd_sem, 0, 1);
	k_thread_create(&anim_thread_data, anim_stack, ANIM_STACK_SIZE, led_animation_thread,
			NULL, NULL, NULL, ANIM_THREAD_PRIORITY, 0, K_NO_WAIT);

	/* Boot flash: white-ish (all three LEDs) to confirm GPIO works. */
	set_led_rgb(0xFF, 0xFF, 0xFF);
	k_msleep(200);
	set_led_rgb(0, 0, 0);

	g_band_addr = derive_band_addr();
	printf("Band address: 0x%04X (PAN 0x%04X, ch %u)\n", g_band_addr, AURA_PAN_ID,
	       AURA_CHANNEL_DEFAULT);

	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	__ASSERT_NO_MSG(radio_api);

	const uint8_t pan_le[2] = {AURA_PAN_ID & 0xFF, AURA_PAN_ID >> 8};
	const uint8_t short_le[2] = {(uint8_t)(g_band_addr & 0xFF), (uint8_t)(g_band_addr >> 8)};
	const uint8_t ext_addr[8] = {(uint8_t)(g_band_addr & 0xFF),
				     (uint8_t)(g_band_addr >> 8),
				     0xAE, 0x7F, 0xAE, 0x7F, 0xAE, 0x7F};

	nrf_802154_pan_id_set(pan_le);
	nrf_802154_short_address_set(short_le);
	nrf_802154_extended_address_set(ext_addr);

	struct ieee802154_config config = {.promiscuous = false};

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	nrf_802154_promiscuous_set(false);

	radio_api->set_channel(radio_dev, AURA_CHANNEL_DEFAULT);
	nrf_802154_tx_power_set(AURA_TX_POWER_DBM);

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif

	radio_api->start(radio_dev);

	uint8_t seq = 0;

	while (1) {
		send_beacon(seq++);
		k_sleep(K_MSEC(AURA_BEACON_INTERVAL_MS));
	}

	return 0;
}
