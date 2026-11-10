/* radio.h - Aetherfield v1 802.15.4 radio for ESP32-C6 (esp_ieee802154) */
#ifndef VOTEBAND_RADIO_H
#define VOTEBAND_RADIO_H

#include <stdint.h>
#include <stdbool.h>

typedef struct {
    /* CMD 0x01 LED block (broadcast show-control) */
    void (*on_led)(uint8_t mode, uint8_t rate, uint8_t r, uint8_t g, uint8_t b);
    /* CMD 0x02 HAPTIC block (no motor on this board - UI pulse instead) */
    void (*on_haptic)(uint8_t pattern, uint8_t intensity);
    /* CMD 0x04 VOTE_CTRL block: action 0 = open/clear round, 1 = close */
    void (*on_vote_ctrl)(uint8_t action, uint8_t round_id);
    /* NET 0x10 CHANNEL_HOP applied (called after the hop) */
    void (*on_channel)(uint8_t new_channel);
} radio_callbacks_t;

/* Bring up the radio on AURA_CHANNEL_DEFAULT with hardware PAN/addr
 * filtering. Returns this band's FICR-equivalent short address
 * (derived from the efuse MAC). */
uint16_t radio_init(const radio_callbacks_t *cbs);

uint8_t radio_channel(void);

/* v1 BEACON broadcast (caps/battery/gesture). */
void radio_send_beacon(uint8_t caps, uint8_t battery, uint8_t gesture);

/* v1 EVENT type=BUTTON, value=1..4. Repeats the frame `repeats` times
 * (same app seq - the gateway dedupes on (src, seq)). Blocking, call from
 * a task context. */
void radio_send_button_event(uint8_t value, int repeats);

#endif
