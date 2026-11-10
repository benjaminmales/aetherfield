/*
 * host_orb_test.c — renders the orb on a host machine to PPM images so the
 * visual can be eyeballed against the Figma references without hardware.
 *
 *   cc -O2 -I../main host_orb_test.c ../main/orb.c -lm -o orb_test && ./orb_test
 *
 * Emits frame_0.ppm .. frame_3.ppm (410x502), one per reference frame.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "orb.h"

#define W 410
#define H 502

typedef struct { uint8_t r, g, b; } rgb_t;
static const rgb_t ORANGE = { 0xFF, 0x6C, 0x11 };
static const rgb_t CYAN   = { 0x4F, 0xE9, 0xFF };

static float mixf(float a, float b, float t) { return a + (b - a) * t; }

static rgb_t body_from(rgb_t bg, rgb_t hot)
{
    float r = mixf(hot.r, bg.r, 0.52f);
    float g = mixf(hot.g, bg.g, 0.52f);
    float b = mixf(hot.b, bg.b, 0.52f);
    float l = (r + g + b) / 3.0f;
    r = mixf(r, l, 0.45f) * 0.92f;
    g = mixf(g, l, 0.45f) * 0.92f;
    b = mixf(b, l, 0.45f) * 0.92f;
    return (rgb_t){ (uint8_t)r, (uint8_t)g, (uint8_t)b };
}

static void set_colors(orb_params_t *p, rgb_t bg, rgb_t hot)
{
    rgb_t body = body_from(bg, hot);
    p->bg_r = bg.r;     p->bg_g = bg.g;     p->bg_b = bg.b;
    p->hot_r = hot.r;   p->hot_g = hot.g;   p->hot_b = hot.b;
    p->body_r = body.r; p->body_g = body.g; p->body_b = body.b;
}

static void save_ppm(const char *name, const uint16_t *px)
{
    FILE *f = fopen(name, "wb");
    fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (int i = 0; i < W * H; i++) {
        uint16_t v = (uint16_t)((px[i] << 8) | (px[i] >> 8)); /* un-swap */
        uint8_t rgb[3] = {
            (uint8_t)(((v >> 11) & 0x1F) << 3),
            (uint8_t)(((v >> 5)  & 0x3F) << 2),
            (uint8_t)(( v        & 0x1F) << 3),
        };
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
}

int main(void)
{
    static uint16_t fb[W * H];

    struct {
        rgb_t bg, hot;
        float cx, cy, R;      /* orb centre + radius (px)          */
        float hx, hy;         /* hot-spot offset from orb centre   */
        float energy;
    } cases[4] = {
        /* startup: orange bg, cyan glow top       (Figma 2:2) */
        { ORANGE, CYAN, 205.0f, 251.0f, 120.0f,  10.0f, -62.0f, 0.10f },
        /* orange bg, glow bottom                  (Figma 2:3) */
        { ORANGE, CYAN, 205.0f, 261.0f, 120.0f,  -8.0f,  64.0f, 0.15f },
        /* cyan bg, orange glow bottom, bloomed    (Figma 2:5) */
        { CYAN, ORANGE, 205.0f, 255.0f, 168.0f,   6.0f,  92.0f, 0.65f },
        /* cyan bg, orange glow left, small orb    (Figma 2:7) */
        { CYAN, ORANGE, 204.0f, 252.0f,  80.0f, -42.0f,  -6.0f, 0.05f },
    };

    for (int c = 0; c < 4; c++) {
        orb_params_t p = { .width = W, .height = H };
        set_colors(&p, cases[c].bg, cases[c].hot);
        p.cx_q8     = ORB_F(cases[c].cx);
        p.cy_q8     = ORB_F(cases[c].cy);
        p.radius_q8 = ORB_F(cases[c].R);
        p.edge_q8   = ORB_F(3.5f);
        p.hx_q8     = ORB_F(cases[c].cx + cases[c].hx);
        p.hy_q8     = ORB_F(cases[c].cy + cases[c].hy);
        p.glow_q8   = ORB_F(cases[c].R * (0.95f + 0.45f * cases[c].energy));
        p.glow_gain = (uint8_t)(185.0f + 70.0f * cases[c].energy);

        orb_begin_frame(&p);
        for (int y = 0; y < H; y += 16) {
            int rows = H - y > 16 ? 16 : H - y;
            orb_render_strip(&p, y, rows, fb + (size_t)y * W);
        }

        char name[32];
        snprintf(name, sizeof(name), "frame_%d.ppm", c);
        save_ppm(name, fb);
        printf("wrote %s\n", name);
    }
    return 0;
}
