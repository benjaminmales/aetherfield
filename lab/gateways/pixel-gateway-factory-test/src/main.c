/*
 * Aetherfield gateway — factory test firmware.
 * Target: Seeed XIAO nRF54LM20A on the XIAO W5500 Ethernet adapter.
 *
 * Needs no server and no Aetherfield infrastructure. On boot it runs every
 * check once, prints a PASS/FAIL report on the USB-C serial console
 * (115200 8N1), and shows the result on the XIAO's RGB LED:
 *
 *   blue   test running
 *   green  all checks passed (blinks once a second while idle)
 *   red    one or more checks failed (fast blink)
 *
 * After the report it keeps running: the W5500 answers ping on its static IP,
 * the radio broadcasts a test frame every second, and a status line is
 * printed every 5 seconds. Type 'help' at the console for commands.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/printk.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include "w5500.h"
#include "radio.h"

#define FW_VERSION "1.0.0"

/* Default static address. Change at the console with: ip <a.b.c.d> */
static uint8_t g_ip[4]   = { 192, 168, 1, 200 };
static uint8_t g_mask[4] = { 255, 255, 255, 0 };
static uint8_t g_gw[4]   = { 192, 168, 1, 1 };

#define LINK_WAIT_MS     10000
#define RADIO_TX_FRAMES  5

/* ---- LEDs ---------------------------------------------------------------- */

static const struct gpio_dt_spec led_b = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec led_r = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static const struct gpio_dt_spec led_g = GPIO_DT_SPEC_GET(DT_ALIAS(led2), gpios);

static void led(bool r, bool g, bool b)
{
	gpio_pin_set_dt(&led_r, r);
	gpio_pin_set_dt(&led_g, g);
	gpio_pin_set_dt(&led_b, b);
}

/* ---- identity ------------------------------------------------------------ */

static uint8_t g_devid[8];
static uint8_t g_mac[6];

static void read_identity(void)
{
	uint8_t id[16] = { 0 };
	ssize_t n = hwinfo_get_device_id(id, sizeof(id));

	if (n < 8) {
		memset(id, 0xAE, sizeof(id));
		n = 8;
	}
	memcpy(g_devid, id, 8);

	/* Same derivation as the production gateway: locally administered,
	 * unicast, unique per unit with no provisioning. */
	g_mac[0] = 0x02;
	for (int i = 1; i < 6; i++) {
		g_mac[i] = id[(n - i) % n];
	}
}

/* ---- test run ------------------------------------------------------------ */

enum res { R_PASS, R_FAIL, R_SKIP, R_INFO };
static const char *const res_str[] = { "PASS", "FAIL", "SKIP", "INFO" };

static int g_failures;
static bool g_last_pass;

static void report(int n, const char *name, enum res r, const char *fmt, ...)
{
	char detail[96];
	va_list ap;

	va_start(ap, fmt);
	vsnprintk(detail, sizeof(detail), fmt, ap);
	va_end(ap);

	printk("[%d] %-15s %-44s %s\n", n, name, detail, res_str[r]);
	if (r == R_FAIL) {
		g_failures++;
	}
}

