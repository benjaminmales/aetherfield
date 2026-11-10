/*
 * AURA IMU-visualiser — a living gradient orb driven by motion.
 *
 * Mapping (tuned for organic feel, not literal readouts):
 *   - tilt (gravity direction)  -> the glow hot-spot rolls around the orb,
 *                                  with spring inertia + overshoot
 *   - wrist rotation (gyro z)   -> tangential swirl on the hot-spot
 *   - motion energy             -> the orb blooms: radius, glow reach and
 *                                  intensity swell, then settle slowly
 *   - face-down flip            -> palettes crossfade (orange bg / cyan glow
 *                                  <-> cyan bg / orange glow), as in the refs
 *   - stillness                 -> slow breathing + lissajous drift
 */
#include <math.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

#include "board.h"
#include "amoled.h"
#include "qmi8658.h"
#include "orb.h"

static const char *TAG = "imu-viz";

#define STRIP_ROWS 16              /* 410*16*2 = 13120 B per DMA strip */

/* ------- palettes (sampled from the Figma reference frames) -------------- */
typedef struct { uint8_t r, g, b; } rgb_t;

static const rgb_t PAL_A_BG  = { 0xFF, 0x6C, 0x11 };  /* vivid orange   */
static const rgb_t PAL_A_HOT = { 0x4F, 0xE9, 0xFF };  /* electric cyan  */
static const rgb_t PAL_B_BG  = { 0x4F, 0xE9, 0xFF };
static const rgb_t PAL_B_HOT = { 0xFF, 0x6C, 0x11 };

static inline float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}
static inline float mixf(float a, float b, float t) { return a + (b - a) * t; }

static inline rgb_t mix_rgb(rgb_t a, rgb_t b, float t)
{
    rgb_t o = {
        (uint8_t)(a.r + (b.r - a.r) * t + 0.5f),
        (uint8_t)(a.g + (b.g - a.g) * t + 0.5f),
        (uint8_t)(a.b + (b.b - a.b) * t + 0.5f),
    };
    return o;
}

/* the muted sage body colour in the refs = the two accents blended and
 * desaturated, so it stays harmonious through the palette crossfade */
static rgb_t body_from(rgb_t bg, rgb_t hot)
{
    float r = mixf(hot.r, bg.r, 0.52f);
    float g = mixf(hot.g, bg.g, 0.52f);
    float b = mixf(hot.b, bg.b, 0.52f);
    float l = (r + g + b) / 3.0f;
    r = mixf(r, l, 0.45f) * 0.92f;
    g = mixf(g, l, 0.45f) * 0.92f;
    b = mixf(b, l, 0.45f) * 0.92f;
    rgb_t o = { (uint8_t)r, (uint8_t)g, (uint8_t)b };
    return o;
}

/* ------------------------- animation state ------------------------------- */
typedef struct {
    float glp[3];        /* low-passed gravity (g)             */
    float energy;        /* motion-energy envelope 0..~1       */
    float ox, oy;        /* orb centre offset from screen mid  */
    float ovx, ovy;      /* orb centre velocity                */
    float hx, hy;        /* hot-spot position (px)             */
    float hvx, hvy;      /* hot-spot velocity                  */
    float pal;           /* palette crossfade 0..1             */
    float pal_target;
    float t;             /* seconds since boot                 */
    int   imu_ok;
} anim_t;

/* orb-centre travel limits (keeps the orb on screen when bloomed) */
#define ORB_TRAVEL_X 92.0f
#define ORB_TRAVEL_Y 128.0f

