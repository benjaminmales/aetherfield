/* ui.h - 4-answer vote screen */
#ifndef VOTEBAND_UI_H
#define VOTEBAND_UI_H

#include <stdint.h>

void ui_init(uint16_t addr, uint8_t channel);
/* sel: 0 = none, 1..4 = A..D. Redraws highlight. */
void ui_set_selected(uint8_t sel);
uint8_t ui_get_selected(void);
/* Advance highlight A->B->C->D->A (BOOT-button navigation). */
void ui_cycle_selected(void);
/* Brief "vote sent" pulse on option n. */
void ui_flash_sent(uint8_t n);
/* Map a touch to an option, 0 if outside the grid. */
uint8_t ui_hit_test(uint16_t x, uint16_t y);
void ui_set_channel(uint8_t channel);
/* Show-control accent (from CMD LED TLV). */
void ui_accent(uint8_t r, uint8_t g, uint8_t b);
/* New round: clear selection. */
void ui_clear_vote(void);

#endif
