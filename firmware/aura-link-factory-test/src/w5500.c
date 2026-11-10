/*
 * Minimal W5500 register driver for the factory test.
 *
 * SPI framing (datasheet §2.2): [addr_hi] [addr_lo] [control] [data...]
 * control = (block << 3) | (write << 2) | OM, OM 0 = variable-length burst.
 * Block 0 = common registers; socket n = regs n*4+1, TX n*4+2, RX n*4+3.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/sys/printk.h>
#include <string.h>
#include <errno.h>

#include "w5500.h"

#define W5500_NODE DT_NODELABEL(w5500)

static const struct spi_dt_spec spi = SPI_DT_SPEC_GET(W5500_NODE,
	SPI_WORD_SET(8) | SPI_OP_MODE_MASTER | SPI_TRANSFER_MSB, 0);

#define HAVE_RST DT_NODE_HAS_PROP(W5500_NODE, reset_gpios)
#define HAVE_INT DT_NODE_HAS_PROP(W5500_NODE, int_gpios)

#if HAVE_RST
static const struct gpio_dt_spec rst = GPIO_DT_SPEC_GET(W5500_NODE, reset_gpios);
#endif
#if HAVE_INT
static const struct gpio_dt_spec intn = GPIO_DT_SPEC_GET(W5500_NODE, int_gpios);
#endif

#define BLK_COMMON        0x00
#define BLK_SOCK_REG(n)   ((n) * 4 + 1)
#define BLK_SOCK_TX(n)    ((n) * 4 + 2)

#define CR_MR        0x0000
#define CR_GAR       0x0001
#define CR_SUBR      0x0005
#define CR_SHAR      0x0009
#define CR_SIPR      0x000F
#define CR_SIR       0x0017
#define CR_SIMR      0x0018
#define CR_PHYCFGR   0x002E
#define CR_VERSIONR  0x0039

#define SR_MR        0x0000
#define SR_CR        0x0001
#define SR_IR        0x0002
#define SR_SR        0x0003
#define SR_PORT      0x0004
#define SR_DIPR      0x000C
#define SR_DPORT     0x0010
#define SR_TX_FSR    0x0020
#define SR_TX_WR     0x0024
#define SR_IMR       0x002C

#define Sn_MR_UDP    0x02
#define Sn_CR_OPEN   0x01
#define Sn_CR_CLOSE  0x10
#define Sn_CR_SEND   0x20
#define Sn_SR_UDP    0x22
#define Sn_IR_SENDOK 0x10
#define Sn_IR_TIMEOUT 0x08

#define UDP_SOCK     1
#define SCRATCH_SOCK 7

static int xfer(uint16_t addr, uint8_t block, bool write,
		const uint8_t *out, uint8_t *in, size_t len)
{
	uint8_t hdr[3] = {
		(uint8_t)(addr >> 8), (uint8_t)(addr & 0xFF),
		(uint8_t)((block << 3) | (write ? 0x04 : 0x00)),
	};
	struct spi_buf tx_bufs[2] = {
		{ .buf = hdr, .len = sizeof(hdr) },
		{ .buf = (void *)out, .len = len },
	};
	const struct spi_buf_set tx = { .buffers = tx_bufs, .count = write ? 2 : 1 };

	if (write) {
		return spi_write_dt(&spi, &tx);
	}

	uint8_t dump[3];
	struct spi_buf rx_bufs[2] = {
		{ .buf = dump, .len = sizeof(dump) },
		{ .buf = in, .len = len },
	};
	const struct spi_buf_set rx = { .buffers = rx_bufs, .count = 2 };

	return spi_transceive_dt(&spi, &tx, &rx);
}

static uint8_t rd8(uint16_t a, uint8_t b) { uint8_t v = 0; xfer(a, b, false, NULL, &v, 1); return v; }
static void wr8(uint16_t a, uint8_t b, uint8_t v) { xfer(a, b, true, &v, NULL, 1); }
static void wr16(uint16_t a, uint8_t b, uint16_t v)
{
	uint8_t d[2] = { v >> 8, v & 0xFF };
	xfer(a, b, true, d, NULL, 2);
}
static uint16_t rd16(uint16_t a, uint8_t b)
{
	uint8_t d[2];
	uint16_t prev, cur;

	xfer(a, b, false, NULL, d, 2);
	prev = (d[0] << 8) | d[1];
	for (int i = 0; i < 8; i++) {
		xfer(a, b, false, NULL, d, 2);
		cur = (d[0] << 8) | d[1];
		if (cur == prev) {
			return cur;
		}
		prev = cur;
	}
	return prev;
}

static void sock_cmd(int s, uint8_t cmd)
{
	wr8(SR_CR, BLK_SOCK_REG(s), cmd);
	for (int i = 0; i < 1000 && rd8(SR_CR, BLK_SOCK_REG(s)); i++) {
		k_busy_wait(10);
	}
}

bool w5500_has_reset_pin(void) { return HAVE_RST; }
bool w5500_has_int_pin(void) { return HAVE_INT; }

int w5500_reset_and_version(void)
{
	if (!spi_is_ready_dt(&spi)) {
		return -ENODEV;
	}

#if HAVE_RST
	if (!gpio_is_ready_dt(&rst)) {
		return -ENODEV;
	}
	gpio_pin_configure_dt(&rst, GPIO_OUTPUT_ACTIVE);  /* RSTn low */
	k_msleep(2);                                      /* >500 us */
	gpio_pin_set_dt(&rst, 0);                         /* release */
	k_msleep(100);                                    /* PLL lock < 50 ms */
