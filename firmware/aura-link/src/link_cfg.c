/*
 * Aura Link network configuration, set over USB and kept across reboots.
 *
 * One firmware image for every Link. What used to be compiled in per unit
 * (gw01.conf .. gw30.conf) is now four settings, typed once at the USB
 * console and stored in the SoC's non-volatile memory:
 *
 *   link config                          show current + saved values
 *   link set name <name>                 how this Link appears in Aura Server
 *   link set index <1-30>                downlink stagger slot (and gw-NN if unnamed)
 *   link set ip <ip> [mask] [router]     this Link's static address
 *   link set server <ip> [port]          where Aura Server is listening
 *   link save                            write to NVM
 *   link reboot                          apply
 *   link defaults                        forget everything saved
 *
 * Nothing applies until reboot, deliberately. Changing the address under a
 * live TCP connection would need the link thread to tear down and rebuild,
 * and the one time it matters is on a bench with a USB cable attached, where
 * a two-second reboot costs nothing and is obviously correct.
 *
 * Defaults are the old compiled-in behaviour: index from CONFIG_GW_INDEX,
 * 10.10.0.(10+index)/24, server 10.10.0.1:9000. A Link that has never been
 * configured therefore still works on the original dedicated-subnet setup.
 *
 * These commands are also reachable from Aura Server, because downlink IS the
 * shell. Be careful doing that: set a wrong server address remotely and the
 * Link can only be recovered over USB.
 */

#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/logging/log.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gw_config.h"
#include "link_cfg.h"

LOG_MODULE_REGISTER(link_cfg, CONFIG_LOG_DEFAULT_LEVEL);

static struct link_cfg g_cfg;        /* what this boot is running with */
static struct link_cfg g_pending;    /* edits, until save */
static bool g_loaded_from_nvm;

static void defaults(struct link_cfg *c)
{
	memset(c, 0, sizeof(*c));
	c->index = GW_INDEX;
	c->ip[0] = 10; c->ip[1] = 10; c->ip[2] = 0; c->ip[3] = (uint8_t)(GW_IP_BASE + GW_INDEX);
	c->mask[0] = 255; c->mask[1] = 255; c->mask[2] = 255; c->mask[3] = 0;
	c->router[0] = 10; c->router[1] = 10; c->router[2] = 0; c->router[3] = 254;
	c->server[0] = 10; c->server[1] = 10; c->server[2] = 0; c->server[3] = 1;
	c->server_port = GW_SERVER_PORT;
	c->version = LINK_CFG_VERSION;
}

/* ---- settings backend ---------------------------------------------------- */

static int cfg_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	if (strcmp(name, "net") != 0) {
		return -ENOENT;
	}
	struct link_cfg tmp;

	if (len != sizeof(tmp)) {
		LOG_WRN("saved config is a different size (%u, expected %u) — ignoring",
			(unsigned)len, (unsigned)sizeof(tmp));
		return 0;
	}
	if (read_cb(cb_arg, &tmp, sizeof(tmp)) != sizeof(tmp) || tmp.version != LINK_CFG_VERSION) {
		LOG_WRN("saved config unreadable or old version — using defaults");
		return 0;
	}
	g_cfg = tmp;
	g_loaded_from_nvm = true;
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(link, "link", NULL, cfg_set, NULL, NULL);

int link_cfg_init(void)
{
	defaults(&g_cfg);
	int err = settings_subsys_init();

	if (err) {
		LOG_ERR("settings init failed (%d) — running on defaults", err);
	} else {
		settings_load_subtree("link");
	}
	g_pending = g_cfg;
	return err;
}

const struct link_cfg *link_cfg(void) { return &g_cfg; }

const char *link_cfg_name(void)
{
	static char fallback[8];

	if (g_cfg.name[0]) {
		return g_cfg.name;
	}
	snprintk(fallback, sizeof(fallback), "gw-%02u", g_cfg.index);
	return fallback;
}

