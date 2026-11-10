// ...existing code...
#include <zephyr/net/ieee802154_radio.h>
#include <zephyr/kernel.h>
#include <zephyr/net/net_pkt.h>
#include <zephyr/net/net_if.h>
// ...existing code...
#include <zephyr/sys/util.h>
#include <nrf_802154.h>
#include <stdio.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>
#include <zephyr/audio/dmic.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/drivers/regulator.h>
#include <zephyr/drivers/hwinfo.h>
#include <math.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <assert.h>

#include <nrf_edgeai/nrf_edgeai.h>
#include <nrf_edgeai_generated/nrf_edgeai_user_model.h>
#include <nrf_edgeai_generated/nrf_edgeai_user_types.h>
#include "bsp/sensor/imu/bsp_imu.h"
#include "inference_postprocessing.h"

/*
 * Payload byte layout:
 * Byte 0: ID     - Packet identifier (always 4)
 * Byte 1: MODE   - Mode value (user-defined)
 * Byte 2: RATE   - Rate value (interval/10 ms)
 * Byte 3: RED    - Red LED value (0-255)
 * Byte 4: GREEN  - Green LED value (0-255)
 * Byte 5: BLUE   - Blue LED value (0-255)
 * All values are uint8_t.
 */
typedef struct {
	uint8_t id;
	uint8_t mode;
	uint8_t rate;
	uint8_t r;
	uint8_t g;
	uint8_t b;
} payload_t;

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
static const struct device *imu_dev;
static const struct device *dmic_dev;
static const struct device *vbat_pwr_dev = DEVICE_DT_GET_OR_NULL(VBAT_PWR_NODE);
static atomic_t mic_brightness = ATOMIC_INIT(255);

/* True only if the LP5012 LED driver responded on the I2C bus at boot.
 * If false, all LED accesses become no-ops so a wristband without an
 * LED daughterboard can still run IMU/ML/radio. */
static bool g_have_led = false;

/* 16-bit unique device identifier, derived from the chip factory UID at
 * boot. Replaces the previous hardcoded UUID_DEVICE_ID = 0x04 so the
 * gateway can distinguish each wristband. */
static uint16_t g_device_id = 0;

/* Continuous hand-raise state from IMU detection. 1 = hand currently
 * raised (any orientation, including band worn back-to-front). */
static atomic_t hand_raised = ATOMIC_INIT(0);

/* k_uptime_get_32() value captured at the most recent clap rising edge.
 * The LED animation thread uses (now - last_clap_ms) < CLAP_EFFECT_MS
 * to decide whether the clap burst effect should still be playing. */
static atomic_t last_clap_ms = ATOMIC_INIT(0);

/* Local LED effect timing. */
#define CLAP_EFFECT_MS         700U  /* duration of the clap burst */
#define LOCAL_EFFECT_FRAME_MS  40U   /* ~25 fps for breathing/chase */

/* Animation command exchanged between the LED animation thread and any
 * producer (the gateway packet handler, the mic thread, and — for the
 * local hand/clap effects — the ML thread). Declared here near the top
 * of the file so threads defined earlier (e.g. ml_inference_thread) can
 * give the semaphore to wake the animation thread on state changes. */
typedef struct {
	uint8_t mode, rate, r, g, b;
} led_anim_cmd_t;

static led_anim_cmd_t anim_cmd = {0, 0, 0, 0, 0};
static struct k_mutex anim_cmd_mutex;
static struct k_sem   anim_cmd_sem;

// IMU -> LED thread
#define IMU_STACK_SIZE 1024
#define IMU_THREAD_PRIORITY 7
K_THREAD_STACK_DEFINE(imu_stack, IMU_STACK_SIZE);
static struct k_thread imu_thread_data;

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
	/* If no LED driver was detected at boot, silently succeed so the
	 * many LED-update call sites in the firmware do not need to be
	 * individually guarded. */
	if (!g_have_led) {
		return 0;
	}
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

static inline float out_ev(const struct sensor_value *val)
{
	return (val->val1 + (float)val->val2 / 1000000);
}

static uint8_t axis_to_u8(const struct sensor_value *val)
{
	// Map -1g..+1g to 0..255
	const float g = 9.81f;
	float f = out_ev(val);
	float norm = (f + g) / (2.0f * g);
	int v = (int)(norm * 255.0f);
	if (v < 0) v = 0;
	if (v > 255) v = 255;
	return (uint8_t)v;
}