static void anim_step(anim_t *s, const qmi8658_sample_t *m, float dt)
{
    s->t += dt;

    /* The QMI8658 is mounted 90 deg rotated relative to the screen, so
     * rotate IMU x/y into screen coordinates (x right, y down) here.
     * If a future build lands rotated the other way, negate ay/gx_s
     * instead of ax/gy_s. */
    float ax = m->ay, ay = -m->ax, az = m->az;
    float gx_s = m->gy, gy_s = -m->gx;          /* gyro, same rotation */

    /* gravity low-pass (tracks faster while rotating) */
    float gyro_mag = fabsf(m->gx) + fabsf(m->gy) + fabsf(m->gz);
    float alpha = clampf(0.06f + gyro_mag * 0.0008f, 0.06f, 0.35f);
    s->glp[0] = mixf(s->glp[0], ax, alpha);
    s->glp[1] = mixf(s->glp[1], ay, alpha);
    s->glp[2] = mixf(s->glp[2], az, alpha);

    /* motion energy: linear acceleration magnitude, fast attack slow decay */
    float lx = ax - s->glp[0], ly = ay - s->glp[1], lz = az - s->glp[2];
    float e = clampf(sqrtf(lx * lx + ly * ly + lz * lz) * 1.4f, 0.0f, 1.0f);
    s->energy = (e > s->energy) ? mixf(s->energy, e, 0.5f)
                                : mixf(s->energy, e, 0.035f);

    /* palette flips when the watch is turned face-down (with hysteresis) */
    if (s->glp[2] < -0.40f) s->pal_target = 1.0f;
    if (s->glp[2] >  0.40f) s->pal_target = 0.0f;
    s->pal = mixf(s->pal, s->pal_target, clampf(dt * 2.2f, 0.0f, 1.0f));

    /* --- orb centre rides the gyro: wrist flicks throw the whole circle,
     *     a soft spring pulls it back to the middle ----------------------- */
    /* rotation about the IMU's Y axis slides the orb in screen-x, about X
     * in screen-y (swap/flip signs here if the wrist feel is inverted) */
    s->ovx += gy_s * 6.0f * dt;                 /* dps -> px/s^2 kick */
    s->ovy += gx_s * 6.0f * dt;
    const float ko = 14.0f, co = 5.0f;          /* return spring     */
    s->ovx += (-ko * s->ox - co * s->ovx) * dt;
    s->ovy += (-ko * s->oy - co * s->ovy) * dt;
    s->ox += s->ovx * dt;
    s->oy += s->ovy * dt;
    s->ox = clampf(s->ox, -ORB_TRAVEL_X, ORB_TRAVEL_X);
    s->oy = clampf(s->oy, -ORB_TRAVEL_Y, ORB_TRAVEL_Y);

    /* --- hot-spot: springs toward the "bubble" point opposite gravity ---- */
    const float cx = BOARD_LCD_WIDTH * 0.5f + s->ox;
    const float cy = BOARD_LCD_HEIGHT * 0.52f + s->oy;
    float gx = s->glp[0], gy = s->glp[1];
    float gn = sqrtf(gx * gx + gy * gy) + 1e-4f;
    float lean = clampf(gn, 0.0f, 1.0f);

    float R = 110.0f * (1.0f + 0.05f * sinf(s->t * 0.63f))
                     * (1.0f + 0.42f * s->energy);

    /* idle lissajous drift keeps it alive when perfectly still */
    float idle = (1.0f - s->energy) * (1.0f - lean);
    float tx = cx - (gx / gn) * lean * R * 0.55f
                  + idle * 22.0f * sinf(s->t * 0.31f);
    float ty = cy + (gy / gn) * lean * R * 0.55f
                  + idle * 22.0f * cosf(s->t * 0.23f);

    /* spring-damper with gyro-z swirl for organic overshoot */
    float k = 26.0f, c = 7.5f;
    s->hvx += (k * (tx - s->hx) - c * s->hvx) * dt - m->gz * 0.55f * (ty - cy) * dt * 0.06f;
    s->hvy += (k * (ty - s->hy) - c * s->hvy) * dt + m->gz * 0.55f * (tx - cx) * dt * 0.06f;
    s->hx += s->hvx * dt;
    s->hy += s->hvy * dt;

    /* keep the hot-spot inside the orb */
    float ox = s->hx - cx, oy = s->hy - cy;
    float od = sqrtf(ox * ox + oy * oy);
    float omax = R * 0.62f;
    if (od > omax) { s->hx = cx + ox / od * omax; s->hy = cy + oy / od * omax; }
}

