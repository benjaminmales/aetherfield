#include "hand_raise.h"

#include <math.h>
#include <stddef.h>

/* Detector state. Single instance; the wristband only wears one band. */
static struct {
    hand_raise_cfg_t cfg;
    float            feature_filt;  /* smoothed feature */
    bool             have_filt;     /* feature_filt seeded yet? */
    bool             latched_up;    /* current output */
} hr_;

void hand_raise_init(const hand_raise_cfg_t *cfg)
{
    if (cfg != NULL) {
        hr_.cfg = *cfg;
    } else {
        /* Defaults: matches the proven wristband tuning (Y vertical, magnitude
         * fraction, 0.82 on / 0.58 off), quasi-static gate +/-2.5 m/s^2,
         * light low-pass.  Re-tune `axis` and thresholds for the HOLYIOT
         * mounting (see notes in main.c). */
        hr_.cfg.axis           = HAND_RAISE_AXIS_Y;
        hr_.cfg.use_signed     = false;
        hr_.cfg.on_thresh      = 0.82f;
        hr_.cfg.off_thresh     = 0.58f;
        hr_.cfg.static_tol_ms2 = 2.5f;
        hr_.cfg.lpf_alpha      = 0.3f;
    }

    /* Clamp lpf_alpha to a sane range. */
    if (hr_.cfg.lpf_alpha <= 0.0f || hr_.cfg.lpf_alpha > 1.0f) {
        hr_.cfg.lpf_alpha = 1.0f;
    }

    hr_.feature_filt = 0.0f;
    hr_.have_filt    = false;
    hr_.latched_up   = false;
}

bool hand_raise_update_ex(float ax, float ay, float az,
                          hand_raise_result_t *out)
{
    const float a[3] = { ax, ay, az };
    const float mag  = sqrtf(ax * ax + ay * ay + az * az);

    bool  is_static = false;
    float feature   = hr_.feature_filt;

    /* Guard against a dead/zero read producing a divide-by-zero. */
    if (mag > 0.001f) {
        const float comp = a[(int)hr_.cfg.axis];   /* gravity component on axis */
        const float raw  = hr_.cfg.use_signed
                               ? (comp / mag)          /* signed, -1..+1 */
                               : (fabsf(comp) / mag);  /* magnitude, 0..1 */

        /* First-order low-pass on the feature. */
        if (!hr_.have_filt) {
            hr_.feature_filt = raw;
            hr_.have_filt    = true;
        } else {
            hr_.feature_filt += hr_.cfg.lpf_alpha * (raw - hr_.feature_filt);
        }
        feature = hr_.feature_filt;

        /* Only trust orientation while quasi-static (|a| ~ 1g). */
        is_static = fabsf(mag - HAND_RAISE_G_MS2) <= hr_.cfg.static_tol_ms2;

        if (is_static) {
            /* Hysteresis. Works for both positive and negative "up" directions
             * because we compare against the configured on/off thresholds with
             * the same ordering the caller picked (|on| > |off|). */
            if (hr_.cfg.on_thresh >= hr_.cfg.off_thresh) {
                /* Up = feature high (typical). */
                if (feature >= hr_.cfg.on_thresh) {
                    hr_.latched_up = true;
                } else if (feature <= hr_.cfg.off_thresh) {
                    hr_.latched_up = false;
                }
            } else {
                /* Up = feature low/negative (signed mode, axis flipped). */
                if (feature <= hr_.cfg.on_thresh) {
                    hr_.latched_up = true;
                } else if (feature >= hr_.cfg.off_thresh) {
                    hr_.latched_up = false;
                }
            }
        }
        /* Not static: hold previous latched state. */
    }

    if (out != NULL) {
        out->is_up     = hr_.latched_up;
        out->is_static = is_static;
        out->feature   = feature;
        out->magnitude = mag;
    }

    return hr_.latched_up;
}

bool hand_raise_update(float ax, float ay, float az)
{
    return hand_raise_update_ex(ax, ay, az, NULL);
}

bool hand_raise_is_up(void)
{
    return hr_.latched_up;
}
