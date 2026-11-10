/*
 * Aura Tag — stock HOLYIOT-25008 (nRF54L15, CR2032, RGB LED, LIS2DH12).
 *
 * The Tag is the test vehicle for the Aura product line, so it does exactly
 * the three things every Aura device does, and nothing else:
 *
 *   1. RECEIVE behaviour commands   colour, animation, brightness, mode
 *   2. DETECT motion                 accelerometer, reported as transitions
 *   3. TRANSMIT identity + status    16-bit id, caps, battery, flags
 *
 * The button on the module is deliberately unused. Aura products have no
 * button; a Tag that answered presses would test a product nobody is making.
 *
 * Radio, CMD/SYNC, dedupe, groups, op_mode, beacons and animation all come
 * from the shared band layer (../common/aura_band.c). This file supplies
 * the render callback, the motion source and the battery reading.
 *
 * ---------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------------
 *
 * The LIS2DH12's own any-motion detector does the watching (INT1 on P2.00,
 * `anym-on-int1` in the board devicetree). The MCU sleeps until the
 * accelerometer interrupts; nothing polls. That matters on a coin cell.
 *
 *   still -> moving   on the first interrupt:  EVENT motion v=1, flag MOVING set
 *   moving -> still   STILL_AFTER_MS after the last interrupt: EVENT motion
 *                     v=0 s=<peak 0-100>, flag cleared
 *
 * Transitions, not a stream: a wearable in a dancing crowd would otherwise
 * report continuously and spend the uplink budget on "still moving". The
 * MOVING flag rides every beacon, so the server always knows the current
 * state even if a transition event was lost.
 *
 * ---------------------------------------------------------------------------
 * Battery
 * ---------------------------------------------------------------------------
 *
 * There is no regulator on this module: the chip's supply IS the cell. So the
 * SAADC reading its own VDD reads the CR2032 directly, no divider needed.
 * Sampled once a minute (it barely moves) and mapped to percent with a
 * coin-cell discharge curve, which is flat for most of its life and falls off
 * a cliff near the end, hence a table rather than a straight line.
 *
 * ---------------------------------------------------------------------------
 * The light
 * ---------------------------------------------------------------------------
 *
 *   RED   P2.09 GPIO on/off   (MCU-domain port: no PWM reaches it)
 *   GREEN P1.10 pwm20 ch0     dimmable
 *   BLUE  P2.07 GPIO on/off
 *
 * Eight clean colours and a dimmable green. A status light, not a show
 * light: Aura One is the show light.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/logging/log.h>
#include <stdbool.h>
#include <stdlib.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(aura_tag, CONFIG_LOG_DEFAULT_LEVEL);

/* ---------------------------------------------------------------- config --- */

/* Group 0x08 = Aura Tag. Bitmask: `aura group 08` -> Tags, 00 -> everyone. */
#define TAG_GROUP          0x08

/* Light + accelerometer. Same as the header's AURA_CAPS_HOLYIOT. */
#define TAG_CAPS           AURA_CAPS_HOLYIOT

#define RGB_ON_THRESHOLD   32

/* Any-motion tuning. Threshold is the acceleration CHANGE that counts as
 * movement: ~0.5 m/s² ignores a table being bumped by a passer-by and
 * catches a wrist being lifted. Raise it for "only real movement". */
#define MOTION_ODR_HZ      10
#define MOTION_THRESH_MS2  0.5
#define MOTION_DUR_SAMPLES 1
#define STILL_AFTER_MS     3000

#define BATT_PERIOD_S      60
#define BATT_LOW_PCT       15

/* Set to 1 to blink out each radio init step on blue (bring-up only). */
#define TAG_BRINGUP_TRACE  0

/* ------------------------------------------------------------- hardware --- */

static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_ALIAS(led_red), gpios);
static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_ALIAS(led_blue), gpios);
static const struct pwm_dt_spec  led_g = PWM_DT_SPEC_GET(DT_ALIAS(led_green));
static const struct device *const accel = DEVICE_DT_GET(DT_NODELABEL(lis2dh12));
static const struct adc_dt_spec vdd = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);

static bool g_have_g;

static void paint(uint8_t r, uint8_t g, uint8_t b)
{
	gpio_pin_set_dt(&led_r, r >= RGB_ON_THRESHOLD);
	gpio_pin_set_dt(&led_b, b >= RGB_ON_THRESHOLD);
	if (g_have_g) {
		pwm_set_pulse_dt(&led_g, (uint32_t)(((uint64_t)led_g.period * g) / 255U));
	}
}