static uint8_t scale_brightness(uint8_t color)
{
	uint8_t brightness = (uint8_t)atomic_get(&mic_brightness);
	return (uint8_t)((color * brightness) / 255);
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

	/* Hand-raise detection state. We're orientation-agnostic on the
	 * Y axis (sign-independent) so the wristband works either way
	 * round on the wearer's wrist. Thresholds in units of g:
	 *   above 0.75g => Y is roughly aligned with gravity => raised
	 *   below 0.40g => Y is roughly perpendicular => lowered
	 * The deadband between 0.40 and 0.75 prevents thrash near the
	 * boundary. ~20 samples at ~104 Hz ≈ 200 ms dwell. */
	const float HAND_RAISE_THRESH_G  = 0.75f;
	const float HAND_LOWER_THRESH_G  = 0.40f;
	const int   HAND_DWELL_SAMPLES   = 20;
	int hand_above_count = 0;
	int hand_below_count = 0;
	bool hand_raised_state = false;

	/* Edge-tracker for the clap rising edge — we only want to arm
	 * the LED clap burst on a fresh clap, not on every inference
	 * tick while the model is still calling out the same event. */
	bool was_clapping = false;

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

		/* Hand-raise detection (orientation-agnostic on Y). The
		 * accel `.phys` field is in m/s^2; convert to g and take
		 * absolute value so the band works back-to-front. */
		{
			float ay_g = imu_data.accel[1].phys / 9.81f;
			float ay_abs = ay_g < 0.0f ? -ay_g : ay_g;
			if (ay_abs > HAND_RAISE_THRESH_G) {
				hand_above_count++;
				hand_below_count = 0;
			} else if (ay_abs < HAND_LOWER_THRESH_G) {
				hand_below_count++;
				hand_above_count = 0;
			}
			/* Values inside the deadband leave both counters
			 * alone so a brief wobble doesn't reset progress
			 * toward a state change. */

			if (!hand_raised_state &&
			    hand_above_count >= HAND_DWELL_SAMPLES) {
				hand_raised_state = true;
				atomic_set(&hand_raised, 1);
				/* Wake the animation thread so it switches
				 * to the voting effect immediately, even
				 * if the gateway last commanded a mode
				 * that blocks on the cmd semaphore. */
				k_sem_give(&anim_cmd_sem);
				LOG_INF("Hand raised");
			} else if (hand_raised_state &&
				   hand_below_count >= HAND_DWELL_SAMPLES) {
				hand_raised_state = false;
				atomic_set(&hand_raised, 0);
				/* Wake the animation thread so it can run
				 * the falling-edge restore of the external
				 * animation color. */
				k_sem_give(&anim_cmd_sem);
				LOG_INF("Hand lowered");
			}
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

				/* Rising-edge of a confident clap: stamp the
				 * timestamp the animation thread watches and
				 * wake it so the burst plays right away. */
				bool is_clapping =
					(predicted_target == CLAP_CLASS_INDEX) &&
					(clap_prob_pct >= CLAP_PROB_REQUIRED_PCT);
				if (is_clapping && !was_clapping) {
					atomic_set(&last_clap_ms,
						   (atomic_val_t)k_uptime_get_32());
					k_sem_give(&anim_cmd_sem);
				}
				was_clapping = is_clapping;

				// Use postprocessing callback
				float probability = (float)p_probabilities[predicted_target] / (float)prob_max;
				inference_postprocess(predicted_target, probability, true, inference_postprocess_cb);
			}
		}
	}
}

static int set_sampling_freq(const struct device *dev)
{
	struct sensor_value odr_attr;

	// set accel/gyro sampling frequency to 12.5 Hz
	odr_attr.val1 = 12.5;
	odr_attr.val2 = 0;

	int ret = sensor_attr_set(dev, SENSOR_CHAN_ACCEL_XYZ,
				  SENSOR_ATTR_SAMPLING_FREQUENCY, &odr_attr);
	if (ret != 0) {
		LOG_ERR("Cannot set sampling frequency for accelerometer.");
		return ret;
	}

	ret = sensor_attr_set(dev, SENSOR_CHAN_GYRO_XYZ,
			      SENSOR_ATTR_SAMPLING_FREQUENCY, &odr_attr);
	if (ret != 0) {
		LOG_ERR("Cannot set sampling frequency for gyro.");
		return ret;
	}

	return 0;
}

static void imu_led_thread(void *a, void *b, void *c) {
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	if (!imu_dev) {
		LOG_ERR("IMU alias imu0 not found");
		return;
	}

	if (!device_is_ready(imu_dev)) {
		LOG_ERR("IMU device not ready: %s", imu_dev->name);
		return;
	}

	if (set_sampling_freq(imu_dev) != 0) {
		return;
	}

	LOG_INF("IMU polling started");

	while (1) {
		struct sensor_value x, y, z;

		if (sensor_sample_fetch_chan(imu_dev, SENSOR_CHAN_ACCEL_XYZ) == 0 &&
		    sensor_channel_get(imu_dev, SENSOR_CHAN_ACCEL_X, &x) == 0 &&
		    sensor_channel_get(imu_dev, SENSOR_CHAN_ACCEL_Y, &y) == 0 &&
		    sensor_channel_get(imu_dev, SENSOR_CHAN_ACCEL_Z, &z) == 0) {
			uint8_t r = scale_brightness(axis_to_u8(&x));
			uint8_t g = scale_brightness(axis_to_u8(&y));
			uint8_t b = scale_brightness(axis_to_u8(&z));
			for (uint8_t i = 0; i < NUM_LEDS; i++) {
				set_led_color(i, r, g, b);
			}
			LOG_INF("accel x:%f y:%f z:%f",
				(double)out_ev(&x), (double)out_ev(&y), (double)out_ev(&z));
		} else {
			LOG_ERR("Failed to read accel");
		}

		k_sleep(K_MSEC(200));
	}
}

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