void link_cfg_ip_str(const uint8_t a[4], char *out, size_t n)
{
	snprintk(out, n, "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
}

/* ---- shell ---------------------------------------------------------------- */

static int parse_ip(const char *s, uint8_t out[4])
{
	unsigned a, b, c, d;
	char tail;

	if (sscanf(s, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4 ||
	    a > 255 || b > 255 || c > 255 || d > 255) {
		return -EINVAL;
	}
	out[0] = a; out[1] = b; out[2] = c; out[3] = d;
	return 0;
}

static void show(const struct shell *sh, const char *title, const struct link_cfg *c)
{
	char ip[16], mask[16], rt[16], srv[16];

	link_cfg_ip_str(c->ip, ip, sizeof(ip));
	link_cfg_ip_str(c->mask, mask, sizeof(mask));
	link_cfg_ip_str(c->router, rt, sizeof(rt));
	link_cfg_ip_str(c->server, srv, sizeof(srv));
	shell_print(sh, "%s", title);
	if (c->name[0]) {
		shell_print(sh, "  name    %s  (index %u)", c->name, c->index);
	} else {
		shell_print(sh, "  name    gw-%02u  (unnamed; index %u)", c->index, c->index);
	}
	shell_print(sh, "  ip      %s  mask %s  router %s", ip, mask, rt);
	shell_print(sh, "  server  %s:%u", srv, c->server_port);
}

static int c_config(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	show(sh, g_loaded_from_nvm ? "Running (from saved config):" : "Running (defaults — nothing saved):", &g_cfg);
	if (memcmp(&g_pending, &g_cfg, sizeof(g_cfg)) != 0) {
		show(sh, "Pending (not yet saved — 'link save' then 'link reboot'):", &g_pending);
	}
	return 0;
}

static int c_index(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	long n = strtol(argv[1], NULL, 10);

	if (n < 1 || n > 30) {
		shell_error(sh, "index must be 1-30");
		return -EINVAL;
	}
	g_pending.index = (uint8_t)n;
	shell_print(sh, "name will be gw-%02ld", n);
	return 0;
}

/*
 * The name travels in HELLO as `gw=<name>` and becomes the zone id in the
 * API, so it is restricted to characters that survive both: no spaces,
 * nothing a URL or the line protocol would need escaping for. A pretty
 * display name ("Bar — north door") is set in the Aura Server console.
 */
static int c_name(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	const char *n = argv[1];
	size_t len = strlen(n);

	if (strcmp(n, "-") == 0) {
		g_pending.name[0] = '\0';
		shell_print(sh, "name cleared; will be gw-%02u", g_pending.index);
		return 0;
	}
	if (len == 0 || len > LINK_NAME_MAX) {
		shell_error(sh, "name must be 1-%d characters", LINK_NAME_MAX);
		return -EINVAL;
	}
	for (size_t i = 0; i < len; i++) {
		char c = n[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '-' || c == '_')) {
			shell_error(sh, "name may use letters, digits, - and _ only (e.g. bar-north)");
			return -EINVAL;
		}
	}
	memcpy(g_pending.name, n, len + 1);
	shell_print(sh, "name will be %s", g_pending.name);
	return 0;
}

static int c_ip(const struct shell *sh, size_t argc, char **argv)
{
	struct link_cfg c = g_pending;

	if (parse_ip(argv[1], c.ip) ||
	    (argc > 2 && parse_ip(argv[2], c.mask)) ||
	    (argc > 3 && parse_ip(argv[3], c.router))) {
		shell_error(sh, "usage: link set ip <a.b.c.d> [mask] [router]");
		return -EINVAL;
	}
	/* If only the address was given, assume a /24 with the router at .1 —
	 * right for almost every office or home network, and what someone typing
	 * one argument expects. Say so, so it is not a surprise. */
	if (argc == 2) {
		c.mask[0] = 255; c.mask[1] = 255; c.mask[2] = 255; c.mask[3] = 0;
		memcpy(c.router, c.ip, 3); c.router[3] = 1;
		shell_print(sh, "assuming mask 255.255.255.0, router %u.%u.%u.1",
			    c.ip[0], c.ip[1], c.ip[2]);
	}
	g_pending = c;
	return 0;
}

static int c_server(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t s[4];

	if (parse_ip(argv[1], s)) {
		shell_error(sh, "usage: link set server <a.b.c.d> [port]");
		return -EINVAL;
	}
	memcpy(g_pending.server, s, 4);
	if (argc > 2) {
		long p = strtol(argv[2], NULL, 10);

		if (p < 1 || p > 65535) {
			shell_error(sh, "port must be 1-65535");
			return -EINVAL;
		}
		g_pending.server_port = (uint16_t)p;
	}
	return 0;
}

static int c_save(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	/* Same-subnet check: the most common mistake, and silent otherwise —
	 * the Link would sit amber forever trying to reach a server it can only
	 * get to through a router that may not exist. Warn, don't refuse:
	 * routed setups are legitimate. */
	bool same = true;

	for (int i = 0; i < 4; i++) {
		if ((g_pending.ip[i] & g_pending.mask[i]) != (g_pending.server[i] & g_pending.mask[i])) {
			same = false;
		}
	}
	if (!same) {
		shell_warn(sh, "note: server is not on this Link's subnet — it will be reached via the router");
	}

	g_pending.version = LINK_CFG_VERSION;
	int err = settings_save_one("link/net", &g_pending, sizeof(g_pending));

	if (err) {
		shell_error(sh, "save failed (%d)", err);
		return err;
	}
	shell_print(sh, "saved. 'link reboot' to apply.");
	return 0;
}

static int c_defaults(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	int err = settings_delete("link/net");

	defaults(&g_pending);
	shell_print(sh, err ? "nothing was saved; pending reset to defaults"
			    : "saved config erased. 'link reboot' to apply defaults.");
	return 0;
}

static int c_reboot(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc); ARG_UNUSED(argv);
	shell_print(sh, "rebooting…");
	k_msleep(100);               /* let the line reach the terminal */
	sys_reboot(SYS_REBOOT_COLD);
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(link_set_cmds,
	SHELL_CMD_ARG(name,   NULL, "<name> e.g. bar-north ('-' to clear)", c_name, 2, 0),
	SHELL_CMD_ARG(index,  NULL, "<1-30> downlink stagger slot; gw-NN if unnamed", c_index, 2, 0),
	SHELL_CMD_ARG(ip,     NULL, "<ip> [mask] [router] this Link's address", c_ip, 2, 2),
	SHELL_CMD_ARG(server, NULL, "<ip> [port] where Aura Server listens (default port 9000)", c_server, 2, 1),
	SHELL_SUBCMD_SET_END
);

/* Registered under `link` alongside `locate` (status.c). */
SHELL_SUBCMD_ADD((link), config,   NULL, "show running and pending network config", c_config, 1, 0);
SHELL_SUBCMD_ADD((link), set,      &link_set_cmds, "change config (then save + reboot)", NULL, 1, 0);
SHELL_SUBCMD_ADD((link), save,     NULL, "write pending config to NVM", c_save, 1, 0);
SHELL_SUBCMD_ADD((link), defaults, NULL, "erase saved config", c_defaults, 1, 0);
SHELL_SUBCMD_ADD((link), reboot,   NULL, "restart to apply saved config", c_reboot, 1, 0);
