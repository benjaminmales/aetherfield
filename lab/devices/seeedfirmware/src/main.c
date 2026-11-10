/*
 * AURA seeed wristband - protocol v2
 *
 * XIAO nRF54L15 + LP5012 (4x RGB) + LSM6DSO IMU + PDM mic + Nordic Edge AI.
 *
 * The radio, the op_mode state machine and the animation engine all live in
 * AURA/common/aura_band.c, shared with the other bands. This file is now just
 * the parts that are specific to this hardware:
 *
 *   - the LP5012 driver
 *   - the IMU / ML / mic sensing threads
 *   - a render() callback that paints one commanded colour onto four LEDs
 *   - a bridge from gesture detection into beacon flags and EVENT uplinks
 *
 * WHAT CHANGED FROM v0, AND WHY
 *
 * v0 had three things fighting for the LEDs: the animation thread, the mic
 * thread (mode 7) and the local clap/voting effects, arbitrated by a priority
 * ladder inside led_animation_thread. A band that heard a noise would stop
 * showing the show. In v2 the animation layer owns the light unconditionally
 * and sensing reports upward instead of painting - so the crowd stays
 * coherent and the gateway decides what a clap should look like.
 *
 * The four LEDs are driven identically. v2 treats every device as one light
 * source regardless of LED count (see PROTOCOL.md 4.1); spatial modes are
 * reserved at anim_mode 0x10+ for when that changes.
 *
 * Previous v0 firmware: src/main_v0.c.bak
 */

// ...existing code...
#include <zephyr/kernel.h>
// ...existing code...
#include <zephyr/sys/util.h>
#include <stdio.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>
#include <zephyr/audio/dmic.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/drivers/regulator.h>
#include <math.h>
#include <string.h>
#include <stdint.h>
#include <assert.h>

#include <nrfx.h>

#include <nrf_edgeai/nrf_edgeai.h>
#include <nrf_edgeai_generated/nrf_edgeai_user_model.h>
#include <nrf_edgeai_generated/nrf_edgeai_user_types.h>
#include "bsp/sensor/imu/bsp_imu.h"
#include "inference_postprocessing.h"

#include "aura_band.h"

/*
 * Radio protocol v1 (see PROTOCOL.md / include/aura_radio.h):
 *  - HW PAN/short-address filtering, PAN 0xAE7F
 *  - Band address derived from FICR DEVICEID
 *  - Uplink:   BEACON [caps, battery, gesture, flags] every 1 s
 *  - Downlink: CMD with TLV blocks; we consume AURA_TLV_LED and
 *    skip everything else; NET CHANNEL_HOP supported.
 */

LOG_MODULE_REGISTER(aura_imu, LOG_LEVEL_INF);

// LED control
#define LP5012_ADDR	 0x14

#define I2C_NODE  DT_NODELABEL(i2c22)
#define I2C_IMU_NODE DT_NODELABEL(i2c30)
#define LED0_NODE DT_ALIAS(led0)
// Use devicetree node label for LP5012 EN pin
#define LP5012_EN_NODE DT_NODELABEL(lp5012_en_led)
#define PDM_IMU_PWR_NODE DT_NODELABEL(pdm_imu_pwr)
#define VBAT_PWR_NODE DT_NODELABEL(vbat_pwr)
#define LSM6DSO_I2C_ADDR 0x6a

static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(LED0_NODE, gpios);
/* LP5012 EN pin on D1 (P1.05) */
static const struct gpio_dt_spec lp5012_en = GPIO_DT_SPEC_GET(LP5012_EN_NODE, gpios);
static const struct gpio_dt_spec pdm_imu_pwr_en = GPIO_DT_SPEC_GET(PDM_IMU_PWR_NODE, enable_gpios);
static const struct device *i2c_dev;
static const struct device *vbat_pwr_dev = DEVICE_DT_GET_OR_NULL(VBAT_PWR_NODE);
/* Mic level 0..255, updated by mic_thread. In v0 this modulated the LEDs
 * directly; in v2 it is a sensed value that local logic or telemetry can
 * use, because the animation layer owns the light. */
static const struct device *dmic_dev;

static atomic_t mic_brightness = ATOMIC_INIT(255);

// IMU -> LED thread
#define IMU_STACK_SIZE 1024
#define IMU_THREAD_PRIORITY 7
K_THREAD_STACK_DEFINE(imu_stack, IMU_STACK_SIZE);


