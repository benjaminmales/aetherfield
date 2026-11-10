/*
 * orb.c — organic gradient-orb renderer (fixed point, FPU-free inner loop).
 *
 * Strategy: per scanline we track squared distances to the orb centre and to
 * the hot-spot incrementally (d2 += step; step += const — no multiplies), and
 * map d2 -> weight through two 512-entry LUTs rebuilt only when the radii
 * change perceptibly. Weights blend bg / body / hot-spot colours in RGB888,
 * packed to byte-swapped RGB565 for the panel.
 *
 * Distances are kept in quarter-pixel units (Q2), so squared values (Q4)
 * stay comfortably inside int32 for a 410x502 canvas.
 */
#include "orb.h"

#include <math.h>
#include <string.h>

#define LUT_N 512

/* +1 sentinel entry so lerp can always read lut[i+1] */
static uint8_t s_edge_lut[LUT_N + 1];
static uint8_t s_glow_lut[LUT_N + 1];
static int s_edge_shift, s_glow_shift;
static int32_t s_edge_max_q4, s_glow_max_q4;
/* rebuild keys (quarter-px quantised) */
static int32_t s_key_r = -1, s_key_e = -1, s_key_g = -1, s_key_gain = -1;

static inline int shift_for(int32_t max_q4)
{
    int s = 0;
    while ((max_q4 >> s) >= LUT_N) s++;
    return s;
}

/* integer sqrt of a uint32 (for per-row span tests) */
static inline uint32_t isqrt32(uint32_t v)
{
    uint32_t r = 0, bit = 1u << 30;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; }
        else               r >>= 1;
        bit >>= 2;
    }
    return r;
}

void orb_begin_frame(const orb_params_t *p)
{
    int32_t kr = p->radius_q8 >> 6, ke = p->edge_q8 >> 6;
    int32_t kg = p->glow_q8 >> 6,   kk = p->glow_gain;
    if (kr == s_key_r && ke == s_key_e && kg == s_key_g && kk == s_key_gain)
        return;
    s_key_r = kr; s_key_e = ke; s_key_g = kg; s_key_gain = kk;

    float R = p->radius_q8 / 256.0f;
    float E = p->edge_q8   / 256.0f;
    if (E < 0.5f) E = 0.5f;
    float G = p->glow_q8   / 256.0f;
    if (G < 1.0f) G = 1.0f;

    /* --- edge LUT: 255 well inside the orb, smoothstep to 0 across R+/-E */
    float dmax_e = R + E;
    s_edge_max_q4 = (int32_t)(dmax_e * dmax_e * 16.0f) + 1;
    s_edge_shift  = shift_for(s_edge_max_q4);
    for (int i = 0; i < LUT_N; i++) {
        float d2 = ((float)((int64_t)i << s_edge_shift) + 0.5f) / 16.0f;
        float d  = sqrtf(d2);
        float t  = (R + E - d) / (2.0f * E);
        if (t < 0.0f) t = 0.0f;
        if (t > 1.0f) t = 1.0f;
        float w = t * t * (3.0f - 2.0f * t);
        s_edge_lut[i] = (uint8_t)(w * 255.0f + 0.5f);
    }
    s_edge_lut[LUT_N] = s_edge_lut[LUT_N - 1];

    /* --- glow LUT: gaussian falloff from the hot-spot, scaled by gain */
    float dmax_g = G * 2.2f;
    s_glow_max_q4 = (int32_t)(dmax_g * dmax_g * 16.0f) + 1;
    s_glow_shift  = shift_for(s_glow_max_q4);
    for (int i = 0; i < LUT_N; i++) {
        float d2 = ((float)((int64_t)i << s_glow_shift) + 0.5f) / 16.0f;
        float x2 = d2 / (G * G);
        float w  = expf(-3.0f * x2) * (float)p->glow_gain;
        s_glow_lut[i] = (uint8_t)(w + 0.5f);
    }
    s_glow_lut[LUT_N] = s_glow_lut[LUT_N - 1];
}

/* linearly interpolated LUT lookup — kills the ring banding that a raw
 * d2 >> shift quantisation produces on wide, shallow gradients */
static inline uint32_t lut_lerp(const uint8_t *lut, uint32_t d2, int shift)
{
    uint32_t i = d2 >> shift;
    int f = (int)((d2 - (i << shift)) >> (shift > 8 ? shift - 8 : 0));
    if (shift < 8) f <<= 8 - shift;                   /* f: 0..255 */
    int a = lut[i];
    return (uint32_t)(a + (((lut[i + 1] - a) * f) >> 8));
}