/* ---------------------------------------------------------------- render --- */

/* Animation thread, ~50 Hz, colour already resolved. Skip unchanged frames:
 * a steady colour is the same triple fifty times a second on a coin cell. */
static void tag_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t lr, lg, lb;
	static bool primed;

	if (primed && r == lr && g == lg && b == lb) {
		return;
	}
	lr = r; lg = g; lb = b;
	primed = true;
	paint(r, g, b);
}

/* ---------------------------------------------------------------- motion --- */

static struct k_work_delayable still_work;
static bool    g_moving;
static uint8_t g_peak;     /* 0-100 over the current episode */

/* |a| deviation from 1 g, scaled so a firm shake (~1 g extra) reads 100. */
static uint8_t movement_strength(void)
{
	struct sensor_value v[3];

	if (sensor_sample_fetch(accel) || sensor_channel_get(accel, SENSOR_CHAN_ACCEL_XYZ, v)) {
		return 0;
	}
	double x = sensor_value_to_double(&v[0]);
	double y = sensor_value_to_double(&v[1]);
	double z = sensor_value_to_double(&v[2]);
	const double g = SENSOR_G / 1000000.0;
	/* (|a|² - g²) / 2g² ≈ Δ|a| / g, without a sqrt. */
	double dev = (x * x + y * y + z * z - g * g) / (2.0 * g * g);
	int pct = (int)((dev < 0 ? -dev : dev) * 100.0);

	return pct > 100 ? 100 : (uint8_t)pct;
}

static void still_fn(struct k_work *w)
{
	ARG_UNUSED(w);
	g_moving = false;
	aura_band_set_flag(AURA_FLAG_MOVING, false);
	aura_band_send_event(AURA_EVENT_MOTION, 0, g_peak);
	LOG_INF("still (peak %u)", g_peak);
}

/* Runs on the LIS2DH trigger thread, not in the ISR, so it may fetch and
 * transmit. Every interrupt pushes the "still" deadline back. */
static void motion_trigger(const struct device *dev, const struct sensor_trigger *trig)
{
	ARG_UNUSED(dev); ARG_UNUSED(trig);
	uint8_t s = movement_strength();

	if (!g_moving) {
		g_moving = true;
		g_peak = s;
		aura_band_set_flag(AURA_FLAG_MOVING, true);
		aura_band_send_event(AURA_EVENT_MOTION, 1, s);
		LOG_INF("moving");
	} else if (s > g_peak) {
		g_peak = s;
	}
	k_work_reschedule(&still_work, K_MSEC(STILL_AFTER_MS));
}

static int motion_init(void)
{
	if (!device_is_ready(accel)) {
		return -ENODEV;
	}
	struct sensor_value odr = { .val1 = MOTION_ODR_HZ };
	struct sensor_value dur = { .val1 = MOTION_DUR_SAMPLES };
	struct sensor_value th;

	/* CTRL_REG2.HPIS1: route high-pass-filtered data to the INT1 any-motion
	 * comparator, so gravity is removed and only CHANGE in acceleration
	 * counts. Without this the comparator sees a constant 1 g. */
	struct sensor_value hp = { .val1 = 0x01 };

	if (sensor_attr_set(accel, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_CONFIGURATION, &hp)) {
		LOG_WRN("could not enable motion high-pass filter — expect false 'moving'");
	}
	sensor_value_from_double(&th, MOTION_THRESH_MS2);
	/* Best effort: a driver that rejects one of these still delivers
	 * motion at its defaults, which beats no motion at all. */
	(void)sensor_attr_set(accel, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_SAMPLING_FREQUENCY, &odr);
	(void)sensor_attr_set(accel, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_SLOPE_TH, &th);
	(void)sensor_attr_set(accel, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_SLOPE_DUR, &dur);

	k_work_init_delayable(&still_work, still_fn);

	static const struct sensor_trigger trig = {
		.type = SENSOR_TRIG_DELTA,
		.chan = SENSOR_CHAN_ACCEL_XYZ,
	};
	return sensor_trigger_set(accel, &trig, motion_trigger);
}

/* --------------------------------------------------------------- battery --- */