// Mic -> LED brightness thread
#define MIC_STACK_SIZE 1024
#define MIC_THREAD_PRIORITY 7
K_THREAD_STACK_DEFINE(mic_stack, MIC_STACK_SIZE);
static struct k_thread mic_thread_data;

// ML inference thread
#define ML_STACK_SIZE 2048
#define ML_THREAD_PRIORITY 6
K_THREAD_STACK_DEFINE(ml_stack, ML_STACK_SIZE);
static struct k_thread ml_thread_data;
static struct k_sem imu_data_ready_sem;
static nrf_edgeai_t *p_model = NULL;
static atomic_t current_gesture = ATOMIC_INIT(CLASS_LABEL_IDLE);

// Raw ML output for clap detection (bypassing postprocessing)
#define CLAP_CLASS_INDEX 2
#define CLAP_PROB_REQUIRED_PCT 100
static atomic_t ml_predicted_class = ATOMIC_INIT(0);
static atomic_t ml_clap_prob_pct = ATOMIC_INIT(0);
#define ACCEL_AXIS_NUM (3U)
#define GYRO_AXIS_NUM (3U)
#define NRF_EDGEAI_INPUT_DATA_LEN (ACCEL_AXIS_NUM + GYRO_AXIS_NUM)

// Number of RGB LEDs
#define NUM_LEDS 4

// Simple function to set color of one LED (0-3), RGB 0-255
// LP5012 register addresses (4-LED variant)
#define LP_RESET_REG            0x27
#define LP_CONFIG0_REG          0x00
#define LP_CONFIG1_REG          0x01
#define LP_LED_CONFIG0_REG      0x02
#define LP_LED0_BRIGHTNESS_REG  0x07
#define LP_OUT0_COLOR_REG       0x0B

static int lp_write(uint8_t reg, uint8_t val) {
	int ret;
	for (int attempt = 0; attempt < 3; attempt++) {
		ret = i2c_reg_write_byte(i2c_dev, LP5012_ADDR, reg, val);
		if (ret == 0) {
			printf("I2C write OK: reg=0x%02X val=0x%02X\n", reg, val);
			return 0;
		} else {
			printf("I2C write FAIL: reg=0x%02X val=0x%02X ret=%d (attempt %d)\n", reg, val, ret, attempt+1);
		}
		i2c_recover_bus(i2c_dev);
		k_msleep(5);
	}
	return ret;
}

static int lp_init_basic(void) {
	int ret;
	k_msleep(50);
	printf("[DEBUG] lp_init_basic: Resetting LP5012...\n");
	ret = lp_write(LP_RESET_REG, 0xFF);
	k_msleep(10);
	if (ret) { printf("[DEBUG] Failed to reset LP5012\n"); return ret; }
	printf("[DEBUG] Configuring LP5012 (CONFIG0)...\n");
	ret = lp_write(LP_CONFIG0_REG, 0x40);
	if (ret) { printf("[DEBUG] Failed CONFIG0\n"); return ret; }
	printf("[DEBUG] Configuring LP5012 (CONFIG1)...\n");
	ret = lp_write(LP_CONFIG1_REG, 0x30);
	if (ret) { printf("[DEBUG] Failed CONFIG1\n"); return ret; }
	printf("[DEBUG] Configuring LP5012 (LED_CONFIG0)...\n");
	ret = lp_write(LP_LED_CONFIG0_REG, 0x00);
	if (ret) { printf("[DEBUG] Failed LED_CONFIG0\n"); return ret; }
	for (int i = 0; i < NUM_LEDS; i++) {
		printf("[DEBUG] Setting LED%d brightness...\n", i);
		ret = lp_write(LP_LED0_BRIGHTNESS_REG + i, 0xFF);
		if (ret) { printf("[DEBUG] Failed to set brightness for LED%d\n", i); return ret; }
	}
	for (int i = 0; i < 12; i++) {
		printf("[DEBUG] Clearing color register %d...\n", i);
		ret = lp_write(LP_OUT0_COLOR_REG + i, 0x00);
		if (ret) { printf("[DEBUG] Failed to clear color register %d\n", i); return ret; }
	}
	printf("[DEBUG] lp_init_basic: Done\n");
	return 0;
}

