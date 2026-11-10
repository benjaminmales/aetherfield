/* Aura Link status light. See status.c for the colour table. */
#ifndef GW_STATUS_H
#define GW_STATUS_H

#include <stdint.h>

enum status_state {
	STATUS_BOOT,       /* W5500 not up yet            solid blue  */
	STATUS_FAULT,      /* W5500 not answering on SPI  red fast    */
	STATUS_NO_ETH,     /* no Ethernet link            red pulse   */
	STATUS_NO_SERVER,  /* link up, server unreachable amber blink */
	STATUS_ONLINE,     /* connected to Aura Server    green       */
};

int  status_init(void);
void status_set(enum status_state s);

/* Safe from any context, including the 802.15.4 receive path: each only
 * sets an atomic that the status thread consumes. */
void status_rx(void);        /* heard a device frame          */
void status_tx(void);        /* sent a command to the fleet   */
void status_locate(uint32_t seconds);

#endif
