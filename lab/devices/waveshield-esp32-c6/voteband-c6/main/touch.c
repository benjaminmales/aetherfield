/*
 * touch.c - input for voteband-c6.
 *
 * CST816T capacitive touch (Touch-LCD-1.69 variant): INT-driven, raw I2C
 * register reads - no managed-component dependency. The controller strobes
 * INT (GPIO11) low on touch activity; we then read the 6-byte touch report
 * at register 0x01. There is no touch reset line on this board.
 *
 * BOOT button (both variants, required on the non-touch LCD-1.69):
 * short press cycles the highlighted answer, long press (>=600 ms) commits.
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"

#include "board.h"
#include "touch.h"

static const char *TAG = "input";

#define LONG_PRESS_MS   600
#define TOUCH_DEBOUNCE_MS 150

static touch_callbacks_t s_cbs;

#if BOARD_HAS_TOUCH
static SemaphoreHandle_t s_tp_irq;
static i2c_master_dev_handle_t s_tp_dev;

static void IRAM_ATTR tp_isr(void *arg)
{
    BaseType_t hpw = pdFALSE;
    xSemaphoreGiveFromISR(s_tp_irq, &hpw);
    if (hpw) portYIELD_FROM_ISR();
}

static bool tp_read_report(uint16_t *x, uint16_t *y, uint8_t *fingers)
{
    /* regs 0x01..0x06: gesture, finger_num, xH(+event), xL, yH, yL */
    uint8_t reg = 0x01, d[6] = {0};

    if (i2c_master_transmit_receive(s_tp_dev, &reg, 1, d, sizeof(d),
                                    50 / portTICK_PERIOD_MS) != ESP_OK) {
        return false; /* controller asleep between touches - normal */
    }
    *fingers = d[1] & 0x0F;
    *x = (uint16_t)(((d[2] & 0x0F) << 8) | d[3]);
    *y = (uint16_t)(((d[4] & 0x0F) << 8) | d[5]);
    return true;
}

static void tp_task(void *arg)
{
    bool was_down = false;
    TickType_t last_press = 0;

    while (1) {
        /* Wake on INT; poll briefly afterwards to catch the release. */
        if (!was_down) {
            xSemaphoreTake(s_tp_irq, portMAX_DELAY);
        } else {
            vTaskDelay(pdMS_TO_TICKS(30));
        }

        uint16_t x, y;
        uint8_t fingers = 0;
        if (!tp_read_report(&x, &y, &fingers)) {
            was_down = false;
            continue;
        }

        bool down = fingers > 0;
        if (down && !was_down) {
            TickType_t now = xTaskGetTickCount();
            if ((now - last_press) * portTICK_PERIOD_MS >= TOUCH_DEBOUNCE_MS) {
                last_press = now;
                if (x < BOARD_LCD_H_RES && y < BOARD_LCD_V_RES && s_cbs.on_press) {
                    s_cbs.on_press(x, y);
                }
            }
        }
        was_down = down;
    }
}

static void tp_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1,
        .sda_io_num = BOARD_PIN_I2C_SDA,
        .scl_io_num = BOARD_PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &bus));

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = BOARD_TP_I2C_ADDR,
        .scl_speed_hz = BOARD_I2C_HZ,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dev_cfg, &s_tp_dev));

    /* Best effort: disable auto-sleep (reg 0xFE = 0x01) so taps register
     * without a wake-up double-touch. Fails silently if asleep. */
    uint8_t dis_sleep[2] = {0xFE, 0x01};
    i2c_master_transmit(s_tp_dev, dis_sleep, 2, 50 / portTICK_PERIOD_MS);

    s_tp_irq = xSemaphoreCreateBinary();

    gpio_config_t int_cfg = {
        .pin_bit_mask = 1ULL << BOARD_PIN_TP_INT,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    gpio_config(&int_cfg);
    gpio_install_isr_service(0);
    gpio_isr_handler_add(BOARD_PIN_TP_INT, tp_isr, NULL);

    xTaskCreate(tp_task, "tp", 4096, NULL, 5, NULL);
    ESP_LOGI(TAG, "CST816T ready (INT GPIO%d)", BOARD_PIN_TP_INT);
}
#endif /* BOARD_HAS_TOUCH */

/* BOOT button: cycle / commit ------------------------------------------ */

static void btn_task(void *arg)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << BOARD_PIN_BOOT_BTN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&cfg);

    bool was_down = false;
    TickType_t down_at = 0;
    bool long_fired = false;

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(20));
        bool down = gpio_get_level(BOARD_PIN_BOOT_BTN) == 0;

        if (down && !was_down) {
            down_at = xTaskGetTickCount();
            long_fired = false;
        } else if (down && !long_fired) {
            if ((xTaskGetTickCount() - down_at) * portTICK_PERIOD_MS >= LONG_PRESS_MS) {
                long_fired = true;
                if (s_cbs.on_button_commit) s_cbs.on_button_commit();
            }
        } else if (!down && was_down && !long_fired) {
            if (s_cbs.on_button_cycle) s_cbs.on_button_cycle();
        }
        was_down = down;
    }
}

void input_init(const touch_callbacks_t *cbs)
{
    if (cbs) s_cbs = *cbs;

#if BOARD_HAS_TOUCH
    tp_init();
#endif
    xTaskCreate(btn_task, "btn", 3072, NULL, 5, NULL);

    /* Keep the board powered when running from battery. */
    gpio_config_t bat = {
        .pin_bit_mask = 1ULL << BOARD_PIN_BAT_EN,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&bat);
    gpio_set_level(BOARD_PIN_BAT_EN, 1);
}
