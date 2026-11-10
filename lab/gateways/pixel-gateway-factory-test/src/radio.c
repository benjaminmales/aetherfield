/*
 * 802.15.4 radio test, using the same raw-mode arrangement as the gateway
 * firmware: the application defines net_recv_data() and receives every frame.
 *
 * Each unit broadcasts a small test frame once a second on a dedicated PAN
 * (0xFAC7, not the Aetherfield network PAN). Any other unit running this test
 * hears it and reports the sender and RSSI, so two boards on a bench test
 * each other's TX and RX paths.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
#include <string.h>

#include "radio.h"

#define TEST_PAN    0xFAC7
#define TEST_MAGIC0 'A'
#define TEST_MAGIC1 'F'
#define TEST_MAGIC2 'T'

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static const struct ieee802154_radio_api *api;

static uint8_t g_channel;
static uint8_t g_id[8];
static uint8_t g_seq;

static struct radio_stats g_stats;
static struct k_spinlock lock;

enum net_verdict ieee802154_handle_ack(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);
	ARG_UNUSED(pkt);
	return NET_DROP;
}

/*
 * Runs in the radio driver's context. Count and copy only — no logging, no
 * sleeping, no mutexes (that faulted the CPU on the band firmware).
 */
int net_recv_data(struct net_if *iface, struct net_pkt *pkt)
{
	ARG_UNUSED(iface);

	if (!pkt) {
		return -EINVAL;
	}

	struct net_buf *b = pkt->buffer;
	uint8_t *p = b ? b->data : NULL;
	size_t len = b ? b->len : 0;
	int8_t rssi = net_pkt_ieee802154_rssi_dbm(pkt);

	k_spinlock_key_t key = k_spin_lock(&lock);

	g_stats.rx_total++;

	/* FCF(2) SEQ(1) PAN(2) DST(2) SRC(2) | 'A' 'F' 'T' seq id[8] */
	if (p && len >= 9 + 3 + 1 + 8 &&
	    p[9] == TEST_MAGIC0 && p[10] == TEST_MAGIC1 && p[11] == TEST_MAGIC2 &&
	    memcmp(&p[13], g_id, 8) != 0) {
		g_stats.rx_peer++;
		g_stats.last_peer_rssi = rssi;
		memcpy(g_stats.last_peer_id, &p[13 + 4], 4);
	}
	k_spin_unlock(&lock, key);

	net_pkt_unref(pkt);
	return 0;
}

int radio_init(uint8_t channel, const uint8_t id[8])
{
	if (!device_is_ready(radio_dev)) {
		return -ENODEV;
	}
	api = radio_dev->api;
	if (!api) {
		return -ENODEV;
	}
	memcpy(g_id, id, 8);

	struct ieee802154_config cfg = { .promiscuous = true };

	api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &cfg);

	int err = radio_set_channel(channel);

	if (err) {
		return err;
	}
	api->set_txpower(radio_dev, 8);
	return api->start(radio_dev);
}

int radio_set_channel(uint8_t ch)
{
	if (ch < 11 || ch > 26) {
		return -EINVAL;
	}
	g_channel = ch;
	return api->set_channel(radio_dev, ch);
}

uint8_t radio_channel(void)
{
	return g_channel;
}

int radio_send_test_frame(void)
{
	uint8_t f[9 + 3 + 1 + 8];

	f[0] = 0x41;                 /* data frame, PAN ID compression */
	f[1] = 0x88;                 /* short dst + short src, 2006 */
	f[2] = g_seq;
	f[3] = TEST_PAN & 0xFF;  f[4] = TEST_PAN >> 8;
	f[5] = 0xFF;             f[6] = 0xFF;            /* broadcast */
	f[7] = g_id[6];          f[8] = g_id[7];
	f[9] = TEST_MAGIC0;  f[10] = TEST_MAGIC1;  f[11] = TEST_MAGIC2;
	f[12] = g_seq++;
	memcpy(&f[13], g_id, 8);

	struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);

	if (!pkt) {
		return -ENOMEM;
	}
	if (net_pkt_alloc_buffer_raw(pkt, sizeof(f), K_NO_WAIT) < 0) {
		net_pkt_unref(pkt);
		return -ENOMEM;
	}
	net_pkt_cursor_init(pkt);
	net_pkt_write(pkt, f, sizeof(f));

	int err = api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, pkt->buffer);

	net_pkt_unref(pkt);

	k_spinlock_key_t key = k_spin_lock(&lock);

	if (err == 0) {
		g_stats.tx_ok++;
	} else {
		g_stats.tx_fail++;
	}
	k_spin_unlock(&lock, key);
	return err;
}

void radio_get_stats(struct radio_stats *out)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	*out = g_stats;
	k_spin_unlock(&lock, key);
}

void radio_reset_stats(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	memset(&g_stats, 0, sizeof(g_stats));
	k_spin_unlock(&lock, key);
}
