/*
 * aura_radio.h - Aetherfield shared 802.15.4 protocol definitions (v2)
 *
 * Shared by: AURA devices (seeed/xiao, pixel-xiao, holyiot, K7, waveshield),
 * GATEWAY/nrf54-firmware, NODE/node-firmware, GATEWAY/nrf54-serialTestBridge.
 *
 * THIS FILE IS THE SOURCE OF TRUTH. PROTOCOL.md and the whitepaper are
 * derived from it. If a doc disagrees, the doc is the bug.
 *
 * ------------------------------------------------------------------------
 * What v2 changes, and why
 * ------------------------------------------------------------------------
 *
 * v2 replaces v1's TLV command blocks with a FLAT FIXED LAYOUT.
 *
 *   Downlink airtime is effectively free - one broadcast reaches the whole
 *   room in ~4 ms at 250 kbps regardless of fleet size - so the extensibility
 *   TLV bought is not worth the parse complexity across four firmware trees
 *   plus a Node bridge plus a browser app. The capability bitmap does the
 *   same job: every device receives every field and its caps decide which
 *   ones it acts on. A lanyard with no LED receives a full CMD and ignores
 *   the animation fields. That is the mechanism, not a special case.
 *
 *   Cost of this choice: adding a field is a version bump for the whole
 *   fleet. Hence AURA_VER in every frame, and reserved bytes below.
 *
 * v2 also drops the legacy FCF 0x2241, which had malformed addressing-mode
 * bits and only ever worked because receivers ran promiscuous. Hardware PAN
 * and address filtering are on in v2.
 *
 * ------------------------------------------------------------------------
 * The two axes: op_mode and anim_mode
 * ------------------------------------------------------------------------
 *
 * These are ORTHOGONAL and must stay separate fields. The normal state
 * during a performance is "listen-only AND animating". Folding them into
 * one enum forces a cross-product (LISTEN_STEADY, LISTEN_FLASH, ...) that
 * doubles every time either axis grows.
 *
 *   op_mode   - what the RADIO and POWER state is doing. This is the fleet's
 *               uplink capacity control: uplink scales linearly with device
 *               count and is the binding constraint at 10k-50k units, while
 *               downlink does not. LISTEN_ONLY exists so a show can run with
 *               zero uplink traffic.
 *   anim_mode - what the LIGHT is doing. Ignored by devices without
 *               AURA_CAP_RGB_LED, and by op_modes where it is meaningless.
 *
 * ------------------------------------------------------------------------
 * Uplink is split by message id, not by a shared "info" field
 * ------------------------------------------------------------------------
 *
 * BEACON / CONTACT / EVENT each have a fixed layout. A union field would
 * force every receiver to guess what it is holding. Three msgids cost
 * nothing and remove the ambiguity entirely.
 *
 * Device identity is the 16-bit MAC SHORT ADDRESS and appears nowhere in a
 * payload. FICR-derived, so no provisioning step. Carrying it twice is how
 * the two copies end up disagreeing.
 */

#ifndef AURA_RADIO_H
#define AURA_RADIO_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================
 * Protocol version
 * ======================================================================== */

#define AURA_VER               2

/* ========================================================================
 * MAC / network constants
 * ======================================================================== */

#define AURA_PAN_ID            0xAE7F  /* "Aetherfield" PAN */

/* Channel plan: sits between Wi-Fi channels 1/6/11. Gateway energy-scans
 * this list at boot and may move the network mid-show. */
#define AURA_CHANNEL_DEFAULT   15
#define AURA_CHANNEL_LIST      { 15, 20, 25, 26 }
#define AURA_CHANNEL_COUNT     4

/* ------------------------------------------------------------------------
 * Downlink liveness timing - these four values are a SET, not independent
 * knobs. The relationship between them is the whole design:
 *
 *     SYNC_INTERVAL  <  CHANNEL_LOST  <  SHOW_LOST
 *     CHANNEL_DWELL  >  SYNC_INTERVAL
 *
 * A band decides the gateway is gone by not hearing downlink. The only
 * guaranteed periodic downlink is SYNC, so the loss timeout must be several
 * SYNC intervals or a band declares the gateway missing between every pair
 * of heartbeats. And while hunting, it must sit on each channel longer than
 * one SYNC interval, or it can never be listening when the heartbeat lands
 * and re-acquisition is impossible by construction.
 *
 * Getting this wrong the first time produced a band that hopped channels
 * four times a second, forever, while a perfectly healthy gateway sat one
 * metre away.
 * ------------------------------------------------------------------------ */

