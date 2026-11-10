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
#include <zephyr/shell/shell_dummy.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/sys/printk.h>
#include <zephyr/logging/log.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "link.h"
#include "status.h"
#include "link_cfg.h"
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

static char g_gw_name[LINK_NAME_MAX + 1];

/*
 * Console mirror budget — a token bucket refilled once a second.
 *
 * The mirror exists so a human on USB sees exactly what the server sees, and
 * that is worth a lot when the two disagree. It is worth nothing at all if
 * printk() blocking on a full 115200 UART stalls the radio receive thread and
 * the gateway starts dropping frames, because then the human is watching an
 * artefact of their own console.
 *
 * So the mirror is best-effort and the LINK is not: the server receives every
 * line regardless. Only the local view degrades, and it says so rather than
 * quietly thinning out.
 */
static uint32_t g_mirror_sec;
static uint16_t g_mirror_budget;
static uint32_t g_mirror_dropped;
static int32_t  g_mirror_limit = GW_MIRROR_MAX_LPS;   /* <0 disables mirroring */

void gw_mirror_limit(int32_t lines_per_sec)
{
	g_mirror_limit = lines_per_sec;
}

/* Returns true if this line may go to the console. */
static bool mirror_allowed(void)
{
	if (g_mirror_limit < 0) {
		return false;
	}

	uint32_t sec = k_uptime_get_32() / 1000u;

	if (sec != g_mirror_sec) {
		if (g_mirror_dropped) {
			/* One line a second, itself inside the budget, so the
			 * warning can never become the flood it is warning
			 * about. */
			printk("... %u console lines dropped (budget %d/s; "
			       "the server still has them all)\n",
			       g_mirror_dropped, g_mirror_limit);
		}
		g_mirror_sec = sec;
		g_mirror_budget = (uint16_t)g_mirror_limit;
		g_mirror_dropped = 0;
	}

	if (g_mirror_budget == 0) {
		g_mirror_dropped++;
		return false;
	}
	g_mirror_budget--;
	return true;
}

bool link_up(void)
{
	return atomic_get(&g_up) != 0;
}

/* ---- outbound ----------------------------------------------------------- */

/* Lines discarded to make room, and when we last said so. */
static uint32_t g_txq_dropped;
static uint32_t g_txq_warn_sec;

/*
 * Discard exactly one whole line from the front of the queue.
 *
 * THIS MUST NOT DROP PARTIAL LINES.
 *
 * The queue is a byte ring, and the obvious implementation — discard N oldest
 * bytes until the new line fits — silently destroys framing: it cuts a line
 * in half, so the receiver gets the tail of one line immediately followed by
 * the head of the next with no newline between them. The server then keeps
 * accumulating, finds no newline within MAX_LINE (4096), concludes it is not
 * talking to a gateway, and drops the connection with "line too long". The
 * gateway reconnects, and every command sent during the gap is lost.
 *
 * That failure looks like three unrelated problems — commands arriving late,
 * the gateway flickering between healthy and stale, and occasional missing
 * telemetry — and it is one bug. It only appears under sustained load, which
 * is exactly when nobody wants to be debugging it.
 *
 * Whole lines in, whole lines out. Returns bytes discarded.
 */
static uint32_t drop_oldest_line(void)
{
	uint32_t total = 0;

	for (;;) {
		uint8_t *data;
		uint32_t n = ring_buf_get_claim(&txq, &data, GW_TXQ_BYTES);

		if (n == 0) {
			ring_buf_get_finish(&txq, 0);
			return total;           /* ring empty */
		}

		uint32_t take = n;
		bool found = false;

		for (uint32_t i = 0; i < n; i++) {
			if (data[i] == '\n') {
				take = i + 1;
				found = true;
				break;
			}
		}
		ring_buf_get_finish(&txq, take);
		total += take;

		if (found) {
			return total;
		}
		/* claim stopped at the ring wrap; continue into the rest. */
	}
}

