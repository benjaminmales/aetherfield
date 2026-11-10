/*
 * Aetherfield load generator — nRF54L15 TAG.
 *
 * This is NOT a simulator. It is the shipping Pixel firmware — the same
 * ../../firmware/common/aura_band.c that runs on the K4, the Holyiot and the
 * XIAO — with one addition: after beaconing as itself, the board also beacons
 * as CONFIG_SIM_DEVICES other addresses.
 *
 * Everything else is real. CMD receive, sequence dedupe, group matching, the
 * op_mode state machine, the shared-clock animation engine at 50 Hz, SYNC,
 * the channel-loss fallback: all of it is the production code path, because
 * it IS the production code path. A test that exercised a second
 * implementation would be measuring the second implementation.
 *
 * The visible consequence, and the point: the RGB LED obeys real commands.
 * Send a colour from the console and twenty boards change together. That is
 * not a proxy for downlink delivery — it IS downlink delivery, at a glance,
 * across the room.
 *
 * ---------------------------------------------------------------------------
 * What is real and what is not
 * ---------------------------------------------------------------------------
 *
 * REAL: every frame. Built by aura_band's own writers through its own radio,
 * so a gateway cannot tell a virtual device from a real one, and neither can
 * anything downstream of it.
 *
 * NOT REAL: contention between the devices on one board. A real fleet has
 * 3,000 independent radios colliding; a board has one radio that serialises
 * its 150 frames. They are spread evenly across the beacon interval rather
 * than bursting, which narrows the gap without closing it.
 *
 * ALSO NOT REAL: spatial reuse. Twenty boards in one room is a single
 * collision domain carrying every frame; a venue spreads the same fleet over
 * ground where each patch of air carries only its local devices. This test is
 * therefore OPTIMISTIC about collisions and PESSIMISTIC about geography. The
 * useful way to put that to a client: if it holds up with everything in one
 * room, the venue is the easier case.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>   /* MAX() in the mono-LED fallback */
#include <zephyr/drivers/hwinfo.h>
#include <stdlib.h>

#include "aura_band.h"

LOG_MODULE_REGISTER(loadgen, CONFIG_LOG_DEFAULT_LEVEL);

#define SIM_DEVICES CONFIG_SIM_DEVICES

/* A frame is ~736 us on air. Slots shorter than this mean the board cannot
 * keep up and you are measuring the load generator, not the network. */
#define SLOT_MIN_US 1200

/*
 * ONE BINARY FOR EVERY BOARD.
 *
 * The block used to be CONFIG_SIM_BLOCK, which meant twenty Kconfig fragments
 * and twenty full Zephyr builds to change one integer. Now it is decided at
 * runtime from the factory device id, so the same hex flashes to all twenty
 * and the only per-board step is plugging in the next board.
 *
 * WHY THIS IS NOT JUST A HASH, AND WHY IT PRINTS SO LOUDLY.
 *
 * Hashing a device id into blocks is a birthday problem, and it is a much
 * worse one than it looks. The band range holds 409 blocks of 150. Twenty
 * boards into 409 blocks collide with probability 37.6% — better than even
 * odds of a clean run, but nowhere near safe enough to trust silently.
 *
 * And a clash is invisible in exactly the wrong way: two boards emit the same
 * 150 addresses, the server dedupes them into one device, and the fleet
 * appears 150 devices short. That does not look like a numbering bug. It looks
 * like 50% packet loss on part of the range, which is precisely the thing this
 * rig exists to measure — so it would be read as a result rather than a fault.
 *
 * So the board announces its block at boot, the server counts how many
 * distinct blocks it can see, and 'sim block <n>' reassigns one board over RTT
 * without a rebuild. Expect to use it on roughly one run in three, on one
 * board.
 */
#define SIM_BLOCKS  ((AURA_ADDR_BAND_MAX - AURA_ADDR_BAND_BASE + 1) / SIM_DEVICES)

static uint16_t g_block;

#define ADDR_OF(i) ((uint16_t)(AURA_ADDR_BAND_BASE + g_block * SIM_DEVICES + (i)))

/*
 * Derive a block from the factory device id.
 *
 * Same source aura_band uses for the board's own address, so a board's block
 * and its real device address move together — flash the same hex twice and you
 * get the same answer twice, which is what makes a run reproducible.
 */
