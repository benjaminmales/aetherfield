/*
 * ui.c - millionaire-style 2x2 answer grid on the 240x280 panel.
 *
 * Layout (portrait, USB at the bottom):
 *   [0..35]    header: short address + channel, accent underline
 *   [44..280]  2x2 grid of answer buttons A/B/C/D
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "board.h"
#include "gfx.h"
#include "ui.h"

#define HDR_H     36
#define MARGIN    8
#define BTN_W     ((BOARD_LCD_H_RES - 3 * MARGIN) / 2)          /* 108 */
#define BTN_H     ((BOARD_LCD_V_RES - HDR_H - 3 * MARGIN) / 2)  /* 110 */
#define BORDER    4
#define BTN_RADIUS 28   /* corner radius - bump towards BTN_H/2 for full pills */

static const char *k_labels[4] = {"A", "B", "C", "D"};

static uint16_t s_col_bg;
static uint16_t s_col_hdr;
static uint16_t s_col_text;
static uint16_t s_btn_col[4];

static uint8_t s_selected;   /* 0 none, 1..4 */
static uint16_t s_addr;
static uint8_t s_channel;
static SemaphoreHandle_t s_lock;

static void btn_rect(int n /*0..3*/, int *x, int *y)
{
    *x = MARGIN + (n % 2) * (BTN_W + MARGIN);
    *y = HDR_H + MARGIN + (n / 2) * (BTN_H + MARGIN);
}

static void draw_button(int n, bool selected, bool flash)
{
    int x, y;
    btn_rect(n, &x, &y);

    uint16_t fill = flash ? gfx_rgb(255, 255, 255) : s_btn_col[n];
    uint16_t border = selected ? gfx_rgb(255, 255, 255) : s_col_bg;
    uint16_t label = flash ? s_btn_col[n] : gfx_rgb(255, 255, 255);

    gfx_fill_round_rect(x, y, BTN_W, BTN_H, BTN_RADIUS, border);
    gfx_fill_round_rect(x + BORDER, y + BORDER,
                        BTN_W - 2 * BORDER, BTN_H - 2 * BORDER,
                        BTN_RADIUS - BORDER, fill);

    int scale = 6; /* 36x48 glyph */
    int tx = x + (BTN_W - 6 * scale) / 2;
    int ty = y + (BTN_H - 8 * scale) / 2;
    gfx_text(tx, ty, k_labels[n], scale, label, fill);
}

static void draw_header(void)
{
    char line[32];

    gfx_fill_rect(0, 0, BOARD_LCD_H_RES, HDR_H, s_col_hdr);
    snprintf(line, sizeof(line), "0X%04X CH%02u", s_addr, s_channel);
    int w = gfx_text_width(line, 2);
    gfx_text((BOARD_LCD_H_RES - w) / 2, 8, line, 2, s_col_text, s_col_hdr);
}

void ui_init(uint16_t addr, uint8_t channel)
{
    s_lock = xSemaphoreCreateMutex();
    s_addr = addr;
    s_channel = channel;

    s_col_bg = gfx_rgb(8, 12, 40);       /* midnight blue */
    s_col_hdr = gfx_rgb(16, 24, 70);
    s_col_text = gfx_rgb(220, 225, 255);
    s_btn_col[0] = gfx_rgb(198, 40, 40);   /* A red */
    s_btn_col[1] = gfx_rgb(21, 101, 192);  /* B blue */
    s_btn_col[2] = gfx_rgb(249, 168, 37);  /* C amber */
    s_btn_col[3] = gfx_rgb(46, 125, 50);   /* D green */

    gfx_init();

    xSemaphoreTake(s_lock, portMAX_DELAY);
    gfx_fill_screen(s_col_bg);
    draw_header();
    for (int i = 0; i < 4; i++) draw_button(i, false, false);
    xSemaphoreGive(s_lock);
}

uint8_t ui_hit_test(uint16_t x, uint16_t y)
{
    for (int n = 0; n < 4; n++) {
        int bx, by;
        btn_rect(n, &bx, &by);
        if (x >= bx && x < bx + BTN_W && y >= by && y < by + BTN_H) {
            return (uint8_t)(n + 1);
        }
    }
    return 0;
}

void ui_set_selected(uint8_t sel)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    uint8_t prev = s_selected;
    s_selected = sel;
    if (prev && prev != sel) draw_button(prev - 1, false, false);
    if (sel) draw_button(sel - 1, true, false);
    xSemaphoreGive(s_lock);
}

uint8_t ui_get_selected(void)
{
    return s_selected;
}

void ui_cycle_selected(void)
{
    ui_set_selected((uint8_t)(s_selected % 4 + 1));
}

void ui_flash_sent(uint8_t n)
{
    if (!n) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    draw_button(n - 1, true, true);
    xSemaphoreGive(s_lock);
    vTaskDelay(pdMS_TO_TICKS(120));
    xSemaphoreTake(s_lock, portMAX_DELAY);
    draw_button(n - 1, n == s_selected, false);
    xSemaphoreGive(s_lock);
}

void ui_set_channel(uint8_t channel)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_channel = channel;
    draw_header();
    xSemaphoreGive(s_lock);
}

void ui_accent(uint8_t r, uint8_t g, uint8_t b)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    gfx_fill_rect(0, HDR_H - 4, BOARD_LCD_H_RES, 4, gfx_rgb(r, g, b));
    xSemaphoreGive(s_lock);
}

void ui_clear_vote(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    uint8_t prev = s_selected;
    s_selected = 0;
    if (prev) draw_button(prev - 1, false, false);
    xSemaphoreGive(s_lock);
}
