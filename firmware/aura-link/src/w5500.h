/*
 * WIZnet W5500 driven through its on-chip TCP/IP stack.
 *
 * The W5500 does TCP in silicon across eight hardware sockets. We use one, as
 * a client, and never touch Zephyr's networking subsystem — which is the whole
 * point: the 802.15.4 receive path owns net_recv_data(), and Zephyr's Ethernet
 * driver would need the same symbol.
 *
 * Everything here is synchronous SPI register work. No threads, no callbacks.
 */
#ifndef W5500_H
#define W5500_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Reset the chip, verify it, and program MAC/IP/mask/router.
 * ip/mask/router are dotted-quad strings. Returns 0 or negative errno. */
int w5500_init(const char *ip, const char *mask, const char *router);

/* PHY link state, straight from PHYCFGR. */
bool w5500_link_up(void);

/* Open socket 0 and start a TCP connect. Non-blocking: poll w5500_state(). */
int w5500_connect(const char *server_ip, uint16_t server_port,
		  uint16_t local_port);

enum w5500_state {
	W5500_CLOSED = 0,
	W5500_CONNECTING,
	W5500_ESTABLISHED,
};

enum w5500_state w5500_state(void);

/* Send. Returns bytes accepted (may be < len if the TX buffer is full),
 * or negative errno. */
int w5500_send(const uint8_t *buf, size_t len);

/* Receive whatever is waiting. Returns bytes read, 0 if none, or negative. */
int w5500_recv(uint8_t *buf, size_t max);

void w5500_close(void);

/*
 * Raw socket status and interrupt registers, for diagnosing a failed connect.
 * Sn_IR bit 3 (TIMEOUT) set means nobody answered — wrong address, wrong
 * subnet, or nothing on the wire. TIMEOUT clear with the socket closed means
 * the host is there and refused the port, which is a very different problem.
 */
void w5500_diag(uint8_t *sr, uint8_t *ir);

#endif /* W5500_H */