/* 4x4 Bayer offsets, pre-scaled for RGB565: +/-half an LSB of the 5-bit
 * (red/blue) and 6-bit (green) channels. Breaks up the contour banding that
 * 565 quantisation would otherwise draw across the shallow glow gradients. */
static const int8_t s_dth5[16] = { -4,  0, -3,  1,   2, -2,  3, -1,
                                   -3,  1, -4,  0,   3, -1,  2, -2 };
static const int8_t s_dth6[16] = { -2,  0, -1,  1,   1, -1,  2,  0,
                                   -1,  1, -2,  0,   2,  0,  1, -1 };

static inline int clamp255(int v)
{
    return v < 0 ? 0 : (v > 255 ? 255 : v);
}

static inline uint16_t pack565_swapped(int r, int g, int b)
{
    uint16_t v = (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
    return (uint16_t)((v << 8) | (v >> 8));
}

void orb_render_strip(const orb_params_t *p, int y0, int rows, uint16_t *out)
{
    const int W = p->width;
    const uint16_t bg565 = pack565_swapped(p->bg_r, p->bg_g, p->bg_b);

    const int bgr = p->bg_r,   bgg = p->bg_g,   bgb = p->bg_b;
    const int bor = p->body_r, bog = p->body_g, bob = p->body_b;
    const int dhr = p->hot_r - bor, dhg = p->hot_g - bog, dhb = p->hot_b - bob;

    /* centre / hot-spot in quarter-px (Q2) */
    const int32_t cx4 = p->cx_q8 >> 6, cy4 = p->cy_q8 >> 6;
    const int32_t hx4 = p->hx_q8 >> 6, hy4 = p->hy_q8 >> 6;
    const int32_t rspan4 = ((p->radius_q8 + p->edge_q8) >> 6) + 4;

    for (int row = 0; row < rows; row++) {
        const int y = y0 + row;
        uint16_t *dst = out + (size_t)row * W;

        const int32_t dyc = (y << 2) + 2 - cy4;           /* Q2 */
        const int32_t dyh = (y << 2) + 2 - hy4;
        const int32_t dyc2 = dyc * dyc;                   /* Q4 */
        const int32_t dyh2 = dyh * dyh;

        /* rows that never touch the orb: flat background fill */
        if (dyc2 >= rspan4 * rspan4) {
            for (int x = 0; x < W; x++) dst[x] = bg565;
            continue;
        }

        /* horizontal span the orb (incl. soft edge) can cover on this row */
        const int32_t half4 = (int32_t)isqrt32((uint32_t)(rspan4 * rspan4 - dyc2));
        int xa = (cx4 - half4) >> 2;
        int xb = ((cx4 + half4) >> 2) + 1;
        if (xa < 0) xa = 0;
        if (xb > W) xb = W;

        for (int x = 0; x < xa; x++) dst[x] = bg565;
        for (int x = xb; x < W; x++) dst[x] = bg565;

        /* incremental squared distances across [xa, xb) */
        int32_t dxc = (xa << 2) + 2 - cx4;
        int32_t dxh = (xa << 2) + 2 - hx4;
        int32_t d2c = dxc * dxc + dyc2;
        int32_t d2h = dxh * dxh + dyh2;
        int32_t stc = 8 * dxc + 16;   /* d((dx)^2) for dx += 4 in Q2 */
        int32_t sth = 8 * dxh + 16;

        for (int x = xa; x < xb; x++) {
            uint32_t we = (d2c < s_edge_max_q4)
                        ? lut_lerp(s_edge_lut, (uint32_t)d2c, s_edge_shift) : 0;
            if (we == 0) {
                dst[x] = bg565;
            } else {
                uint32_t wg = ((uint32_t)d2h < (uint32_t)s_glow_max_q4)
                            ? lut_lerp(s_glow_lut, (uint32_t)d2h, s_glow_shift) : 0;
                int r = bor + ((dhr * (int)wg) >> 8);
                int g = bog + ((dhg * (int)wg) >> 8);
                int b = bob + ((dhb * (int)wg) >> 8);
                if (we != 255) {
                    r = bgr + (((r - bgr) * (int)we) >> 8);
                    g = bgg + (((g - bgg) * (int)we) >> 8);
                    b = bgb + (((b - bgb) * (int)we) >> 8);
                }
                const int di = ((y & 3) << 2) | (x & 3);
                dst[x] = pack565_swapped(clamp255(r + s_dth5[di]),
                                         clamp255(g + s_dth6[di]),
                                         clamp255(b + s_dth5[di]));
            }
            d2c += stc; stc += 32;
            d2h += sth; sth += 32;
        }
    }
}
