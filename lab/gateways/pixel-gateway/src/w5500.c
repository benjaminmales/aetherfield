/*
 * W5500 hardware-TCP driver. See w5500.h for why this exists rather than
 * Zephyr's wiznet,w5500 Ethernet driver.
 *
 * SPI framing, from the datasheet: every transaction is
 *
 *   [addr_hi] [addr_lo] [control] [data...]
 *
 * where control is  (block << 3) | (write << 2) | operation_mode.
 * Operation mode 0 is variable-length data, which is what lets us keep the
 * chip select asserted for a burst of arbitrary size.
 *
 * Block numbers: 0 is the common register file; each socket n then has three
 * blocks — registers at n*4+1, TX buffer at n*4+2, RX buffer at n*4+3.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdlib.h>

#include "w5500.h"

LOG_MODULE_REGISTER(w5500, CONFIG_LOG_DEFAULT_LEVEL);

#define W5500_NODE DT_NODELABEL(w5500)

static const struct spi_dt_spec spi = SPI_DT_SPEC_GET(W5500_NODE,
	SPI_WORD_SET(8) | SPI_OP_MODE_MASTER | SPI_TRANSFER_MSB, 0);
static const struct gpio_dt_spec rst =
	GPIO_DT_SPEC_GET(W5500_NODE, reset_gpios);

/* ---- block selectors ---------------------------------------------------- */
#define BLK_COMMON        0x00
#define BLK_SOCK_REG(n)   ((n) * 4 + 1)
#define BLK_SOCK_TX(n)    ((n) * 4 + 2)
#define BLK_SOCK_RX(n)    ((n) * 4 + 3)

/* ---- common registers --------------------------------------------------- */
#define CR_MR             0x0000
#define CR_GAR            0x0001
#define CR_SUBR           0x0005
#define CR_SHAR           0x0009
#define CR_SIPR           0x000F
#define CR_PHYCFGR        0x002E
#define CR_VERSIONR       0x0039

#define MR_RST            0x80
#define PHYCFGR_LNK       0x01
#define W5500_VERSION     0x04

/* ---- socket registers --------------------------------------------------- */
#define SR_MR             0x0000
#define SR_CR             0x0001
#define SR_IR             0x0002
#define SR_SR             0x0003
#define SR_PORT           0x0004
#define SR_DIPR           0x000C
#define SR_DPORT          0x0010
#define SR_TX_FSR         0x0020
#define SR_TX_RD          0x0022
#define SR_TX_WR          0x0024
#define SR_RX_RSR         0x0026
#define SR_RX_RD          0x0028
#define SR_KPALVTR        0x002F

#define Sn_MR_TCP         0x01

#define Sn_CR_OPEN        0x01
#define Sn_CR_CONNECT     0x04
#define Sn_CR_DISCON      0x08
#define Sn_CR_CLOSE       0x10
#define Sn_CR_SEND        0x20
#define Sn_CR_RECV        0x40

#define Sn_SR_CLOSED      0x00
#define Sn_SR_INIT        0x13
#define Sn_SR_SYNSENT     0x15
#define Sn_SR_ESTABLISHED 0x17
#define Sn_SR_CLOSE_WAIT  0x1C

#define Sn_IR_SEND_OK     0x10
#define Sn_IR_TIMEOUT     0x08
#define Sn_IR_DISCON      0x02

#define SOCK 0    /* we use socket 0 and only socket 0 */

/* ---- raw register access ------------------------------------------------ */

static int xfer(uint16_t addr, uint8_t block, bool write,
		const uint8_t *out, uint8_t *in, size_t len)
{
	uint8_t hdr[3] = {
		(uint8_t)(addr >> 8),
		(uint8_t)(addr & 0xFF),
		(uint8_t)((block << 3) | (write ? 0x04 : 0x00)),
	};

	struct spi_buf tx_bufs[2] = {
		{ .buf = hdr, .len = sizeof(hdr) },
		{ .buf = (void *)out, .len = len },
	};
	const struct spi_buf_set tx = {
		.buffers = tx_bufs,
		.count = write ? 2 : 1,
	};

	if (write) {
		return spi_write_dt(&spi, &tx);
	}

	/* Read: clock out the header, discard those three bytes, then take
	 * len bytes back. The rx set must cover the header too or the driver
	 * will start capturing from the wrong offset. */
	uint8_t dump[3];
	struct spi_buf rx_bufs[2] = {
		{ .buf = dump, .len = sizeof(dump) },
		{ .buf = in,   .len = len },
	};
	const struct spi_buf_set rx = { .buffers = rx_bufs, .count = 2 };

	return spi_transceive_dt(&spi, &tx, &rx);
}

static uint8_t rd8(uint16_t addr, uint8_t block)
{
	uint8_t v = 0;

	xfer(addr, block, false, NULL, &v, 1);
	return v;
}

static void wr8(uint16_t addr, uint8_t block, uint8_t v)
{
	xfer(addr, block, true, &v, NULL, 1);
}

