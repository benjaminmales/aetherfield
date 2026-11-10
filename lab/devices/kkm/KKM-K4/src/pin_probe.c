/*
 * K4 -- radio-narrated GPIO pin probe, with gateway-driven manual hold.
 *
 * Two things at once:
 *
 *   AUTO SWEEP   walks every GPIO, announcing each pin over the radio just
 *                before driving it. Watch the LED, read the pin off the log.
 *
 *   MANUAL HOLD  drive ONE named pin indefinitely, commanded from the gateway.
 *                This is the mode for putting a MULTIMETER on the LED pads --
 *                a 2 s sweep slot is not long enough to probe calmly, and a
 *                dim LED that the eye misses is plainly visible as a voltage
 *                step. It also forces pins the auto sweep will not drive.
 *
 * ------------------------------------------------------------------------
 * Gateway -> K4:   aura color <pincode> <mode> 0
 * ------------------------------------------------------------------------
 *
 *   <pincode> = port*100 + pin   (110 = P1.10, 4 = P0.04, 210 = P2.10)
 *   <mode>    0  hold SINKING     (open-drain low)  -> active-low LED
 *             1  hold SOURCING    (push-pull high)  -> active-high LED
 *             2  RELEASE, resume the automatic sweep
 *             3  hold SOURCING at high drive strength
 *
 * The command doubles as the downlink test: `cseq` in the next BEACON should
 * change to this command's seq. If it does, the K4 is receiving as well as
 * transmitting.
 *
 * ------------------------------------------------------------------------
 * K4 -> gateway
 * ------------------------------------------------------------------------
 *
 *     <EVT a=4C51 n=0 r=-55 t=? v=110 s=0
 *                                 |     |
 *                                 |     +-- what happened
 *                                 +-------- v = port*100 + pin
 *
 *   v = 254  pass marker      v = 255  cycle marker
 *
 *   s = 0  sweep: driven open-drain, sinking   (active-low LED)
 *   s = 1  sweep: driven push-pull, sourcing   (active-high LED)
 *   s = 2  sweep: skipped, on the push-pull skip list
 *   s = 3  gpio_pin_configure refused it
 *   s = 4  HELD sinking          s = 5  HELD sourcing
 *   s = 6  HELD sourcing, high drive
 *   s = 7  released, sweep resumed
 *   s = 8  unknown pin code in the command
 *
 * `t=?` is expected: 0x7E is a bring-up event type, deliberately absent from
 * include/aura_radio.h so this costs no protocol change and no gateway
 * reflash.
 *
 * The event is sent BEFORE the pin is driven. If a pin drives an RF switch or
 * a power rail, the radio dies the moment it is touched and the last <EVT line
 * names it. Silence in the log is a result, not a lost run.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>

/* High drive strength is a Nordic GPIO flag extension. Guarded because this
 * project cannot be compile-tested from the cloud session: if the binding
 * header is not where we expect, mode 3 quietly becomes standard drive rather
 * than failing the build. */
#if defined(__has_include)
#  if __has_include(<zephyr/dt-bindings/gpio/nordic-nrf-gpio.h>)
#    include <zephyr/dt-bindings/gpio/nordic-nrf-gpio.h>
#  endif
#endif
#ifndef NRF_GPIO_DRIVE_H0H1
#define NRF_GPIO_DRIVE_H0H1 0
#endif

#include "aura_band.h"

LOG_MODULE_DECLARE(k4_hello, LOG_LEVEL_INF);

#define EV_PINPROBE      0x7E

#define V_PASS_MARKER    254
#define V_CYCLE_MARKER   255

#define S_OPEN_DRAIN     0
#define S_PUSH_PULL      1
#define S_SKIPPED        2
#define S_REFUSED        3
#define S_HELD_SINK      4
#define S_HELD_SOURCE    5
#define S_HELD_SOURCE_HD 6
#define S_RELEASED       7
#define S_BAD_PINCODE    8

/* Command modes, as sent in the CMD frame's r/g bytes. */
#define MODE_SINK        0
#define MODE_SOURCE      1
#define MODE_RELEASE     2
#define MODE_SOURCE_HD   3

#define SLOT_MS          2000
#define SLOT_ON_MS       1600
#define PASS_GAP_MS      4000
#define CYCLE_GAP_MS     6000
#define POLL_MS          100

/*
 * Boot signature on the confirmed LED D2 (P2.03, active high). Three red
 * flashes before any sweeping starts.
 *
 * NOTE the correction: this probe originally reported the LED at v=202. The
 * schematic puts LED2 on P2.03 and nothing at all on P2.02 -- the sighting was
 * the ADJACENT SLOT, i.e. the flash was matched to the log line printed two
 * seconds earlier. Worth remembering when reading any timed probe by eye.
 *
 * This board has no console, so until now a reset was invisible. Now that one
 * pin is confirmed, it can say "I booted, and the pin configuration is right"
 * in the one second before the log fills with probe events -- which also means
 * a failed flash or a halted core is obvious without reading anything.
 */
