/*
 * amoled.c — CO5300 AMOLED over QSPI, ESP32-C6
 *
 * Wire protocol mirrors Arduino_GFX's Arduino_ESP32QSPI + Arduino_CO5300
 * (the combination Waveshare ships for this board):
 *   - register writes : SPI cmd 0x02, 24-bit addr = reg << 8, params on 1 line
 *   - pixel data      : SPI cmd 0x32, 24-bit addr = 0x003C00 (DCS "memory
 *                       write continue"), data on 4 lines (QIO)
 * Init sequence from Arduino_CO5300.h co5300_init_operations.
 */
#include "amoled.h"
#include "board.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "amoled";

#define QSPI_HOST       SPI2_HOST
#define QSPI_CLOCK_HZ   (40 * 1000 * 1000)
#define TX_QUEUE_DEPTH  4
/* keep at most 2 colour transactions in flight so a ping-pong pair of pixel
 * buffers is never overwritten while the DMA is still reading it */
#define TX_INFLIGHT_MAX 2

/* CO5300 / DCS commands */
#define CO5300_C_SLPOUT     0x11
#define CO5300_C_INVOFF     0x20
#define CO5300_C_DISPON     0x29
#define CO5300_W_CASET      0x2A
#define CO5300_W_PASET      0x2B
#define CO5300_W_RAMWR      0x2C
#define CO5300_W_PIXFMT     0x3A
#define CO5300_W_WRMC       0x3C
#define CO5300_W_WCTRLD1    0x53
#define CO5300_W_BRIGHT_NOR 0x51
#define CO5300_W_WCE        0x58
#define CO5300_W_BRIGHT_HBM 0x63
#define CO5300_W_SPIMODECTL 0xC4

static spi_device_handle_t s_dev;
static int s_inflight;                       /* queued colour transactions   */
static spi_transaction_ext_t s_tx[TX_QUEUE_DEPTH];
static int s_tx_next;

/* ---- low-level writes --------------------------------------------------- */

/* register write, everything on 1 data line */
static void wr_cmd(uint8_t reg, const uint8_t *data, size_t len)
{
    spi_transaction_ext_t t = {
        .base = {
            .flags     = SPI_TRANS_MULTILINE_CMD | SPI_TRANS_MULTILINE_ADDR |
                         (len && len <= 4 ? SPI_TRANS_USE_TXDATA : 0),
            .cmd       = 0x02,
            .addr      = (uint32_t)reg << 8,
            .length    = len * 8,
        },
    };
    if (len && len <= 4) {
        memcpy((void *)t.base.tx_data, data, len);
    } else {
        t.base.tx_buffer = data;
    }
    ESP_ERROR_CHECK(spi_device_polling_transmit(s_dev, &t.base));
}

static void wr_cmd0(uint8_t reg)               { wr_cmd(reg, NULL, 0); }
static void wr_cmd1(uint8_t reg, uint8_t v)    { wr_cmd(reg, &v, 1);   }

static void wr_window(uint8_t reg, uint16_t a, uint16_t b)
{
    uint8_t d[4] = { a >> 8, a & 0xFF, b >> 8, b & 0xFF };
    wr_cmd(reg, d, 4);
}

/* ---- public API ---------------------------------------------------------- */

