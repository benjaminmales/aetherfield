/*
 * board.h — Waveshare ESP32-C6-Touch-AMOLED-2.06 pin map
 *
 * Verified against Waveshare's official demo repo
 * (github.com/waveshareteam/ESP32-C6-Touch-AMOLED-2.06,
 *  examples/Arduino-v3.3.0/libraries/Mylibrary/pin_config.h)
 * and the wiki: https://www.waveshare.com/wiki/ESP32-C6-Touch-AMOLED-2.06
 *
 * Display : CO5300 AMOLED, 410x502, QSPI, RGB565 (pixel column offset 22)
 * Touch   : FT3168 (I2C, unused here)
 * IMU     : QMI8658 @ 0x6B (I2C)
 * RTC     : PCF85063 (I2C, unused)
 * PMU     : AXP2101 (I2C, defaults power the panel — no init required)
 */
#pragma once

/* --- CO5300 AMOLED over QSPI ------------------------------------------- */
#define BOARD_LCD_SCLK      0
#define BOARD_LCD_SDIO0     1
#define BOARD_LCD_SDIO1     2
#define BOARD_LCD_SDIO2     3
#define BOARD_LCD_SDIO3     4
#define BOARD_LCD_CS        5
#define BOARD_LCD_RESET     11

#define BOARD_LCD_WIDTH     410
#define BOARD_LCD_HEIGHT    502
#define BOARD_LCD_COL_OFS   22   /* CASET offset — panel RAM starts at column 22 */

/* --- shared I2C bus ------------------------------------------------------ */
#define BOARD_IIC_SDA       8
#define BOARD_IIC_SCL       7

#define BOARD_QMI8658_ADDR  0x6B /* QMI8658_L_SLAVE_ADDRESS */

/* --- touch (unused, for reference) -------------------------------------- */
#define BOARD_TP_INT        15
#define BOARD_TP_RESET      10