/* Gateway broadcasts SYNC this often. Downlink cost is flat regardless of
 * crowd size, so a brisk heartbeat is nearly free - and it is what makes
 * channel re-acquisition and clock discipline quick. */
#define AURA_SYNC_INTERVAL_MS  5000

/* No valid downlink for this long (4 missed SYNCs) -> start cycling
 * AURA_CHANNEL_LIST. */
#define AURA_CHANNEL_LOST_MS   20000

/* Listen this long on each channel while hunting. Must exceed one SYNC
 * interval with margin, or the band hops past the heartbeat every time. */
#define AURA_CHANNEL_DWELL_MS  7000

/* No valid downlink for this long -> fade to idle, so a band that has lost
 * the gateway does not sit at full brightness draining its cell. */
#define AURA_SHOW_LOST_MS      60000

/* 802.15.4-2003 data frame, no ACK request, PAN-ID compression,
 * 16-bit dst + 16-bit src addressing. */
#define AURA_FCF_DATA_NOACK    0x8841
#define AURA_FCF_DATA_ACK      0x8861  /* future unicast control traffic */

/* FCF(2) + seq(1) + dstPAN(2) + dst(2) + src(2) */
#define AURA_MHR_LEN           9

#define AURA_TX_POWER_DBM      8
#define AURA_MAX_PSDU          127

/* Gateway repeats every CMD this many times. Downlink is broadcast and
 * unacknowledged - never assume delivery. Devices dedupe on (src, seq). */
#define AURA_CMD_REPEAT        3

/* ========================================================================
 * Address plan (16-bit short addresses)
 * ======================================================================== */

#define AURA_ADDR_GATEWAY      0x0001
#define AURA_ADDR_NODE_BASE    0x0100  /* nodes: 0x0100..0x01FF */
#define AURA_ADDR_NODE_MAX     0x01FF
#define AURA_ADDR_BAND_BASE    0x1000  /* bands: 0x1000..0xFFFD */
#define AURA_ADDR_BAND_MAX     0xFFFD
#define AURA_ADDR_UNASSIGNED   0xFFFE
#define AURA_ADDR_BROADCAST    0xFFFF

static inline bool aura_addr_is_node(uint16_t a)
{
	return a >= AURA_ADDR_NODE_BASE && a <= AURA_ADDR_NODE_MAX;
}

static inline bool aura_addr_is_band(uint16_t a)
{
	return a >= AURA_ADDR_BAND_BASE && a <= AURA_ADDR_BAND_MAX;
}

/* Derive a band short address from the chip's factory device ID
 * (nRF54: NRF_FICR->INFO.DEVICEID[0..1]). Deterministic, no provisioning.
 * Collisions are unlikely (<0.1% for 100 bands) and can be resolved by a
 * registration flow that overrides the derived address. */
static inline uint16_t aura_band_addr_from_deviceid(uint32_t id0, uint32_t id1)
{
	uint32_t h = id0 ^ (id1 * 0x9E3779B9u);

	h ^= h >> 16;
	h ^= h >> 8;
	return (uint16_t)(AURA_ADDR_BAND_BASE +
			  (h % (AURA_ADDR_BAND_MAX - AURA_ADDR_BAND_BASE + 1u)));
}

/* ========================================================================
 * Message ids (payload byte 0)
 * ======================================================================== */

#define AURA_MSG_EVENT         0x02  /* band -> gw: gesture / button */
#define AURA_MSG_BEACON        0x03  /* band -> gw: presence + caps + state */
#define AURA_MSG_CMD           0x04  /* gw -> bands: the one command frame */
#define AURA_MSG_NODE_RELAY    0x05  /* node -> gw: relayed band frame */
#define AURA_MSG_CONTACT       0x06  /* band -> gw: proximity contact event */
#define AURA_MSG_SYNC          0x07  /* gw -> all: master clock + channel hop */

/* ========================================================================
 * DOWNLINK: CMD frame (AURA_MSG_CMD) - 12 byte payload
 *
 *   [0]  msgid       0x04
 *   [1]  ver         AURA_VER
 *   [2]  seq         dedupe key; echoed back in BEACON.last_cmd_seq
 *   [3]  group       0x00 = all; else bitmask AND against the device's mask
 *   [4]  anim_mode   AURA_ANIM_*
 *   [5]  anim_param  animation period / 10 ms  (0 = default 1 s)
 *   [6]  op_mode     AURA_OP_*
 *   [7]  op_param    meaning depends on op_mode - see the table
 *   [8]  R
 *   [9]  G
 *   [10] B
 *   [11] bright      master scale 0..255, applied AFTER the animation
 *   [12] dev_flags   AURA_DEV_FLAG_* - device CONFIGURATION, not show state
 *
 * 22 bytes on air including the MAC header. ~118 payload bytes are
 * available; the spare is deliberate headroom, not an oversight.
 * ======================================================================== */

