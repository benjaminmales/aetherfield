
ç/*
 * radio.c - Aetherfield v1 over esp_ieee802154 on the ESP32-C6.
 *
 * Mirrors AURA/voteband (nRF52840/Zephyr) behaviour:
 *  - hardware PAN (0xAE7F) + short-address filtering, promiscuous OFF
 *  - identity = 16-bit short address derived from the chip's factory ID
 *    (efuse MAC here, FICR DEVICEID on Nordic - same hash)
 *  - uplink: BEACON / EVENT broadcast to the gateway
 *  - downlink: CMD/NET TLVs, unknown tags skipped, dedupe on (src, seq)
 *  - NET CHANNEL_HOP honoured with countdown
 *
 * On-air check (AURA sniffer): 16-byte beacon frames
 *   41 88 <seq> 7f ae ff ff <src_lo> <src_hi> a7 11 <seq> <caps> <batt> <gesture> <flags>
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_ieee802154.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_log.h"

#include "aura_radio.h"
#include "radio.h"

static const char *TAG = "aura-radio";

#define FCS_LEN         2
#define TX_TIMEOUT_MS   20
#define RX_QUEUE_DEPTH  8
#define DEDUPE_SLOTS    8

typedef struct {
    uint8_t len;                    /* PSDU length incl. FCS */
    uint8_t psdu[AURA_MAX_PSDU];
    int8_t  rssi;
} rx_item_t;

static radio_callbacks_t s_cbs;
static uint16_t s_addr = AURA_ADDR_UNASSIGNED;
static volatile uint8_t s_channel = AURA_CHANNEL_DEFAULT;

static uint8_t s_mac_seq;
static uint8_t s_app_seq;

static SemaphoreHandle_t s_tx_done;
static SemaphoreHandle_t s_tx_lock;
static QueueHandle_t s_rx_queue;

/* Pending channel hop */
static esp_timer_handle_t s_hop_timer;
static volatile uint8_t s_hop_target;

/* -------------------------------------------------------------------- */
/* Identity                                                              */
/* -------------------------------------------------------------------- */

static uint16_t derive_addr(void)
{
    uint8_t mac[8] = {0};
    esp_efuse_mac_get_default(mac);

    uint32_t id0 = (uint32_t)mac[0] | ((uint32_t)mac[1] << 8) |
                   ((uint32_t)mac[2] << 16) | ((uint32_t)mac[3] << 24);
    uint32_t id1 = (uint32_t)mac[4] | ((uint32_t)mac[5] << 8);

    return aura_band_addr_from_deviceid(id0, id1);
}

/* -------------------------------------------------------------------- */
/* TX                                                                    */
/* -------------------------------------------------------------------- */

/* frame[0] = PSDU length (incl. 2-byte FCS filled by hardware) */
static void tx_frame(uint8_t *frame)
{
    xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    xSemaphoreTake(s_tx_done, 0); /* clear any stale token */

    esp_err_t err = esp_ieee802154_transmit(frame, false);
    if (err == ESP_OK) {
        if (xSemaphoreTake(s_tx_done, pdMS_TO_TICKS(TX_TIMEOUT_MS)) != pdTRUE) {
            ESP_LOGW(TAG, "tx done timeout");
        }
    } else {
        ESP_LOGW(TAG, "transmit err %d", err);
    }
    /* Radio returns to RX by itself (rx_when_idle), but be explicit. */
    esp_ieee802154_receive();
    xSemaphoreGive(s_tx_lock);
}

void radio_send_beacon(uint8_t caps, uint8_t battery, uint8_t gesture)
{
    uint8_t buf[1 + AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN + FCS_LEN];

    buf[0] = AURA_MHR_LEN + AURA_HDR_LEN + AURA_BEACON_BODY_LEN + FCS_LEN;
    uint8_t *pl = aura_mhr_write(buf + 1, s_mac_seq++, AURA_ADDR_BROADCAST, s_addr);
    aura_hdr_write(pl, AURA_MSG_BEACON, s_app_seq++);
    pl[AURA_HDR_LEN + 0] = caps;
    pl[AURA_HDR_LEN + 1] = battery;
    pl[AURA_HDR_LEN + 2] = gesture;
    pl[AURA_HDR_LEN + 3] = 0;

    tx_frame(buf);
}

