#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/ieee802154_mgmt.h>
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/shell/shell.h>
#include <zephyr/shell/shell_uart.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <errno.h>
#include <stdlib.h>
#include <nrf_802154.h>
#include <nrf_802154_types.h>

LOG_MODULE_REGISTER(app, CONFIG_LOG_DEFAULT_LEVEL);

#define UUID_BROADCAST_ID 3
/* Wristband broadcasts 4 payload bytes:
 *   [0] UUID_BROADCAST_ID (0x03)
 *   [1] device id low byte
 *   [2] device id high byte
 *   [3] flags: bit1=clap event, bit2=hand raised
 * The parser scans the frame for byte 0x03 and reads the following 3
 * bytes — keep this layout in sync with the wristband sender. */
#define UUID_PAYLOAD_LEN 5  // 1 byte ID + 4 bytes UUID
#define WB_FLAG_CLAP        (1u << 1)
#define WB_FLAG_HAND_RAISED (1u << 2)
#define SEND_INTERVAL_MS 1000
#define PAYLOAD_LEN 6
#define RAW_HEX_STRING_LENGTH 256

/* Devicetree node identifier for RF switch */
#define RFSW_REGULATOR_NODE DT_NODELABEL(pdm_imu_pwr)

/* GPIO device spec for rfsw_ctl */
static const struct gpio_dt_spec rfsw_gpio = {
	.port = DEVICE_DT_GET(DT_GPIO_CTLR(RFSW_REGULATOR_NODE, enable_gpios)),
	.pin = DT_GPIO_PIN(RFSW_REGULATOR_NODE, enable_gpios),
	.dt_flags = DT_GPIO_FLAGS(RFSW_REGULATOR_NODE, enable_gpios),
};

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;
static const struct shell *uart_shell;
static char raw_hex_string[RAW_HEX_STRING_LENGTH];

static uint8_t led_r = 0, led_g = 0, led_b = 0;
static uint8_t mode = 1;
static uint8_t rate = SEND_INTERVAL_MS / 10;

static struct net_if *g_iface = NULL;
static uint8_t g_seq = 0;
static uint32_t g_rx_count = 0;  // Counter for received messages

// Packet data structure for work queue processing
#define MAX_FRAME_LEN 127
struct rx_packet_data {
	struct k_work work;
	uint8_t *buffer;  // Pointer to the buffer to free
	uint8_t frame[MAX_FRAME_LEN];
	uint8_t len;
	int8_t power;
	uint8_t lqi;
};

// Work queue to process packets and free buffers outside of interrupt context
static void process_packet_work_handler(struct k_work *work);

static void process_packet_work_handler(struct k_work *work)
{
	struct rx_packet_data *packet_data = CONTAINER_OF(work, struct rx_packet_data, work);
	
	uint8_t *frame = packet_data->frame;
	uint8_t len = packet_data->len;
	int8_t power = packet_data->power;
	
	g_rx_count++;

	/* Search for the wristband payload anywhere in the frame. The
	 * sender places it at bytes 9..12 inside its 802.15.4 frame but
	 * the raw RX driver may include/strip MAC header bytes
	 * differently across builds, so we scan rather than hardcode an
	 * offset. We need 4 bytes (id + 2 uid + flags), so the last
	 * legal start index is len-4. */
	for (int i = 0; i <= len - 4; i++) {
		if (frame[i] != UUID_BROADCAST_ID) {
			continue;
		}
		uint16_t received_uuid =
			(uint16_t)frame[i + 1] | ((uint16_t)frame[i + 2] << 8);
		uint8_t  flags = frame[i + 3];
		uint8_t  hand  = (flags & WB_FLAG_HAND_RAISED) ? 1 : 0;
		uint8_t  clap  = (flags & WB_FLAG_CLAP)        ? 1 : 0;

		/* Stable single-line format consumed by the visualiser
		 * web app. The 'BAND ' prefix lets the web parser ignore
		 * other shell/log noise on the same UART. */
		printk("BAND uuid=0x%04X rssi=%d hand=%u clap=%u\n",
		       received_uuid, power, hand, clap);
		break;
	}
	
	// Free the buffer after processing (outside interrupt context)
	if (packet_data->buffer) {
		nrf_802154_buffer_free_raw(packet_data->buffer);
	}
	
	// Free the work structure
	k_free(packet_data);
}