#define AURA_CMD_LEN           13

#define AURA_CMD_OFF_MSGID     0
#define AURA_CMD_OFF_VER       1
#define AURA_CMD_OFF_SEQ       2
#define AURA_CMD_OFF_GROUP     3
#define AURA_CMD_OFF_ANIM_MODE 4
#define AURA_CMD_OFF_ANIM_PARAM 5
#define AURA_CMD_OFF_OP_MODE   6
#define AURA_CMD_OFF_OP_PARAM  7
#define AURA_CMD_OFF_R         8
#define AURA_CMD_OFF_G         9
#define AURA_CMD_OFF_B         10
#define AURA_CMD_OFF_BRIGHT    11
#define AURA_CMD_OFF_DEV_FLAGS 12

struct aura_cmd {
	uint8_t seq;
	uint8_t group;
	uint8_t anim_mode;
	uint8_t anim_param;
	uint8_t op_mode;
	uint8_t op_param;
	uint8_t r, g, b;
	uint8_t bright;
	uint8_t dev_flags;
};

/* ------------------------------------------------------------------------
 * anim_mode - what the light does
 *
 * v2 treats every device as ONE light source regardless of how many LEDs
 * it physically has. Spatial modes are reserved at 0x10+ so multi-LED
 * chasers arrive later as new enum values, not as a frame-layout change.
 * ------------------------------------------------------------------------ */

#define AURA_ANIM_OFF          0x00
#define AURA_ANIM_STEADY       0x01
#define AURA_ANIM_FLASH        0x02  /* square, 50% duty */
#define AURA_ANIM_PULSE        0x03  /* sine breathe */
#define AURA_ANIM_HEARTBEAT    0x04  /* double pulse, 20/12/10/58 split */
#define AURA_ANIM_RAMP         0x05  /* sawtooth build-up */
#define AURA_ANIM_STROBE       0x06  /* short hard flash */
#define AURA_ANIM_RAINBOW      0x07  /* hue sweep over time */
/* 0x08..0x0F reserved - temporal */
/* 0x10..0x1F reserved - spatial, requires AURA_CAP_MULTI_LED */
#define AURA_ANIM_SPATIAL_BASE 0x10

/* anim_param is the animation period in units of 10 ms. */
#define AURA_ANIM_PERIOD_MS(p) ((p) ? (uint32_t)(p) * 10u : 1000u)

/* ------------------------------------------------------------------------
 * op_mode - what the radio and power state do
 *
 *   mode           op_param means                behaviour
 *   NORMAL         beacon period / 100 ms        listen + beacon
 *   LISTEN_ONLY    -                             RX only, ZERO TX. Show mode.
 *   ROLL_CALL      response window / 100 ms      beacon once, in your slot
 *   SOCIAL         RSSI threshold (dBm + 128)    proximity scan -> CONTACT
 *   LOW_POWER      beacon period / 1 s           slow beacon, brightness capped
 *   SLEEP          wake interval, seconds        radio off, then an RX window
 *   IDENTIFY       -                             override anim, blink white
 *
 * IDENTIFY is an op_mode rather than an anim_mode because it deliberately
 * overrides whatever the show is doing - it is an operational action
 * ("which physical device is 0x1A2C?"), not a look.
 *
 * SLEEP IS ALWAYS DUTY-CYCLED. There is deliberately no unbounded sleep in
 * this protocol. A device that cannot hear the wake command is a brick, and
 * 50k bricked lanyards in a crate is not a recoverable situation. op_param
 * is the off-interval; the device must then open an RX window long enough
 * to catch a repeated CMD.
 * ------------------------------------------------------------------------ */

#define AURA_OP_NORMAL         0x00
#define AURA_OP_LISTEN_ONLY    0x01
#define AURA_OP_ROLL_CALL      0x02
#define AURA_OP_SOCIAL         0x03
#define AURA_OP_LOW_POWER      0x04
#define AURA_OP_SLEEP          0x05
#define AURA_OP_IDENTIFY       0x06