static void scan_i2c_bus(void) {
	uint8_t dummy = 0x00;
	uint8_t rx = 0x00;

	printf("[SCAN] I2C scan on i2c22...\n");
	for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
		int ret = i2c_write_read(i2c_dev, addr, &dummy, 1, &rx, 1);
		if (ret == 0) {
			printf("[SCAN] device at 0x%02X\n", addr);
		}
	}
}
static int set_led_color(uint8_t led, uint8_t r, uint8_t g, uint8_t b) {
	if (led >= NUM_LEDS) return -EINVAL;
	uint8_t base = LP_OUT0_COLOR_REG + (led * 3);
	int ret = 0;
	ret = lp_write(base, r);
	if (ret) { return ret; }
	ret = lp_write(base + 1, g);
	if (ret) { return ret; }
	ret = lp_write(base + 2, b);
	return ret;
}

static void probe_imu_on_bus(const struct device *i2c_dev, const char *name)
{
	if (!i2c_dev || !device_is_ready(i2c_dev)) {
		printf("I2C bus %s not ready\n", name);
		return;
	}

	uint8_t reg = 0x0f; /* WHO_AM_I */
	uint8_t val = 0x00;
	int ret = i2c_write_read(i2c_dev, LSM6DSO_I2C_ADDR, &reg, 1, &val, 1);
	if (ret == 0) {
		printf("IMU WHOAMI on %s: 0x%02x\n", name, val);
	} else {
		printf("IMU probe failed on %s: %d\n", name, ret);
	}
}


static void imu_data_ready_cb(void)
{
	k_sem_give(&imu_data_ready_sem);
}

static void inference_postprocess_cb(const class_label_t class_label,
				     const float probability,
				     const char *class_name,
				     const bool is_raw)
{
	ARG_UNUSED(probability);
	ARG_UNUSED(class_name);
	ARG_UNUSED(is_raw);
	
	// Update atomic gesture variable
	atomic_set(&current_gesture, (atomic_val_t)class_label);
	
	LOG_INF("Gesture detected: %d (%s) prob=%.2f", class_label, class_name, (double)probability);
}

static void ml_inference_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	// IMU is already initialized in main() thread, just wait a bit for it to be ready
	k_msleep(200);
	
	printf("ML: Starting ML model initialization\n");

	// Initialize ML model
	p_model = nrf_edgeai_user_model();
	if (p_model == NULL) {
		LOG_ERR("Failed to get ML model");
		return;
	}

	if (!nrf_edgeai_is_runtime_compatible(p_model)) {
		LOG_ERR("ML model runtime incompatible");
		return;
	}

	nrf_edgeai_err_t res = nrf_edgeai_init(p_model);
	if (res != NRF_EDGEAI_ERR_SUCCESS) {
		LOG_ERR("Failed to initialize ML model: %d", (int)res);
		printf("ML: ML model init FAILED: %d - thread exiting\n", (int)res);
		p_model = NULL; // Clear model pointer on failure
		return;
	}

	printf("ML: ML model initialized successfully\n");
	
	bsp_imu_data_t imu_data = {0};
	int16_t input_data[NRF_EDGEAI_INPUT_DATA_LEN];

	LOG_INF("ML inference thread started");
	printf("ML inference thread started\n");

	// Safety check: ensure p_model is valid before entering loop
	if (p_model == NULL) {
		LOG_ERR("ML: p_model is NULL, thread exiting");
		return;
	}

	for (;;) {
		// Safety check: ensure p_model is still valid
		if (p_model == NULL) {
			LOG_ERR("ML: p_model became NULL, thread exiting");
			return;
		}
		
		k_sem_take(&imu_data_ready_sem, K_FOREVER);

		if (bsp_imu_read(&imu_data) != BSP_STATUS_SUCCESS) {
			continue;
		}

		input_data[0] = imu_data.accel[0].raw;
		input_data[1] = imu_data.accel[1].raw;
		input_data[2] = imu_data.accel[2].raw;
		input_data[3] = imu_data.gyro[0].raw;
		input_data[4] = imu_data.gyro[1].raw;
		input_data[5] = imu_data.gyro[2].raw;

		res = nrf_edgeai_feed_inputs(p_model, input_data, NRF_EDGEAI_INPUT_DATA_LEN);

		if (res == NRF_EDGEAI_ERR_SUCCESS) {
			res = nrf_edgeai_run_inference(p_model);

			if (res == NRF_EDGEAI_ERR_SUCCESS) {
				// Access decoded output
				uint16_t predicted_target = p_model->decoded_output.classif.predicted_class;
				const void *prob_ptr =
					(sizeof(nrf_user_output_t) == 1) ?
						(const void *)p_model->decoded_output.classif.probabilities.p_q8 :
						(const void *)p_model->decoded_output.classif.probabilities.p_q16;
				
				// Safety check: ensure probability pointer is valid
				if (prob_ptr == NULL) {
					continue;
				}
				
				const nrf_user_output_t *p_probabilities =
					(const nrf_user_output_t *)prob_ptr;
				uint32_t prob_max = (sizeof(nrf_user_output_t) == 1) ? 255U : 65535U;
				
				// Safety check: ensure predicted_target is within valid range
				if (predicted_target >= 255) {
					continue;
				}
				
				uint32_t clap_prob_pct =
					(uint32_t)p_probabilities[CLAP_CLASS_INDEX] * 100U / prob_max;
				
				// Store raw ML output for clap detection
				atomic_set(&ml_predicted_class, (atomic_val_t)predicted_target);
				if (predicted_target == CLAP_CLASS_INDEX) {
					atomic_set(&ml_clap_prob_pct, (atomic_val_t)clap_prob_pct);
				} else {
					atomic_set(&ml_clap_prob_pct, 0);
				}

				// Use postprocessing callback
				float probability = (float)p_probabilities[predicted_target] / (float)prob_max;
				inference_postprocess(predicted_target, probability, true, inference_postprocess_cb);
			}
		}
	}
}