#define KNOWN_LED_CODE   203
#define BOOT_FLASHES     3
#define BOOT_FLASH_MS    120

struct probe_pin {
	const struct device *dev;
	uint8_t port;
	uint8_t pin;
};

/* Written out entry by entry: this project cannot be compile-tested from the
 * cloud session, so a list macro that expands wrongly costs a build cycle.
 * Port sizes from the SoC devicetree: P0 = 5, P1 = 16, P2 = 11. */
static const struct probe_pin pins[] = {
	{ DEVICE_DT_GET(DT_NODELABEL(gpio0)), 0,  0 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio0)), 0,  1 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio0)), 0,  2 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio0)), 0,  3 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio0)), 0,  4 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  0 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  1 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  2 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  3 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  4 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  5 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  6 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  7 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  8 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1,  9 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 10 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 11 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 12 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 13 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 14 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio1)), 1, 15 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  0 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  1 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  2 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  3 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  4 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  5 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  6 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  7 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  8 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2,  9 },
	{ DEVICE_DT_GET(DT_NODELABEL(gpio2)), 2, 10 },
};

/*
 * Skipped in the AUTO push-pull pass only: the LIS2DW12's INT1 / INT2 lines,
 * which are outputs from the sensor, and driving a pin another chip is also
 * driving is the one way this probe could damage something.
 *
 * CORRECTED from the schematic: these are P1.13 / P1.14, NOT the P1.06 / P1.07
 * inherited from the K7. P1.06 is SDA on this board. So the earlier runs were
 * guarding the wrong two pins and did drive the real interrupt lines -- no
 * harm done, but it was luck, not care.
 *
 * Manual hold WILL drive them: a deliberate act, not an automatic sweep.
 */
static const struct { uint8_t port, pin; } PUSH_PULL_SKIP[] = {
	{ 1, 13 },
	{ 1, 14 },
};

static bool push_pull_skipped(uint8_t port, uint8_t pin)
{
	for (size_t i = 0; i < ARRAY_SIZE(PUSH_PULL_SKIP); i++) {
		if (PUSH_PULL_SKIP[i].port == port &&
		    PUSH_PULL_SKIP[i].pin == pin) {
			return true;
		}
	}
	return false;
}

static uint8_t pin_code(const struct probe_pin *p)
{
	return (uint8_t)(p->port * 100u + p->pin);
}

static const struct probe_pin *pin_by_code(uint8_t code)
{
	for (size_t i = 0; i < ARRAY_SIZE(pins); i++) {
		if (pin_code(&pins[i]) == code) {
			return &pins[i];
		}
	}
	return NULL;
}

static void say(uint8_t value, uint8_t how)
{
	aura_band_send_event(EV_PINPROBE, value, how);
}

/* ---------------- manual hold, commanded from the gateway ---------------- */

static const struct probe_pin *g_held;
static uint8_t g_last_seq;
static bool    g_have_seq;

static void release_held(void)
{
	if (g_held) {
		gpio_pin_configure(g_held->dev, g_held->pin, GPIO_DISCONNECTED);
		g_held = NULL;
	}
}

static void apply_hold(uint8_t code, uint8_t mode)
{
	const struct probe_pin *p;
	gpio_flags_t flags;
	int active, err;
	uint8_t s;

	release_held();

	if (mode == MODE_RELEASE) {
		say(V_CYCLE_MARKER, S_RELEASED);
		return;
	}

	p = pin_by_code(code);
	if (!p || !device_is_ready(p->dev)) {
		say(code, S_BAD_PINCODE);
		return;
	}

	switch (mode) {
	case MODE_SINK:
		flags = GPIO_OUTPUT_HIGH | GPIO_OPEN_DRAIN;
		active = 0;
		s = S_HELD_SINK;
		break;
	case MODE_SOURCE_HD:
		flags = GPIO_OUTPUT_LOW | NRF_GPIO_DRIVE_H0H1;
		active = 1;
		s = S_HELD_SOURCE_HD;
		break;
	case MODE_SOURCE:
	default:
		flags = GPIO_OUTPUT_LOW;
		active = 1;
		s = S_HELD_SOURCE;
		break;
	}

	err = gpio_pin_configure(p->dev, p->pin, flags);
	if (err) {
		say(code, S_REFUSED);
		return;
	}

	say(code, s);                       /* announce before driving */
	gpio_pin_set_raw(p->dev, p->pin, active);
	g_held = p;
}

/*
 * Poll the commanded state for a new CMD. Returns true if one arrived.
 *
 * Read without the band's state mutex, which is fine here: the fields are
 * single bytes and this is a bring-up tool, not show firmware. A torn read
 * costs one repeated command, and the gateway repeats CMDs anyway.
 */
