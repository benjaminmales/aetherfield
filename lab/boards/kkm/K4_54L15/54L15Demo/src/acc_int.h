#ifndef ACC_INTERRUPT_H
#define ACC_INTERRUPT_H

#include <stdint.h>

typedef void (*acc_interrupt_evt) (uint8_t event);
 

int Acc_interrupt_init(acc_interrupt_evt accEvtCallback);

#endif