/*
 * Default beacon cadence when op_param is 0 in NORMAL.
 *
 * 5 s, not 1 s. One second was never a product requirement — presence at a
 * checkpoint is not a sub-second event — and at fleet scale it is actively
 * harmful: 3,000 devices at 1 s offer 3,000 frames/s, which is 221% of the
 * channel. The uplink is unslotted ALOHA, so past roughly 18% utilisation
 * beaconing MORE often means being detected LESS.
 *
 * This is only the fallback for op_param 0. The fleet is re-rated over the air
 * with 'aura op 0 <param>' (param x 100 ms), so the operating interval is a
 * decision made at the venue from measurement, not a constant compiled in.
 */
#define AURA_BEACON_DEFAULT_MS 5000

/* RX window a SLEEPing device must open on each wake, long enough to catch
 * a repeated CMD (AURA_CMD_REPEAT frames plus gateway spacing). */
#define AURA_SLEEP_RX_WINDOW_MS 250

/* ------------------------------------------------------------------------
 * dev_flags - device configuration
 *
 * Deliberately NOT an op_mode. NFC state is orthogonal to radio state: a
 * lanyard can sit in LISTEN_ONLY with its NFC tag live. Folding it into the
 * op enum would recreate exactly the cross-product problem that splitting
 * op_mode from anim_mode was meant to avoid.
 *
 * It is also configuration rather than show state - set once at deployment,
 * not changed per lighting cue - so it rides as a bitfield instead of
 * consuming a mode value. Devices without AURA_CAP_NFC ignore it.
 *
 * NFC AS THE RECOVERY PATH: on nRF5x the NFCT field-detect can wake the SoC
 * with the radio completely off. That makes a phone tap an out-of-band way
 * back into any device, which is the belt to duty-cycled SLEEP's braces -
 * a lanyard that somehow never hears another CMD is still physically
 * recoverable. Worth wiring on every NFC-capable board for that alone.
 * ------------------------------------------------------------------------ */

#define AURA_DEV_FLAG_NFC_EN   (1u << 0) /* NFC tag emulation enabled */
#define AURA_DEV_FLAG_NFC_WAKE (1u << 1) /* NFC field-detect wakes from SLEEP */

/*
 * Listen before transmitting.
 *
 * Clear (the default, and what every shipping image does today) the uplink
 * transmits with IEEE802154_TX_MODE_DIRECT: the radio talks without checking
 * whether anyone else is. That makes the uplink unslotted ALOHA, which peaks
 * near 18% channel utilisation and degrades beyond it — at 3,000 devices it is
 * the difference between roughly 60% and roughly 99% of devices being detected
 * inside a 20 s window.
 *
 * This belongs in dev_flags rather than op_param for the same reason NFC does:
 * it is configuration, decided once for a deployment from measurement, not
 * show state changed per cue. Putting it here also means it is FLEET-WIDE and
 * instantaneous — one broadcast flips every device at the same moment, which
 * is the only way to A/B it honestly. Setting boards one at a time produces a
 * fleet that is half one thing and half the other, and a smear rather than a
 * measurement.
 *
 * Older firmware ignores the bit, so this is backwards compatible.
 */
#define AURA_DEV_FLAG_TX_CSMA  (1u << 2) /* CSMA/CA instead of direct transmit */
/* bits 3..7 reserved */

/* ------------------------------------------------------------------------
 * Group addressing - 8-bit mask
 *
 * A device holds a group mask. A CMD with group 0x00 applies to everyone;
 * otherwise it applies if (cmd.group & my_mask) is non-zero. A mask rather
 * than an index so a device can be in several groups and one broadcast can
 * address a union of them ("all traitors" and "everyone" both work).
 * ------------------------------------------------------------------------ */

#define AURA_GROUP_ALL         0x00

static inline bool aura_group_match(uint8_t cmd_group, uint8_t my_mask)
{
	return cmd_group == AURA_GROUP_ALL || (cmd_group & my_mask) != 0u;
}

/* ========================================================================
 * DOWNLINK: SYNC frame (AURA_MSG_SYNC) - 9 byte payload
 *
 *   [0]    msgid  0x07
 *   [1]    ver
 *   [2..5] epoch_ms   LE32, the gateway's master clock
 *   [6]    hop_channel   0 = no hop pending
 *   [7]    hop_countdown frames remaining before the hop
 *   [8]    wave_step     per-group phase offset / 10 ms; 0 = unison
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A FIELD IN CMD.
 *
 * Phase-coherent animation across a crowd needs a shared CLOCK, not a phase
 * byte on every command. Given a common epoch, every device computes
 *
 *     frame = f(epoch_ms + local_elapsed, anim_mode, anim_param)
 *
 * and two devices that agree on the time agree on the frame by construction.
 * That keeps CMD at 13 bytes and means a cue does not have to carry timing.
 *
 * Unison is wave_step = 0. A wave is the same code path with a per-group
 * offset added, so an operator morphs between a crowd-wide strobe and a
 * rolling wave by changing one number.
 *
 * Broadcast every few tens of seconds. Cheap crystals drift tens of ppm -
 * a few ms per minute - which is inside the perceptual budget between
 * resyncs but not across a whole show.
 * ======================================================================== */