static volatile uint8_t g_batt = AURA_BATTERY_UNKNOWN;
static struct k_work_delayable batt_work;

/* CR2032 at light load, mV -> %. Flat for most of its life, steep at the end. */
static uint8_t cr2032_pct(int mv)
{
	static const struct { int mv; uint8_t pct; } t[] = {
		{ 3000, 100 }, { 2900, 85 }, { 2800, 65 }, { 2700, 45 },
		{ 2600, 28 },  { 2500, 15 }, { 2400, 7 },  { 2200, 0 },
	};

	if (mv >= t[0].mv) {
		return 100;
	}
	for (size_t i = 1; i < ARRAY_SIZE(t); i++) {
		if (mv >= t[i].mv) {
			return t[i].pct + (uint8_t)((mv - t[i].mv) * (t[i - 1].pct - t[i].pct) /
						    (t[i - 1].mv - t[i].mv));
		}
	}
	return 0;
}

static void batt_fn(struct k_work *w)
{
	ARG_UNUSED(w);
	int16_t raw;
	struct adc_sequence seq = { .buffer = &raw, .buffer_size = sizeof(raw) };

	if (adc_sequence_init_dt(&vdd, &seq) == 0 && adc_read_dt(&vdd, &seq) == 0) {
		int32_t mv = raw;

		if (adc_raw_to_millivolts_dt(&vdd, &mv) == 0) {
			g_batt = cr2032_pct(mv);
			aura_band_set_flag(AURA_FLAG_LOW_BATTERY, g_batt <= BATT_LOW_PCT);
			LOG_INF("VDD %d mV -> %u%%", mv, g_batt);
		}
	}
	k_work_reschedule(&batt_work, K_SECONDS(BATT_PERIOD_S));
}

static uint8_t tag_battery(void) { return g_batt; }

static int battery_init(void)
{
	if (!adc_is_ready_dt(&vdd) || adc_channel_setup_dt(&vdd)) {
		return -ENODEV;
	}
	k_work_init_delayable(&batt_work, batt_fn);
	k_work_schedule(&batt_work, K_NO_WAIT);
	return 0;
}

/* ------------------------------------------------------------ boot sign --- */

#if TAG_BRINGUP_TRACE
static void boot_progress(uint8_t step)
{
	LOG_INF("init step %u", step);
	gpio_pin_set_dt(&led_b, 1);
	k_msleep(60);
	gpio_pin_set_dt(&led_b, 0);
	k_msleep(90);
}
#endif

/* R, G, B, 100 ms each. The commanded state starts dark, so without this a
 * healthy Tag with no Link in range and a dead one look the same. */
static void boot_flash(void)
{
	paint(255, 0, 0);   k_msleep(100);
	paint(0, 255, 0);   k_msleep(100);
	paint(0, 0, 255);   k_msleep(100);
	paint(0, 0, 0);
}

/* ------------------------------------------------------------------ main --- */

int main(void)
{
	LOG_INF("Aura Tag / HOLYIOT-25008");

	if (!gpio_is_ready_dt(&led_r) || !gpio_is_ready_dt(&led_b)) {
		LOG_ERR("RGB GPIO not ready");
		return -1;
	}
	gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);

	/* pwm20 leaves P1.10 LOW at init and the LED is common-anode: park it
	 * or the Tag boots green. */
	g_have_g = pwm_is_ready_dt(&led_g);
	if (g_have_g) {
		pwm_set_pulse_dt(&led_g, 0);
	}

	boot_flash();

	/* Battery before the radio, so the first beacons carry a level. */
	int berr = battery_init();

	struct aura_band_cfg cfg = {
		.caps             = TAG_CAPS,
		.group_mask       = TAG_GROUP,
		.render           = tag_render,
		.battery_pct      = berr ? NULL : tag_battery,
		.antenna_external = false,
#if TAG_BRINGUP_TRACE
		.progress         = boot_progress,
#endif
	};

	if (aura_band_init(&cfg) != 0) {
		LOG_ERR("aura_band_init failed");
		return -1;
	}

	/* After init: motion events go out through the band layer. */
	int merr = motion_init();

	LOG_INF("proto=%u addr=%04X caps=%02X group=%02X motion=%s battery=%s",
		AURA_VER, aura_band_addr(), cfg.caps, cfg.group_mask,
		merr ? "MISSING" : "ok", berr ? "MISSING" : "ok");
	return 0;
}
