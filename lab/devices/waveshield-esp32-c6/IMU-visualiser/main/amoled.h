/* amoled.h — minimal CO5300 QSPI driver (Waveshare ESP32-C6-Touch-AMOLED-2.06) */
#pragma once

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

esp_err_t amoled_init(void);

/* 0x00 (off) .. 0xFF (max) */
void amoled_set_brightness(uint8_t level);

/* Begin a full-screen frame: sets the address window and issues RAMWR.
 * Follow with amoled_send_strip() calls covering all rows top-to-bottom. */
void amoled_frame_begin(void);

/* Block until fewer than the max in-flight DMA transfers remain queued.
 * Call before re-rendering into a ping-pong buffer: it guarantees the
 * buffer's previous transfer has fully completed. */
void amoled_reserve(void);

/* Queue one strip of pixels (RGB565, big-endian / byte-swapped) for DMA.
 * `px` must be DMA-capable and stay valid until amoled_wait_done().
 * rows*BOARD_LCD_WIDTH*2 bytes are sent. Returns after queueing. */
void amoled_send_strip(const uint16_t *px, int rows);

/* Block until every queued strip has finished transmitting. */
void amoled_wait_done(void);
