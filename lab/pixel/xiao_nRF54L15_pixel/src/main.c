/*
 * Pixel — Seeed XIAO nRF54L15.
 *
 * A Pixel is the simplest device on the Aetherfield protocol: one light, no
 * sensors. Everything that makes it a v2 device — radio bring-up, CMD/SYNC
 * receive, dedupe, group filtering, the op_mode state machine, beacons, the
 * shared-clock animation engine — lives in ../../common/aura_band.c and is
 * identical on every board.
 *
 * What is left here is the last centimetre: turn one RGB triple into light.
 * That is the whole point of the seam. If you are adding a board, this file is
 * the shape of the work; you should not be touching the radio.
 *
 * ---------------------------------------------------------------------------
 * Light
 * ---------------------------------------------------------------------------
 * This board carries an LP5012 driving four RGB LEDs over I2C. v2 treats every
 * device as ONE light source however many LEDs it has, so all four are painted
 * the same colour. If the LP5012 is absent or fails to init, the module still
 * runs — it beacons, it takes commands, it simply makes no light. A Pixel that
 * has lost its LED is still useful presence data.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/logging/log.h>
#include <stdbool.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(pixel, CONFIG_LOG_DEFAULT_LEVEL);

/* --------------------------------------------------------------- LP5012 --- */

#define LP5012_ADDR 0x14
#define NUM_LEDS    4

#define LP_RESET_REG           0x27
#define LP_CONFIG0_REG         0x00
#define LP_CONFIG1_REG         0x01
#define LP_LED_CONFIG0_REG     0x02
#define LP_LED0_BRIGHTNESS_REG 0x07
#define LP_OUT0_COLOR_REG      0x0B

#define LP5012_EN_NODE DT_NODELABEL(lp5012_en_led)
#define HAVE_LP5012    DT_NODE_HAS_STATUS(LP5012_EN_NODE, okay)

#if HAVE_LP5012
static const struct gpio_dt_spec lp_en = GPIO_DT_SPEC_GET(LP5012_EN_NODE, gpios);
#endif

static const struct device *i2c_dev = DEVICE_DT_GET(DT_NODELABEL(i2c22));
static bool g_have_led;

static int lp_write(uint8_t reg, uint8_t val)
{
	/* Retry and recover. The LP5012 shares a bus that gets hot-plugged on
	 * the bench, and a wedged bus is recoverable — a dropped colour is not
	 * worth dropping the device for. */
	int ret = -EIO;

	for (int attempt = 0; attempt < 3; attempt++) {
		ret = i2c_reg_write_byte(i2c_dev, LP5012_ADDR, reg, val);
		if (ret == 0) {
			return 0;
		}
		i2c_recover_bus(i2c_dev);
		k_msleep(5);
	}
	return ret;
}

static int lp_init(void)
{
	int ret;

	k_msleep(50);

	ret = lp_write(LP_RESET_REG, 0xFF);
	if (ret) {
		return ret;
	}
	k_msleep(10);

	/* CONFIG0 bit6 = chip enable. CONFIG1 0x30 = auto-increment + PWM
	 * dithering, which is what stops low brightnesses banding. */
	if ((ret = lp_write(LP_CONFIG0_REG, 0x40)) != 0) {
		return ret;
	}
	if ((ret = lp_write(LP_CONFIG1_REG, 0x30)) != 0) {
		return ret;
	}
	/* Independent per-LED control rather than banked. */
	if ((ret = lp_write(LP_LED_CONFIG0_REG, 0x00)) != 0) {
		return ret;
	}

	for (int i = 0; i < NUM_LEDS; i++) {
		if ((ret = lp_write(LP_LED0_BRIGHTNESS_REG + i, 0xFF)) != 0) {
			return ret;
		}
	}
	for (int i = 0; i < NUM_LEDS * 3; i++) {
		if ((ret = lp_write(LP_OUT0_COLOR_REG + i, 0x00)) != 0) {
			return ret;
		}
	}
	return 0;
}

/* ---------------------------------------------------------------- render --- */

/* Write all four LEDs unconditionally. */
static void paint(uint8_t r, uint8_t g, uint8_t b)
{
	if (!g_have_led) {
		return;
	}
	for (uint8_t i = 0; i < NUM_LEDS; i++) {
		uint8_t base = LP_OUT0_COLOR_REG + (i * 3);

		lp_write(base + 0, r);
		lp_write(base + 1, g);
		lp_write(base + 2, b);
	}
}

/*
 * Boot signature.
 *
 * Without this a healthy device and a bricked one look identical: the
 * commanded state starts dark on purpose, so nothing lights until a gateway
 * says so — and if no gateway is listening yet, that is indefinitely.
 *
 * A red/green/blue sweep proves the whole light path in about a second, before
 * the radio is even up, and it tells you which channel is broken if one is.
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
 * where — on a board with no console attached.
 *
 * Safe to paint from here: aura_band signals every step BEFORE it starts the
 * animation thread, so nothing else owns the I2C bus yet.
 */
static void boot_progress(uint8_t step)
{
	LOG_INF("init step %u", step);
	paint(40, 40, 40);
	k_msleep(60);
	paint(0, 0, 0);
	k_msleep(90);
}

/*
 * Called from the animation thread at ~50 Hz with the fully resolved colour —
 * animation and master brightness are already applied, so this only paints.
 */
static void pixel_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t last_r, last_g, last_b;
	static bool primed;

	if (!g_have_led) {
		return;
	}

	/*
	 * Only touch the bus when the colour actually changes. A steady colour
	 * is the same triple every frame, and each frame here is twelve I2C
	 * register writes — a lot of bus traffic and current for no visible
	 * difference, on a device that has to last three days.
	 */
	if (primed && r == last_r && g == last_g && b == last_b) {
		return;
	}
	last_r = r; last_g = g; last_b = b;
	primed = true;

	paint(r, g, b);
}

/* ------------------------------------------------------------------ main --- */

int main(void)
{
	LOG_INF("Pixel / XIAO nRF54L15");

	if (!device_is_ready(i2c_dev)) {
		LOG_ERR("i2c22 not ready — no light on this device");
	} else {
#if HAVE_LP5012
		if (gpio_is_ready_dt(&lp_en)) {
			gpio_pin_configure_dt(&lp_en, GPIO_OUTPUT_ACTIVE);
			k_msleep(10);
		}
#endif
		if (lp_init() == 0) {
			g_have_led = true;
			LOG_INF("LP5012 ready, %d LEDs", NUM_LEDS);
			boot_flash();
		} else {
			LOG_ERR("LP5012 init failed — running without light");
		}
	}

	struct aura_band_cfg cfg = {
		.caps = AURA_CAPS_PIXEL_XIAO,

		/*
		 * Group 0x02. Groups are a bitmask, so the gateway can address
		 * the two test Pixels separately or together:
		 *   aura group 02 -> this board
		 *   aura group 04 -> the Holyiot Pixel
		 *   aura group 06 -> both
		 *   aura group 00 -> everyone
		 */
		.group_mask = 0x02,

		.render = pixel_render,
		.battery_pct = NULL,        /* VBAT divider not wired on this board */

		/*
		 * Onboard ceramic antenna. Set true ONLY if a u.FL antenna is
		 * actually fitted — selecting a port with no antenna on it
		 * leaves the radio nearly deaf and looks exactly like a
		 * protocol bug.
		 */
		.antenna_external = false,

		/* Blink out each init step. See boot_progress(). */
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