// Raw RX callback - catches all packets at the radio level
// Copy data and defer processing/freeing to work queue to avoid race conditions
void nrf_802154_received_raw(uint8_t *p_data, int8_t power, uint8_t lqi)
{
	// p_data[0] = length, p_data[1..] = frame (PSDU including MAC header)
	uint8_t len = p_data[0];
	if (len > MAX_FRAME_LEN) len = MAX_FRAME_LEN; // Sanity check
	
	// Allocate work structure and copy packet data
	struct rx_packet_data *packet_data = k_malloc(sizeof(struct rx_packet_data));
	if (!packet_data) {
		// If allocation fails, free buffer immediately (fallback)
		nrf_802154_buffer_free_raw(p_data);
		return;
	}
	
	// Copy packet data
	memcpy(packet_data->frame, &p_data[1], len);
	packet_data->len = len;
	packet_data->power = power;
	packet_data->lqi = lqi;
	packet_data->buffer = p_data;  // Save buffer pointer to free later
	
	// Initialize work and submit to work queue
	k_work_init(&packet_data->work, process_packet_work_handler);
	k_work_submit_to_queue(&k_sys_work_q, &packet_data->work);
}

static void send_packet(struct net_if *iface, uint8_t seq)
{
	uint8_t payload[PAYLOAD_LEN];
	// Byte 0: ID (value 4)
	// Byte 1: MODE (example: 1)
	// Byte 2: RATE (example: SEND_INTERVAL_MS / 10)
	// Byte 3: RED
	// Byte 4: GREEN
	// Byte 5: BLUE
	payload[0] = 4; // ID
	payload[1] = mode; // MODE
	payload[2] = rate; // RATE
	payload[3] = led_r;
	payload[4] = led_g;
	payload[5] = led_b;
	struct net_pkt *pkt = net_pkt_alloc_with_buffer(iface, PAYLOAD_LEN, AF_UNSPEC, 0, K_NO_WAIT);
	if (!pkt) {
		printk("Sender: Failed to allocate net_pkt\n");
		return;
	}
	net_pkt_write(pkt, payload, PAYLOAD_LEN);
	int send_res = net_if_send_data(iface, pkt);
	if (send_res) {
		printk("Sender: net_if_send_data failed: %d\n", send_res);
		net_pkt_unref(pkt); // Free packet on error
	} else {
		printk("Sender: Packet sent successfully\n");
	}
	
	// The network stack should automatically return to receive mode after TX
	// Don't manually restart here to avoid race conditions
	// Just ensure we're in receive mode (but don't force restart)
	k_msleep(100); // Delay to let TX complete and radio return to RX
}

static int cmd_led(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 4) {
		shell_print(shell, "Usage: led <R> <G> <B>");
		return -EINVAL;
	}
	led_r = (uint8_t)atoi(argv[1]);
	led_g = (uint8_t)atoi(argv[2]);
	led_b = (uint8_t)atoi(argv[3]);
	shell_print(shell, "LED set to: R=%d G=%d B=%d", led_r, led_g, led_b);
	if (g_iface) {
		printk("Sending packet seq=%d\n", g_seq);
		send_packet(g_iface, g_seq++);
	}
	return 0;
}

static int cmd_aura(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 6) {
		shell_print(shell, "Usage: aura <MODE> <RATE> <R> <G> <B>");
		return -EINVAL;
	}
	mode = (uint8_t)atoi(argv[1]);
	rate = (uint8_t)atoi(argv[2]);
	led_r = (uint8_t)atoi(argv[3]);
	led_g = (uint8_t)atoi(argv[4]);
	led_b = (uint8_t)atoi(argv[5]);
	shell_print(shell, "AURA set: MODE=%d RATE=%d R=%d G=%d B=%d", mode, rate, led_r, led_g, led_b);
	if (g_iface) {
		printk("Sending packet seq=%d\n", g_seq);
		send_packet(g_iface, g_seq++);
	}
	return 0;
}

static int cmd_rate(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2) {
		shell_print(shell, "Usage: rate <RATE>");
		return -EINVAL;
	}
	rate = (uint8_t)atoi(argv[1]);
	shell_print(shell, "Rate set to: %d", rate);
	return 0;
}

static int cmd_mode(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2) {
		shell_print(shell, "Usage: mode <MODE>");
		return -EINVAL;
	}
	mode = (uint8_t)atoi(argv[1]);
	shell_print(shell, "Mode set to: %d", mode);
	return 0;
}

static int cmd_receive(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(shell);
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	radio_api->start(radio_dev);
	nrf_802154_receive(); // Also ensure nRF driver is receiving
	shell_print(shell, "Radio set to receive mode");
	return 0;
}