/* v0's local command mirror lived here. In v2 the shared band layer holds
 * the commanded state - aura_band_state() - so there is nothing to mirror. */

static int app_init(void) {
	int ret;
	printf("[DEBUG] app_init: Getting I2C device...\n");
	i2c_dev = DEVICE_DT_GET(I2C_NODE);
	if (!device_is_ready(i2c_dev)) {
		printf("ERROR: I2C device not ready!\n");
		return -ENODEV;
	}
	printf("[DEBUG] app_init: Configuring I2C...\n");
	uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
	ret = i2c_configure(i2c_dev, i2c_cfg);
	if (ret) {
		printf("ERROR: I2C configure failed (%d)\n", ret);
		return ret;
	}
	if (!gpio_is_ready_dt(&led)) {
		printf("WARNING: GPIO not ready (led0)\n");
	} else {
		printf("[DEBUG] app_init: Configuring LED0 GPIO...\n");
		ret = gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
		if (ret < 0) {
			printf("WARNING: Failed to configure GPIO\n");
		}
	}
	if (!gpio_is_ready_dt(&lp5012_en)) {
		printf("ERROR: LP5012 EN pin GPIO not ready!\n");
		return -ENODEV;
	}
	printf("[DEBUG] app_init: Configuring LP5012 EN pin as output (inactive)...\n");
	ret = gpio_pin_configure_dt(&lp5012_en, GPIO_OUTPUT_INACTIVE);
	if (ret < 0) {
		printf("ERROR: Failed to configure LP5012 EN pin: %d\n", ret);
		return ret;
	}
	printf("[DEBUG] app_init: Setting LP5012 EN pin HIGH...\n");
	ret = gpio_pin_set_dt(&lp5012_en, 1);
	if (ret < 0) {
		printf("ERROR: Failed to set LP5012 EN pin HIGH: %d\n", ret);
		return ret;
	}
	// Read back EN pin state
	int en_state = gpio_pin_get_dt(&lp5012_en);
	if (en_state < 0) {
		printf("[DEBUG] Failed to read LP5012 EN pin state: %d\n", en_state);
	} else {
		printf("[DEBUG] LP5012 EN pin state is: %d (should be 1)\n", en_state);
	}
	k_msleep(500);
	printf("[DEBUG] app_init: Probing I2C devices...\n");
	scan_i2c_bus();
	printf("[DEBUG] app_init: Initializing LP5012...\n");
	ret = lp_init_basic();
	if (ret) {
		printf("LP5012 init failed: %d\n", ret);
		return ret;
	}
	printf("[DEBUG] app_init: Writing 0xFF to reg 0x06...\n");
	lp_write(0x06, 0xFF);
	printf("[DEBUG] app_init: Done\n");
	return 0;
}
// End of LED control

// radio handling

