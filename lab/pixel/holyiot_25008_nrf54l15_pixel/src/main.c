/*
 * Pixel — modified HOLYIOT-25008.
 *
 * Same shared band layer as every other Aetherfield device: radio, CMD/SYNC,
 * dedupe, groups, op_mode, beacons and the animation engine all live in
 * ../../common/aura_band.c. This file is only the last centimetre — turning
 * one RGB triple into light on a board whose product LED is a single colour.
 *
 * ---------------------------------------------------------------------------
 * Two lights, two jobs
 * ---------------------------------------------------------------------------
 *
 *   HB BLUE   P1.13, pwm20 ch1   the product light — the modification
 *   RGB       P2.09 / P1.10 / P2.07   the module's onboard indicator
 *
 * The HB blue is what the real device does, and it is blue-only, so it is
 * driven from the BLUE channel alone. Send red and it goes dark. That is
 * correct, not a bug — but it is also indistinguishable from a dead device,
 * which is exactly the trap this board sets on a bench.
 *
 * So the onboard RGB mirrors the FULL commanded colour alongside it. That way
 * a red command visibly does something: the indicator turns red while the
 * product light stays off, and you can see at a glance that the command
 * arrived and the blue-only mapping is what darkened the HB LED. Without the
 * mirror you would be debugging the radio.
 *
 * The onboard RGB is a compromised display and that is fine for an indicator:
 * red and blue are MCU-domain (P2) pins which the nRF54L15's LP-domain PWM
 * cannot reach, so they are on/off only; green is P1 and gets real PWM.
 *
 * ---------------------------------------------------------------------------
 * Current
 * ---------------------------------------------------------------------------
 *
 * The HB LED has NO series resistor. Its current is limited only by C19's ESR
 * and the cell's internal resistance, so peak duty is capped here in firmware.
 * On a coin cell the cell's own 10-40 ohm holds you to roughly 10 mA. From a
 * bench supply, set a 100 mA limit before raising HB_MAX_PER_MILLE.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/logging/log.h>
#include <stdbool.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(pixel, CONFIG_LOG_DEFAULT_LEVEL);

/* ------------------------------------------------------------ the light --- */

static const struct pwm_dt_spec hb = PWM_DT_SPEC_GET(DT_ALIAS(led_hb));

/*
 * Peak duty for the HB LED, per-mille. 250 = 25%: clearly visible without
 * leaning on the cell. Raise only with a current limit in place — read the
 * note at the top of this file first.
 */
#define HB_MAX_PER_MILLE 250

/* ------------------------------------------------------- onboard mirror --- */

static const struct gpio_dt_spec rgb_r = GPIO_DT_SPEC_GET(DT_ALIAS(led_red), gpios);
static const struct gpio_dt_spec rgb_b = GPIO_DT_SPEC_GET(DT_ALIAS(led_blue), gpios);
static const struct pwm_dt_spec  rgb_g = PWM_DT_SPEC_GET(DT_ALIAS(led_green));

/* On/off threshold for the two GPIO-only channels. Half-scale: a channel that
 * is more on than off reads as lit. */
#define RGB_ON_THRESHOLD 128

static bool g_have_hb;
static bool g_have_rgb;

/* ------------------------------------------------------------ boot sign --- */

/* Drive both lights unconditionally, bypassing the change filter. */
static void paint(uint8_t r, uint8_t g, uint8_t b)
{
	if (g_have_hb) {
		uint32_t per_mille = ((uint32_t)b * HB_MAX_PER_MILLE) / 255U;

		pwm_set_pulse_dt(&hb,
			(uint32_t)(((uint64_t)hb.period * per_mille) / 1000U));
	}
	if (g_have_rgb) {
		gpio_pin_set_dt(&rgb_r, r >= RGB_ON_THRESHOLD);
		gpio_pin_set_dt(&rgb_b, b >= RGB_ON_THRESHOLD);
		if (pwm_is_ready_dt(&rgb_g)) {
			pwm_set_pulse_dt(&rgb_g,
				(uint32_t)(((uint64_t)rgb_g.period * g) / 255U));
		}
	}
}

/*
 * Boot signature.
 *
 * Without this a healthy device and a bricked one look identical: the
 * commanded state starts dark on purpose, so nothing lights until a gateway
 * says so — and if no gateway is listening yet, that is indefinitely.
 *
 * The sweep runs red, green, then blue. Watch BOTH lights: on blue the
 * indicator and the HB LED should come up together, which is the one moment
 * you can confirm the modification works without a gateway in the room.
 */
