/*
 * K4 Beacon (nRF54L15) -- application dispatch.
 *
 * Four applications, one per build configuration (Kconfig choice K4_APP):
 *
 *   default        Aetherfield v2 band. Joins the fleet and paints the
 *                  commanded colour onto both LEDs.
 *   breathe.conf   Hello world: pulse one LED. Radio off.
 *   probe.conf     Radio-narrated walk of all 32 GPIOs (found the LEDs).
 *   sweep.conf     Offline stopwatch version of the same.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(k4_hello, LOG_LEVEL_INF);

#if defined(CONFIG_K4_APP_BEACON)

int k4_beacon_app(void);

int main(void)
{
	return k4_beacon_app();
}

#elif defined(CONFIG_K4_APP_PINPROBE)

int k4_pin_probe_app(void);

int main(void)
{
	return k4_pin_probe_app();
}

#elif defined(CONFIG_K4_APP_SWEEP)

#include "pin_sweep.h"

int main(void)
{
	k4_pin_sweep();
	return 0;
}

#else /* CONFIG_K4_APP_BREATHE -- hello world */

#include <zephyr/drivers/pwm.h>

/*
 * Both LEDs, from the schematic: D1 red on P1.04 (PWM20 OUT0), D2 red on
 * P2.03 (PWM20 OUT1). Both ACTIVE HIGH through 1 k, so PWM_POLARITY_NORMAL
 * and about 1.1 mA at full duty off a 3 V cell.
 */
static const struct pwm_dt_spec d1 = PWM_DT_SPEC_GET(DT_NODELABEL(led_d1));
static const struct pwm_dt_spec d2 = PWM_DT_SPEC_GET(DT_NODELABEL(led_d2));

/*
 * WHICH ONE IS THE TOP LED?
 *
 * D1 is the working assumption, by elimination: D2/P2.03 is the one that lit
 * during the pin probe while the BOTTOM face was being watched. That is an
 * inference from where someone was looking, not a fact from the schematic --
 * the schematic names the nets, not the faces.
 *
 * So this app does not just assume it. The boot sequence below identifies each
 * LED unambiguously before the breathe starts, and if the count says otherwise
 * the fix is one fragment: breathe-d2.conf.
 */
#ifdef CONFIG_K4_BREATHE_D2
#define BREATHE_LED d2
#define OTHER_LED   d1
#else
#define BREATHE_LED d1
#define OTHER_LED   d2
#endif

#define BREATHE_STEPS   256
#define BREATHE_STEP_MS 6            /* -> ~3.1 s per full breath */

#define ID_FLASH_MS     140
#define ID_GAP_MS       200

/*
 * Brightness ladder, held steady after the identification flashes:
 * 25 %, 50 %, 100 % for a second and a half each.
 *
 * The breathe only touches full duty for about 6 ms at the top of each
 * ~3.1 s cycle, which is far too brief to judge. If you want to know how
 * bright this LED actually gets, the third rung is the answer -- that is
 * 100 % duty, held.
 */
#define LADDER_HOLD_MS  1500

static void set(const struct pwm_dt_spec *led, uint32_t level255)
{
	/*
	 * Squaring approximates gamma: a linear duty ramp looks like it slams
	 * on and then crawls. At the bottom of the ramp this rounds below one
	 * PWM tick, which is what gives a clean full-off.
	 */
	uint32_t pulse = (uint32_t)(((uint64_t)led->period * level255 * level255) /
				    (255u * 255u));

	pwm_set_pulse_dt(led, pulse);
}

/* Flash one LED n times, leaving it off. */
static void identify(const struct pwm_dt_spec *led, int n)
{
	for (int i = 0; i < n; i++) {
		set(led, 255);
		k_msleep(ID_FLASH_MS);
		set(led, 0);
		k_msleep(ID_GAP_MS);
	}
}

int main(void)
{
	uint32_t cycle = 0;

	LOG_INF("K4 hello world -- LED breathe");

	if (!pwm_is_ready_dt(&d1) || !pwm_is_ready_dt(&d2)) {
		LOG_ERR("PWM not ready -- check CONFIG_PWM=y and pwm20 status");
		return -ENODEV;
	}

	set(&d1, 0);
	set(&d2, 0);
	k_msleep(400);

	/*
	 * Identification, once, before anything else:
	 *
	 *   ONE  flash  = D1, P1.04
	 *   TWO  flashes = D2, P2.03
	 *
	 * Watch which face each appears on. Then the LED that breathes
	 * afterwards is D1 unless CONFIG_K4_BREATHE_D2=y. This board has no
	 * console wired by default, so the LEDs have to say it themselves.
	 */
	identify(&d1, 1);
	k_msleep(700);
	identify(&d2, 2);
	k_msleep(1200);

	/* Brightness ladder on the LED that is about to breathe. */
	{
		static const uint32_t rungs[] = { 64, 128, 255 };

		for (int i = 0; i < (int)ARRAY_SIZE(rungs); i++) {
			set(&BREATHE_LED, rungs[i]);
			k_msleep(LADDER_HOLD_MS);
		}
		set(&BREATHE_LED, 0);
		k_msleep(600);
	}

	LOG_INF("breathing %s (the other LED stays dark)",
		IS_ENABLED(CONFIG_K4_BREATHE_D2) ? "D2 / P2.03" : "D1 / P1.04");

	/* The non-breathing LED is explicitly parked off, so "which one is
	 * pulsing" is never ambiguous. */
	set(&OTHER_LED, 0);

	while (1) {
		for (uint32_t step = 0; step < 2U * BREATHE_STEPS; step++) {
			uint32_t level = (step <= BREATHE_STEPS)
					       ? step
					       : (2U * BREATHE_STEPS - step);

			/* step runs 0..2*STEPS with STEPS=256, so level is
			 * 0..256; clamp the single overshoot to 255. */
			set(&BREATHE_LED, level > 255u ? 255u : level);
			k_msleep(BREATHE_STEP_MS);
		}
		LOG_INF("breath %u", ++cycle);
	}

	return 0;
}

#endif /* K4_APP */