static int cmd_sleep(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(shell);
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	radio_api->stop(radio_dev);
	shell_print(shell, "Radio stopped (sleep mode)");
	return 0;
}

static int cmd_stats(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	
	shell_print(shell, "Receive Statistics:");
	shell_print(shell, "  Total messages received: %u", g_rx_count);
	return 0;
}

int main(void)
{
	int ret;

	/* Initialize external antenna permanently */
	if (gpio_is_ready_dt(&rfsw_gpio)) {
		ret = gpio_pin_configure_dt(&rfsw_gpio, GPIO_OUTPUT);
		if (ret < 0) {
			LOG_ERR("Error configuring rfsw-ctl: %d", ret);
		} else {
			/* Set to external antenna (physical HIGH = logic 0 based on sample code) */
			ret = gpio_pin_set_dt(&rfsw_gpio, 0);
			if (ret < 0) {
				LOG_ERR("Error setting rfsw-ctl to external antenna: %d", ret);
			} else {
				printk("External antenna enabled permanently\n");
			}
		}
	} else {
		printk("Warning: RF switch control GPIO not ready - antenna may not be configured\n");
	}

	g_iface = net_if_get_default();
	if (!g_iface) {
		printk("Failed to get network interface\n");
		return -1;
	}

	uart_shell = shell_backend_uart_get_ptr();

	// Configure radio API
	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	if (!radio_api) {
		printk("Failed to get radio API\n");
		return -1;
	}

	// Set channel to 15 using nRF driver directly
	nrf_802154_channel_set(15);
	printk("Channel set to 15\n");

	// Configure promiscuous mode
	struct ieee802154_config config = {
		.promiscuous = true
	};

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif

	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	
	// Also set promiscuous mode at nRF driver level
	nrf_802154_promiscuous_set(true);
	
	// Set TX power to 10 dBm using nRF driver directly
	nrf_802154_tx_power_set(10);
	printk("TX power set to 10 dBm\n");
	
	// Start receiving - ensure radio is in receive mode
	radio_api->start(radio_dev);
	nrf_802154_receive();
	
	// Ensure we stay in receive mode
	printk("Radio started, ensuring receive mode...\n");

	printk("Controller started - sender and receiver enabled\n");
	printk("Raw RX callback enabled - all received messages will be logged\n");
	printk("Waiting for packets...\n");

	uint32_t last_rx_count = 0;
	uint32_t receive_check_counter = 0;

	while (1) {
		if (mode == 187) {
			send_packet(g_iface, g_seq++);
			k_msleep(500);
		} else {
			k_msleep(1000);
		}
		
		// With proper buffer freeing in the raw callback, we shouldn't need frequent restarts
		// Only restart if no new packets are received (indicating a problem)
		receive_check_counter++;
		if (receive_check_counter >= 5) { // Every ~5 seconds
			receive_check_counter = 0;
			
			// Only restart if no new packets received for a while (indicating a problem)
			if (g_rx_count == last_rx_count && g_rx_count > 0) {
				// No new packets - might indicate a problem, restart
				printk("No new packets (total: %u), restarting radio...\n", g_rx_count);
				radio_api->stop(radio_dev);
				k_msleep(100);
				radio_api->start(radio_dev);
				nrf_802154_receive();
			} else {
				// Just ensure we're in receive mode
				radio_api->start(radio_dev);
				nrf_802154_receive();
			}
			last_rx_count = g_rx_count;
		}
	}
	return 0;
}

// Register shell commands after all function definitions
SHELL_CMD_ARG_REGISTER(led, NULL, "Set LED color: led <R> <G> <B>", cmd_led, 4, 0);
SHELL_CMD_ARG_REGISTER(aura, NULL, "Set AURA: aura <MODE> <RATE> <R> <G> <B>", cmd_aura, 6, 0);
SHELL_CMD_ARG_REGISTER(rate, NULL, "Set RATE: rate <RATE>", cmd_rate, 2, 0);
SHELL_CMD_ARG_REGISTER(mode, NULL, "Set MODE: mode <MODE>", cmd_mode, 2, 0);
SHELL_CMD_ARG_REGISTER(receive, NULL, "Put radio in receive state", cmd_receive, 1, 0);
SHELL_CMD_ARG_REGISTER(sleep, NULL, "Disable the radio", cmd_sleep, 1, 0);
SHELL_CMD_ARG_REGISTER(stats, NULL, "Show receive statistics", cmd_stats, 1, 0);