/*
 * Minimal W5500 register driver for the factory test.
 * Same SPI framing and register map as GATEWAY/pixel-gateway/src/w5500.c.
 */
#ifndef W5500_H
#define W5500_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

bool w5500_has_reset_pin(void);
bool w5500_has_int_pin(void);

/* Hardware (or software) reset, then return VERSIONR. <0 on bus error. */
int w5500_reset_and_version(void);

/* Write patterns to scratch registers and a socket buffer, read them back.
 * Returns number of mismatched bytes (0 = pass), <0 on bus error. */
int w5500_spi_integrity(void);

/* Program MAC (derived from SoC device ID), IP, mask, gateway. */
int w5500_configure(const uint8_t mac[6], const uint8_t ip[4],
		    const uint8_t mask[4], const uint8_t gw[4]);

uint8_t w5500_phycfgr(void);

/* INT pin test: arm an interrupt, provoke it with a UDP broadcast, check INTn
 * goes low, clear it, check INTn goes high again.
 * Returns 0 pass, -EIO INT never asserted, -EBUSY INT never released,
 * -ENOTSUP no int-gpios in devicetree. */
int w5500_int_test(void);

/* Send one UDP broadcast datagram from socket 1 (used by the INT test and
 * visible in Wireshark as a "hello" from the unit). */
int w5500_udp_broadcast(const uint8_t *buf, size_t len, uint16_t port);

#endif