static void wrn(uint16_t addr, uint8_t block, const uint8_t *v, size_t n)
{
	xfer(addr, block, true, v, NULL, n);
}

/*
 * The 16-bit free/received-size registers are updated by the chip
 * asynchronously, so a single read can straddle an update and return a
 * value that was never true. The datasheet's remedy is to read until two
 * consecutive reads agree.
 */
static uint16_t rd16_stable(uint16_t addr, uint8_t block)
{
	uint8_t b[2];
	uint16_t prev, cur;

	xfer(addr, block, false, NULL, b, 2);
	prev = (uint16_t)((b[0] << 8) | b[1]);

	for (int i = 0; i < 8; i++) {
		xfer(addr, block, false, NULL, b, 2);
		cur = (uint16_t)((b[0] << 8) | b[1]);
		if (cur == prev) {
			return cur;
		}
		prev = cur;
	}
	return cur;
}

static void wr16(uint16_t addr, uint8_t block, uint16_t v)
{
	uint8_t b[2] = { (uint8_t)(v >> 8), (uint8_t)(v & 0xFF) };

	wrn(addr, block, b, 2);
}

/* Issue a socket command and wait for the chip to clear it. */
static void sock_cmd(uint8_t cmd)
{
	wr8(SR_CR, BLK_SOCK_REG(SOCK), cmd);
	for (int i = 0; i < 1000 && rd8(SR_CR, BLK_SOCK_REG(SOCK)); i++) {
		k_busy_wait(10);
	}
}

static uint8_t sock_status(void)
{
	return rd8(SR_SR, BLK_SOCK_REG(SOCK));
}

/* ---- address parsing ---------------------------------------------------- */

static int parse_ip(const char *s, uint8_t out[4])
{
	for (int i = 0; i < 4; i++) {
		char *end;
		long v = strtol(s, &end, 10);

		if (end == s || v < 0 || v > 255) {
			return -EINVAL;
		}
		out[i] = (uint8_t)v;
		s = (i < 3) ? end + 1 : end;
		if (i < 3 && *end != '.') {
			return -EINVAL;
		}
	}
	return 0;
}

/*
 * MAC from the SoC's factory device ID, with the locally-administered bit set
 * and the multicast bit cleared. Unique per unit with no provisioning step,
 * which matters when there are twenty of these in a venue.
 */
static void derive_mac(uint8_t mac[6])
{
	uint8_t id[16] = { 0 };
	ssize_t n = hwinfo_get_device_id(id, sizeof(id));

	if (n <= 0) {
		/* No hardware ID available. Fall back to something stable and
		 * obviously synthetic rather than a random MAC that changes on
		 * every boot and fills the switch's MAC table. */
		LOG_WRN("no hwinfo device id; using a fixed fallback MAC");
		id[0] = 0xAE; id[1] = 0x7F; id[2] = 0x00;
		id[3] = 0x00; id[4] = 0x00; n = 5;
	}

	mac[0] = 0x02;                       /* locally administered, unicast */
	for (int i = 1; i < 6; i++) {
		mac[i] = id[(n - i) % n];
	}
}

/* ---- public ------------------------------------------------------------- */

int w5500_init(const char *ip, const char *mask, const char *router)
{
	uint8_t v4[4], mac[6];
	int err;

	if (!spi_is_ready_dt(&spi)) {
		LOG_ERR("SPI not ready");
		return -ENODEV;
	}
	if (!gpio_is_ready_dt(&rst)) {
		LOG_ERR("reset GPIO not ready");
		return -ENODEV;
	}

	/* Hard reset. The datasheet wants RSTn low for at least 500 us and
	 * allows up to 50 ms before the chip answers; be generous, this
	 * happens once. */
	gpio_pin_configure_dt(&rst, GPIO_OUTPUT_ACTIVE);
	k_msleep(2);
	gpio_pin_set_dt(&rst, 0);
	k_msleep(100);

	/* Software reset on top, then confirm we are actually talking to a
	 * W5500 and not to an open bus. VERSIONR is a constant 0x04 — if this
	 * check fails, suspect wiring or chip select before anything else. */
	wr8(CR_MR, BLK_COMMON, MR_RST);
	k_msleep(10);

	uint8_t ver = rd8(CR_VERSIONR, BLK_COMMON);

	if (ver != W5500_VERSION) {
		LOG_ERR("VERSIONR=0x%02X, expected 0x%02X — check SPI wiring "
			"and that CS is on D0", ver, W5500_VERSION);
		return -ENODEV;
	}

	derive_mac(mac);
	wrn(CR_SHAR, BLK_COMMON, mac, 6);

	if ((err = parse_ip(ip, v4)) < 0) {
		return err;
	}
	wrn(CR_SIPR, BLK_COMMON, v4, 4);

	if ((err = parse_ip(mask, v4)) < 0) {
		return err;
	}
	wrn(CR_SUBR, BLK_COMMON, v4, 4);

	if ((err = parse_ip(router, v4)) < 0) {
		return err;
	}
	wrn(CR_GAR, BLK_COMMON, v4, 4);

	LOG_INF("W5500 up, MAC %02X:%02X:%02X:%02X:%02X:%02X, IP %s",
		mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], ip);
	return 0;
}