#define AURA_SYNC_LEN          9
#define AURA_SYNC_OFF_EPOCH    2
#define AURA_SYNC_OFF_HOP_CH   6
#define AURA_SYNC_OFF_HOP_CD   7
#define AURA_SYNC_OFF_WAVE     8

/* AURA_SYNC_INTERVAL_MS is defined with the other liveness timings above -
 * it is part of that set, not an independent choice. NOT VALIDATED ON
 * HARDWARE for clock accuracy; see PROTOCOL.md section 10. Every sync figure
 * in this project is design intent until the device-to-device spread has
 * actually been measured. */

/* A channel hop is announced this many SYNC frames ahead, counting down. */
#define AURA_HOP_ANNOUNCE      10

struct aura_sync {
	uint32_t epoch_ms;
	uint8_t  hop_channel;
	uint8_t  hop_countdown;
	uint8_t  wave_step;
};

static inline uint8_t aura_sync_write(uint8_t *p, const struct aura_sync *s)
{
	p[0] = AURA_MSG_SYNC;
	p[1] = AURA_VER;
	p[AURA_SYNC_OFF_EPOCH + 0] = (uint8_t)(s->epoch_ms & 0xFF);
	p[AURA_SYNC_OFF_EPOCH + 1] = (uint8_t)((s->epoch_ms >> 8) & 0xFF);
	p[AURA_SYNC_OFF_EPOCH + 2] = (uint8_t)((s->epoch_ms >> 16) & 0xFF);
	p[AURA_SYNC_OFF_EPOCH + 3] = (uint8_t)((s->epoch_ms >> 24) & 0xFF);
	p[AURA_SYNC_OFF_HOP_CH]    = s->hop_channel;
	p[AURA_SYNC_OFF_HOP_CD]    = s->hop_countdown;
	p[AURA_SYNC_OFF_WAVE]      = s->wave_step;
	return AURA_SYNC_LEN;
}

static inline bool aura_sync_parse(const uint8_t *p, uint8_t len,
				   struct aura_sync *out)
{
	if (len < AURA_SYNC_LEN) {
		return false;
	}
	if (p[0] != AURA_MSG_SYNC || p[1] != AURA_VER) {
		return false;
	}
	out->epoch_ms = (uint32_t)p[AURA_SYNC_OFF_EPOCH + 0] |
			((uint32_t)p[AURA_SYNC_OFF_EPOCH + 1] << 8) |
			((uint32_t)p[AURA_SYNC_OFF_EPOCH + 2] << 16) |
			((uint32_t)p[AURA_SYNC_OFF_EPOCH + 3] << 24);
	out->hop_channel   = p[AURA_SYNC_OFF_HOP_CH];
	out->hop_countdown = p[AURA_SYNC_OFF_HOP_CD];
	out->wave_step     = p[AURA_SYNC_OFF_WAVE];
	return true;
}

/* Group index = position of the lowest set bit in the device's mask, so a
 * device in several groups takes the phase of its lowest. 0 if ungrouped. */
static inline uint8_t aura_group_index(uint8_t my_mask)
{
	for (uint8_t i = 0; i < 8; i++) {
		if (my_mask & (1u << i)) {
			return i;
		}
	}
	return 0;
}

/* Phase offset this device should add. wave_step 0 gives unison. */
static inline uint32_t aura_phase_offset_ms(uint8_t my_mask, uint8_t wave_step)
{
	return (uint32_t)aura_group_index(my_mask) * (uint32_t)wave_step * 10u;
}

/* ========================================================================
 * UPLINK
 * ======================================================================== */

/* BEACON (AURA_MSG_BEACON) - 6 byte payload
 *   [0] msgid 0x03   [1] ver
 *   [2] caps         AURA_CAP_* bitmap - lets the gateway learn the fleet
 *   [3] battery_pct  0..100, 0xFF unknown
 *   [4] flags        AURA_FLAG_*
 *   [5] last_cmd_seq the seq of the last CMD this device acted on
 *
 * last_cmd_seq is the ONLY delivery statistic available on an
 * unacknowledged broadcast protocol. One byte, no extra traffic, and it
 * turns "the show looked wrong" into "40% loss in the north stand". */