void radio_send_button_event(uint8_t value, int repeats)
{
    uint8_t buf[1 + AURA_MHR_LEN + AURA_HDR_LEN + AURA_EVENT_BODY_LEN + FCS_LEN];
    uint8_t app_seq = s_app_seq++; /* same app seq across repeats -> dedupe */

    for (int i = 0; i < repeats; i++) {
        buf[0] = AURA_MHR_LEN + AURA_HDR_LEN + AURA_EVENT_BODY_LEN + FCS_LEN;
        uint8_t *pl = aura_mhr_write(buf + 1, s_mac_seq++, AURA_ADDR_BROADCAST, s_addr);
        aura_hdr_write(pl, AURA_MSG_EVENT, app_seq);
        pl[AURA_HDR_LEN + 0] = AURA_EVENT_BUTTON;
        pl[AURA_HDR_LEN + 1] = value;
        pl[AURA_HDR_LEN + 2] = 0;

        tx_frame(buf);
        if (i + 1 < repeats) {
            vTaskDelay(pdMS_TO_TICKS(40));
        }
    }
    ESP_LOGI(TAG, "EVENT button=%u sent x%d (seq %u)", value, repeats, app_seq);
}

/* -------------------------------------------------------------------- */
/* RX                                                                    */
/* -------------------------------------------------------------------- */

/* Dedupe repeated broadcast commands on (src, app seq). */
static bool seen_before(uint16_t src, uint8_t seq)
{
    static uint32_t slots[DEDUPE_SLOTS];
    static int next;
    uint32_t key = ((uint32_t)src << 8) | seq | 0x80000000u;

    for (int i = 0; i < DEDUPE_SLOTS; i++) {
        if (slots[i] == key) return true;
    }
    slots[next] = key;
    next = (next + 1) % DEDUPE_SLOTS;
    return false;
}

static void hop_timer_cb(void *arg)
{
    uint8_t ch = s_hop_target;
    esp_ieee802154_set_channel(ch);
    s_channel = ch;
    esp_ieee802154_receive();
    ESP_LOGI(TAG, "hopped to channel %u", ch);
    if (s_cbs.on_channel) s_cbs.on_channel(ch);
}

static void handle_tlvs(const uint8_t *body, int len, bool is_net)
{
    struct aura_tlv t;
    const uint8_t *pos = body;
    const uint8_t *end = body + len;

    while ((pos = aura_tlv_next(pos, end, &t)) != NULL) {
        switch (t.tag) {
        case AURA_TLV_LED:
            if (t.len >= AURA_TLV_LED_LEN && s_cbs.on_led) {
                s_cbs.on_led(t.value[0], t.value[1], t.value[2], t.value[3], t.value[4]);
            }
            break;
        case AURA_TLV_HAPTIC:
            if (t.len >= AURA_TLV_HAPTIC_LEN && s_cbs.on_haptic) {
                s_cbs.on_haptic(t.value[0], t.value[1]);
            }
            break;
        case AURA_TLV_VOTE_CTRL:
            if (t.len >= AURA_TLV_VOTE_CTRL_LEN && s_cbs.on_vote_ctrl) {
                s_cbs.on_vote_ctrl(t.value[0], t.value[1]);
            }
            break;
        case AURA_TLV_GROUP:
            /* POC: no group provisioning yet - apply all CMDs. */
            break;
        case AURA_TLV_CHANNEL_HOP:
            if (is_net && t.len >= AURA_TLV_CHANNEL_HOP_LEN) {
                uint8_t new_ch = t.value[0];
                uint16_t countdown = (uint16_t)(t.value[1] | (t.value[2] << 8));
                s_hop_target = new_ch;
                esp_timer_stop(s_hop_timer);
                esp_timer_start_once(s_hop_timer, (uint64_t)countdown * 1000);
            }
            break;
        case AURA_TLV_TX_POWER:
            if (is_net && t.len >= 1) {
                esp_ieee802154_set_txpower((int8_t)t.value[0]);
            }
            break;
        default:
            break; /* unknown tag: skip - that's the capability mechanism */
        }
    }
}