static void anim_to_params(const anim_t *s, orb_params_t *p)
{
    float R = 110.0f * (1.0f + 0.05f * sinf(s->t * 0.63f))
                     * (1.0f + 0.42f * s->energy);

    rgb_t bg   = mix_rgb(PAL_A_BG, PAL_B_BG, s->pal);
    rgb_t hot  = mix_rgb(PAL_A_HOT, PAL_B_HOT, s->pal);
    rgb_t body = body_from(bg, hot);

    p->width  = BOARD_LCD_WIDTH;
    p->height = BOARD_LCD_HEIGHT;
    p->bg_r = bg.r;     p->bg_g = bg.g;     p->bg_b = bg.b;
    p->hot_r = hot.r;   p->hot_g = hot.g;   p->hot_b = hot.b;
    p->body_r = body.r; p->body_g = body.g; p->body_b = body.b;

    p->cx_q8     = ORB_F(BOARD_LCD_WIDTH * 0.5f + s->ox);
    p->cy_q8     = ORB_F(BOARD_LCD_HEIGHT * 0.52f + s->oy);
    p->radius_q8 = ORB_F(R);
    p->edge_q8   = ORB_F(3.5f);
    p->hx_q8     = ORB_F(s->hx);
    p->hy_q8     = ORB_F(s->hy);
    p->glow_q8   = ORB_F(R * (0.95f + 0.45f * s->energy));
    p->glow_gain = (uint8_t)(185.0f + 70.0f * s->energy);
}

/* synthetic motion if the IMU is missing, so the visual still runs */
static void demo_sample(float t, qmi8658_sample_t *m)
{
    m->ax = 0.35f * sinf(t * 0.7f);
    m->ay = 0.35f * cosf(t * 0.5f);
    m->az = cosf(t * 0.1f) > 0 ? 0.9f : -0.9f;
    m->gx = 45.0f * sinf(t * 0.9f);
    m->gy = 45.0f * cosf(t * 0.6f);
    m->gz = 30.0f * sinf(t * 0.4f);
}

void app_main(void)
{
    ESP_ERROR_CHECK(amoled_init());

    anim_t st = {
        .glp = { 0, 0, 1 },
        .hx = BOARD_LCD_WIDTH * 0.5f,
        .hy = BOARD_LCD_HEIGHT * 0.35f,
        .imu_ok = (qmi8658_init() == ESP_OK),
    };
    if (!st.imu_ok) {
        ESP_LOGW(TAG, "QMI8658 unavailable — running demo motion");
    }

    const size_t strip_bytes = (size_t)BOARD_LCD_WIDTH * STRIP_ROWS * 2;
    uint16_t *buf[2] = {
        heap_caps_malloc(strip_bytes, MALLOC_CAP_DMA),
        heap_caps_malloc(strip_bytes, MALLOC_CAP_DMA),
    };
    configASSERT(buf[0] && buf[1]);

    orb_params_t prm;
    int64_t t_prev = esp_timer_get_time();
    int64_t t_fps  = t_prev;
    int frames = 0;

    for (;;) {
        int64_t now = esp_timer_get_time();
        float dt = clampf((now - t_prev) / 1e6f, 0.001f, 0.1f);
        t_prev = now;

        qmi8658_sample_t m;
        if (!st.imu_ok || qmi8658_read(&m) != ESP_OK) {
            demo_sample(st.t, &m);
        }

        anim_step(&st, &m, dt);
        anim_to_params(&st, &prm);

        orb_begin_frame(&prm);
        amoled_frame_begin();

        int i = 0;
        for (int y = 0; y < BOARD_LCD_HEIGHT; y += STRIP_ROWS, i++) {
            int rows = BOARD_LCD_HEIGHT - y;
            if (rows > STRIP_ROWS) rows = STRIP_ROWS;
            uint16_t *b = buf[i & 1];
            amoled_reserve();                     /* b's previous DMA done */
            orb_render_strip(&prm, y, rows, b);   /* overlaps current DMA  */
            amoled_send_strip(b, rows);
        }
        amoled_wait_done();

        frames++;
        if (now - t_fps > 5 * 1000 * 1000) {
            ESP_LOGI(TAG, "%.1f fps  energy=%.2f pal=%.2f",
                     frames / ((now - t_fps) / 1e6f), st.energy, st.pal);
            t_fps = now;
            frames = 0;
        }
    }
}