static void run_tests(void)
{
	g_failures = 0;
	led(false, false, true);

	printk("\n==================================================================\n");
	printk(" AETHERFIELD GATEWAY FACTORY TEST  fw %s\n", FW_VERSION);
	printk(" Board     XIAO nRF54LM20A + W5500\n");
	printk(" Device ID %02X%02X%02X%02X%02X%02X%02X%02X\n",
	       g_devid[0], g_devid[1], g_devid[2], g_devid[3],
	       g_devid[4], g_devid[5], g_devid[6], g_devid[7]);
	printk(" MAC       %02X:%02X:%02X:%02X:%02X:%02X\n",
	       g_mac[0], g_mac[1], g_mac[2], g_mac[3], g_mac[4], g_mac[5]);
	printk(" IP        %u.%u.%u.%u / %u.%u.%u.%u\n",
	       g_ip[0], g_ip[1], g_ip[2], g_ip[3],
	       g_mask[0], g_mask[1], g_mask[2], g_mask[3]);
	printk("==================================================================\n");

	/* 1. W5500 present and answering on SPI. */
	int ver = w5500_reset_and_version();
	bool w5500_ok = (ver == 0x04);

	if (ver < 0) {
		report(1, "W5500 SPI", R_FAIL, "SPI error %d", ver);
	} else {
		report(1, "W5500 SPI", w5500_ok ? R_PASS : R_FAIL,
		       "VERSIONR=0x%02X (expect 0x04)%s", ver,
		       w5500_has_reset_pin() ? "" : ", no RST pin");
	}
	if (!w5500_ok) {
		printk("    -> check SCK/MISO/MOSI on D8/D9/D10, CS pin in the\n"
		       "       overlay, and 3V3 at the W5500. 0x00/0xFF = no response.\n");
	}

	/* 2. Data integrity across the bus. */
	if (w5500_ok) {
		int bad = w5500_spi_integrity();

		report(2, "SPI integrity", bad == 0 ? R_PASS : R_FAIL,
		       bad < 0 ? "bus error" : "70 bytes written/read, %d mismatched",
		       bad);
		w5500_configure(g_mac, g_ip, g_mask, g_gw);
	} else {
		report(2, "SPI integrity", R_SKIP, "needs test 1");
	}

	/* 3. Ethernet PHY link. */
	bool link_ok = false;

	if (w5500_ok) {
		uint8_t phy = 0;
		int waited = 0;

		while (waited < LINK_WAIT_MS) {
			phy = w5500_phycfgr();
			if (phy & 0x01) {
				break;
			}
			k_msleep(100);
			waited += 100;
		}
		link_ok = (phy & 0x01) != 0;
		if (link_ok) {
			report(3, "Ethernet link", R_PASS, "%s %s-duplex",
			       (phy & 0x02) ? "100M" : "10M",
			       (phy & 0x04) ? "full" : "half");
		} else {
			report(3, "Ethernet link", R_FAIL,
			       "no link after %d s - cable/switch/magnetics",
			       LINK_WAIT_MS / 1000);
		}
	} else {
		report(3, "Ethernet link", R_SKIP, "needs test 1");
	}

	/* 4. INTn wiring. */
	if (!w5500_ok) {
		report(4, "W5500 INT", R_SKIP, "needs test 1");
	} else if (!link_ok) {
		/* The INT test provokes a SEND_OK interrupt with a UDP broadcast,
		 * which needs the PHY up to complete reliably. */
		report(4, "W5500 INT", R_SKIP, "needs Ethernet link (test 3)");
	} else {
		int r = w5500_int_test();

		if (r == -ENOTSUP) {
			report(4, "W5500 INT", R_SKIP, "no int-gpios in overlay");
		} else if (r == 0) {
			report(4, "W5500 INT", R_PASS, "asserted and released");
		} else if (r == -EBUSY) {
			report(4, "W5500 INT", R_FAIL, "stuck low / wrong pin");
		} else {
			report(4, "W5500 INT", R_FAIL, "never asserted / wrong pin");
		}
	}

	/* 5. Radio transmit. */
	int ok = 0;

	for (int i = 0; i < RADIO_TX_FRAMES; i++) {
		if (radio_send_test_frame() == 0) {
			ok++;
		}
		k_msleep(20);
	}
	report(5, "802.15.4 TX", ok == RADIO_TX_FRAMES ? R_PASS : R_FAIL,
	       "%d/%d frames sent, ch %u, +8 dBm", ok, RADIO_TX_FRAMES,
	       radio_channel());

	/* 6. Radio receive — informational; needs a second unit running this
	 * test within range on the same channel. */
	struct radio_stats st;

	radio_get_stats(&st);
	if (st.rx_peer) {
		report(6, "802.15.4 RX", R_PASS, "peer %02X%02X%02X%02X heard, RSSI %d dBm",
		       st.last_peer_id[0], st.last_peer_id[1],
		       st.last_peer_id[2], st.last_peer_id[3], st.last_peer_rssi);
	} else {
		report(6, "802.15.4 RX", R_INFO,
		       "no peer yet (%u frames heard) - see status", st.rx_total);
	}

	printk("------------------------------------------------------------------\n");
	printk(" RESULT: %s  (%d failure%s)\n", g_failures ? "FAIL" : "PASS",
	       g_failures, g_failures == 1 ? "" : "s");
	printk("------------------------------------------------------------------\n");
	printk(" Next: ping %u.%u.%u.%u from a PC on the same subnet.\n",
	       g_ip[0], g_ip[1], g_ip[2], g_ip[3]);
	printk(" Radio RX: run a second unit; its ID appears in the status line.\n");
	printk(" Type 'help' for commands, 'test' to run again.\n\n");

	g_last_pass = (g_failures == 0);
}

/* ---- shell ---------------------------------------------------------------- */

static atomic_t g_req_test;
static atomic_t g_req_reconf;