static uint16_t derive_block(void)
{
	uint8_t uid[16] = {0};
	ssize_t n = hwinfo_get_device_id(uid, sizeof(uid));

	if (n <= 0) {
		LOG_WRN("no factory device id; falling back to block 0. If two "
			"boards do this they WILL clash — set 'sim block <n>'.");
		return 0;
	}

	/* FNV-1a over the whole id. The low bytes of an nRF device id are not
	 * uniformly distributed, so taking a modulus of them directly would
	 * cluster; mixing every byte first costs nothing here. */
	uint32_t h = 2166136261u;

	for (ssize_t i = 0; i < n; i++) {
		h ^= uid[i];
		h *= 16777619u;
	}
	return (uint16_t)(h % SIM_BLOCKS);
}

/* ------------------------------------------------------------------ LED -- */
/*
 * The TAG's RGB LED is three plain GPIOs — no PWM — so each channel is on or
 * off and the board shows eight colours rather than a gamut. That is enough
 * for the job: the question this answers is "did the command arrive", and a
 * room of boards going from red to blue together answers it from the far side
 * of the room.
 *
 * The threshold sits low (64, not 128) so a dimmed command still lights
 * something. Animations stay visible either way: flash and pulse cross the
 * threshold, so they blink exactly as they should.
 */
#define CH_ON 64

#if DT_NODE_EXISTS(DT_NODELABEL(led1_red)) && \
    DT_NODE_EXISTS(DT_NODELABEL(led1_green)) && \
    DT_NODE_EXISTS(DT_NODELABEL(led1_blue))
#define HAVE_RGB 1
static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_NODELABEL(led1_red), gpios);
static const struct gpio_dt_spec led_g = GPIO_DT_SPEC_GET(DT_NODELABEL(led1_green), gpios);
static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_NODELABEL(led1_blue), gpios);
#elif DT_NODE_EXISTS(DT_ALIAS(led0))
#define HAVE_MONO 1
static const struct gpio_dt_spec led_mono = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
#endif

static bool g_led_ready;

/* Called from aura_band's animation thread at ~50 Hz with the colour already
 * resolved: animation and master brightness applied. Paint only. */
static void render(uint8_t r, uint8_t g, uint8_t b)
{
	if (!g_led_ready) {
		return;
	}
#ifdef HAVE_RGB
	gpio_pin_set_dt(&led_r, r >= CH_ON);
	gpio_pin_set_dt(&led_g, g >= CH_ON);
	gpio_pin_set_dt(&led_b, b >= CH_ON);
#elif defined(HAVE_MONO)
	gpio_pin_set_dt(&led_mono, MAX(r, MAX(g, b)) >= CH_ON);
#else
	ARG_UNUSED(r); ARG_UNUSED(g); ARG_UNUSED(b);
#endif
}

static bool led_init(void)
{
#ifdef HAVE_RGB
	if (!gpio_is_ready_dt(&led_r) || !gpio_is_ready_dt(&led_g) ||
	    !gpio_is_ready_dt(&led_b)) {
		return false;
	}
	gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_g, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);
	return true;
#elif defined(HAVE_MONO)
	if (!gpio_is_ready_dt(&led_mono)) {
		return false;
	}
	gpio_pin_configure_dt(&led_mono, GPIO_OUTPUT_INACTIVE);
	return true;
#else
	return false;
#endif
}

/* ---------------------------------------------------- virtual fleet ---- */

/*
 * Beacon interval.
 *
 * By default the virtual fleet follows the SAME over-the-air setting the real
 * device does: aura_band reads op_param from the commanded state and beacons
 * every op_param*100 ms (0 meaning AURA_BEACON_DEFAULT_MS). So
 * `aura op 0 100` from the dashboard re-rates every virtual device on every
 * board at once, through the real protocol.
 *
 * That matters more than it sounds. This board has no UART, so twenty boards
 * is twenty RTT sessions to change a number by hand — and a sweep where each
 * board is re-rated at a slightly different moment is not a sweep, it is a
 * smear. One broadcast changes them together.
 *
 * `sim rate <ms>` overrides locally for one board; `sim rate 0` gives it back
 * to the fleet.
 */
static uint32_t g_override_ms;   /* 0 = follow the commanded op_param */
static uint32_t g_applied_ms;    /* what the timer is currently set to */
static uint16_t g_n = SIM_DEVICES;
static bool     g_running = true;
static uint32_t g_tx;
static uint16_t g_cursor = 1;   /* slot 0 is the board's own beacon */