esp_err_t amoled_init(void)
{
    /* reset pulse (mirrors Arduino_CO5300::tftInit) */
    gpio_config_t rst_cfg = {
        .pin_bit_mask = 1ULL << BOARD_LCD_RESET,
        .mode         = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&rst_cfg));
    gpio_set_level(BOARD_LCD_RESET, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(BOARD_LCD_RESET, 0);
    vTaskDelay(pdMS_TO_TICKS(200));
    gpio_set_level(BOARD_LCD_RESET, 1);
    vTaskDelay(pdMS_TO_TICKS(200));

    spi_bus_config_t bus_cfg = {
        .sclk_io_num     = BOARD_LCD_SCLK,
        .data0_io_num    = BOARD_LCD_SDIO0,
        .data1_io_num    = BOARD_LCD_SDIO1,
        .data2_io_num    = BOARD_LCD_SDIO2,
        .data3_io_num    = BOARD_LCD_SDIO3,
        .max_transfer_sz = BOARD_LCD_WIDTH * 32 * 2 + 8,
        .flags = SPICOMMON_BUSFLAG_MASTER | SPICOMMON_BUSFLAG_GPIO_PINS |
                 SPICOMMON_BUSFLAG_QUAD,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(QSPI_HOST, &bus_cfg, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev_cfg = {
        .command_bits   = 8,
        .address_bits   = 24,
        .mode           = 0,
        .clock_speed_hz = QSPI_CLOCK_HZ,
        .spics_io_num   = BOARD_LCD_CS,
        .flags          = SPI_DEVICE_HALFDUPLEX,
        .queue_size     = TX_QUEUE_DEPTH,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(QSPI_HOST, &dev_cfg, &s_dev));

    /* init sequence (co5300_init_operations) */
    wr_cmd0(CO5300_C_SLPOUT);
    vTaskDelay(pdMS_TO_TICKS(120));
    wr_cmd1(0xFE, 0x00);                 /* page select                     */
    wr_cmd1(CO5300_W_SPIMODECTL, 0x80);  /* SPI interface control           */
    wr_cmd1(CO5300_W_PIXFMT, 0x55);      /* RGB565                          */
    wr_cmd1(CO5300_W_WCTRLD1, 0x20);     /* brightness control on           */
    wr_cmd1(CO5300_W_BRIGHT_HBM, 0xFF);
    wr_cmd0(CO5300_C_DISPON);
    wr_cmd1(CO5300_W_BRIGHT_NOR, 0xD0);
    wr_cmd1(CO5300_W_WCE, 0x00);         /* contrast enhance off            */
    wr_cmd0(CO5300_C_INVOFF);
    vTaskDelay(pdMS_TO_TICKS(10));

    ESP_LOGI(TAG, "CO5300 up: %dx%d QSPI @%d MHz",
             BOARD_LCD_WIDTH, BOARD_LCD_HEIGHT, QSPI_CLOCK_HZ / 1000000);
    return ESP_OK;
}

void amoled_set_brightness(uint8_t level)
{
    amoled_wait_done();
    wr_cmd1(CO5300_W_BRIGHT_NOR, level);
}

void amoled_frame_begin(void)
{
    amoled_wait_done();
    wr_window(CO5300_W_CASET, BOARD_LCD_COL_OFS,
              BOARD_LCD_COL_OFS + BOARD_LCD_WIDTH - 1);
    wr_window(CO5300_W_PASET, 0, BOARD_LCD_HEIGHT - 1);
    wr_cmd0(CO5300_W_RAMWR);             /* open the RAM write             */
}

void amoled_reserve(void)
{
    while (s_inflight >= TX_INFLIGHT_MAX) {
        spi_transaction_t *done;
        ESP_ERROR_CHECK(spi_device_get_trans_result(s_dev, &done, portMAX_DELAY));
        s_inflight--;
    }
}

void amoled_send_strip(const uint16_t *px, int rows)
{
    amoled_reserve();

    spi_transaction_ext_t *t = &s_tx[s_tx_next];
    s_tx_next = (s_tx_next + 1) % TX_QUEUE_DEPTH;

    memset(t, 0, sizeof(*t));
    t->base.flags     = SPI_TRANS_MODE_QIO;   /* cmd+addr 1 line, data 4    */
    t->base.cmd       = 0x32;
    t->base.addr      = (uint32_t)CO5300_W_WRMC << 8; /* 0x003C00           */
    t->base.length    = (size_t)rows * BOARD_LCD_WIDTH * 16;
    t->base.tx_buffer = px;

    ESP_ERROR_CHECK(spi_device_queue_trans(s_dev, &t->base, portMAX_DELAY));
    s_inflight++;
}

void amoled_wait_done(void)
{
    while (s_inflight > 0) {
        spi_transaction_t *done;
        ESP_ERROR_CHECK(spi_device_get_trans_result(s_dev, &done, portMAX_DELAY));
        s_inflight--;
    }
}