/* (Animation command typedef + statics hoisted to the top of the file
 * so threads above can give anim_cmd_sem on state changes.) */

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
		
		// Get current mode, rate, and RGB color to determine sensitivity and color
		k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
		uint8_t current_mode = anim_cmd.mode;
		uint8_t rate = anim_cmd.rate;
		uint8_t cmd_r = anim_cmd.r;
		uint8_t cmd_g = anim_cmd.g;
		uint8_t cmd_b = anim_cmd.b;
		k_mutex_unlock(&anim_cmd_mutex);

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

		if (current_mode == 7) {
			// Mode 7: Mic control - use received RGB color scaled by mic brightness
			uint8_t r = (cmd_r * brightness) / 255;
			uint8_t g = (cmd_g * brightness) / 255;
			uint8_t b = (cmd_b * brightness) / 255;
			for (uint8_t i = 0; i < NUM_LEDS; i++) {
				set_led_color(i, r, g, b);
			}
		}
		// Otherwise, let the LED animation thread handle LEDs

		k_mem_slab_free(&mic_slab, buffer);
	}
}

// Animation handler for LED modes

// Animation thread
#define ANIM_STACK_SIZE 1024
#define ANIM_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(anim_stack, ANIM_STACK_SIZE);
static struct k_thread anim_thread_data;

/* Local LED effect: gentle breathing green while the wearer's hand is
 * raised. Period ~1.6 s feels organic rather than strobe-y. All four
 * LEDs pulse in lock-step so it reads clearly as a single "I'm voting"
 * signal from across a room. */
static void render_local_voting(uint32_t now_ms)
{
	uint32_t t = now_ms % 1600U;
	uint32_t half = 800U;
	uint32_t bright32 = (t < half)
		? (t * 220U) / half
		: ((1600U - t) * 220U) / half;
	uint8_t bright = (uint8_t)bright32;
	uint8_t r = bright / 12U;          /* a hint of warmth */
	uint8_t g = bright;
	uint8_t b = bright / 6U;
	for (uint8_t i = 0; i < NUM_LEDS; i++) {
		set_led_color(i, r, g, b);
	}
}

/* Local LED effect: bright warm-white burst that chases around the 4
 * LEDs (using the same {0,1,3,2} order as the chaser mode, which traces
 * the perimeter of the physical square). The lead LED is bright, the
 * trailing one is dim, and the whole burst fades out over the
 * CLAP_EFFECT_MS window so it ends gracefully. */
static void render_local_clap(uint32_t elapsed_ms)
{
	static const uint8_t order[NUM_LEDS] = {0, 1, 3, 2};
	uint32_t step = elapsed_ms / 60U;  /* 60 ms per LED step */
	uint8_t head = order[step % NUM_LEDS];
	uint8_t tail = order[(step + NUM_LEDS - 1U) % NUM_LEDS];

	uint32_t fade_pct = (elapsed_ms >= CLAP_EFFECT_MS)
		? 0U
		: (100U - (elapsed_ms * 100U / CLAP_EFFECT_MS));
	uint8_t lead_w  = (uint8_t)((255U * fade_pct) / 100U);
	uint8_t trail_w = (uint8_t)(lead_w / 4U);

	for (uint8_t i = 0; i < NUM_LEDS; i++) {
		uint8_t v = 0;
		if (i == head)      v = lead_w;
		else if (i == tail) v = trail_w;
		/* Warm white: full R, slightly under G, half B. */
		uint8_t g = (uint8_t)((uint32_t)v * 217U / 255U);
		uint8_t b = (uint8_t)((uint32_t)v * 153U / 255U);
		set_led_color(i, v, g, b);
	}
}