/* Local xorshift, seeded from the block so two boards differ from the first
 * frame rather than after their clocks drift apart. */
static uint32_t g_sim_rng;

static uint32_t sim_rnd(void)
{
	if (g_sim_rng == 0) {
		g_sim_rng = ((uint32_t)g_block << 16) ^ k_uptime_get_32() ^ 0x5bd1e995u;
		if (g_sim_rng == 0) {
			g_sim_rng = 1;
		}
	}
	g_sim_rng ^= g_sim_rng << 13;
	g_sim_rng ^= g_sim_rng >> 17;
	g_sim_rng ^= g_sim_rng << 5;
	return g_sim_rng;
}

/*
 * The rate one virtual device beacons at, in milliseconds.
 *
 * Normally this follows the fleet: op_param carries the NORMAL-mode cadence
 * in units of 100 ms, exactly as aura_band.c reads it, so a single broadcast
 * re-rates every board at the same instant. `sim rate <ms>` sets a local
 * override for one board; `sim rate 0` hands it back to the fleet.
 */
static uint32_t effective_interval(void)
{
	if (g_override_ms) {
		return g_override_ms;
	}

	const struct aura_cmd *st = aura_band_state();
	uint32_t p = st ? st->op_param : 0;

	return p ? p * 100u : AURA_BEACON_DEFAULT_MS;
}

/*
 * A dedicated thread, not the system workqueue.
 *
 * The first version submitted a work item from a k_timer at up to 600 Hz. Two
 * things are wrong with that. The system workqueue is shared with the rest of
 * Zephyr and each of these items holds it for about a millisecond inside the
 * radio transmit — at 600/s that is most of the queue's time, and anything
 * else needing it waits. And the workqueue stack was 2 kB, which is generous
 * for light work and thin for the 802.15.4 transmit path; the earlier
 * nrf5_rx overflow on this project was the same mistake one thread over.
 *
 * Priority 8 puts it BELOW aura_band's radio thread (6) and animation thread
 * (7) on purpose. This board is a real Pixel first and a load generator
 * second: if something has to give, it should be the synthetic traffic, not
 * the device's own behaviour.
 */
#define TX_STACK      2048
#define TX_PRIORITY   8

static K_THREAD_STACK_DEFINE(tx_stack, TX_STACK);
static struct k_thread tx_thread_data;

static void tx_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	for (;;) {
		if (!g_running || g_n <= 1) {
			/* g_n == 1 means this board represents only itself, and
			 * aura_band is already beaconing for it. */
			k_msleep(100);
			continue;
		}

		uint32_t interval = effective_interval();
		/* g_n - 1 virtual slots: aura_band's own beacon is slot 0, and
		 * it is already paced by the same commanded interval. */
		uint32_t want = (interval * 1000u) / (g_n - 1);
		uint32_t slot = want < SLOT_MIN_US ? SLOT_MIN_US : want;

		/*
		 * Jitter the slot, for the same reason aura_band jitters its
		 * own beacon: twenty boards emitting on an identical fixed
		 * period can drift into phase and then stay there, colliding
		 * repeatedly instead of occasionally. Zero-mean, so the offered
		 * load this board reports is still the load it produces.
		 */
		uint32_t j = slot / 4;

		if (j >= 2) {
			slot = slot - (j / 2) + (sim_rnd() % j);
		}

		if (interval != g_applied_ms) {
			g_applied_ms = interval;
			if (slot != want) {
				LOG_WRN("%u devices at %u ms needs %u us slots; "
					"clamped to %u. Offered load is now LOWER "
					"than requested — do not report this run "
					"as %u ms.",
					g_n, interval, want, slot, interval);
			} else {
				LOG_INF("beacon interval %u ms -> %u frames/s",
					interval, (1000u * g_n) / interval);
			}
		}

		/*
		 * Echo the seq this board actually acted on. The virtual
		 * devices share one radio, so they acquire a command together
		 * — downlink delivery is measurable at BOARD granularity, not
		 * per virtual device. Twenty boards around a room still gives
		 * twenty independent samples, which is what the statistic is
		 * for.
		 */
		const struct aura_cmd *st = aura_band_state();
		uint16_t addr = ADDR_OF(g_cursor);

		/* A battery that varies per address, so the server's fleet view
		 * looks like a fleet rather than 3,000 identical rows. */
		uint8_t batt = (uint8_t)(60 + (addr % 41));

		aura_band_beacon_as(addr, AURA_CAPS_PIXEL_XIAO, batt, 0,
				    st ? st->seq : 0);
		g_tx++;

		/*
		 * Slot 0 belongs to aura_band's own beacon — the board really
		 * is that device, transmitting on its own schedule through the
		 * full stack. The virtual fleet is 1..g_n-1, so the board plus
		 * its virtual devices come to exactly g_n.
		 */
		g_cursor = (g_n > 1)
			? (uint16_t)(1 + (g_cursor % (g_n - 1)))
			: 0;

		k_sleep(K_USEC(slot));
	}
}

