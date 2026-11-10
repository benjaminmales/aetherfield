/*
 * aura_band.h - shared Aetherfield v2 band layer
 *
 * Everything a device needs to be a v2 band EXCEPT how it makes light:
 * radio bring-up, CMD/SYNC receive, command dedupe and group filtering,
 * the op_mode state machine, beacon/event/contact transmit, the shared-clock
 * animation engine, and the channel-loss fallbacks.
 *
 * ------------------------------------------------------------------------
 * The seam
 * ------------------------------------------------------------------------
 *
 * v2 treats every device as ONE light source however many LEDs it carries.
 * So this layer computes a single RGB triple per frame and hands it to a
 * board-supplied render callback. The wristband paints it across four LP5012
 * channels; the pixel module writes one WS2812; a lanyard supplies no
 * callback at all and simply never lights up.
 *
 * That is the capability model expressed in code: same command, same
 * animation maths, different final centimetre.
 *
 * ------------------------------------------------------------------------
 * Usage
 * ------------------------------------------------------------------------
 *
 *   static void render(uint8_t r, uint8_t g, uint8_t b) { ... }
 *
 *   struct aura_band_cfg cfg = {
 *       .caps = AURA_CAPS_PIXEL_XIAO,
 *       .group_mask = 0x01,
 *       .render = render,
 *       .battery_pct = NULL,        // optional
 *   };
 *   aura_band_init(&cfg);           // starts the radio + internal threads
 *
 * Then just report state as it changes:
 *   aura_band_set_flag(AURA_FLAG_HAND_RAISED, true);
 *   aura_band_send_event(AURA_EVENT_GESTURE, 2, 100);
 */

#ifndef AURA_BAND_H
#define AURA_BAND_H

#include <stdint.h>
#include <stdbool.h>
#include "aura_radio.h"

/* Board paints one colour. Called from the animation thread at ~50 Hz.
 * Must not block for long. */
typedef void (*aura_render_fn)(uint8_t r, uint8_t g, uint8_t b);

/* Optional: return battery 0..100, or AURA_BATTERY_UNKNOWN. */
typedef uint8_t (*aura_battery_fn)(void);

/* Optional bring-up trace. Called once as each init step COMPLETES, so on a
 * board with no console the LED can count them out and the last number you
 * see is the last step that worked. Steps are AURA_INIT_*. */
typedef void (*aura_progress_fn)(uint8_t step);

#define AURA_INIT_ENTERED   1  /* config stored, mutex up */
#define AURA_INIT_ADDR      2  /* short address derived from FICR */
#define AURA_INIT_RADIO_DEV 3  /* radio device ready, api fetched */
#define AURA_INIT_ANTENNA   4  /* rfsw_ctl driven */
#define AURA_INIT_PIB       5  /* PAN + addresses programmed */
#define AURA_INIT_STARTED   6  /* radio started and receiving */
#define AURA_INIT_THREADS   7  /* about to start anim + radio threads.
				* Signalled BEFORE they exist: once the anim
				* thread runs it owns the light, and a progress
				* callback after that puts a second thread in
				* the same SPI path. */

struct aura_band_cfg {
	uint8_t         caps;        /* AURA_CAPS_* for this board */
	uint8_t         group_mask;  /* which groups this device belongs to */
	aura_render_fn  render;      /* NULL for devices with no light */
	aura_battery_fn battery_pct; /* NULL -> reports AURA_BATTERY_UNKNOWN */

	/* XIAO nRF54L15 antenna select (rfsw_ctl, P2.05).
	 *
	 * false = onboard ceramic  (physical 0)
	 * true  = external u.FL    (physical 1)
	 *
	 * This MUST match the antenna actually fitted. The devicetree marks
	 * rfsw_ctl as regulator-fixed / ACTIVE_LOW / regulator-boot-on, so if
	 * nothing drives it the pin sits physically LOW - i.e. onboard - which
	 * is a boot-time accident rather than a decision. Selecting a port with
	 * no antenna on it leaves the radio nearly deaf and mute, and it looks
	 * exactly like a protocol bug. Say what you mean.
	 */
	bool antenna_external;