static void led_animation_thread(void *a, void *b, void *c) {
	led_anim_cmd_t last = {255, 0, 0, 0, 0};
	/* Tracks whether the previous loop iteration rendered a local
	 * (IMU-driven) effect. Used to detect the falling edge so we
	 * can re-apply the gateway-set color and not leave the LEDs
	 * stuck in whatever transient state the local effect left. */
	bool was_local = false;
	while (1) {
		/* --------------------------------------------------------
		 * Local IMU/ML-driven effects take priority over whatever
		 * the gateway last commanded. Clap (event, with a fade-out
		 * window) beats voting (continuous state).
		 * -------------------------------------------------------- */
		uint32_t now_ms = k_uptime_get_32();
		bool hand_state = (bool)atomic_get(&hand_raised);
		uint32_t clap_at = (uint32_t)atomic_get(&last_clap_ms);
		bool clap_active = (clap_at != 0U) &&
				   ((now_ms - clap_at) < CLAP_EFFECT_MS);

		if (clap_active) {
			render_local_clap(now_ms - clap_at);
			was_local = true;
			k_msleep(LOCAL_EFFECT_FRAME_MS);
			/* Drain any pending wake from the ML thread so
			 * the next external-mode case doesn't fall
			 * straight through without rendering. */
			k_sem_take(&anim_cmd_sem, K_NO_WAIT);
			continue;
		}
		if (hand_state) {
			render_local_voting(now_ms);
			was_local = true;
			k_msleep(LOCAL_EFFECT_FRAME_MS);
			k_sem_take(&anim_cmd_sem, K_NO_WAIT);
			continue;
		}

		/* Falling edge of local effect: re-apply the gateway-set
		 * color once so the LEDs don't freeze in a transitional
		 * voting/clap frame before the external animation case
		 * gets a chance to paint. */
		if (was_local) {
			was_local = false;
			led_anim_cmd_t snap;
			k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
			snap = anim_cmd;
			k_mutex_unlock(&anim_cmd_mutex);
			for (uint8_t i = 0; i < NUM_LEDS; i++) {
				set_led_color(i, snap.r, snap.g, snap.b);
			}
		}

		k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
		led_anim_cmd_t cmd = anim_cmd;
		k_mutex_unlock(&anim_cmd_mutex);

		if (memcmp(&cmd, &last, sizeof(cmd)) != 0) {
			last = cmd;
		}

		uint32_t interval = (uint32_t)cmd.rate * 10;
		if (interval == 0) {
			interval = 100;
		}
		switch (cmd.mode) {
		case 0: // Steady
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, cmd.r, cmd.g, cmd.b);
			k_sem_take(&anim_cmd_sem, K_FOREVER); // Wait for new command
			break;
		case 1: { // Heartbeat (realistic double pulse)
			// Timing fractions (total = interval):
			// 1st pulse: 20%, pause: 12%, 2nd pulse: 10%, rest: 58%
			uint32_t t1 = interval * 20 / 100;
			uint32_t t2 = interval * 12 / 100;
			uint32_t t3 = interval * 10 / 100;
			uint32_t t4 = interval - (t1 + t2 + t3);
			// 1st strong pulse
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, cmd.r, cmd.g, cmd.b);
			k_msleep(t1);
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
			k_msleep(t2);
			// 2nd weaker pulse (half brightness)
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, cmd.r/2, cmd.g/2, cmd.b/2);
			k_msleep(t3);
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
			k_msleep(t4);
			break;
		}
		case 2: // Flash
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, cmd.r, cmd.g, cmd.b);
			k_msleep(interval);
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
			k_msleep(interval);
			break;
		case 3: // Build up
			for (uint8_t step = 0; step <= 10; step++) {
				uint8_t rr = (cmd.r * step) / 10;
				uint8_t gg = (cmd.g * step) / 10;
				uint8_t bb = (cmd.b * step) / 10;
				for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, rr, gg, bb);
				k_msleep(interval / 10);
			}
			break;
		case 4: { // Chaser (fade in/out)
			static const uint8_t chase_order[NUM_LEDS] = {0, 1, 3, 2};
			for (uint8_t idx = 0; idx < NUM_LEDS; idx++) {
				uint8_t led = chase_order[idx];
				uint8_t prev_led = chase_order[(idx + NUM_LEDS - 1) % NUM_LEDS];
				uint8_t next_led = chase_order[(idx + 1) % NUM_LEDS];
				for (uint8_t step = 0; step <= 10; step++) {
					uint8_t rr = (cmd.r * step) / 10;
					uint8_t gg = (cmd.g * step) / 10;
					uint8_t bb = (cmd.b * step) / 10;
					uint8_t rr_dim = rr / 3;
					uint8_t gg_dim = gg / 3;
					uint8_t bb_dim = bb / 3;
					for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
					set_led_color(prev_led, rr_dim, gg_dim, bb_dim);
					set_led_color(led, rr, gg, bb);
					set_led_color(next_led, rr_dim, gg_dim, bb_dim);
					k_msleep(interval / 10);
				}
				for (uint8_t step = 10; step > 0; step--) {
					uint8_t rr = (cmd.r * step) / 10;
					uint8_t gg = (cmd.g * step) / 10;
					uint8_t bb = (cmd.b * step) / 10;
					uint8_t rr_dim = rr / 3;
					uint8_t gg_dim = gg / 3;
					uint8_t bb_dim = bb / 3;
					for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
					set_led_color(prev_led, rr_dim, gg_dim, bb_dim);
					set_led_color(led, rr, gg, bb);
					set_led_color(next_led, rr_dim, gg_dim, bb_dim);
					k_msleep(interval / 10);
				}
			}
			break;
		}
		case 5: { // Rainbow animation
			static uint8_t hue = 0;
			for (uint8_t i = 0; i < NUM_LEDS; i++) {
				uint8_t h = hue + (i * 64);
				uint8_t r = 0, g = 0, b = 0;
				uint8_t region = h / 43;
				uint8_t remainder = (h - (region * 43)) * 6;
				uint8_t p = 0;
				uint8_t q = (255 * (255 - remainder)) / 255;
				uint8_t t = (255 * remainder) / 255;
				switch (region) {
				case 0: r = 255; g = t; b = p; break;
				case 1: r = q; g = 255; b = p; break;
				case 2: r = p; g = 255; b = t; break;
				case 3: r = p; g = q; b = 255; break;
				case 4: r = t; g = p; b = 255; break;
				default: r = 255; g = p; b = q; break;
				}
				set_led_color(i, r, g, b);
			}
			hue += 4;
			k_msleep(interval);
			break;
		}
		case 6: { // Gesture control (ML inference)
			// Check for clap directly from raw ML output (class index 2, 100% probability only)
			// Model classes: 0=IDLE, 1=UNKNOWN, 2=CLAP
			uint16_t predicted_target = (uint16_t)atomic_get(&ml_predicted_class);
			uint32_t clap_prob_pct = (uint32_t)atomic_get(&ml_clap_prob_pct);
			bool clap_detected = (predicted_target == CLAP_CLASS_INDEX && 
			                      clap_prob_pct >= CLAP_PROB_REQUIRED_PCT);
			
			uint8_t r = 0, g = 0, b = 0;
			
			if (clap_detected) {
				// Clap detected (class 2, 100% prob) - use RGB color from received message
				r = cmd.r;
				g = cmd.g;
				b = cmd.b;
			} else {
				// No clap at 100% - LEDs off
				r = 0;
				g = 0;
				b = 0;
			}
			
			// Apply color to all LEDs
			for (uint8_t i = 0; i < NUM_LEDS; i++) {
				set_led_color(i, r, g, b);
			}
			k_msleep(interval);
			break;
		}
		case 7: // Mic control - mic thread handles LEDs
			// Mic thread will update LEDs based on audio input
			// Just sleep here to avoid interfering
			k_msleep(interval);
			break;
		default:
			for (uint8_t i = 0; i < NUM_LEDS; i++) set_led_color(i, 0, 0, 0);
			k_sem_take(&anim_cmd_sem, K_FOREVER);
			break;
		}

		// Check for new command (non-blocking)
		if (k_sem_take(&anim_cmd_sem, K_NO_WAIT) == 0) {
			continue;
		}
	}
}