#define SAMPLE_RATE_HZ 16000
#define SAMPLE_BIT_WIDTH 16
#define BYTES_PER_SAMPLE (SAMPLE_BIT_WIDTH / 8)
#define CHUNK_DURATION_MS 100
#define CHUNK_SIZE_BYTES  (BYTES_PER_SAMPLE * (SAMPLE_RATE_HZ * CHUNK_DURATION_MS) / 1000)
#define CHUNK_COUNT 4

K_MEM_SLAB_DEFINE_STATIC(mic_slab, CHUNK_SIZE_BYTES, CHUNK_COUNT, 4);

static struct pcm_stream_cfg mic_stream_cfg = {
	.pcm_rate = SAMPLE_RATE_HZ,
	.pcm_width = SAMPLE_BIT_WIDTH,
	.block_size = CHUNK_SIZE_BYTES,
	.mem_slab = &mic_slab,
};

static struct dmic_cfg mic_cfg = {
	.io = {
		.min_pdm_clk_freq = 1000000,
		.max_pdm_clk_freq = 3500000,
		.min_pdm_clk_dc = 40,
		.max_pdm_clk_dc = 60,
	},
	.streams = &mic_stream_cfg,
	.channel = {
		.req_num_streams = 1,
		.req_num_chan = 1,
	},
};

/* v0 kept a local mirror of the last command here for the animation and mic
 * threads to read. In v2 the shared band layer owns the commanded state -
 * aura_band_state() - so there is nothing to mirror and nothing to lock. */


static void mic_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	if (!dmic_dev || !device_is_ready(dmic_dev)) {
		LOG_ERR("DMIC device not ready: %s", dmic_dev ? dmic_dev->name : "null");
		return;
	}

	mic_cfg.channel.req_chan_map_lo = dmic_build_channel_map(0, 0, PDM_CHAN_LEFT);

	int ret = dmic_configure(dmic_dev, &mic_cfg);
	if (ret < 0) {
		LOG_ERR("Failed to configure DMIC: %d", ret);
		return;
	}

	ret = dmic_trigger(dmic_dev, DMIC_TRIGGER_START);
	if (ret < 0) {
		LOG_ERR("Failed to start DMIC: %d", ret);
		return;
	}

	// Discard first buffer
	void *buffer;
	uint32_t size;
	if (dmic_read(dmic_dev, 0, &buffer, &size, 100) == 0) {
		k_mem_slab_free(&mic_slab, buffer);
	}

	while (1) {
		ret = dmic_read(dmic_dev, 0, &buffer, &size, 1000);
		if (ret < 0) {
			if (ret != -EAGAIN) {
				LOG_ERR("DMIC read failed: %d", ret);
			}
			continue;
		}

		int16_t *samples = (int16_t *)buffer;
		size_t count = size / sizeof(int16_t);
		int32_t peak = 0;
		int64_t sum_sq = 0;

		for (size_t i = 0; i < count; i++) {
			int32_t s = samples[i];
			if (s < 0) s = -s;
			if (s > peak) peak = s;
			sum_sq += (int64_t)samples[i] * samples[i];
		}

		float rms = sqrtf((float)sum_sq / (float)count);
		float norm_rms = rms / 32768.0f;
		
		/* v2: sensitivity follows the commanded animation rate, which is
		 * the closest equivalent to v0's `rate`. Read straight from the
		 * shared layer - there is no local command mirror any more. */
		uint8_t rate = aura_band_state()->anim_param;

		// Use rate to control sensitivity/gain
		// Rate 0-255 maps to gain 0.5x to 8.0x (sensitivity)
		// Default rate 0 = gain 4.0 (middle sensitivity)
		float gain;
		if (rate == 0) {
			gain = 4.0f; // Default sensitivity
		} else {
			// Map rate (1-255) to gain (0.5 to 8.0)
			// Linear mapping: gain = 0.5 + (rate / 255.0) * 7.5
			gain = 0.5f + ((float)rate / 255.0f) * 7.5f;
		}
		
		int scaled = (int)(norm_rms * 255.0f * gain);
		if (scaled < 0) scaled = 0;
		if (scaled > 255) scaled = 255;
		uint8_t brightness = (uint8_t)scaled;
		atomic_set(&mic_brightness, brightness);

		LOG_INF("mic rms:%f peak:%d brightness:%u gain:%f rate:%u", 
			(double)rms, peak, brightness, (double)gain, rate);

		/* v2: the mic no longer drives LEDs. The shared animation layer
		 * owns the light so the whole fleet stays coherent; the mic is a
		 * sensor whose level feeds local logic and telemetry.
		 * (v0 mode 7 painted from here - that is what made a band ignore
		 * the show whenever it heard a noise.) */

		k_mem_slab_free(&mic_slab, buffer);
	}
}

