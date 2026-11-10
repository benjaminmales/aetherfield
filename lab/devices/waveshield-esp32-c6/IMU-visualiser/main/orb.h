/*
 * orb.h — organic gradient-orb renderer.
 *
 * Pure C, no ESP-IDF dependencies: the same file compiles on the host for
 * visual testing (see test/host_orb_test.c).
 *
 * Visual model (matches the Figma references):
 *   - full-bleed background colour
 *   - one circular orb with a soft anti-aliased edge
 *   - inside the orb, a gaussian "hot-spot" glow that drifts around;
 *     colour runs hot-spot colour -> body colour with distance
 *
 * All positions/radii are Q8 fixed point (1/256 px).
 */
#pragma once

#include <stdint.h>

#define ORB_Q 8                    /* fixed-point fractional bits */
#define ORB_F(x) ((int32_t)((x) * 256.0f + 0.5f))

typedef struct {
    int16_t width, height;

    uint8_t bg_r, bg_g, bg_b;      /* background            */
    uint8_t body_r, body_g, body_b;/* orb body (far side)   */
    uint8_t hot_r, hot_g, hot_b;   /* hot-spot glow         */

    int32_t cx_q8, cy_q8;          /* orb centre            */
    int32_t radius_q8;             /* orb radius            */
    int32_t edge_q8;               /* edge softness (px)    */

    int32_t hx_q8, hy_q8;          /* hot-spot centre       */
    int32_t glow_q8;               /* glow falloff radius   */
    uint8_t glow_gain;             /* 0..255 glow intensity */
} orb_params_t;

/* Rebuild internal falloff LUTs for the current radii. Call once per frame
 * (cheap: skipped internally when radii haven't changed enough to matter). */
void orb_begin_frame(const orb_params_t *p);

/* Render `rows` scanlines starting at y0 into `out` (width*rows RGB565
 * values, byte-swapped ready for the panel/SPI). */
void orb_render_strip(const orb_params_t *p, int y0, int rows, uint16_t *out);