static bool poll_cmd(void)
{
	const struct aura_cmd *c = aura_band_state();
	uint8_t seq = c->seq;

	if (g_have_seq && seq == g_last_seq) {
		return false;
	}
	g_have_seq = true;
	g_last_seq = seq;

	apply_hold(c->r, c->g);
	return true;
}

/* Sleep, but return early if a command arrives. */
static bool sleep_poll(uint32_t ms)
{
	while (ms > 0) {
		uint32_t chunk = ms < POLL_MS ? ms : POLL_MS;

		k_msleep(chunk);
		ms -= chunk;
		if (poll_cmd()) {
			return true;
		}
	}
	return false;
}

/* ---------------------------- automatic sweep --------------------------- */

/* Returns true if interrupted by a command. */
static bool probe_one(const struct probe_pin *p, bool open_drain)
{
	gpio_flags_t flags = open_drain ? (GPIO_OUTPUT_HIGH | GPIO_OPEN_DRAIN)
					: GPIO_OUTPUT_LOW;
	int active = open_drain ? 0 : 1;
	uint8_t code = pin_code(p);
	int err;

	if (!open_drain && push_pull_skipped(p->port, p->pin)) {
		say(code, S_SKIPPED);
		return sleep_poll(SLOT_MS);
	}
	if (!device_is_ready(p->dev)) {
		say(code, S_REFUSED);
		return sleep_poll(SLOT_MS);
	}

	err = gpio_pin_configure(p->dev, p->pin, flags);
	if (err) {
		say(code, S_REFUSED);
		return sleep_poll(SLOT_MS);
	}

	say(code, open_drain ? S_OPEN_DRAIN : S_PUSH_PULL);

	gpio_pin_set_raw(p->dev, p->pin, active);
	if (sleep_poll(SLOT_ON_MS)) {
		return true;   /* apply_hold already took the pin over */
	}
	gpio_pin_set_raw(p->dev, p->pin, !active);
	gpio_pin_configure(p->dev, p->pin, GPIO_DISCONNECTED);

	return sleep_poll(SLOT_MS - SLOT_ON_MS);
}

static bool probe_pass(bool open_drain)
{
	say(V_PASS_MARKER, open_drain ? S_OPEN_DRAIN : S_PUSH_PULL);
	if (sleep_poll(SLOT_MS)) {
		return true;
	}
	for (size_t i = 0; i < ARRAY_SIZE(pins); i++) {
		if (probe_one(&pins[i], open_drain)) {
			return true;
		}
	}
	return false;
}

int k4_pin_probe_app(void)
{
	int err;

	static const struct aura_band_cfg cfg = {
		.caps             = 0x00,
		.group_mask       = 0x04,
		.render           = NULL,
		.battery_pct      = NULL,
		.antenna_external = false,
		.progress         = NULL,
	};

	err = aura_band_init(&cfg);
	if (err) {
		return err;
	}

	/* Boot signature on the confirmed LED, before anything else. */
	{
		const struct probe_pin *known = pin_by_code(KNOWN_LED_CODE);

		if (known && device_is_ready(known->dev) &&
		    gpio_pin_configure(known->dev, known->pin,
				       GPIO_OUTPUT_LOW) == 0) {
			for (int i = 0; i < BOOT_FLASHES; i++) {
				gpio_pin_set_raw(known->dev, known->pin, 1);
				k_msleep(BOOT_FLASH_MS);
				gpio_pin_set_raw(known->dev, known->pin, 0);
				k_msleep(BOOT_FLASH_MS * 2);
			}
			gpio_pin_configure(known->dev, known->pin,
					   GPIO_DISCONNECTED);
		}
	}

	/* Let the first beacons out so the gateway has us in its fleet table
	 * before we start talking about pins. */
	k_msleep(3000);

	while (1) {
		if (g_held) {
			/* Manual hold: the pin stays driven until told
			 * otherwise. Nothing to do but listen. */
			sleep_poll(POLL_MS * 10);
			continue;
		}

		say(V_CYCLE_MARKER, V_CYCLE_MARKER);
		if (sleep_poll(SLOT_MS)) {
			continue;
		}
		/*
		 * SOURCING FIRST. The bottom LED was found at P2.02 driven
		 * push-pull, so this board's LEDs are ACTIVE HIGH -- the
		 * sinking pass is the unlikely one here and now runs second.
		 * Watching only the s=1 lines halves the time to a result.
		 */
		if (probe_pass(false)) {
			continue;
		}
		if (sleep_poll(PASS_GAP_MS)) {
			continue;
		}
		if (probe_pass(true)) {
			continue;
		}
		sleep_poll(CYCLE_GAP_MS);
	}

	return 0;
}