#endif
#if HAVE_INT
	if (gpio_is_ready_dt(&intn)) {
		gpio_pin_configure_dt(&intn, GPIO_INPUT);
	}
#endif

	wr8(CR_MR, BLK_COMMON, 0x80);                     /* software reset */
	k_msleep(10);

	uint8_t v;
	int err = xfer(CR_VERSIONR, BLK_COMMON, false, NULL, &v, 1);

	return err < 0 ? err : v;
}

int w5500_spi_integrity(void)
{
	/*
	 * Registers: GAR + SUBR (common block 0x0001..0x0008), 8 bytes that are
	 * plain read/write storage. They are reprogrammed by w5500_configure()
	 * straight after this test, so scribbling on them costs nothing.
	 * Patterns cover all-ones, all-zeros and alternating bits on MOSI/MISO.
	 *
	 * (v1.0.0 used socket 7's DIPR/DPORT here. Those read back as zero on
	 * real hardware while the socket is closed, which reported 5 bogus
	 * mismatches on a good board. Don't go back to them.)
	 */
	static const uint8_t reg_pat[8] = { 0xA5, 0x5A, 0xFF, 0x00,
					    0xC3, 0x3C, 0x0F, 0xF0 };
	uint8_t buf_pat[64], back[64];
	int bad = 0;

	xfer(CR_GAR, BLK_COMMON, true, reg_pat, NULL, sizeof(reg_pat));
	memset(back, 0, sizeof(back));
	if (xfer(CR_GAR, BLK_COMMON, false, NULL, back, sizeof(reg_pat)) < 0) {
		return -EIO;
	}
	for (int i = 0; i < (int)sizeof(reg_pat); i++) {
		if (back[i] != reg_pat[i]) {
			if (!bad) {
				printk("    reg 0x%04X: wrote %02X read %02X\n",
				       CR_GAR + i, reg_pat[i], back[i]);
			}
			bad++;
		}
	}

	/* 64-byte burst into socket 7's TX buffer memory and back: catches
	 * clock/timing problems that a single-byte read hides. */
	for (int i = 0; i < 64; i++) {
		buf_pat[i] = (uint8_t)(i * 37 + 11);
	}
	xfer(0x0000, BLK_SOCK_TX(SCRATCH_SOCK), true, buf_pat, NULL, 64);
	memset(back, 0, sizeof(back));
	if (xfer(0x0000, BLK_SOCK_TX(SCRATCH_SOCK), false, NULL, back, 64) < 0) {
		return -EIO;
	}
	for (int i = 0; i < 64; i++) {
		if (back[i] != buf_pat[i]) {
			if (!bad) {
				printk("    TX buf +%d: wrote %02X read %02X\n",
				       i, buf_pat[i], back[i]);
			}
			bad++;
		}
	}
	return bad;
}