bool w5500_link_up(void)
{
	return (rd8(CR_PHYCFGR, BLK_COMMON) & PHYCFGR_LNK) != 0;
}

int w5500_connect(const char *server_ip, uint16_t server_port,
		  uint16_t local_port)
{
	uint8_t v4[4];
	int err = parse_ip(server_ip, v4);

	if (err < 0) {
		return err;
	}

	sock_cmd(Sn_CR_CLOSE);
	wr8(SR_MR, BLK_SOCK_REG(SOCK), Sn_MR_TCP);
	wr16(SR_PORT, BLK_SOCK_REG(SOCK), local_port);
	sock_cmd(Sn_CR_OPEN);

	if (sock_status() != Sn_SR_INIT) {
		LOG_ERR("socket would not open (SR=0x%02X)", sock_status());
		return -EIO;
	}

	/* TCP keepalive in hardware, 5 s units. Belt and braces alongside the
	 * application PING — this one survives a wedged application thread. */
	wr8(SR_KPALVTR, BLK_SOCK_REG(SOCK), 6);   /* 30 s */

	wrn(SR_DIPR, BLK_SOCK_REG(SOCK), v4, 4);
	wr16(SR_DPORT, BLK_SOCK_REG(SOCK), server_port);
	sock_cmd(Sn_CR_CONNECT);
	return 0;
}

enum w5500_state w5500_state(void)
{
	switch (sock_status()) {
	case Sn_SR_ESTABLISHED:
		return W5500_ESTABLISHED;
	case Sn_SR_INIT:
	case Sn_SR_SYNSENT:
		return W5500_CONNECTING;
	default:
		return W5500_CLOSED;
	}
}

int w5500_send(const uint8_t *buf, size_t len)
{
	if (sock_status() != Sn_SR_ESTABLISHED) {
		return -ENOTCONN;
	}
	if (len == 0) {
		return 0;
	}

	uint16_t free = rd16_stable(SR_TX_FSR, BLK_SOCK_REG(SOCK));

	if (free == 0) {
		return 0;
	}
	if (len > free) {
		len = free;
	}

	uint16_t wr = rd16_stable(SR_TX_WR, BLK_SOCK_REG(SOCK));

	/* The TX buffer is a 16-bit ring, and the chip handles the wrap for
	 * us — the write pointer is an address into the socket's TX block and
	 * the block is exactly the buffer, so a burst that runs off the end
	 * continues at the start. Nothing to split. */
	xfer(wr, BLK_SOCK_TX(SOCK), true, buf, NULL, len);

	wr16(SR_TX_WR, BLK_SOCK_REG(SOCK), (uint16_t)(wr + len));
	sock_cmd(Sn_CR_SEND);

	/* Wait for SEND_OK so a caller that loops never runs ahead of the
	 * chip. TIMEOUT here means the peer stopped acknowledging. */
	for (int i = 0; i < 2000; i++) {
		uint8_t ir = rd8(SR_IR, BLK_SOCK_REG(SOCK));

		if (ir & Sn_IR_SEND_OK) {
			wr8(SR_IR, BLK_SOCK_REG(SOCK), Sn_IR_SEND_OK);
			return (int)len;
		}
		if (ir & Sn_IR_TIMEOUT) {
			wr8(SR_IR, BLK_SOCK_REG(SOCK), Sn_IR_TIMEOUT);
			LOG_WRN("TX timeout — peer stopped acking");
			return -ETIMEDOUT;
		}
		k_msleep(1);
	}
	return -ETIMEDOUT;
}

int w5500_recv(uint8_t *buf, size_t max)
{
	uint8_t st = sock_status();

	if (st != Sn_SR_ESTABLISHED && st != Sn_SR_CLOSE_WAIT) {
		return -ENOTCONN;
	}

	uint16_t avail = rd16_stable(SR_RX_RSR, BLK_SOCK_REG(SOCK));

	if (avail == 0) {
		return 0;
	}
	if (avail > max) {
		avail = (uint16_t)max;
	}

	uint16_t rd = rd16_stable(SR_RX_RD, BLK_SOCK_REG(SOCK));

	xfer(rd, BLK_SOCK_RX(SOCK), false, NULL, buf, avail);

	wr16(SR_RX_RD, BLK_SOCK_REG(SOCK), (uint16_t)(rd + avail));
	sock_cmd(Sn_CR_RECV);
	return (int)avail;
}

void w5500_close(void)
{
	sock_cmd(Sn_CR_DISCON);
	sock_cmd(Sn_CR_CLOSE);
}