static void boot_flash(void)
{
	paint(255, 0, 0); k_msleep(250);
	paint(0, 255, 0); k_msleep(250);
	paint(0, 0, 255); k_msleep(250);
	paint(0, 0, 0);
}

/*
 * One short blink per completed init step. Count them: the total is the last
 * step that succeeded, so a device that dies during bring-up still tells you
 * where — useful here, where the console needs a debugger attached.
 *
 * Blinks the indicator, not the HB LED: the product light has no series
 * resistor and there is no reason to pulse it for diagnostics.
 */
static void boot_progress(uint8_t step)
{
	LOG_INF("init step %u", step);
	if (g_have_rgb) {
		gpio_pin_set_dt(&rgb_b, 1);
		k_msleep(60);
		gpio_pin_set_dt(&rgb_b, 0);
	}
	k_msleep(90);
}

/* ---------------------------------------------------------------- render --- */

/*
 * Called from the animation thread at ~50 Hz with the fully resolved colour:
 * animation and master brightness are already applied. Paint only.
 */
static void pixel_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t last_r, last_g, last_b;
	static bool primed;

	/* A steady colour is the same triple 50 times a second. Skip the work
	 * on a device that has to last three days. */
	if (primed && r == last_r && g == last_g && b == last_b) {
		return;
	}
	last_r = r; last_g = g; last_b = b;
	primed = true;

	/*
	 * paint() drives the product light from BLUE alone — this LED cannot be
	 * any other colour, so representing r/g there would be a lie about what
	 * the device is showing — and mirrors the whole commanded colour on the
	 * onboard indicator, so a non-blue command is visibly a command rather
	 * than a dead board.
	 */
	paint(r, g, b);
}

/* ------------------------------------------------------------------ main --- */

int main(void)
{
	LOG_INF("Pixel / HOLYIOT-25008 (modified)");

	g_have_hb = pwm_is_ready_dt(&hb);
	if (!g_have_hb) {
		LOG_ERR("HB blue (P1.13, pwm20 ch1) not ready — no product light");
	}

	g_have_rgb = gpio_is_ready_dt(&rgb_r) && gpio_is_ready_dt(&rgb_b);
	if (g_have_rgb) {
		gpio_pin_configure_dt(&rgb_r, GPIO_OUTPUT_INACTIVE);
		gpio_pin_configure_dt(&rgb_b, GPIO_OUTPUT_INACTIVE);
		/*
		 * Park green explicitly. pwm20 claims P1.10 the moment the
		 * driver initialises and leaves the pin LOW, which on a
		 * common-anode LED means lit. Without this the board comes up
		 * green and stays green.
		 */
		if (pwm_is_ready_dt(&rgb_g)) {
			pwm_set_pulse_dt(&rgb_g, 0);
		}
	} else {
		LOG_WRN("onboard RGB not ready — indicator mirror disabled");
	}

	if (g_have_hb) {
		pwm_set_pulse_dt(&hb, 0);
	}

	boot_flash();

	struct aura_band_cfg cfg = {
		/*
		 * Takes full RGB commands even though it shows one colour —
		 * the capability bitmap says what it HAS, and the render
		 * callback decides what it can do with it. HP_LED because the
		 * modification is a high-power part on a FET, not an indicator.
		 */
		.caps = AURA_CAP_RGB_LED | AURA_CAP_HP_LED,

		/*
		 * Group 0x04. Bitmask, so:
		 *   aura group 04 -> this board
		 *   aura group 02 -> the XIAO Pixel
		 *   aura group 06 -> both
		 *   aura group 00 -> everyone
		 */
		.group_mask = 0x04,

		.render = pixel_render,
		.battery_pct = NULL,        /* no divider fitted on this module */
		.antenna_external = false,  /* module has no antenna switch */

		/* Blink out each init step. See boot_progress(). */
		.progress = boot_progress,
	};

	if (aura_band_init(&cfg) != 0) {
		LOG_ERR("aura_band_init failed");
		return -1;
	}

	LOG_INF("proto=%u addr=%04X caps=%02X group=%02X hb=%s rgb=%s",
		AURA_VER, aura_band_addr(), cfg.caps, cfg.group_mask,
		g_have_hb ? "yes" : "NO", g_have_rgb ? "yes" : "NO");

	/* aura_band owns the radio and animation threads from here. */
	return 0;
}