// Call this to update the animation command and signal the thread
static void handle_led_animation(uint8_t mode, uint8_t rate, uint8_t r, uint8_t g, uint8_t b) {
	k_mutex_lock(&anim_cmd_mutex, K_FOREVER);
	anim_cmd.mode = mode;
	anim_cmd.rate = rate;
	anim_cmd.r = r;
	anim_cmd.g = g;
	anim_cmd.b = b;
	k_mutex_unlock(&anim_cmd_mutex);
	k_sem_give(&anim_cmd_sem);
}

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

	/* Probe for LP5012 directly (bypass lp_write gate). If the chip
	 * is not on the bus, this returns non-zero and we continue with
	 * g_have_led=false so the rest of the firmware still runs. */
	uint8_t probe_val = 0;
	int probe_ret = i2c_reg_read_byte(i2c_dev, LP5012_ADDR,
					  LP_CONFIG0_REG, &probe_val);
	if (probe_ret == 0) {
		g_have_led = true;
		printf("[DEBUG] LP5012 detected at 0x%02X (CONFIG0=0x%02X)\n",
		       LP5012_ADDR, probe_val);
		printf("[DEBUG] app_init: Initializing LP5012...\n");
		ret = lp_init_basic();
		if (ret) {
			/* Probe worked but init didn't — chip may be on bus
			 * but malfunctioning. Disable LED control and keep
			 * going rather than killing the system. */
			printf("LP5012 init failed: %d (continuing without LEDs)\n", ret);
			g_have_led = false;
		} else {
			printf("[DEBUG] app_init: Writing 0xFF to reg 0x06...\n");
			lp_write(0x06, 0xFF);
		}
	} else {
		g_have_led = false;
		printf("LP5012 not detected (probe ret=%d) - running without LED driver\n",
		       probe_ret);
	}
	printf("[DEBUG] app_init: Done (LED %s)\n", g_have_led ? "enabled" : "disabled");
	return 0;
}
// End of LED control

