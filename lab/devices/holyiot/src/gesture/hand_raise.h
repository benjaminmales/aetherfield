/**
 * @defgroup hand_raise Accelerometer-only hand-raise detector
 * @{
 *
 * @brief Detects a raised forearm (e.g. raised hand to vote) using ONLY a
 *        3-axis accelerometer. No gyro / sensor fusion required.
 *
 * Principle: a quasi-static accelerometer measures the gravity vector. The
 * direction of gravity relative to the device gives tilt directly. Raising the
 * forearm rotates the board so the chosen "forearm" axis swings toward (or away
 * from) gravity. We threshold the projection of gravity onto that axis, with
 * hysteresis, and only trust the reading while the device is quasi-static
 * (|a| ~ 1g) so that dynamic motion does not fake a raise.
 *
 * This is the same method the LSM6DSO wristband used for hand-raise — it never
 * needed the gyro for that gesture, so it ports directly to the accel-only
 * LIS2DH12 on the HOLYIOT board.
 */
#ifndef __GESTURE_HAND_RAISE_H__
#define __GESTURE_HAND_RAISE_H__

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Device axis used as the "vertical / forearm" axis. */
typedef enum {
    HAND_RAISE_AXIS_X = 0,
    HAND_RAISE_AXIS_Y = 1,
    HAND_RAISE_AXIS_Z = 2,
} hand_raise_axis_t;

/** Detector configuration. Pass NULL to hand_raise_init() to accept defaults. */
typedef struct {
    /** Which device axis aligns with gravity when the hand is raised. */
    hand_raise_axis_t axis;

    /**
     * Use the SIGNED gravity projection (a_axis / |a|, range -1..+1) when true,
     * or the magnitude fraction (|a_axis| / |a|, range 0..1) when false.
     *
     * Signed is more robust when the down-position also leaves the axis near
     * vertical (e.g. axis points "up" when raised, "down" when at rest) — the
     * sign disambiguates the two. Magnitude matches the original wristband and
     * is fine when the axis is horizontal at rest and vertical when raised.
     */
    bool use_signed;

    /**
     * Hysteresis thresholds on the chosen feature.
     *  - magnitude mode: 0..1, e.g. on=0.82 off=0.58
     *  - signed mode:   -1..+1, e.g. on=+0.80 off=+0.50 (raised = +g on axis),
     *    or on=-0.80 off=-0.50 if the axis points the other way when raised.
     * Latches UP when feature crosses past on_thresh, releases when it falls
     * back past off_thresh. Keep |on| > |off| for clean hysteresis.
     */
    float on_thresh;
    float off_thresh;

    /**
     * Quasi-static gate: only update the latch while
     * | |a| - 1g | <= static_tol_ms2. Outside this band (the arm is swinging,
     * being shaken, etc.) the previous latched state is held. ~2.5 m/s^2 is a
     * sensible start; tighten for fewer false triggers, loosen if real raises
     * get rejected.
     */
    float static_tol_ms2;

    /**
     * First-order low-pass smoothing on the feature, 0..1.
     *  - 1.0 = no smoothing (raw each sample)
     *  - smaller = heavier smoothing / more lag
     * ~0.3 at 50-104 Hz removes jitter without much latency. Use 1.0 to disable.
     */
    float lpf_alpha;
} hand_raise_cfg_t;

/** Result of a single update, useful for tuning / logging. */
typedef struct {
    bool  is_up;        /**< Latched raised state after this sample. */
    bool  is_static;    /**< Whether the sample passed the quasi-static gate. */
    float feature;      /**< Smoothed feature value used for thresholding. */
    float magnitude;    /**< |a| in m/s^2 for this sample. */
} hand_raise_result_t;

/** Standard earth gravity used for the quasi-static gate (m/s^2). */
#define HAND_RAISE_G_MS2 9.80665f

/**
 * @brief Initialise / reset the detector.
 * @param cfg  Configuration, or NULL for sensible defaults
 *             (axis=Y, magnitude mode, on=0.82, off=0.58,
 *              static_tol=2.5, lpf_alpha=0.3).
 */
void hand_raise_init(const hand_raise_cfg_t *cfg);

/**
 * @brief Feed one accelerometer sample (m/s^2) and update the latch.
 * @return Latched raised state (true = hand up).
 */
bool hand_raise_update(float ax, float ay, float az);

/**
 * @brief Same as hand_raise_update() but also returns detail for tuning.
 */
bool hand_raise_update_ex(float ax, float ay, float az,
                          hand_raise_result_t *out);

/** @brief Current latched state without feeding a new sample. */
bool hand_raise_is_up(void);

#ifdef __cplusplus
}
#endif

#endif /* __GESTURE_HAND_RAISE_H__ */

/** @} */