#define AURA_BEACON_LEN        6
#define AURA_BEACON_OFF_CAPS   2
#define AURA_BEACON_OFF_BATT   3
#define AURA_BEACON_OFF_FLAGS  4
#define AURA_BEACON_OFF_LASTSEQ 5

#define AURA_BATTERY_UNKNOWN   0xFF

/* CONTACT (AURA_MSG_CONTACT) - 6 byte payload
 *   [0] msgid 0x06   [1] ver
 *   [2..3] peer_id LE16
 *   [4] rssi_enc     dBm + 128, as seen by the reporting device
 *   [5] event        AURA_CONTACT_OPEN / _CLOSE
 *
 * Emitted on a CONTACT TRANSITION, not continuously. A lanyard in a busy
 * room can see dozens of peers; sampling one per beacon would be a slow,
 * biased trickle. What a venue actually wants is "A met B, for how long",
 * so report once when a peer crosses the threshold and stays, and again
 * when it drops. Uplink stays tiny and the gateway rebuilds the graph. */
#define AURA_CONTACT_LEN       6
#define AURA_CONTACT_OFF_PEER  2
#define AURA_CONTACT_OFF_RSSI  4
#define AURA_CONTACT_OFF_EVENT 5

#define AURA_CONTACT_OPEN      0x00
#define AURA_CONTACT_CLOSE     0x01

/* Hysteresis so a peer hovering at the threshold does not flap. */
#define AURA_CONTACT_HYST_DB   6
#define AURA_CONTACT_HOLD_MS   2000

/* EVENT (AURA_MSG_EVENT) - 5 byte payload
 *   [0] msgid 0x02   [1] ver
 *   [2] event_type   AURA_EVENT_*
 *   [3] value        gesture class / button action
 *   [4] strength     probability pct or hold time, 0 if n/a */
#define AURA_EVENT_LEN         5
#define AURA_EVENT_OFF_TYPE    2
#define AURA_EVENT_OFF_VALUE   3
#define AURA_EVENT_OFF_STRENGTH 4

#define AURA_EVENT_GESTURE     0x01
#define AURA_EVENT_BUTTON      0x02
#define AURA_EVENT_NFC         0x03 /* tag was read; value = reader context */
/* Motion from the accelerometer, reported on TRANSITIONS only (same reasoning
 * as CONTACT): value 1 = started moving, 0 = came to rest. strength = peak
 * movement over the episode, 0-100. Added 2026-11-10; receivers that predate
 * it print the type as unknown and carry on. */
#define AURA_EVENT_MOTION      0x04

/* NODE_RELAY (AURA_MSG_NODE_RELAY) - node -> gateway
 *   [0] msgid 0x05   [1] ver
 *   [2..3] band_addr LE16   the original source
 *   [4] rssi_enc            as seen at the node
 *   [5..] the original uplink payload, verbatim */
#define AURA_NODE_RELAY_HDR_LEN 5
#define AURA_NODE_RELAY_OFF_ADDR 2
#define AURA_NODE_RELAY_OFF_RSSI 4

/* Beacon flags */
#define AURA_FLAG_CHARGING     (1u << 0)
#define AURA_FLAG_LOW_BATTERY  (1u << 1)
#define AURA_FLAG_HAND_RAISED  (1u << 2)
#define AURA_FLAG_CLAP         (1u << 3) /* latched since the last beacon */
#define AURA_FLAG_BUTTON_HELD  (1u << 4)
#define AURA_FLAG_MOVING       (1u << 5) /* level, not latched: moving now */
/* bits 6..7 reserved */

static inline uint8_t aura_rssi_encode(int rssi_dbm)
{
	return (uint8_t)(rssi_dbm + 128);
}

static inline int aura_rssi_decode(uint8_t enc)
{
	return (int)enc - 128;
}

/* ========================================================================
 * Capability bitmap (carried in BEACON)
 *
 * A device acts on a CMD field only if it has the matching capability.
 * This is how one broadcast serves a fleet of mixed form factors, and it
 * is why the gateway needs caps in the beacon: without it there is no way
 * to tell "lanyard correctly ignoring the LED fields" from "device dead".
 * ======================================================================== */

#define AURA_CAP_RGB_LED       (1u << 0) /* addressable/RGB LED(s) */
#define AURA_CAP_HP_LED        (1u << 1) /* high-power LED driver */
#define AURA_CAP_IMU           (1u << 2) /* 6-axis IMU (accel+gyro) */
#define AURA_CAP_ACCEL         (1u << 3) /* accelerometer only */
#define AURA_CAP_MIC           (1u << 4) /* microphone */
#define AURA_CAP_BUTTON        (1u << 5) /* user button */
#define AURA_CAP_NFC           (1u << 6) /* NFC antenna */
#define AURA_CAP_MULTI_LED     (1u << 7) /* >1 independent light source */

