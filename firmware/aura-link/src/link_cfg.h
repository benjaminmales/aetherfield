/* Aura Link network configuration — set over USB, kept in NVM. See link_cfg.c. */
#ifndef LINK_CFG_H
#define LINK_CFG_H

#include <stdint.h>
#include <stddef.h>

#define LINK_CFG_VERSION 1
#define LINK_NAME_MAX    20

struct link_cfg {
	uint8_t  version;
	uint8_t  index;        /* 1..30: name gw-NN, stagger slot, local port */
	uint8_t  ip[4];
	uint8_t  mask[4];
	uint8_t  router[4];
	uint8_t  server[4];
	uint16_t server_port;
	char     name[LINK_NAME_MAX + 1]; /* "" = use gw-NN */
};

/* Load saved config (or defaults). Call once, before the link thread starts. */
int link_cfg_init(void);

/* The config this boot is running with. Never changes until reboot. */
const struct link_cfg *link_cfg(void);

/* The id this Link announces in HELLO: its name, or gw-NN if unnamed. */
const char *link_cfg_name(void);

void link_cfg_ip_str(const uint8_t a[4], char *out, size_t n);

#endif
