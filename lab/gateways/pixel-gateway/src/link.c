/*
 * Server link. See link.h.
 *
 * One thread owns the socket and does everything on it, so there is no locking
 * around the W5500 beyond the outbound ring buffer. Telemetry producers (the
 * radio receive path, the shell) only ever push bytes into that ring.
 *
 * Inbound lines are handed to the Zephyr shell with shell_execute_cmd(). That
 * is deliberate and it is the reason this file is short: every command the
 * server can send — 'aura cmd ...', 'aura op ...', 'aura identify ...' — is
 * already implemented as a shell command in main.c, tested from the console,
 * and now reachable from the network with no duplicate parser to drift.
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/sys/printk.h>
#include <zephyr/logging/log.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "link.h"
#include "w5500.h"
#include "gw_config.h"

LOG_MODULE_REGISTER(link, CONFIG_LOG_DEFAULT_LEVEL);

#define STACK_SIZE 3072
#define PRIORITY   6

static K_THREAD_STACK_DEFINE(link_stack, STACK_SIZE);
static struct k_thread link_thread_data;

RING_BUF_DECLARE(txq, GW_TXQ_BYTES);
static K_MUTEX_DEFINE(txq_lock);

static atomic_t g_up = ATOMIC_INIT(0);

/* Assembled-but-unsent partial line from gw_emit(). */
static char   g_line[GW_LINE_MAX];
static size_t g_line_len;
static K_MUTEX_DEFINE(line_lock);

static char g_gw_name[16];

bool link_up(void)
{
	return atomic_get(&g_up) != 0;
}

/* ---- outbound ----------------------------------------------------------- */

static void txq_put(const char *s, size_t len)
{
	k_mutex_lock(&txq_lock, K_FOREVER);

	/*
	 * If the queue is full the link is down or the server has stopped
	 * reading. Drop the OLDEST data, not the newest: current presence is
	 * worth more than a backlog of stale beacons, and dropping the new
	 * line would mean the first thing the server sees after a stall is
	 * already out of date.
	 */
	uint32_t space = ring_buf_space_get(&txq);

	if (space < len) {
		uint8_t scratch[128];
		uint32_t need = len - space;

		while (need > 0) {
			uint32_t n = MIN(need, sizeof(scratch));
			uint32_t got = ring_buf_get(&txq, scratch, n);

			if (got == 0) {
				break;
			}
			need -= got;
		}
	}
	ring_buf_put(&txq, (const uint8_t *)s, len);
	k_mutex_unlock(&txq_lock);
}

void gw_emit(const char *fmt, ...)
{
	char chunk[GW_LINE_MAX];
	va_list ap;

	va_start(ap, fmt);
	int n = vsnprintk(chunk, sizeof(chunk), fmt, ap);
	va_end(ap);

	if (n <= 0) {
		return;
	}
	if (n >= (int)sizeof(chunk)) {
		n = sizeof(chunk) - 1;
	}

	/* Always mirror to the local console, unconditionally and first, so a
	 * human on USB still sees telemetry when the link is down — which is
	 * exactly when they will be looking. */
	printk("%s", chunk);

	k_mutex_lock(&line_lock, K_FOREVER);
	for (int i = 0; i < n; i++) {
		char c = chunk[i];

		if (g_line_len < sizeof(g_line) - 1) {
			g_line[g_line_len++] = c;
		}
		if (c == '\n') {
			txq_put(g_line, g_line_len);
			g_line_len = 0;
		}
	}
	k_mutex_unlock(&line_lock);
}

/* Send a control line immediately, bypassing the queue's drop policy. */
static int send_now(const char *s)
{
	size_t len = strlen(s);
	size_t sent = 0;

	while (sent < len) {
		int n = w5500_send((const uint8_t *)s + sent, len - sent);

		if (n < 0) {
			return n;
		}
		if (n == 0) {
			k_msleep(2);
			continue;
		}
		sent += n;
	}
	return 0;
}

static int drain_txq(void)
{
	uint8_t buf[256];

	for (;;) {
		k_mutex_lock(&txq_lock, K_FOREVER);
		uint32_t n = ring_buf_get(&txq, buf, sizeof(buf));
		k_mutex_unlock(&txq_lock);

		if (n == 0) {
			return 0;
		}

		uint32_t sent = 0;

		while (sent < n) {
			int w = w5500_send(buf + sent, n - sent);

			if (w < 0) {
				return w;
			}
			if (w == 0) {
				k_msleep(2);
				continue;
			}
			sent += w;
		}
	}
}

/* ---- inbound ------------------------------------------------------------ */