/* Per-board capability sets */
#define AURA_CAPS_XIAO_BAND    (AURA_CAP_RGB_LED | AURA_CAP_HP_LED | \
				AURA_CAP_IMU | AURA_CAP_MIC | AURA_CAP_MULTI_LED)
#define AURA_CAPS_PIXEL_XIAO   (AURA_CAP_RGB_LED)
#define AURA_CAPS_HOLYIOT      (AURA_CAP_RGB_LED | AURA_CAP_ACCEL)
#define AURA_CAPS_K7           (AURA_CAP_RGB_LED | AURA_CAP_ACCEL | \
				AURA_CAP_BUTTON | AURA_CAP_NFC)
#define AURA_CAPS_LANYARD      (AURA_CAP_NFC) /* no LED: takes CMDs, animates nothing */

/* ========================================================================
 * Roll-call slotting
 *
 * "Everybody beacon now" sent to 10k devices produces 10k simultaneous
 * transmissions and you hear almost nothing - CSMA collapses well before
 * that. Instead each device derives a slot from its own address, so the
 * responses spread deterministically with no coordination and no state.
 *
 * SCALE LIMIT, stated honestly: a 25.5 s window gives 5100 slots. That is
 * a clean census for hundreds of devices and a lossy sample for tens of
 * thousands. At Vegas scale you roll-call BY GROUP in batches, never the
 * whole fleet at once.
 * ======================================================================== */

#define AURA_SLOT_MS           5

static inline uint32_t aura_rollcall_delay_ms(uint16_t src_addr,
					      uint8_t op_param)
{
	uint32_t window_ms = (uint32_t)op_param * 100u;
	uint32_t n_slots;

	if (window_ms < AURA_SLOT_MS) {
		return 0;
	}
	n_slots = window_ms / AURA_SLOT_MS;
	return (uint32_t)(src_addr % n_slots) * AURA_SLOT_MS;
}

/* ========================================================================
 * Frame building / parsing
 * ======================================================================== */

/* Writes a 9-byte MAC header. Returns a pointer to the payload area. */
static inline uint8_t *aura_mhr_write(uint8_t *frame, uint8_t mac_seq,
				      uint16_t dst_addr, uint16_t src_addr)
{
	uint16_t fcf = AURA_FCF_DATA_NOACK;

	frame[0] = (uint8_t)(fcf & 0xFF);
	frame[1] = (uint8_t)(fcf >> 8);
	frame[2] = mac_seq;
	frame[3] = (uint8_t)(AURA_PAN_ID & 0xFF);
	frame[4] = (uint8_t)(AURA_PAN_ID >> 8);
	frame[5] = (uint8_t)(dst_addr & 0xFF);
	frame[6] = (uint8_t)(dst_addr >> 8);
	frame[7] = (uint8_t)(src_addr & 0xFF);
	frame[8] = (uint8_t)(src_addr >> 8);
	return frame + AURA_MHR_LEN;
}

/* Returns false if the frame is too short or not our PAN. */
static inline bool aura_mhr_parse(const uint8_t *psdu, uint8_t len,
				  uint16_t *src, uint16_t *dst)
{
	if (len < AURA_MHR_LEN) {
		return false;
	}
	uint16_t pan = (uint16_t)(psdu[3] | (psdu[4] << 8));

	if (pan != AURA_PAN_ID && pan != 0xFFFF) {
		return false;
	}
	if (dst) {
		*dst = (uint16_t)(psdu[5] | (psdu[6] << 8));
	}
	if (src) {
		*src = (uint16_t)(psdu[7] | (psdu[8] << 8));
	}
	return true;
}

/* Write a CMD payload. Returns bytes written. */
static inline uint8_t aura_cmd_write(uint8_t *p, const struct aura_cmd *c)
{
	p[AURA_CMD_OFF_MSGID]      = AURA_MSG_CMD;
	p[AURA_CMD_OFF_VER]        = AURA_VER;
	p[AURA_CMD_OFF_SEQ]        = c->seq;
	p[AURA_CMD_OFF_GROUP]      = c->group;
	p[AURA_CMD_OFF_ANIM_MODE]  = c->anim_mode;
	p[AURA_CMD_OFF_ANIM_PARAM] = c->anim_param;
	p[AURA_CMD_OFF_OP_MODE]    = c->op_mode;
	p[AURA_CMD_OFF_OP_PARAM]   = c->op_param;
	p[AURA_CMD_OFF_R]          = c->r;
	p[AURA_CMD_OFF_G]          = c->g;
	p[AURA_CMD_OFF_B]          = c->b;
	p[AURA_CMD_OFF_BRIGHT]     = c->bright;
	p[AURA_CMD_OFF_DEV_FLAGS]  = c->dev_flags;
	return AURA_CMD_LEN;
}