	/* Optional. See aura_progress_fn. */
	aura_progress_fn progress;
};

int  aura_band_init(const struct aura_band_cfg *cfg);

/* This device's short address (FICR-derived). Valid after init. */
uint16_t aura_band_addr(void);

/* Set or clear a beacon flag (hand raised, button held, charging...). */
void aura_band_set_flag(uint8_t flag, bool on);

/* Send an EVENT uplink. Suppressed in LISTEN_ONLY - the whole point of
 * show mode is that the fleet is silent. */
void aura_band_send_event(uint8_t type, uint8_t value, uint8_t strength);

/* Report a proximity transition. Normally driven by the SOCIAL op_mode
 * internally, exposed for boards that detect peers another way (NFC). */
void aura_band_send_contact(uint16_t peer, int rssi_dbm, uint8_t event);

/* Current commanded state, for boards that want to react to it directly. */
const struct aura_cmd *aura_band_state(void);

/* Milliseconds on the gateway's clock, or local uptime if never synced. */
uint32_t aura_band_now_ms(void);
bool     aura_band_is_synced(void);

/* ------------------------------------------------------------------------
 * Load generation
 *
 * These two exist so a scale rehearsal can run the REAL firmware rather than
 * a simulator written to resemble it. A test that exercises a second
 * implementation measures the second implementation.
 * ------------------------------------------------------------------------ */

/*
 * Emit a beacon as if it came from `addr`.
 *
 * Identical bytes to this device's own beacon — same MHR builder, same
 * payload builder, same radio, same channel — with a different source
 * address. A gateway cannot distinguish one from a real device's, which is
 * the entire point: one board can present as 150 Pixels and everything
 * downstream is genuinely under test.
 *
 * `last_cmd_seq` should be the seq the caller last acted on, so the
 * gateway's delivery statistic stays meaningful for the virtual fleet too;
 * aura_band_state()->seq is normally the right value.
 *
 * Safe to call from a work item or thread. Not for production firmware —
 * nothing in the shipping apps calls it.
 */
void aura_band_beacon_as(uint16_t addr, uint8_t caps, uint8_t battery_pct,
			 uint8_t flags, uint8_t last_cmd_seq);

/*
 * Transmit with CSMA/CA instead of the default direct transmit.
 *
 * The shipping default is DIRECT: the radio does not listen before it talks,
 * which makes the uplink unslotted ALOHA. That peaks near 18% channel
 * utilisation and degrades beyond it, so at fleet scale it is worth being
 * able to measure the alternative on the real firmware rather than arguing
 * about it. Defaults to false; nothing in the shipping apps changes it.
 */
void aura_band_tx_csma(bool on);

/*
 * Pin this device's own short address instead of deriving it from FICR.
 *
 * Must be called BEFORE aura_band_init(); ignored afterwards.
 *
 * A load generator has a problem the shipping firmware does not: the board
 * beacons as itself as well as as its virtual fleet, and that real address is
 * hashed across the whole 61,438-address band. So it lands somewhere unrelated
 * to the block the board is presenting — which makes the fleet 151 devices
 * rather than 150, and, 4.9% of the time per board, lands INSIDE some other
 * board's block and quietly impersonates one of its devices. Across twenty
 * boards that is a 63% chance of at least one stray.
 *
 * Pinning the address to the first slot of the board's own block makes the
 * board device 0 of the 150 it represents rather than a 151st device standing
 * outside them. The arithmetic then closes exactly: 20 x 150 = 3000.
 *
 * Nothing in the shipping apps calls this.
 */
void aura_band_addr_override(uint16_t addr);

#endif /* AURA_BAND_H */