/* ------------------------------------------------------------------ */
/* v2 band wiring                                                      */
/* ------------------------------------------------------------------ */

/* The one seam between the shared layer and this board: it computes a
 * colour, we put it on the hardware. Called at 50 Hz. */
/* Set once app_init() has proved the LP5012 answered on I2C. If it never
 * did, render becomes a no-op so a board with no LED daughterboard still
 * runs the radio and sensing normally. */
static bool g_have_led;

static void wristband_render(uint8_t r, uint8_t g, uint8_t b)
{
	static uint8_t last_r, last_g, last_b;
	static bool primed;

	if (!g_have_led) {
		return;
	}

	/* Only touch the bus when the colour changes. The animation layer runs
	 * at 50 Hz, but a steady colour is the same triple every frame - and
	 * here each frame is twelve I2C register writes to the LP5012. That is
	 * a lot of bus traffic and current for no visible difference. */
	if (primed && r == last_r && g == last_g && b == last_b) {
		return;
	}
	last_r = r; last_g = g; last_b = b;
	primed = true;

	for (uint8_t i = 0; i < NUM_LEDS; i++) {
		set_led_color(i, r, g, b);
	}
}

/* Bridge sensing -> telemetry. Runs alongside the shared layer's own
 * threads and never touches the LEDs. */
#define SENSE_BRIDGE_STACK 768
K_THREAD_STACK_DEFINE(sense_bridge_stack, SENSE_BRIDGE_STACK);
static struct k_thread sense_bridge_data;

/* Minimum gap between reported claps, so one clap is one event rather than
 * a burst while the model stays confident. */
#define CLAP_REPORT_GAP_MS 700U

static void sense_bridge_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	class_label_t last_gesture = CLASS_LABEL_IDLE;
	uint32_t last_clap_ms = 0;

	while (1) {
		uint32_t now = k_uptime_get_32();

		/* Postprocessed gesture class: report the edge, carry nothing
		 * in the flags - the gesture set on this board is discrete
		 * actions (swipe, shake), not a held state. */
		class_label_t g = (class_label_t)atomic_get(&current_gesture);

		if (g != last_gesture) {
			last_gesture = g;
			if (g != CLASS_LABEL_IDLE && g != CLASS_LABEL_UNKNOWN) {
				aura_band_send_event(AURA_EVENT_GESTURE,
						     (uint8_t)g, 100);
			}
		}

		/* Clap comes from the RAW model output rather than the
		 * postprocessed class, matching how v0 gated it. */
		uint16_t cls = (uint16_t)atomic_get(&ml_predicted_class);
		uint32_t prob = (uint32_t)atomic_get(&ml_clap_prob_pct);

		if (cls == CLAP_CLASS_INDEX && prob >= CLAP_PROB_REQUIRED_PCT &&
		    (last_clap_ms == 0 || (now - last_clap_ms) > CLAP_REPORT_GAP_MS)) {
			last_clap_ms = now;
			/* The flag rides the next beacon and is cleared once
			 * sent; the EVENT is the immediate edge. Gateway gets
			 * both the moment and the periodic state. */
			aura_band_set_flag(AURA_FLAG_CLAP, true);
			aura_band_send_event(AURA_EVENT_GESTURE, 2,
					     (uint8_t)(prob > 100u ? 100u : prob));
		}

		k_msleep(50);
	}
}

