/*
 * qmi8658.c — QMI8658 IMU on the shared I2C bus (SDA 8 / SCL 7), addr 0x6B.
 * Config: accel +/-4 g @ 250 Hz, gyro +/-512 dps @ 235 Hz, LPFs on.
 */
#include "qmi8658.h"
#include "board.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "qmi8658";

/* registers */
#define REG_WHOAMI   0x00   /* == 0x05 */
#define REG_CTRL1    0x02
#define REG_CTRL2    0x03
#define REG_CTRL3    0x04
#define REG_CTRL5    0x06
#define REG_CTRL7    0x08
#define REG_RESET    0x60
#define REG_AX_L     0x35   /* 12 bytes: ax..az, gx..gz, little-endian */

#define WHOAMI_VAL   0x05

#define ACC_LSB_PER_G    8192.0f   /* +/-4 g, 16 bit  */
#define GYR_LSB_PER_DPS  64.0f     /* +/-512 dps      */

static i2c_master_dev_handle_t s_dev;

static esp_err_t wr(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_dev, buf, 2, 100);
}

static esp_err_t rd(uint8_t reg, uint8_t *dst, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, dst, len, 100);
}

esp_err_t qmi8658_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1,
        .sda_io_num = BOARD_IIC_SDA,
        .scl_io_num = BOARD_IIC_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &bus));

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = BOARD_QMI8658_ADDR,
        .scl_speed_hz    = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dev_cfg, &s_dev));

    uint8_t id = 0;
    esp_err_t err = rd(REG_WHOAMI, &id, 1);
    if (err != ESP_OK || id != WHOAMI_VAL) {
        ESP_LOGE(TAG, "not found (err=%d id=0x%02X)", err, id);
        return ESP_FAIL;
    }

    wr(REG_RESET, 0xB0);                 /* soft reset                     */
    vTaskDelay(pdMS_TO_TICKS(15));

    wr(REG_CTRL1, 0x40);                 /* auto-increment addressing      */
    wr(REG_CTRL2, 0x15);                 /* accel: +/-4 g,   250 Hz        */
    wr(REG_CTRL3, 0x55);                 /* gyro : +/-512 dps, 235 Hz      */
    wr(REG_CTRL5, 0x11);                 /* accel + gyro LPF mode 0        */
    wr(REG_CTRL7, 0x03);                 /* enable accel + gyro            */
    vTaskDelay(pdMS_TO_TICKS(10));

    ESP_LOGI(TAG, "up: accel 4g/250Hz gyro 512dps/235Hz");
    return ESP_OK;
}

esp_err_t qmi8658_read(qmi8658_sample_t *out)
{
    uint8_t raw[12];
    esp_err_t err = rd(REG_AX_L, raw, sizeof(raw));
    if (err != ESP_OK) return err;

    int16_t v[6];
    for (int i = 0; i < 6; i++) {
        v[i] = (int16_t)(raw[2 * i] | (raw[2 * i + 1] << 8));
    }
    out->ax = v[0] / ACC_LSB_PER_G;
    out->ay = v[1] / ACC_LSB_PER_G;
    out->az = v[2] / ACC_LSB_PER_G;
    out->gx = v[3] / GYR_LSB_PER_DPS;
    out->gy = v[4] / GYR_LSB_PER_DPS;
    out->gz = v[5] / GYR_LSB_PER_DPS;
    return ESP_OK;
}
