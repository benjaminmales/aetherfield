/* gfx.h - minimal ST7789 drawing layer (no LVGL) */
#ifndef VOTEBAND_GFX_H
#define VOTEBAND_GFX_H

#include <stdint.h>

/* RGB888 -> RGB565, pre-byte-swapped for the ST7789 SPI byte order. */
static inline uint16_t gfx_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    uint16_t c = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
    return (uint16_t)((c >> 8) | (c << 8));
}

void gfx_init(void);
void gfx_fill_rect(int x, int y, int w, int h, uint16_t color);
/* Rounded rectangle (corner radius r), filled. */
void gfx_fill_round_rect(int x, int y, int w, int h, int r, uint16_t color);
void gfx_fill_screen(uint16_t color);
/* 5x7 font scaled by `scale`; draws opaque cells of (6*scale x 8*scale). */
void gfx_text(int x, int y, const char *s, int scale, uint16_t fg, uint16_t bg);
int  gfx_text_width(const char *s, int scale);

#endif