int main(void)
{
	/* Order matters and is inherited from v0: VBAT regulator, then LED,
	 * then the IMU power rail, then the IMU itself. The radio comes last
	 * because aura_band_init() starts threads that expect the rest up. */

	if (vbat_pwr_dev && device_is_ready(vbat_pwr_dev)) {
		int ret = regulator_enable(vbat_pwr_dev);

		if (ret < 0) {
			printf("ERROR: Failed to enable VBAT regulator: %d\n", ret);
		} else {
			k_msleep(100);   /* let it stabilise */
		}
	} else {
		printf("WARNING: VBAT regulator device not available\n");
	}

	/* If the LP5012 never answers we keep going: the band still runs the
	 * radio and sensing, render() just becomes a no-op. Useful for bare
	 * modules with no LED daughterboard. */
	g_have_led = (app_init() == 0);
	if (!g_have_led) {
		printf("WARNING: LP5012 init failed - running with no light\n");
		if (gpio_is_ready_dt(&led)) {
			gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
		}
	} else {
		/* Two white flashes: proves I2C and the LED board before any
		 * radio traffic exists to explain what you are seeing. */
		for (int i = 0; i < 2; i++) {
			for (uint8_t l = 0; l < NUM_LEDS; l++) {
				set_led_color(l, 0xFF, 0xFF, 0xFF);
			}
			k_msleep(150);
			for (uint8_t l = 0; l < NUM_LEDS; l++) {
				set_led_color(l, 0x00, 0x00, 0x00);
			}
			k_msleep(150);
		}
	}

	/* IMU + PDM share a power rail. */
	if (gpio_is_ready_dt(&pdm_imu_pwr_en)) {
		if (gpio_pin_configure_dt(&pdm_imu_pwr_en, GPIO_OUTPUT_ACTIVE) == 0) {
			gpio_pin_set_dt(&pdm_imu_pwr_en, 1);
			k_msleep(10);
		}
	} else {
		printf("WARNING: IMU power rail GPIO not ready\n");
	}

	/* Probing the bus also wakes the part. */
	probe_imu_on_bus(DEVICE_DT_GET_OR_NULL(I2C_IMU_NODE), "i2c30");

	bsp_imu_config_t imu_config = {
		.accel_fs_g = BSP_IMU_ACCEL_SCALE_4G,
		.gyro_fs_dps = BSP_IMU_ACCEL_SCALE_1000DPS,
		.data_rate_hz = 104,
	};

	k_sem_init(&imu_data_ready_sem, 0, 1);

	bsp_status_t status = bsp_imu_init(&imu_config, imu_data_ready_cb);

	if (status != BSP_STATUS_SUCCESS) {
		printf("Failed to initialize IMU sensor, error = %d\n", (int)status);
	}

	/* --- v2 radio + animation ------------------------------------- */

	struct aura_band_cfg cfg = {
		.caps = AURA_CAPS_XIAO_BAND,
		.group_mask = 0x01,   /* wristband. Pixel module is 0x02, so the
				       * gateway can address them separately:
				       *   aura group 01 -> wristband only
				       *   aura group 02 -> pixel only
				       *   aura group 03 -> both
				       *   aura group 00 -> everyone */
		.render = wristband_render,
		.battery_pct = NULL,   /* TODO: VBAT divider not wired up yet */
		.antenna_external = false,  /* onboard ceramic - set true only if a
					     * u.FL antenna is fitted to this band */
	};

	if (aura_band_init(&cfg) != 0) {
		printf("ERROR: aura_band_init failed\n");
		return -1;
	}
	printf("wristband v%u up: addr=0x%04X caps=0x%02X\n",
	       AURA_VER, aura_band_addr(), AURA_CAPS_XIAO_BAND);

	/* --- sensing ---------------------------------------------------- */

	/* The IMU is driven directly over I2C by bsp_imu, not through the
	 * Zephyr sensor API - see the note in prj.conf. bsp_imu_init() above
	 * is the real check; DEVICE_DT_GET_OR_NULL() on a node that exists is
	 * always non-NULL, so the old guard here was decorative. */
	k_thread_create(&ml_thread_data, ml_stack, ML_STACK_SIZE,
			ml_inference_thread, NULL, NULL, NULL,
			ML_THREAD_PRIORITY, 0, K_NO_WAIT);

	dmic_dev = DEVICE_DT_GET_OR_NULL(DT_NODELABEL(pdm20));
	if (dmic_dev && device_is_ready(dmic_dev)) {
		k_thread_create(&mic_thread_data, mic_stack, MIC_STACK_SIZE,
				mic_thread, NULL, NULL, NULL,
				MIC_THREAD_PRIORITY, 0, K_NO_WAIT);
	} else {
		printf("WARNING: DMIC pdm20 unavailable, skipping mic thread\n");
	}

	k_thread_create(&sense_bridge_data, sense_bridge_stack, SENSE_BRIDGE_STACK,
			sense_bridge_thread, NULL, NULL, NULL, 7, 0, K_NO_WAIT);

	while (1) {
		k_msleep(1000);
	}
	return 0;
}