static void rx_task(void *arg)
{
    rx_item_t item;

    while (xQueueReceive(s_rx_queue, &item, portMAX_DELAY) == pdTRUE) {
        int len = item.len >= FCS_LEN ? item.len - FCS_LEN : 0;
        uint16_t src, dst;

        if (!aura_mhr_parse(item.psdu, len, &src, &dst)) continue;
        if (dst != s_addr && dst != AURA_ADDR_BROADCAST) continue;

        uint8_t seq;
        int type = aura_hdr_parse(item.psdu + AURA_MHR_LEN,
                                  (uint8_t)(len - AURA_MHR_LEN), &seq);
        if (type < 0) continue;
        if (seen_before(src, seq)) continue;

        const uint8_t *body = item.psdu + AURA_MHR_LEN + AURA_HDR_LEN;
        int body_len = len - AURA_MHR_LEN - AURA_HDR_LEN;
        if (body_len < 0) continue;

        switch (type) {
        case AURA_MSG_CMD:
            handle_tlvs(body, body_len, false);
            break;
        case AURA_MSG_NET:
            handle_tlvs(body, body_len, true);
            break;
        default:
            break; /* uplink types - not for us */
        }
    }
}

/* esp_ieee802154 event hooks (ISR context) ---------------------------- */

void esp_ieee802154_receive_done(uint8_t *frame,
                                 esp_ieee802154_frame_info_t *frame_info)
{
    BaseType_t hpw = pdFALSE;
    rx_item_t item;

    item.len = frame[0] > AURA_MAX_PSDU ? AURA_MAX_PSDU : frame[0];
    memcpy(item.psdu, frame + 1, item.len);
    item.rssi = frame_info ? frame_info->rssi : 0;

    xQueueSendFromISR(s_rx_queue, &item, &hpw);
    esp_ieee802154_receive_handle_done(frame);
    if (hpw) portYIELD_FROM_ISR();
}

void esp_ieee802154_transmit_done(const uint8_t *frame, const uint8_t *ack,
                                  esp_ieee802154_frame_info_t *ack_frame_info)
{
    BaseType_t hpw = pdFALSE;
    if (ack) esp_ieee802154_receive_handle_done(ack);
    xSemaphoreGiveFromISR(s_tx_done, &hpw);
    if (hpw) portYIELD_FROM_ISR();
}

void esp_ieee802154_transmit_failed(const uint8_t *frame,
                                    esp_ieee802154_tx_error_t error)
{
    BaseType_t hpw = pdFALSE;
    xSemaphoreGiveFromISR(s_tx_done, &hpw);
    if (hpw) portYIELD_FROM_ISR();
}

/* -------------------------------------------------------------------- */
/* Init                                                                  */
/* -------------------------------------------------------------------- */

uint8_t radio_channel(void)
{
    return s_channel;
}

uint16_t radio_init(const radio_callbacks_t *cbs)
{
    if (cbs) s_cbs = *cbs;

    s_tx_done = xSemaphoreCreateBinary();
    s_tx_lock = xSemaphoreCreateMutex();
    s_rx_queue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(rx_item_t));

    const esp_timer_create_args_t hop_args = {
        .callback = hop_timer_cb,
        .name = "aura_hop",
    };
    ESP_ERROR_CHECK(esp_timer_create(&hop_args, &s_hop_timer));

    s_addr = derive_addr();

    ESP_ERROR_CHECK(esp_ieee802154_enable());
    ESP_ERROR_CHECK(esp_ieee802154_set_channel(AURA_CHANNEL_DEFAULT));
    ESP_ERROR_CHECK(esp_ieee802154_set_panid(AURA_PAN_ID));
    ESP_ERROR_CHECK(esp_ieee802154_set_short_address(s_addr));
    ESP_ERROR_CHECK(esp_ieee802154_set_promiscuous(false));
    ESP_ERROR_CHECK(esp_ieee802154_set_coordinator(false));
    ESP_ERROR_CHECK(esp_ieee802154_set_rx_when_idle(true));
    esp_ieee802154_set_txpower(AURA_TX_POWER_DBM);
    ESP_ERROR_CHECK(esp_ieee802154_receive());

    xTaskCreate(rx_task, "aura_rx", 4096, NULL, 10, NULL);

    ESP_LOGI(TAG, "up: addr=0x%04X pan=0x%04X ch=%u", s_addr, AURA_PAN_ID,
             s_channel);
    return s_addr;
}