static int parse_ip(const char *s, uint8_t out[4])
{
	for (int i = 0; i < 4; i++) {
		char *end;
		long v = strtol(s, &end, 10);

		if (end == s || v < 0 || v > 255 || (i < 3 && *end != '.') ||
		    (i == 3 && *end != '\0')) {
			return -EINVAL;
		}
		out[i] = (uint8_t)v;
		s = end + 1;
	}
	return 0;
}

static int c_test(const struct shell *sh, size_t argc, char **argv)
{
	atomic_set(&g_req_test, 1);
	return 0;
}

static int c_ip(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t ip[4], mask[4], gw[4];

	memcpy(mask, g_mask, 4);
	if (parse_ip(argv[1], ip) ||
	    (argc > 2 && parse_ip(argv[2], mask)) ||
	    (argc > 3 && parse_ip(argv[3], gw))) {
		shell_error(sh, "usage: ip <a.b.c.d> [mask] [gateway]");
		return -EINVAL;
	}
	if (argc <= 3) {
		memcpy(gw, ip, 4);
		gw[3] = 1;
	}
	memcpy(g_ip, ip, 4);
	memcpy(g_mask, mask, 4);
	memcpy(g_gw, gw, 4);
	atomic_set(&g_req_reconf, 1);
	shell_print(sh, "IP %u.%u.%u.%u mask %u.%u.%u.%u gw %u.%u.%u.%u",
		    ip[0], ip[1], ip[2], ip[3], mask[0], mask[1], mask[2], mask[3],
		    gw[0], gw[1], gw[2], gw[3]);
	return 0;
}

static int c_chan(const struct shell *sh, size_t argc, char **argv)
{
	int ch = atoi(argv[1]);

	if (radio_set_channel((uint8_t)ch)) {
		shell_error(sh, "channel must be 11..26");
		return -EINVAL;
	}
	radio_reset_stats();
	shell_print(sh, "radio channel %d (both units must match)", ch);
	return 0;
}

SHELL_CMD_ARG_REGISTER(test, NULL, "Run the full factory test again", c_test, 1, 0);
SHELL_CMD_ARG_REGISTER(ip, NULL, "Set static IP: ip <a.b.c.d> [mask] [gateway]",
		       c_ip, 2, 2);
SHELL_CMD_ARG_REGISTER(chan, NULL, "Radio channel: chan <11-26>", c_chan, 2, 0);

/* ---- main ------------------------------------------------------------------ */

int main(void)
{
	gpio_pin_configure_dt(&led_r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_g, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led_b, GPIO_OUTPUT_INACTIVE);
	led(false, false, true);

	read_identity();

	/* Let the USB serial bridge enumerate so the report isn't lost. */
	k_msleep(1500);

	int err = radio_init(FT_RADIO_CHANNEL_DEFAULT, g_devid);

	if (err) {
		printk("radio init failed: %d\n", err);
	}

	run_tests();

	uint32_t tick = 0;

	for (;;) {
		if (atomic_cas(&g_req_test, 1, 0)) {
			radio_reset_stats();
			run_tests();
		}
		if (atomic_cas(&g_req_reconf, 1, 0)) {
			w5500_configure(g_mac, g_ip, g_mask, g_gw);
		}

		radio_send_test_frame();

		/* LED heartbeat: green blink on pass, fast red on fail. */
		if (g_last_pass) {
			led(false, true, false);
			k_msleep(100);
			led(false, false, false);
			k_msleep(900);
		} else {
			for (int i = 0; i < 5; i++) {
				led(true, false, false);
				k_msleep(100);
				led(false, false, false);
				k_msleep(100);
			}
		}

		if (++tick % 5 == 0) {
			struct radio_stats st;
			uint8_t phy = w5500_phycfgr();

			radio_get_stats(&st);
			printk("[status] eth %s | radio ch%u tx %u/%u rx %u",
			       (phy & 0x01) ? ((phy & 0x02) ? "up 100M" : "up 10M")
					    : "DOWN",
			       radio_channel(), st.tx_ok, st.tx_ok + st.tx_fail,
			       st.rx_total);
			if (st.rx_peer) {
				printk(" | peer %02X%02X%02X%02X x%u rssi %d",
				       st.last_peer_id[0], st.last_peer_id[1],
				       st.last_peer_id[2], st.last_peer_id[3],
				       st.rx_peer, st.last_peer_rssi);
			}
			printk(" | %s\n", g_last_pass ? "PASS" : "FAIL");
		}
	}
	return 0;
}
