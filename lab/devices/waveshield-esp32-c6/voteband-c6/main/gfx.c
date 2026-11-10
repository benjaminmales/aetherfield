/*
 * gfx.c - ST7789V2 bring-up + minimal drawing for voteband-c6.
 *
 * Uses the esp_lcd built-in ST7789 driver. Panel quirks (from Waveshare's
 * BSP): colour inversion ON (IPS), 240x280 window with a 20px Y gap,
 * rotation 0 = portrait, USB connector at the bottom.
 */
#include <string.h>
#include <assert.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "board.h"
#include "gfx.h"
#include "font5x7.h"

#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "gfx";

/* Strip buffer: full width x 40 rows, DMA-capable. 240*40*2 = 18.75 KB */
#define STRIP_ROWS 40

static esp_lcd_panel_handle_t s_panel;
static uint16_t *s_strip;
static SemaphoreHandle_t s_flush_done;

/* draw_bitmap queues an async DMA transfer; we must not touch s_strip again
 * until the panel IO signals completion, or in-flight pixels get stomped. */
static bool flush_done_cb(esp_lcd_panel_io_handle_t io,
                          esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    BaseType_t hpw = pdFALSE;
    xSemaphoreGiveFromISR(s_flush_done, &hpw);
    return hpw == pdTRUE;
}

static void blit(int x, int y, int w, int h, const uint16_t *buf)
{
    esp_lcd_panel_draw_bitmap(s_panel, x, y, x + w, y + h, buf);
    xSemaphoreTake(s_flush_done, pdMS_TO_TICKS(250));
}

static int isqrt(int v)
{
    int r = 0;
    while ((r + 1) * (r + 1) <= v) r++;
    return r;
}

void gfx_init(void)
{
    spi_bus_config_t buscfg = {
        .sclk_io_num = BOARD_PIN_SCLK,
        .mosi_io_num = BOARD_PIN_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = BOARD_LCD_H_RES * STRIP_ROWS * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(BOARD_LCD_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO));

    s_flush_done = xSemaphoreCreateBinary();

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = BOARD_PIN_LCD_CS,
        .dc_gpio_num = BOARD_PIN_LCD_DC,
        .spi_mode = 0,
        .pclk_hz = BOARD_LCD_PIXEL_HZ,
        .trans_queue_depth = 10,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .on_color_trans_done = flush_done_cb,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(
        (esp_lcd_spi_bus_handle_t)BOARD_LCD_SPI_HOST, &io_config, &io));

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = BOARD_PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &panel_config, &s_panel));

    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(s_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(s_panel, BOARD_LCD_GAP_X, BOARD_LCD_GAP_Y));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(s_panel, false, false));

    s_strip = heap_caps_malloc(BOARD_LCD_H_RES * STRIP_ROWS * 2,
                               MALLOC_CAP_DMA | MALLOC_CAP_8BIT);
    assert(s_strip);

    gfx_fill_screen(0x0000);
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));

    /* Backlight full on (PWM dimming not needed for the POC). */
    gpio_config_t bl = {
        .pin_bit_mask = 1ULL << BOARD_PIN_LCD_BL,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&bl);
    gpio_set_level(BOARD_PIN_LCD_BL, 1);

    ESP_LOGI(TAG, "ST7789 up (%dx%d)", BOARD_LCD_H_RES, BOARD_LCD_V_RES);
}

void gfx_fill_rect(int x, int y, int w, int h, uint16_t color)
{
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > BOARD_LCD_H_RES) w = BOARD_LCD_H_RES - x;
    if (y + h > BOARD_LCD_V_RES) h = BOARD_LCD_V_RES - y;
    if (w <= 0 || h <= 0) return;

    for (int i = 0; i < w * (h > STRIP_ROWS ? STRIP_ROWS : h); i++) {
        s_strip[i] = color;
    }
    int row = y;
    while (row < y + h) {
        int rows = y + h - row;
        if (rows > STRIP_ROWS) rows = STRIP_ROWS;
        blit(x, row, w, rows, s_strip);
        row += rows;
    }
}

void gfx_fill_round_rect(int x, int y, int w, int h, int r, uint16_t color)
{
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    if (r <= 0) {
        gfx_fill_rect(x, y, w, h, color);
        return;
    }

    /* centre slab */
    gfx_fill_rect(x, y + r, w, h - 2 * r, color);

    /* corner rows: horizontal span per row from the circle equation */
    for (int i = 0; i < r; i++) {
        /* distance from the corner-circle centre, at row-centre precision */
        int dy2 = (2 * (r - i) - 1) * (2 * (r - i) - 1);
        int span = isqrt(4 * r * r - dy2) / 2;   /* 0..r */
        int inset = r - span;
        gfx_fill_rect(x + inset, y + i, w - 2 * inset, 1, color);
        gfx_fill_rect(x + inset, y + h - 1 - i, w - 2 * inset, 1, color);
    }
}

void gfx_fill_screen(uint16_t color)
{
    gfx_fill_rect(0, 0, BOARD_LCD_H_RES, BOARD_LCD_V_RES, color);
}

int gfx_text_width(const char *s, int scale)
{
    return (int)strlen(s) * 6 * scale;
}

void gfx_text(int x, int y, const char *s, int scale, uint16_t fg, uint16_t bg)
{
    for (; *s; s++, x += 6 * scale) {
        char c = *s;
        if (c >= 'a' && c <= 'z') c -= 32; /* uppercase-only font */
        if (c < FONT5X7_FIRST || c > FONT5X7_LAST) c = '?';
        const uint8_t *glyph = font5x7[c - FONT5X7_FIRST];

        int cw = 6 * scale, ch = 8 * scale;
        if (cw * ch > BOARD_LCD_H_RES * STRIP_ROWS) return; /* scale too big */

        for (int col = 0; col < 6; col++) {
            uint8_t bits = (col < 5) ? glyph[col] : 0;
            for (int rowb = 0; rowb < 8; rowb++) {
                uint16_t px = ((bits >> rowb) & 1) ? fg : bg;
                for (int sx = 0; sx < scale; sx++) {
                    for (int sy = 0; sy < scale; sy++) {
                        int cx = col * scale + sx;
                        int cy = rowb * scale + sy;
                        s_strip[cy * cw + cx] = px;
                    }
                }
            }
        }
        if (x + cw <= 0 || x >= BOARD_LCD_H_RES) continue;
        blit(x, y, cw, ch, s_strip);
    }
}
