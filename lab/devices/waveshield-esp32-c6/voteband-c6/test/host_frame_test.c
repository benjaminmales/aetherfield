/*
 * host_frame_test.c - host-side check that voteband-c6 emits the exact
 * on-air bytes the AURA sniffer / nRF54 gateway expect.
 *
 * Build & run:  gcc -I../../../include host_frame_test.c -o t && ./t
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "aura_radio.h"

static void build_beacon(uint8_t *psdu, uint16_t src, uint8_t mac_seq,
                         uint8_t app_seq, uint8_t caps, uint8_t batt,
                         uint8_t gesture)
{
    uint8_t *pl = aura_mhr_write(psdu, mac_seq, AURA_ADDR_BROADCAST, src);
    aura_hdr_write(pl, AURA_MSG_BEACON, app_seq);
    pl[AURA_HDR_LEN + 0] = caps;
    pl[AURA_HDR_LEN + 1] = batt;
    pl[AURA_HDR_LEN + 2] = gesture;
    pl[AURA_HDR_LEN + 3] = 0;
}

static void build_event(uint8_t *psdu, uint16_t src, uint8_t mac_seq,
                        uint8_t app_seq, uint8_t value)
{
    uint8_t *pl = aura_mhr_write(psdu, mac_seq, AURA_ADDR_BROADCAST, src);
    aura_hdr_write(pl, AURA_MSG_EVENT, app_seq);
    pl[AURA_HDR_LEN + 0] = AURA_EVENT_BUTTON;
    pl[AURA_HDR_LEN + 1] = value;
    pl[AURA_HDR_LEN + 2] = 0;
}

int main(void)
{
    uint8_t f[64];

    /* --- BEACON: 41 88 seq 7f ae ff ff src_lo src_hi a7 11 seq caps batt g 0 */
    build_beacon(f, 0x1A2B, 0x05, 0x07, 0x34, 0xFF, 3);
    const uint8_t exp_beacon[] = {
        0x41, 0x88, 0x05, 0x7F, 0xAE, 0xFF, 0xFF, 0x2B, 0x1A,
        0xA7, 0x11, 0x07, 0x34, 0xFF, 0x03, 0x00,
    };
    assert(sizeof(exp_beacon) ==
           AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN);
    assert(memcmp(f, exp_beacon, sizeof(exp_beacon)) == 0);

    /* Round-trip through the same parsers the gateway uses. */
    uint16_t src, dst;
    assert(aura_mhr_parse(f, sizeof(exp_beacon), &src, &dst));
    assert(src == 0x1A2B && dst == AURA_ADDR_BROADCAST);
    uint8_t seq;
    assert(aura_hdr_parse(f + AURA_MHR_LEN, AURA_HDR_LEN, &seq) ==
           AURA_MSG_BEACON);
    assert(seq == 0x07);

    /* --- EVENT button=2: a7 12 seq 02 02 00 */
    build_event(f, 0x1A2B, 0x06, 0x08, 2);
    const uint8_t exp_event[] = {
        0x41, 0x88, 0x06, 0x7F, 0xAE, 0xFF, 0xFF, 0x2B, 0x1A,
        0xA7, 0x12, 0x08, 0x02, 0x02, 0x00,
    };
    assert(memcmp(f, exp_event, sizeof(exp_event)) == 0);

    /* --- Address derivation is deterministic and in band range. */
    uint16_t a1 = aura_band_addr_from_deviceid(0xDEADBEEF, 0x00001234);
    uint16_t a2 = aura_band_addr_from_deviceid(0xDEADBEEF, 0x00001234);
    assert(a1 == a2);
    assert(a1 >= AURA_ADDR_BAND_BASE && a1 <= AURA_ADDR_BAND_MAX);

    /* --- Downlink TLV walk incl. the new VOTE_CTRL tag. */
    uint8_t body[16], *w = body;
    const uint8_t led[] = {1, 10, 255, 0, 128};
    const uint8_t vote[] = {AURA_VOTE_OPEN, 7};
    w = aura_tlv_write(w, AURA_TLV_LED, led, sizeof(led));
    w = aura_tlv_write(w, AURA_TLV_VOTE_CTRL, vote, sizeof(vote));

    struct aura_tlv t;
    const uint8_t *pos = body;
    int seen_led = 0, seen_vote = 0;
    while ((pos = aura_tlv_next(pos, w, &t)) != NULL) {
        if (t.tag == AURA_TLV_LED) { seen_led = 1; assert(t.value[2] == 255); }
        if (t.tag == AURA_TLV_VOTE_CTRL) {
            seen_vote = 1;
            assert(t.value[0] == AURA_VOTE_OPEN && t.value[1] == 7);
        }
    }
    assert(seen_led && seen_vote);

    printf("host_frame_test: all assertions passed\n");
    printf("  beacon: ");
    for (size_t i = 0; i < sizeof(exp_beacon); i++) printf("%02x ", exp_beacon[i]);
    printf("\n  derived addr example: 0x%04X\n", a1);
    return 0;
}