/* Kept as a no-op seam: the thread re-reads the interval every slot, so
 * there is nothing to reschedule. Callers stay readable. */
static void reschedule(void)
{
	g_applied_ms = 0;   /* force the next pass to log the new rate */
}

/* --------------------------------------------------------------- shell -- */

static int c_stats(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);

	const struct aura_cmd *st = aura_band_state();
	uint32_t iv = effective_interval();
	uint32_t fps = iv ? (1000u * g_n) / iv : 0;

	shell_print(sh, "block %u   virtual %u   addr %04X..%04X",
		    g_block, g_n, ADDR_OF(0), ADDR_OF(g_n ? g_n - 1 : 0));
	shell_print(sh, "real device addr %04X = slot 0 of this block "
			"(virtual fleet is slots 1..%u)",
		    aura_band_addr(), g_n ? g_n - 1 : 0);
	shell_print(sh, "interval %u ms (%s)  ->  %u frames/s from this board",
		    iv, g_override_ms ? "local override"
				      : "from op_param, fleet-wide", fps);
	shell_print(sh, "virtual beacons sent %u   %s",
		    g_tx, g_running ? "RUNNING" : "STOPPED");
	if (st) {
		shell_print(sh, "commanded: seq=%u grp=%02X anim=%u/%u op=%u/%u "
			    "rgb=%02X%02X%02X br=%u",
			    st->seq, st->group, st->anim_mode, st->anim_param,
			    st->op_mode, st->op_param, st->r, st->g, st->b,
			    st->bright);
	}
	shell_print(sh, "clock %s", aura_band_is_synced() ? "synced to gateway"
							  : "local only");
	return 0;
}

static int c_rate(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	long ms = strtol(argv[1], NULL, 0);

	if (ms != 0 && (ms < 100 || ms > 60000)) {
		shell_print(sh, "0 (follow the fleet) or 100..60000 ms");
		return -EINVAL;
	}
	g_override_ms = (uint32_t)ms;
	reschedule();

	if (ms == 0) {
		shell_print(sh, "following the fleet: %u ms. Change it for "
			    "everyone with 'aura op 0 <param>' (param x 100 ms).",
			    effective_interval());
	} else {
		shell_print(sh, "THIS BOARD overridden to %u ms -> %u frames/s. "
			    "The rest of the fleet is unchanged; 'sim rate 0' "
			    "hands it back.",
			    g_override_ms, (1000u * g_n) / g_override_ms);
	}
	return 0;
}

static int c_devices(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	long n = strtol(argv[1], NULL, 0);

	if (n < 0 || n > SIM_DEVICES) {
		shell_print(sh, "0..%u (compiled maximum)", SIM_DEVICES);
		return -EINVAL;
	}
	g_n = (uint16_t)n;
	g_cursor = 1;
	reschedule();
	shell_print(sh, "%u virtual devices", g_n);
	return 0;
}

/*
 * Move this board to another block, live.
 *
 * For the ~1-in-3 run where two boards derive the same block. The server shows
 * how many distinct blocks it can see; if that is fewer than the number of
 * boards powered up, pick a free one here rather than rebuilding anything.
 *
 * Not persisted — it lasts until reset, which is the length of a test run.
 */
static int c_block(const struct shell *sh, size_t argc, char **argv)
{
	if (argc < 2) {
		shell_print(sh, "block %u of %u   addr %04X..%04X",
			    g_block, (unsigned int)SIM_BLOCKS,
			    ADDR_OF(0), ADDR_OF(SIM_DEVICES - 1));
		return 0;
	}

	long n = strtol(argv[1], NULL, 0);

	if (n < 0 || n >= SIM_BLOCKS) {
		shell_print(sh, "0..%u", (unsigned int)SIM_BLOCKS - 1);
		return -EINVAL;
	}

	g_block = (uint16_t)n;
	g_cursor = 1;
	shell_print(sh, "block %u   addr %04X..%04X   "
			"(tell the server this range moved)",
		    g_block, ADDR_OF(0), ADDR_OF(SIM_DEVICES - 1));
	return 0;
}