static void txq_put(const char *s, size_t len)
{
	k_mutex_lock(&txq_lock, K_FOREVER);

	/*
	 * If the queue is full the link is down or the server has stopped
	 * reading. Drop the OLDEST lines, not the newest: current presence is
	 * worth more than a backlog of stale beacons, and dropping the new
	 * line would mean the first thing the server sees after a stall is
	 * already out of date.
	 */
	while (ring_buf_space_get(&txq) < len) {
		if (drop_oldest_line() == 0) {
			break;                  /* nothing left to give */
		}
		g_txq_dropped++;
	}

	ring_buf_put(&txq, (const uint8_t *)s, len);

	/* Say so, at most once a second, so shedding is never silent. */
	uint32_t sec = k_uptime_get_32() / 1000u;

	if (g_txq_dropped && sec != g_txq_warn_sec) {
		g_txq_warn_sec = sec;
		LOG_WRN("uplink saturated: %u telemetry line(s) dropped",
			g_txq_dropped);
		g_txq_dropped = 0;
	}

	k_mutex_unlock(&txq_lock);
}

/*
 * Formatting scratch. STATIC, not on the stack, and that is not a style
 * choice.
 *
 * gw_emit() is called from net_recv_data(), which the 802.15.4 driver invokes
 * on its own nrf5_rx thread — a driver thread sized for a driver's needs, not
 * for a 256-byte buffer plus a vsnprintk frame. A local array here overflows
 * that stack on the first frame received and halts the CPU, which presents as
 * the gateway dying the instant a device comes into range.
 *
 * line_lock already serialises this function, so one shared buffer is safe.
 */
static char g_chunk[GW_LINE_MAX];