// radio handling
#define HEX_STRING_LENGTH 129

static const struct device *radio_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_ieee802154));
static struct ieee802154_radio_api *radio_api;
/* Unused placeholders removed to keep build clean. */
static char hex_string[HEX_STRING_LENGTH];

// UUID broadcast
/* Halved from 1000 ms so hand-raise / clap state propagates to the
 * gateway with sub-second latency for the voting demo. 8 wristbands at
 * 2 Hz is well below 802.15.4 saturation. */
#define UUID_BROADCAST_INTERVAL_MS 500
#define UUID_MESSAGE_ID            0x03
/* Payload now carries a 2-byte unique device id plus 1 flags byte:
 *   [0] UUID_MESSAGE_ID
 *   [1] device_id_lo
 *   [2] device_id_hi
 *   [3] flags: bit1 = clap event, bit2 = hand raised
 */
#define UUID_PAYLOAD_LEN           4
/* Flag bit positions inside the flags byte. */
#define UUID_FLAG_CLAP             (1u << 1)
#define UUID_FLAG_HAND_RAISED      (1u << 2)
#define UUID_TX_CHANNEL            15  // Channel 15 (2425 MHz) - better for high-density environments
#define UUID_PAN_ID                0x1234
#define UUID_SRC_ADDR              0x1234
#define UUID_DST_ADDR              0xFFFF
#define UUID_FCF                   0x2241
#define UUID_FRAME_HEADER_LEN      9
#define UUID_FRAME_LEN             (UUID_FRAME_HEADER_LEN + UUID_PAYLOAD_LEN)

#define UUID_STACK_SIZE 1024
#define UUID_THREAD_PRIORITY 6
K_THREAD_STACK_DEFINE(uuid_stack, UUID_STACK_SIZE);
static struct k_thread uuid_thread_data;

static void uuid_broadcast_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	uint8_t seq = 0;
	for (uint8_t i = 0; i < NUM_LEDS; i++) {
		set_led_color(i, 0x00, 0x00, 0x00);
	}

	while (1) {
		// Use static aligned buffer to avoid stack alignment issues
		static uint8_t frame[UUID_FRAME_LEN] __aligned(4);

		// Write all values byte-by-byte to avoid any alignment issues
		// FCF (bytes 0-1)
		frame[0] = UUID_FCF & 0xFF;
		frame[1] = (UUID_FCF >> 8) & 0xFF;
		
		// Sequence number (byte 2)
		frame[2] = seq++;
		
		// PAN_ID (bytes 3-4)
		frame[3] = UUID_PAN_ID & 0xFF;
		frame[4] = (UUID_PAN_ID >> 8) & 0xFF;
		
		// DST_ADDR (bytes 5-6)
		frame[5] = UUID_DST_ADDR & 0xFF;
		frame[6] = (UUID_DST_ADDR >> 8) & 0xFF;
		
		// SRC_ADDR (bytes 7-8)
		frame[7] = UUID_SRC_ADDR & 0xFF;
		frame[8] = (UUID_SRC_ADDR >> 8) & 0xFF;
		
		/* Payload (bytes 9-12):
		 *   [9]  UUID_MESSAGE_ID
		 *   [10] device id low byte
		 *   [11] device id high byte
		 *   [12] flags: clap (bit 1), hand raised (bit 2)
		 * The gateway scans the frame for the message id and then
		 * reads the next three bytes, so this exact ordering must
		 * be kept in sync with the gateway parser. */
		frame[9]  = UUID_MESSAGE_ID;
		frame[10] = (uint8_t)(g_device_id & 0xFFu);
		frame[11] = (uint8_t)((g_device_id >> 8) & 0xFFu);

		uint16_t predicted_class = (uint16_t)atomic_get(&ml_predicted_class);
		uint32_t clap_prob_pct   = (uint32_t)atomic_get(&ml_clap_prob_pct);
		uint8_t  flags           = 0;
		if (predicted_class == CLAP_CLASS_INDEX &&
		    clap_prob_pct >= CLAP_PROB_REQUIRED_PCT) {
			flags |= UUID_FLAG_CLAP;
		}
		if (atomic_get(&hand_raised)) {
			flags |= UUID_FLAG_HAND_RAISED;
		}
		frame[12] = flags;

		struct net_pkt *pkt = net_pkt_alloc(K_NO_WAIT);
		if (!pkt) {
			k_sleep(K_MSEC(UUID_BROADCAST_INTERVAL_MS));
			continue;
		}

		if (net_pkt_alloc_buffer_raw(pkt, UUID_FRAME_LEN, K_NO_WAIT) < 0) {
			net_pkt_unref(pkt);
			k_sleep(K_MSEC(UUID_BROADCAST_INTERVAL_MS));
			continue;
		}

		net_pkt_cursor_init(pkt);
		if (net_pkt_write(pkt, frame, UUID_FRAME_LEN) != 0) {
			net_pkt_unref(pkt);
			k_sleep(K_MSEC(UUID_BROADCAST_INTERVAL_MS));
			continue;
		}

		if (gpio_is_ready_dt(&led)) {
			gpio_pin_toggle_dt(&led); // TX heartbeat on board LED
		}

		radio_api->set_channel(radio_dev, UUID_TX_CHANNEL);
		struct net_buf *frag = pkt->buffer;
		int err = radio_api->tx(radio_dev, IEEE802154_TX_MODE_DIRECT, pkt, frag);
		if (err) {
			printf("UUID TX failed: %d\n", err);
			if (gpio_is_ready_dt(&led)) {
				for (int i = 0; i < 2; i++) {
					gpio_pin_toggle_dt(&led);
					k_msleep(50);
				}
			}
		}
		net_pkt_unref(pkt);

		k_sleep(K_MSEC(UUID_BROADCAST_INTERVAL_MS));
	}
}

