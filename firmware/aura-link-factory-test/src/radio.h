#ifndef FT_RADIO_H
#define FT_RADIO_H

#include <stdint.h>
#include <stdbool.h>

#define FT_RADIO_CHANNEL_DEFAULT 15

int  radio_init(uint8_t channel, const uint8_t id[8]);
/* Transmit one test frame. 0 on success (radio reported TX done). */
int  radio_send_test_frame(void);
int  radio_set_channel(uint8_t ch);
uint8_t radio_channel(void);

struct radio_stats {
	uint32_t tx_ok, tx_fail;
	uint32_t rx_total;      /* any 802.15.4 frame heard */
	uint32_t rx_peer;       /* factory-test frames from another unit */
	int8_t   last_peer_rssi;
	uint8_t  last_peer_id[4];
};
void radio_get_stats(struct radio_stats *out);
void radio_reset_stats(void);

#endif