static int c_csma(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	bool on = strtol(argv[1], NULL, 0) != 0;

	aura_band_tx_csma(on);
	shell_print(sh, "%s", on
		? "CSMA/CA — listens before transmitting"
		: "DIRECT — shipping default, unslotted ALOHA at scale");
	return 0;
}

static int c_run(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	g_running = strtol(argv[1], NULL, 0) != 0;
	reschedule();
	shell_print(sh, "virtual fleet %s (this board still beacons as itself)",
		    g_running ? "running" : "stopped");
	return 0;
}

static int c_zero(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	g_tx = 0;
	shell_print(sh, "counter zeroed");
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_sim,
	SHELL_CMD_ARG(stats,   NULL, "Offered load, commanded state, clock", c_stats, 1, 0),
	SHELL_CMD_ARG(rate,    NULL, "Beacon interval: rate <ms>", c_rate, 2, 0),
	SHELL_CMD_ARG(devices, NULL, "Virtual devices: devices <n>", c_devices, 2, 0),
	SHELL_CMD_ARG(block,   NULL, "Address block: block [n]", c_block, 1, 1),
	SHELL_CMD_ARG(csma,    NULL, "csma <0|1> — DIRECT vs CSMA/CA", c_csma, 2, 0),
	SHELL_CMD_ARG(run,     NULL, "run <0|1>", c_run, 2, 0),
	SHELL_CMD_ARG(zero,    NULL, "Zero the counter", c_zero, 1, 0),
	SHELL_SUBCMD_SET_END
);
SHELL_CMD_REGISTER(sim, &sub_sim, "Load generator (the fleet layer is real)", NULL);

/* ---------------------------------------------------------------- main -- */

int main(void)
{
	/*
	 * CONFIG_SIM_BLOCK >= 0 pins this board explicitly and is what the old
	 * tagNN.conf fragments set. Left at the default -1 the board derives
	 * its own block, which is the whole point: one binary, twenty boards.
	 */
	g_block = (CONFIG_SIM_BLOCK >= 0)
		? (uint16_t)CONFIG_SIM_BLOCK
		: derive_block();

	/*
	 * Be device 0 of our own block rather than a 151st device standing
	 * outside it. Without this the board's own FICR-derived address lands
	 * anywhere in the band: the fleet counts 151 per board, and 4.9% of the
	 * time that address falls inside some other board's block and
	 * impersonates one of its devices.
	 */
	aura_band_addr_override(ADDR_OF(0));

	g_led_ready = led_init();
	if (!g_led_ready) {
		LOG_WRN("no LED — commands will land but nothing will show");
	}

	struct aura_band_cfg cfg = {
		.caps = AURA_CAPS_PIXEL_XIAO,

		/* Group 0x01, the same group the K4 Pixels use, so 'aura cmd
		 * 00 ...' and a group-01 command both reach these boards and
		 * the simulated fleet behaves as part of the real one. */
		.group_mask = 0x01,

		.render = render,
		.battery_pct = NULL,
		.antenna_external = false,
		.progress = NULL,
	};

	if (aura_band_init(&cfg) != 0) {
		LOG_ERR("aura_band_init failed");
		return -1;
	}

	/*
	 * Offset the boards against each other. Twenty of them powered from
	 * one hub would otherwise start their cycles on the same millisecond
	 * and stay in lockstep, manufacturing collisions a real fleet would
	 * not have.
	 */
	k_msleep(80 + (g_block * 37) % 500);

	k_thread_create(&tx_thread_data, tx_stack, TX_STACK,
			tx_thread, NULL, NULL, NULL, TX_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&tx_thread_data, "loadgen");

	printk(">LOADGEN block=%u virtual=%u addr=%04X..%04X real=%04X "
	       "interval=%ums group=%02X\n",
	       g_block, g_n, ADDR_OF(0), ADDR_OF(SIM_DEVICES - 1),
	       aura_band_addr(), effective_interval(), cfg.group_mask);
	return 0;
}