enum net_verdict ieee802154_handle_ack(struct net_if *iface, struct net_pkt *pkt)
{
    ARG_UNUSED(iface);
    ARG_UNUSED(pkt);
    return NET_DROP;
}

int net_recv_data(struct net_if *iface, struct net_pkt *pkt)
{
    if (!pkt || net_pkt_is_empty(pkt)) {
        return -EINVAL;
    }

    uint8_t *psdu = net_buf_frag_last(pkt->buffer)->data;
    size_t length = net_buf_frags_len(pkt->buffer);

	// Accept any message with payload ID == 4, extract mode, rate, and RGB
	// Payload mapping:
	// [15]=id, [16]=mode, [17]=rate, [18]=red, [19]=green, [20]=blue
	if (length >= 21) {
		bin2hex(psdu, length, hex_string, HEX_STRING_LENGTH);
		uint8_t id = psdu[15];
		uint8_t mode = psdu[16];
		uint8_t rate = psdu[17];
		uint8_t red = psdu[18];
		uint8_t green = psdu[19];
		uint8_t blue = psdu[20];
		if (id == 4) {
			handle_led_animation(mode, rate, red, green, blue);
		}
	}
    net_pkt_unref(pkt);
    return 0;
}
// end of radio handling

/* Derive a 16-bit unique-ish device id from the chip's factory unique
 * ID using FNV-1a folded down. With ~8 wristbands across 64k possible
 * values the expected collision probability is well under 0.1%. The
 * values 0x0000 and 0xFFFF are reserved so the gateway/web app can use
 * them as sentinels if needed. */
static uint16_t derive_device_id(void)
{
	uint8_t uid_buf[16] = {0};
	ssize_t uid_len = hwinfo_get_device_id(uid_buf, sizeof(uid_buf));
	if (uid_len <= 0) {
		/* No hardware UID available — fall back to something
		 * deterministic so a single dev board is still usable. */
		return 0x00A1;
	}

	uint32_t h = 2166136261u; /* FNV offset basis */
	for (ssize_t i = 0; i < uid_len; i++) {
		h ^= uid_buf[i];
		h *= 16777619u; /* FNV prime */
	}
	uint16_t id = (uint16_t)((h ^ (h >> 16)) & 0xFFFFu);
	if (id == 0x0000u) id = 0x00A1u;
	if (id == 0xFFFFu) id = 0xFEFEu;
	return id;
}