int w5500_configure(const uint8_t mac[6], const uint8_t ip[4],
		    const uint8_t mask[4], const uint8_t gw[4])
{
	xfer(CR_SHAR, BLK_COMMON, true, mac, NULL, 6);
	xfer(CR_SIPR, BLK_COMMON, true, ip, NULL, 4);
	xfer(CR_SUBR, BLK_COMMON, true, mask, NULL, 4);
	return xfer(CR_GAR, BLK_COMMON, true, gw, NULL, 4);
}

uint8_t w5500_phycfgr(void)
{
	return rd8(CR_PHYCFGR, BLK_COMMON);
}

int w5500_udp_broadcast(const uint8_t *buf, size_t len, uint16_t port)
{
	static const uint8_t bcast[4] = { 255, 255, 255, 255 };
	const uint8_t s = UDP_SOCK;

	sock_cmd(s, Sn_CR_CLOSE);
	wr8(SR_MR, BLK_SOCK_REG(s), Sn_MR_UDP);
	wr16(SR_PORT, BLK_SOCK_REG(s), port);
	sock_cmd(s, Sn_CR_OPEN);
	if (rd8(SR_SR, BLK_SOCK_REG(s)) != Sn_SR_UDP) {
		return -EIO;
	}

	xfer(SR_DIPR, BLK_SOCK_REG(s), true, bcast, NULL, 4);
	wr16(SR_DPORT, BLK_SOCK_REG(s), port);

	if (rd16(SR_TX_FSR, BLK_SOCK_REG(s)) < len) {
		return -ENOMEM;
	}
	uint16_t wr = rd16(SR_TX_WR, BLK_SOCK_REG(s));

	xfer(wr, BLK_SOCK_TX(s), true, buf, NULL, len);
	wr16(SR_TX_WR, BLK_SOCK_REG(s), wr + len);
	sock_cmd(s, Sn_CR_SEND);
	return 0;
}

__attribute__((unused)) int w5500_int_test(void)
{
#if !HAVE_INT
	return -ENOTSUP;
#else
	const uint8_t s = UDP_SOCK;
	static const uint8_t msg[] = "FACTORY-TEST\n";
	int ret = -EIO;

	/* Only socket 1, only SEND_OK, routed to INTn. */
	wr8(SR_IMR, BLK_SOCK_REG(s), Sn_IR_SENDOK);
	wr8(SR_IR, BLK_SOCK_REG(s), 0xFF);
	wr8(CR_SIMR, BLK_COMMON, BIT(s));

	if (gpio_pin_get_dt(&intn) != 0) {
		/* Asserted before we did anything: stuck low or wrong pin. */
		ret = -EBUSY;
		goto out;
	}

	if (w5500_udp_broadcast(msg, sizeof(msg) - 1, 9) < 0) {
		goto out;
	}

	for (int i = 0; i < 200; i++) {
		if (gpio_pin_get_dt(&intn) == 1) {        /* active-low: asserted */
			ret = 0;
			break;
		}
		k_msleep(1);
	}
	if (ret != 0) {
		goto out;
	}

	/* Clear it and make sure the line is released. */
	wr8(SR_IR, BLK_SOCK_REG(s), 0xFF);
	k_msleep(2);
	if (gpio_pin_get_dt(&intn) != 0) {
		ret = -EBUSY;
	}

out:
	wr8(CR_SIMR, BLK_COMMON, 0);
	wr8(SR_IR, BLK_SOCK_REG(s), 0xFF);
	sock_cmd(s, Sn_CR_CLOSE);
	return ret;
#endif
}
