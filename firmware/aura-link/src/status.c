/*
 * Aura Link status light — the XIAO's onboard RGB LED.
 *
 * A gateway in a venue ceiling has no console attached. Before this, the only
 * way to tell a healthy Link from one with a bad cable, a wrong server
 * address or a dead W5500 was to plug in USB and read the log. Now it says so
 * itself:
 *
 *   solid blue           booting, W5500 not yet up
 *   red, fast blink      W5500 not answering on SPI — hardware or seating
 *   red, short pulse/s   no Ethernet link — cable, switch port or PoE
 *   amber, blink         Ethernet up, server not answering on 10.10.0.1:9000
 *   green, solid         online
 *     + blue flicker     hearing devices (one blip per tick with traffic)
 *     + white flash      transmitting a command to the fleet
 *   white, fast flash    LOCATE — `link locate <s>` from the console or the
 *                        server, to find which physical Link is which
 *
 * The three LEDs are plain GPIO (no PWM on this board's RGB), so everything
 * is on/off at a 10 Hz tick on its own thread. The radio path only ever sets
 * an atomic flag — net_recv_data() runs on the 802.15.4 driver thread and
 * must not touch a GPIO, let alone wait.
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/shell/shell.h>
#include <stdlib.h>

#include "status.h"

#define TICK_MS 100

static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static const struct gpio_dt_spec led_g = GPIO_DT_SPEC_GET(DT_ALIAS(led2), gpios);

static atomic_t g_state = ATOMIC_INIT(STATUS_BOOT);
static atomic_t g_rx;
static atomic_t g_tx_ticks;
static atomic_t g_locate_ticks;
static bool     g_ready;

void status_set(enum status_state s) { atomic_set(&g_state, s); }
void status_rx(void)                 { atomic_set(&g_rx, 1); }
void status_tx(void)                 { atomic_set(&g_tx_ticks, 2); }

void status_locate(uint32_t seconds)
{
	atomic_set(&g_locate_ticks, (atomic_val_t)(seconds * (1000 / TICK_MS)));
}

static void paint(bool r, bool g, bool b)
{
	gpio_pin_set_dt(&led_r, r);
	gpio_pin_set_dt(&led_g, g);
	gpio_pin_set_dt(&led_b, b);
}

static void status_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	uint32_t t = 0;

	for (;; t++, k_msleep(TICK_MS)) {
		/* LOCATE overrides everything: it is a person on a ladder. */
		if (atomic_get(&g_locate_ticks) > 0) {
			atomic_dec(&g_locate_ticks);
			bool on = (t & 1) == 0;

			paint(on, on, on);
			continue;
		}

		switch ((enum status_state)atomic_get(&g_state)) {
		case STATUS_BOOT:
			paint(false, false, true);
			break;
		case STATUS_FAULT:              /* 2.5 Hz */
			paint((t % 4) < 2, false, false);
			break;
		case STATUS_NO_ETH:             /* 100 ms pulse each second */
			paint((t % 10) == 0, false, false);
			break;
		case STATUS_NO_SERVER: {        /* 1 Hz, 50% */
			bool on = (t % 10) < 5;

			paint(on, on, false);
			break;
		}
		case STATUS_ONLINE:
		default:
			if (atomic_get(&g_tx_ticks) > 0) {
				atomic_dec(&g_tx_ticks);
				paint(true, true, true);
			} else if (atomic_cas(&g_rx, 1, 0)) {
				paint(false, true, true);
			} else {
				paint(false, true, false);
			}
			break;
		}
	}
}

K_THREAD_STACK_DEFINE(status_stack, 512);
static struct k_thread status_thread_data;

int status_init(void)
{
	if (!gpio_is_ready_dt(&led_r) || !gpio_is_ready_dt(&led_g) ||
	    !gpio_is_ready_dt(&led_b)) {
		return -ENODEV;
	}
	gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_g, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);
	g_ready = true;

	/* Lowest priority that still runs: the light must never steal time
	 * from the radio or the link. */
	k_thread_create(&status_thread_data, status_stack,
			K_THREAD_STACK_SIZEOF(status_stack), status_thread,
			NULL, NULL, NULL, K_LOWEST_APPLICATION_THREAD_PRIO, 0,
			K_NO_WAIT);
	k_thread_name_set(&status_thread_data, "status");
	return 0;
}

/* ---- shell: reachable from the server too, because downlink is the shell */

static int c_locate(const struct shell *sh, size_t argc, char **argv)
{
	uint32_t s = (argc > 1) ? (uint32_t)strtoul(argv[1], NULL, 10) : 10;

	if (s > 300) {
		s = 300;
	}
	if (!g_ready) {
		shell_error(sh, "status LED not available");
		return -ENODEV;
	}
	status_locate(s);
	shell_print(sh, "locate: flashing white for %u s", s);
	return 0;
}

/* `link` is a section-based command set so link_cfg.c can add its own
 * subcommands (config/set/save/reboot) without this file knowing about them. */
SHELL_SUBCMD_SET_CREATE(link_cmds, (link));
SHELL_SUBCMD_ADD((link), locate, NULL, "[seconds] flash this Link's LED white (default 10)",
		 c_locate, 1, 1);
SHELL_CMD_REGISTER(link, &link_cmds, "Aura Link commands", NULL);