int main(void)
{
	g_device_id = derive_device_id();
	// initialise LED
	printf("\nLP5012 LED Demo (device_id=0x%04X)\n", g_device_id);

	// Enable VBAT power regulator FIRST for battery operation
	if (vbat_pwr_dev && device_is_ready(vbat_pwr_dev)) {
		int ret = regulator_enable(vbat_pwr_dev);
		if (ret < 0) {
			printf("ERROR: Failed to enable VBAT regulator: %d\n", ret);
		} else {
			printf("VBAT regulator enabled for battery operation\n");
			k_msleep(100); // Allow regulator to stabilize
		}
	} else {
		printf("WARNING: VBAT regulator device not available\n");
	}

	int ret = app_init();
	if (ret) {
		// Fallback: blink board LED if LP5012/I2C fails
		if (gpio_is_ready_dt(&led)) {
			gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
			while (1) {
				gpio_pin_toggle_dt(&led);
				k_msleep(300);
			}
		}
		return 0;
	}

	// ...existing code...

	// Existing white flash sequence to confirm LED/I2C is working (all LEDs)
	for (int i = 0; i < 2; i++) {
		for (uint8_t led = 0; led < NUM_LEDS; led++) set_led_color(led, 0xFF, 0xFF, 0xFF); // All white
		k_msleep(150);
		for (uint8_t led = 0; led < NUM_LEDS; led++) set_led_color(led, 0x00, 0x00, 0x00); // All off
		k_msleep(150);
	}

	// Init animation command mutex and semaphore
	k_mutex_init(&anim_cmd_mutex);
	k_sem_init(&anim_cmd_sem, 0, 1);

	// Enable IMU power rail and initialize synchronously for ML
	if (gpio_is_ready_dt(&pdm_imu_pwr_en)) {
		ret = gpio_pin_configure_dt(&pdm_imu_pwr_en, GPIO_OUTPUT_ACTIVE);
		if (ret < 0) {
			printf("ERROR: Failed to configure IMU power GPIO: %d\n", ret);
		} else {
			gpio_pin_set_dt(&pdm_imu_pwr_en, 1);
			printf("IMU power rail enabled\n");
			k_msleep(10);
		}
	} else {
		printf("WARNING: IMU power rail GPIO not ready\n");
	}

	// Probe IMU on i2c30 bus - this helps wake up the device
	probe_imu_on_bus(DEVICE_DT_GET_OR_NULL(I2C_IMU_NODE), "i2c30");

	// Initialize IMU synchronously before starting ML thread
	bsp_imu_config_t imu_config = {
		.accel_fs_g = BSP_IMU_ACCEL_SCALE_4G,
		.gyro_fs_dps = BSP_IMU_ACCEL_SCALE_1000DPS,
		.data_rate_hz = 104,
	};
	
	k_sem_init(&imu_data_ready_sem, 0, 1);
	
	printf("Initializing IMU...\n");
	bsp_status_t status = bsp_imu_init(&imu_config, imu_data_ready_cb);
	if (status != BSP_STATUS_SUCCESS) {
		printf("Failed to initialize IMU sensor, error = %d\n", (int)status);
	} else {
		printf("IMU initialized successfully\n");
	}
	
	// Get IMU device pointer
	imu_dev = DEVICE_DT_GET_OR_NULL(DT_ALIAS(imu0));

	// Start ML inference thread only if IMU device is available
	const struct device *imu_check = DEVICE_DT_GET_OR_NULL(DT_ALIAS(imu0));
	if (imu_check != NULL) {
		k_thread_create(&ml_thread_data, ml_stack, ML_STACK_SIZE,
				ml_inference_thread, NULL, NULL, NULL,
				ML_THREAD_PRIORITY, 0, K_NO_WAIT);
	} else {
		printf("WARNING: IMU device not found, skipping ML thread\n");
	}

	// Start Mic -> LED brightness thread (uses DT nodelabel pdm20)
	dmic_dev = DEVICE_DT_GET_OR_NULL(DT_NODELABEL(pdm20));
	if (!dmic_dev) {
		LOG_ERR("DMIC node pdm20 not found");
	} else if (!device_is_ready(dmic_dev)) {
		LOG_ERR("DMIC device not ready: %s", dmic_dev->name);
	} else {
		k_thread_create(&mic_thread_data, mic_stack, MIC_STACK_SIZE,
				mic_thread, NULL, NULL, NULL,
				MIC_THREAD_PRIORITY, 0, K_NO_WAIT);
	}

	// Start animation thread
	k_thread_create(&anim_thread_data, anim_stack, ANIM_STACK_SIZE,
					led_animation_thread, NULL, NULL, NULL,
					ANIM_THREAD_PRIORITY, 0, K_NO_WAIT);

	// initialise Radio
	// uart_shell = shell_backend_uart_get_ptr(); // Removed for battery/RTT build
	radio_api = (struct ieee802154_radio_api *)radio_dev->api;
	__ASSERT_NO_MSG(radio_api);

	struct ieee802154_config config = { .promiscuous = true };
	radio_api->configure(radio_dev, IEEE802154_CONFIG_PROMISCUOUS, &config);
	radio_api->set_channel(radio_dev, UUID_TX_CHANNEL);
	nrf_802154_tx_power_set(8);

#if !IS_ENABLED(CONFIG_NRF_802154_SERIALIZATION)
	nrf_802154_auto_ack_set(false);
#endif

	radio_api->start(radio_dev);

	// Start UUID broadcast thread (non-blocking)
	k_thread_create(&uuid_thread_data, uuid_stack, UUID_STACK_SIZE,
					uuid_broadcast_thread, NULL, NULL, NULL,
					UUID_THREAD_PRIORITY, 0, K_NO_WAIT);
	while (1) {
		k_sleep(K_MSEC(1000));
	}
	return 0;
}