static void handle_line(char *line)
{
	/* Trim CR and trailing space so a line typed into a telnet session
	 * behaves the same as one from the server. */
	size_t len = strlen(line);

	while (len && (line[len - 1] == '\r' || line[len - 1] == ' ')) {
		line[--len] = '\0';
	}
	if (len == 0) {
		return;
	}

	if (strcmp(line, "PING") == 0) {
		send_now("PONG\n");
		return;
	}
	if (strcmp(line, "PONG") == 0) {
		return;
	}

	/*
	 * Anything else is a gateway shell command. Its output goes to the
	 * console rather than back down the socket — the server learns what
	 * happened from the next round of beacons, which carry the CMD seq
	 * each device actually applied. That is a better acknowledgement than
	 * the gateway saying "I sent it".
	 */
	int err = shell_execute_cmd(NULL, line);

	if (err) {
		LOG_WRN("server sent '%s' -> %d", line, err);
	}
}

static void pump_rx(void)
{
	static char acc[GW_LINE_MAX];
	static size_t acc_len;
	uint8_t buf[256];

	for (;;) {
		int n = w5500_recv(buf, sizeof(buf));

		if (n <= 0) {
			return;
		}
		for (int i = 0; i < n; i++) {
			char c = (char)buf[i];

			if (c == '\n') {
				acc[acc_len] = '\0';
				handle_line(acc);
				acc_len = 0;
			} else if (acc_len < sizeof(acc) - 1) {
				acc[acc_len++] = c;
			} else {
				/* Over-long line. The protocol says the server
				 * drops a connection that sends one; we just
				 * discard and resynchronise at the next newline
				 * rather than tearing down a link mid-show over
				 * one bad line. */
				acc_len = 0;
			}
		}
	}
}

/* ---- thread ------------------------------------------------------------- */

static void link_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	char ip[16];
	uint32_t backoff = GW_RECONNECT_MIN_MS;

	snprintk(g_gw_name, sizeof(g_gw_name), "gw-%02d", GW_INDEX);
	snprintk(ip, sizeof(ip), "%s%d", GW_IP_PREFIX, GW_IP_BASE + GW_INDEX);

	while (w5500_init(ip, GW_NETMASK, GW_ROUTER) < 0) {
		LOG_ERR("W5500 init failed; retrying in 5 s");
		k_msleep(5000);
	}

	for (;;) {
		atomic_set(&g_up, 0);

		if (!w5500_link_up()) {
			LOG_WRN("no Ethernet link — check the cable");
			while (!w5500_link_up()) {
				k_msleep(500);
			}
			LOG_INF("Ethernet link up");
		}

		LOG_INF("connecting to %s:%d as %s",
			GW_SERVER_IP, GW_SERVER_PORT, g_gw_name);
		w5500_connect(GW_SERVER_IP, GW_SERVER_PORT, GW_LOCAL_PORT);

		/* Bounded handshake window rather than blocking forever on a
		 * server that is not up yet. */
		int waited = 0;

		while (w5500_state() == W5500_CONNECTING && waited < 5000) {
			k_msleep(50);
			waited += 50;
		}

		if (w5500_state() != W5500_ESTABLISHED) {
			w5500_close();
			LOG_WRN("connect failed; retry in %u ms", backoff);
			k_msleep(backoff);
			backoff = MIN(backoff * 2, GW_RECONNECT_MAX_MS);
			continue;
		}

		/* HELLO first on every connect. Until it arrives the server can
		 * only identify us by IP and its console shows '(no HELLO)'. */
		char hello[64];

		snprintk(hello, sizeof(hello), "HELLO gw=%s fw=%s proto=2\n",
			 g_gw_name, "1.0.0");
		if (send_now(hello) < 0) {
			w5500_close();
			continue;
		}

		LOG_INF("link established");
		atomic_set(&g_up, 1);
		backoff = GW_RECONNECT_MIN_MS;

		int64_t last_tx = k_uptime_get();

		while (w5500_state() == W5500_ESTABLISHED) {
			if (drain_txq() < 0) {
				break;
			}
			pump_rx();

			if (!ring_buf_is_empty(&txq)) {
				last_tx = k_uptime_get();
			} else if (k_uptime_get() - last_tx >
				   GW_PING_INTERVAL_MS) {
				if (send_now("PING\n") < 0) {
					break;
				}
				last_tx = k_uptime_get();
			}
			k_msleep(5);
		}

		atomic_set(&g_up, 0);
		LOG_WRN("link lost; reconnecting");
		w5500_close();
		k_msleep(backoff);
		backoff = MIN(backoff * 2, GW_RECONNECT_MAX_MS);
	}
}

int link_init(void)
{
	k_thread_create(&link_thread_data, link_stack, STACK_SIZE,
			link_thread, NULL, NULL, NULL,
			PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&link_thread_data, "gwlink");
	return 0;
}
