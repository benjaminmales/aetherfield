/*
 * board.h - Waveshare ESP32-C6 1.69" board definitions
 *
 * Pin map taken from Waveshare's own ESP-IDF BSP
 * (github.com/waveshareteam/ESP32-C6-Touch-LCD-1.69, components/esp_bsp).
 *
 * Two board variants share this map:
 *   ESP32-C6-Touch-LCD-1.69  (CST816T touch)  -> BOARD_HAS_TOUCH 1
 *   ESP32-C6-LCD-1.69        (no touch panel) -> BOARD_HAS_TOUCH 0
 *     (BOOT button cycles the highlighted answer, long-press casts the vote)
 */
#ifndef VOTEBAND_BOARD_H
#define VOTEBAND_BOARD_H

#include "driver/gpio.h"

#ifndef BOARD_HAS_TOUCH
#define BOARD_HAS_TOUCH      1
#endif

/* --- LCD: ST7789V2, 240x280, 4-wire SPI ------------------------------- */
#define BOARD_LCD_SPI_HOST   SPI2_HOST
#define BOARD_LCD_PIXEL_HZ   (40 * 1000 * 1000)
#define BOARD_PIN_SCLK       GPIO_NUM_1
#define BOARD_PIN_MOSI       GPIO_NUM_2
#define BOARD_PIN_LCD_DC     GPIO_NUM_3
#define BOARD_PIN_LCD_RST    GPIO_NUM_4
#define BOARD_PIN_LCD_CS     GPIO_NUM_5
#define BOARD_PIN_LCD_BL     GPIO_NUM_6

#define BOARD_LCD_H_RES      240   /* portrait, rotation 0 */
#define BOARD_LCD_V_RES      280
#define BOARD_LCD_GAP_X      0     /* 240x280 window on the 240x320 ST7789 */
#define BOARD_LCD_GAP_Y      20

/* --- I2C bus (CST816T touch, QMI8658 IMU, PCF85063 RTC) ---------------- */
#define BOARD_PIN_I2C_SDA    GPIO_NUM_8
#define BOARD_PIN_I2C_SCL    GPIO_NUM_7
#define BOARD_I2C_HZ         400000

/* --- CST816T touch ------------------------------------------------------ */
#define BOARD_PIN_TP_INT     GPIO_NUM_11
#define BOARD_TP_I2C_ADDR    0x15

/* --- Buttons / power ---------------------------------------------------- */
#define BOARD_PIN_BOOT_BTN   GPIO_NUM_9    /* active low */
#define BOARD_PIN_PWR_KEY    GPIO_NUM_18   /* active low, side button */
#define BOARD_PIN_BAT_EN     GPIO_NUM_15   /* hold high to stay on from battery */

#endif /* VOTEBAND_BOARD_H */
