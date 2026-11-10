/* touch.h - CST816T raw driver + BOOT-button fallback input */
#ifndef VOTEBAND_TOUCH_H
#define VOTEBAND_TOUCH_H

#include <stdint.h>
#include <stdbool.h>

typedef struct {
    /* Finger down at panel coordinates (rotation 0: x 0..239, y 0..279). */
    void (*on_press)(uint16_t x, uint16_t y);
    /* BOOT button (non-touch variant): short press = cycle highlight. */
    void (*on_button_cycle)(void);
    /* BOOT button long press = cast vote on the highlighted option. */
    void (*on_button_commit)(void);
} touch_callbacks_t;

void input_init(const touch_callbacks_t *cbs);

#endif
