/*
 * Aetherfield voteband-c6 - 4-option audience voting band
 * Target: Waveshare ESP32-C6-Touch-LCD-1.69 (ESP32-C6, 802.15.4)
 *
 * Behaviour (mirrors AURA/voteband, extended to 4 options):
 *  - broadcasts a v1 BEACON 1x/sec; the gesture byte carries the current
 *    vote (0 = none, 1..4 = A..D), so the gateway re-syncs missed events
 *  - tapping an answer sends EVENT type=BUTTON value=1..4, repeated 3x
 *    with one app seq (gateway dedupes on (src, seq))
 *  - listens for broadcast CMD (LED accent / VOTE_CTRL round reset) and
 *    NET (CHANNEL_HOP, TX_POWER) from the gateway
 *
 * Route: this band -> nRF54 gateway -> pi-bridge (serial) -> /votes page.
 */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_log.h"

#include "aura_radio.h"
#include "board.h"
#include "radio.h"
#include "ui.h"
#include "touch.h"

static const char *TAG = "voteband-c6";

#define BEACON_INTERVAL_MS 1000
#define EVENT_REPEATS      3

/* This board: touch "button", 6-axis IMU, microphone. */
#define VOTEBAND_C6_CAPS   (AURA_CAP_BUTTON | AURA_CAP_IMU | AURA_CAP_MIC)

static void beacon_cb(void *arg)
{
    radio_send_beacon(VOTEBAND_C6_CAPS, AURA_BATTERY_UNKNOWN,
                      ui_get_selected());
}

/* --- vote casting ------------------------------------------------------ */

static void cast_vote(uint8_t option)
{
    ui_set_selected(option);
    radio_send_button_event(option, EVENT_REPEATS);
    ui_flash_sent(option);
}

static void on_press(uint16_t x, uint16_t y)
{
    uint8_t option = ui_hit_test(x, y);
    ESP_LOGI(TAG, "touch (%u,%u) -> option %u", x, y, option);
    if (option) cast_vote(option);
}

static void on_button_cycle(void)
{
    ui_cycle_selected();
}

static void on_button_commit(void)
{
    uint8_t sel = ui_get_selected();
    if (sel) cast_vote(sel);
}

/* --- downlink ----------------------------------------------------------- */

static void on_led(uint8_t mode, uint8_t rate, uint8_t r, uint8_t g, uint8_t b)
{
    ESP_LOGI(TAG, "CMD LED mode=%u rate=%u rgb=(%u,%u,%u)", mode, rate, r, g, b);
    ui_accent(r, g, b);
}

static void on_haptic(uint8_t pattern, uint8_t intensity)
{
    /* No vibration motor on this board - pulse the selected button. */
    uint8_t sel = ui_get_selected();
    if (sel) ui_flash_sent(sel);
}

static void on_vote_ctrl(uint8_t action, uint8_t round_id)
{
    ESP_LOGI(TAG, "CMD VOTE_CTRL action=%u round=%u", action, round_id);
    if (action == AURA_VOTE_OPEN) {
        ui_clear_vote();
    }
    /* AURA_VOTE_CLOSE: keep showing the final choice. */
}

static void on_channel(uint8_t new_channel)
{
    ui_set_channel(new_channel);
}

void app_main(void)
{
    static const radio_callbacks_t radio_cbs = {
        .on_led = on_led,
        .on_haptic = on_haptic,
        .on_vote_ctrl = on_vote_ctrl,
        .on_channel = on_channel,
    };
    static const touch_callbacks_t input_cbs = {
        .on_press = on_press,
        .on_button_cycle = on_button_cycle,
        .on_button_commit = on_button_commit,
    };

    uint16_t addr = radio_init(&radio_cbs);
    ui_init(addr, radio_channel());
    input_init(&input_cbs);

    const esp_timer_create_args_t beacon_args = {
        .callback = beacon_cb,
        .name = "aura_beacon",
    };
    esp_timer_handle_t beacon_timer;
    ESP_ERROR_CHECK(esp_timer_create(&beacon_args, &beacon_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(beacon_timer,
                                             BEACON_INTERVAL_MS * 1000ULL));

    ESP_LOGI(TAG, "voteband-c6 up: addr=0x%04X ch=%u caps=0x%02X",
             addr, radio_channel(), VOTEBAND_C6_CAPS);
}
