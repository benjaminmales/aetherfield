/*
 * Pixel — KKM K4 Beacon (nRF54L15).
 *
 * Same shared band layer as every other Aetherfield device: radio, CMD/SYNC,
 * dedupe, groups, op_mode, beacons and the animation engine live in
 * ../../common/aura_band.c. This file is only the last centimetre.
 *
 * ---------------------------------------------------------------------------
 * The light
 * ---------------------------------------------------------------------------
 *
 *   LED1  P1.04  pwm20 ch0   dimmable — and the one carrying the HB blue mod
 *   LED2  P2.03  GPIO        on/off only
 *
 * Both are ACTIVE HIGH: 1 kOhm from the pin to the anode, cathode at GND. That
 * is the opposite of the K7, and it is why a high-power LED on an N-channel
 * MOSFET drops straight in — the FET is active high too, so the modified board
 * and the stock boards run the SAME firmware. No variant, no build flag,
 * nothing to get wrong when flashing three units in a row.
 *
 * LED2 cannot be dimmed: P2 is the MCU domain and the nRF54L15's PWM
 * peripherals are LP-domain, so they physically cannot reach it.
 *
 * ---------------------------------------------------------------------------
 * Colour on a board that has none
 * ---------------------------------------------------------------------------
 *
 * Both LEDs are red (blue on the modified unit). The device still receives the
 * full RGB command — the capability bitmap says what it HAS, and this callback
 * decides what it can do with it — and renders max(r, g, b) as brightness.
 *
 * Luminance would be more "correct" and is wrong here: it would make a blue
 * command nearly invisible on a red device, so one "go blue" would light some
 * of the fleet and not the rest, and read as broken. max() means any saturated
 * colour lights every device in the room, which is what a mixed fleet has to
 * do in front of an audience.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>
#include <stdbool.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(pixel, CONFIG_LOG_DEFAULT_LEVEL);

static const struct pwm_dt_spec led1 = PWM_DT_SPEC_GET(DT_ALIAS(led_main));
static const struct gpio_dt_spec led2 = GPIO_DT_SPEC_GET(DT_ALIAS(led_aux), gpios);

static bool g_have_led1;
static bool g_have_led2;

/* LED2 is on/off; half scale is the sensible threshold. */
#define LED2_ON_THRESHOLD 128

/*
 * Never write exactly 100%.
 *
 * At 0% and 100% Zephyr's nRF PWM driver stops the peripheral, drives the pin
 * as a constant level and applies the SLEEP pinctrl state — declared
 * low-power-enable, i.e. pin disconnected. At 100% that turns the LED OFF while
 * every value below it works, which presents as a dead channel.
 *
 * At 0% the same disconnect is exactly what we want: these LEDs are ACTIVE
 * HIGH with no pull-up, so an undriven pin is genuinely dark.
 *
 * So zero must stay zero. Clamping it up to a 1% floor — which an earlier
 * version of this did — leaves the LED sitting at a low glow instead of off,
 * and on a 1.1 mA indicator that is clearly visible in a dim room.
 */
#define DUTY_MIN_PER_MILLE  10
#define DUTY_MAX_PER_MILLE  990

static void paint(uint8_t level)
{
	if (g_have_led1) {
		uint32_t pulse = 0;

		if (level > 0) {
			uint32_t pm = ((uint32_t)level * 1000U) / 255U;

			pm = CLAMP(pm, DUTY_MIN_PER_MILLE, DUTY_MAX_PER_MILLE);
			pulse = (uint32_t)(((uint64_t)led1.period * pm) / 1000U);
		}
		pwm_set_pulse_dt(&led1, pulse);
	}
	if (g_have_led2) {
		gpio_pin_set_dt(&led2, level >= LED2_ON_THRESHOLD);
	}
}

/*
 * Boot signature. Without it a healthy device and a bricked one look identical:
 * the commanded state starts dark on purpose, so nothing lights until a gateway
 * says so — and if no gateway is listening yet, that is indefinitely.
 */
static void boot_flash(void)
{
	for (int i = 0; i < 3; i++) {
		paint(255);
		k_msleep(150);
		paint(0);
		k_msleep(150);
	}
}

/*
 * One short blink per completed init step. Count them: the total is the last
 * step that succeeded, so a device that dies during bring-up still says where.
 *
 * Safe to paint from here: aura_band signals every step BEFORE it starts the
 * animation thread, so nothing else owns the LED yet.
 */
static void boot_progress(uint8_t step)
{
	LOG_INF("init step %u", step);
	paint(60);
	k_msleep(60);
	paint(0);
	k_msleep(90);
}

/* Called from the animation thread at ~50 Hz with the colour already resolved:
 * animation and master brightness applied. Paint only. */
static void pixel_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t last;
	static bool primed;

	uint8_t level = MAX(r, MAX(g, b));

	if (primed && level == last) {
		return;
	}
	last = level;
	primed = true;

	paint(level);
}

int main(void)
{
	LOG_INF("Pixel / KKM K4 Beacon");

	g_have_led1 = pwm_is_ready_dt(&led1);
	g_have_led2 = gpio_is_ready_dt(&led2);

	if (!g_have_led1) {
		LOG_ERR("LED1 (P1.04, pwm20 ch0) not ready");
	}
	if (g_have_led2) {
		gpio_pin_configure_dt(&led2, GPIO_OUTPUT_INACTIVE);
	} else {
		LOG_WRN("LED2 (P2.03) not ready");
	}

	paint(0);
	boot_flash();

	struct aura_band_cfg cfg = {
		.caps = AURA_CAPS_PIXEL_XIAO,   /* takes RGB, shows one colour */

		/*
		 * 0x01 | 0x08.
		 *
		 * Bit 0 is the fleet: shared with every other Pixel so a mixed
		 * fleet behaves as one product, and 'aura cmd 00 ...' still
		 * addresses absolutely everything.
		 *
		 * Bit 3 is this unit alone. A mask means a device can sit in
		 * several groups at once, so the production candidate answers
		 * to the fleet AND to a channel nothing else listens on:
		 *
		 *   aura cmd 00 ...   everything, including this board
		 *   aura cmd 01 ...   the fleet, including this board
		 *   aura cmd 08 ...   ONLY this board
		 *
		 * Which beats chasing its address: the address is FICR-derived
		 * and changes with the chip, the group does not.
		 */
		.group_mask = 0x01 | 0x08,

		.render = pixel_render,
		.battery_pct = NULL,
		.antenna_external = false,   /* no RF switch on this module */
		.progress = boot_progress,
	};

	if (aura_band_init(&cfg) != 0) {
		LOG_ERR("aura_band_init failed");
		return -1;
	}

	LOG_INF("proto=%u addr=%04X caps=%02X group=%02X",
		AURA_VER, aura_band_addr(), cfg.caps, cfg.group_mask);

	/* aura_band owns the radio and animation threads from here. */
	return 0;
}