/* Parse a CMD payload. Returns false if it is not a v2 CMD. */
static inline bool aura_cmd_parse(const uint8_t *p, uint8_t len,
				  struct aura_cmd *out)
{
	if (len < AURA_CMD_LEN) {
		return false;
	}
	if (p[AURA_CMD_OFF_MSGID] != AURA_MSG_CMD ||
	    p[AURA_CMD_OFF_VER] != AURA_VER) {
		return false;
	}
	out->seq        = p[AURA_CMD_OFF_SEQ];
	out->group      = p[AURA_CMD_OFF_GROUP];
	out->anim_mode  = p[AURA_CMD_OFF_ANIM_MODE];
	out->anim_param = p[AURA_CMD_OFF_ANIM_PARAM];
	out->op_mode    = p[AURA_CMD_OFF_OP_MODE];
	out->op_param   = p[AURA_CMD_OFF_OP_PARAM];
	out->r          = p[AURA_CMD_OFF_R];
	out->g          = p[AURA_CMD_OFF_G];
	out->b          = p[AURA_CMD_OFF_B];
	out->bright     = p[AURA_CMD_OFF_BRIGHT];
	out->dev_flags  = p[AURA_CMD_OFF_DEV_FLAGS];
	return true;
}

static inline uint8_t aura_beacon_write(uint8_t *p, uint8_t caps,
					uint8_t battery_pct, uint8_t flags,
					uint8_t last_cmd_seq)
{
	p[0] = AURA_MSG_BEACON;
	p[1] = AURA_VER;
	p[AURA_BEACON_OFF_CAPS]    = caps;
	p[AURA_BEACON_OFF_BATT]    = battery_pct;
	p[AURA_BEACON_OFF_FLAGS]   = flags;
	p[AURA_BEACON_OFF_LASTSEQ] = last_cmd_seq;
	return AURA_BEACON_LEN;
}

static inline uint8_t aura_contact_write(uint8_t *p, uint16_t peer_id,
					 int rssi_dbm, uint8_t event)
{
	p[0] = AURA_MSG_CONTACT;
	p[1] = AURA_VER;
	p[AURA_CONTACT_OFF_PEER]     = (uint8_t)(peer_id & 0xFF);
	p[AURA_CONTACT_OFF_PEER + 1] = (uint8_t)(peer_id >> 8);
	p[AURA_CONTACT_OFF_RSSI]     = aura_rssi_encode(rssi_dbm);
	p[AURA_CONTACT_OFF_EVENT]    = event;
	return AURA_CONTACT_LEN;
}

static inline uint8_t aura_event_write(uint8_t *p, uint8_t type,
				       uint8_t value, uint8_t strength)
{
	p[0] = AURA_MSG_EVENT;
	p[1] = AURA_VER;
	p[AURA_EVENT_OFF_TYPE]     = type;
	p[AURA_EVENT_OFF_VALUE]    = value;
	p[AURA_EVENT_OFF_STRENGTH] = strength;
	return AURA_EVENT_LEN;
}

/* ========================================================================
 * Legacy v0 - migration only. Remove once no v0 device is in the field.
 *
 * The gateway must dual-accept v0 and v2 for the whole transition or field
 * bands go dark mid-migration. Migration order:
 *   gateway -> seeed band -> pixel-xiao -> holyiot -> K7 -> nodes
 * ======================================================================== */

#define AURA_V0_FCF               0x2241  /* malformed; promiscuous only */
#define AURA_V0_PAN_ID            0x1234
#define AURA_V0_PAYLOAD_UUID_BC   0x03    /* [3, id_lo, id_hi, flags] */
#define AURA_V0_PAYLOAD_LED       0x04    /* [4, mode, rate, R, G, B] */
#define AURA_V0_PAYLOAD_NODE_RELAY 0x05
#define AURA_V0_LED_OFFSET        15      /* the fixed-offset parse v2 kills */

#ifndef AURA_ACCEPT_V0_AT_GATEWAY
#define AURA_ACCEPT_V0_AT_GATEWAY 1
#endif

#ifdef __cplusplus
}
#endif

#endif /* AURA_RADIO_H */