void gw_emit(const char *fmt, ...)
{
	va_list ap;

	k_mutex_lock(&line_lock, K_FOREVER);

	va_start(ap, fmt);
	int n = vsnprintk(g_chunk, sizeof(g_chunk), fmt, ap);
	va_end(ap);

	if (n <= 0) {
		k_mutex_unlock(&line_lock);
		return;
	}
	if (n >= (int)sizeof(g_chunk)) {
		n = sizeof(g_chunk) - 1;
	}

	/* Mirror to the local console so a human on USB still sees telemetry
	 * when the link is down — which is exactly when they will be looking.
	 * Budgeted, because at fleet scale this UART is an order of magnitude
	 * slower than the radio, and printk() backpressure here stalls the
	 * receive thread and drops frames. The LINK is never throttled. */
	if (mirror_allowed()) {
		printk("%s", g_chunk);
	}

	for (int i = 0; i < n; i++) {
		char c = g_chunk[i];

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

/*
 * Send at most this many chunks before returning, so the caller can service
 * receive.
 *
 * drain_txq() used to loop until the ring was empty. That is fine at a few
 * hundred bytes a second and actively harmful at fleet scale: the radio
 * receive thread runs at a HIGHER priority than this one and refills the ring
 * faster than the W5500 empties it, so the loop rarely terminates — and
 * pump_rx(), where inbound commands are read, only runs after it does.
 * Downlink latency then scales with uplink backlog, which is precisely
 * backwards. A command sent while 1,300 telemetry lines a second are flowing
 * would sit behind all of them.
 *
 * 32 chunks is 8 kB, comfortably more than one pass of telemetry, so under
 * normal load the behaviour is unchanged.
 */
#define DRAIN_MAX_CHUNKS 32

static int drain_txq(void)
{
	uint8_t buf[256];

	for (int chunk = 0; chunk < DRAIN_MAX_CHUNKS; chunk++) {
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
	return 0;
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
	 * Anything else is a gateway shell command.
	 *
	 * Run it on the DUMMY backend, not the interactive one, and never pass
	 * NULL: shell_execute_cmd(NULL, ...) returns -EINVAL without executing
	 * anything unless CONFIG_SHELL_BACKEND_DUMMY is set, which is a silent
	 * and very convincing way to make every downlink command look like a
	 * bad argument list.
	 *
	 * The dummy backend also keeps network commands off the UART shell's
	 * state, so a human typing at the console during a show cannot collide
	 * with a command arriving from the server.
	 *
	 * Output is captured and logged rather than returned to the server. The
	 * server learns what actually happened from the next round of beacons,
	 * which carry the CMD seq each device applied — a better acknowledgement
	 * than the gateway saying "I sent it".
	 */
	const struct shell *sh = shell_backend_dummy_get_ptr();

	if (sh == NULL) {
		LOG_ERR("no dummy shell backend — CONFIG_SHELL_BACKEND_DUMMY?");
		return;
	}

	shell_backend_dummy_clear_output(sh);

	int err = shell_execute_cmd(sh, line);

	size_t out_len = 0;
	const char *out = shell_backend_dummy_get_output(sh, &out_len);

	if (err) {
		LOG_WRN("'%s' -> %d", line, err);
	}
	if (out && out_len > 0) {
		LOG_INF("%s", out);
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

	const struct link_cfg *cfg = link_cfg();
	char mask[16], router[16], server[16];

	strncpy(g_gw_name, link_cfg_name(), sizeof(g_gw_name) - 1);
	link_cfg_ip_str(cfg->ip, ip, sizeof(ip));
	link_cfg_ip_str(cfg->mask, mask, sizeof(mask));
	link_cfg_ip_str(cfg->router, router, sizeof(router));
	link_cfg_ip_str(cfg->server, server, sizeof(server));
	const uint16_t server_port = cfg->server_port;
	const uint16_t local_port = 50000 + cfg->index;

	status_set(STATUS_BOOT);
	while (w5500_init(ip, mask, router) < 0) {
		status_set(STATUS_FAULT);
		LOG_ERR("W5500 init failed; retrying in 5 s");
		k_msleep(5000);
	}

	for (;;) {
		atomic_set(&g_up, 0);

		if (!w5500_link_up()) {
			status_set(STATUS_NO_ETH);
			LOG_WRN("no Ethernet link — check the cable");
			while (!w5500_link_up()) {
				k_msleep(500);
			}
			LOG_INF("Ethernet link up");
		}

		status_set(STATUS_NO_SERVER);
		LOG_INF("connecting to %s:%d as %s",
			server, server_port, g_gw_name);
		w5500_connect(server, server_port, local_port);

		/* Bounded handshake window rather than blocking forever on a
		 * server that is not up yet. */
		int waited = 0;

		while (w5500_state() == W5500_CONNECTING && waited < 5000) {
			k_msleep(50);
			waited += 50;
		}

		if (w5500_state() != W5500_ESTABLISHED) {
			uint8_t sr = 0, ir = 0;

			w5500_diag(&sr, &ir);

			/*
			 * Say WHICH failure this is. The two look identical in
			 * a log that only says "connect failed", and they send
			 * you to opposite ends of the system.
			 */
			if (ir & 0x08) {          /* Sn_IR TIMEOUT */
				LOG_WRN("no answer from %s:%d — check the "
					"server's IP and that it is on this "
					"subnet (SR=0x%02X IR=0x%02X)",
					server, server_port, sr, ir);
			} else {
				LOG_WRN("%s:%d refused the connection — host "
					"is reachable but nothing is listening "
					"on that port (SR=0x%02X IR=0x%02X)",
					server, server_port, sr, ir);
			}
			w5500_close();
			LOG_WRN("retry in %u ms", backoff);
			k_msleep(backoff);
			backoff = MIN(backoff * 2, GW_RECONNECT_MAX_MS);
			continue;
		}

		/* HELLO first on every connect. Until it arrives the server can
		 * only identify us by IP and its console shows '(no HELLO)'. */
		char hello[64];

		snprintk(hello, sizeof(hello), "HELLO gw=%s fw=%s proto=2\n",
			 g_gw_name, GW_FW_VERSION);
		if (send_now(hello) < 0) {
			w5500_close();
			continue;
		}

		LOG_INF("link established");
		status_set(STATUS_ONLINE);
		atomic_set(&g_up, 1);
		backoff = GW_RECONNECT_MIN_MS;

		int64_t last_tx = k_uptime_get();

		while (w5500_state() == W5500_ESTABLISHED) {
			/*
			 * RECEIVE FIRST.
			 *
			 * A command the server sent should be acted on now, not
			 * after however much telemetry happens to be queued.
			 * Under load the two orderings differ by hundreds of
			 * milliseconds, and the visible symptom is a fleet that
			 * changes colour late — or looks like it missed the
			 * command entirely.
			 */
			pump_rx();

			if (drain_txq() < 0) {
				break;
			}

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
		status_set(STATUS_NO_SERVER);
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
