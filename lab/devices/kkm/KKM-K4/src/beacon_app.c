/*
 * K4 Beacon -- Aetherfield v2 band, now with light.
 *
 * Joins the fleet through the shared band layer (AURA/common/aura_band.c),
 * the same code the wristband and pixel module run, and paints the commanded
 * colour onto the K4's two red LEDs.
 *
 * v2 treats every device as ONE light source however many LEDs it carries, so
 * the render callback collapses the commanded RGB to a single luminance and
 * drives both LEDs together. The wristband spreads that triple across four
 * LP5012 channels, the pixel module writes one WS2812, and the K4 does this.
 * Same command, same animation maths, different final centimetre.
 *
 * Gateway:  aura color 255 0 0     -> both LEDs full
 *           aura color 0 0 255     -> dim (blue weighs ~7% of luminance)
 *           aura anim 1 0 255 0 0  -> animated
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/logging/log.h>

#include "aura_band.h"

LOG_MODULE_DECLARE(k4_hello, LOG_LEVEL_INF);

static const struct pwm_dt_spec led_d1 = PWM_DT_SPEC_GET(DT_NODELABEL(led_d1));
static const struct pwm_dt_spec led_d2 = PWM_DT_SPEC_GET(DT_NODELABEL(led_d2));

/*
 * Both LEDs are red at 1 k, so about 1.1 mA each off a 3 V cell. They are
 * indicators, not illuminators -- do not expect a colour cue to read across a
 * room, and do not raise CONFIG on the assumption that more duty means more
 * light. The resistor sets the ceiling, not us.
 */

/* Rec. 709 luma, integer. Mono hardware has to collapse colour somehow, and
 * perceived brightness is the collapse that keeps a fade looking like a fade. */
static inline uint8_t luma(uint8_t r, uint8_t g, uint8_t b)
{
	return (uint8_t)(((54u * r) + (183u * g) + (19u * b)) >> 8);
}

/*
 * Called from the band's animation thread at ~50 Hz. Must not block.
 *
 * Squaring the level approximates gamma: a linear duty ramp looks like it
 * slams on and then crawls, which makes every fade in the show look wrong on
 * this board while looking right on the others.
 */
static void render(uint8_t r, uint8_t g, uint8_t b)
{
	uint32_t level = luma(r, g, b);
	uint32_t pulse = (uint32_t)(((uint64_t)led_d1.period * level * level) /
				    (255u * 255u));

	pwm_set_pulse_dt(&led_d1, pulse);
	pwm_set_pulse_dt(&led_d2, pulse);
}

/*
 * Capabilities.
 *
 * MULTI_LED only, deliberately. The schematic shows a KEY button (P0.04) and a
 * LIS2DW12 (I2C 0x19, INT1/INT2 on P1.13/P1.14) are FITTED, but this firmware
 * does not yet drive either, and caps is how the gateway tells "correctly
 * ignoring a field" from "dead". It should describe what this build honours,
 * not what the PCB carries. Add AURA_CAP_BUTTON and AURA_CAP_ACCEL as each is
 * actually wired up.
 *
 * Note the gap this board exposes in the protocol: the two LEDs are single
 * colour, which is neither AURA_CAP_RGB_LED nor nothing, and the caps bitmap
 * has all 8 bits allocated with no room for a "mono LED" bit. MULTI_LED
 * without RGB_LED is the closest honest encoding today -- "I have lights, I
 * have no colour".
 */
#define K4_CAPS       AURA_CAP_MULTI_LED

/* Wristband is 0x01 and the pixel module 0x02, so the K4 can be addressed on
 * its own (`aura group 04`) or with them (`aura group 07`). */
#define K4_GROUP_MASK 0x04

int k4_beacon_app(void)
{
	int err;

	static const struct aura_band_cfg cfg = {
		.caps        = K4_CAPS,
		.group_mask  = K4_GROUP_MASK,
		.render      = render,
		.battery_pct = NULL,  /* see note below */

		/* XIAO-only antenna switch; the K4 has no rfsw_ctl node, so the
		 * band layer compiles this out entirely. Stated rather than
		 * omitted so nobody reads the omission as an oversight. */
		.antenna_external = false,

		/* The LEDs are known now, so a boot trace could be blinked --
		 * but the board finally has a real console on UART30, which
		 * says more. Left NULL. */
		.progress = NULL,
	};

	LOG_INF("K4 -- Aetherfield v2 band, 2x red LED");

	if (!pwm_is_ready_dt(&led_d1) || !pwm_is_ready_dt(&led_d2)) {
		LOG_ERR("PWM not ready -- check CONFIG_PWM and pwm20 status");
		return -ENODEV;
	}

	/* Boot signature: two flashes on both LEDs. */
	for (int i = 0; i < 2; i++) {
		render(255, 255, 255);
		k_msleep(80);
		render(0, 0, 0);
		k_msleep(160);
	}

	err = aura_band_init(&cfg);
	if (err) {
		LOG_ERR("aura_band_init failed: %d", err);
		return err;
	}

	LOG_INF("band up, addr=%04X group=%02X caps=%02X",
		aura_band_addr(), K4_GROUP_MASK, K4_CAPS);

	/*
	 * battery_pct is still NULL. The schematic has no divider -- KKM's
	 * reference measures the rail directly with SAADC on NRF_SAADC_VDD
	 * (gain 1/4, internal ref), which needs no pin at all. That is the way
	 * to finally replace batt=0xFF on this board, and it would be the
	 * first band in the fleet to report a real percentage.
	 */

	/* The band layer owns its threads from here. */
	return 0;
}
