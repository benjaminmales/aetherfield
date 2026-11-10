/*
 * Server link: the gateway half of the line protocol in docs/PROTOCOL.md.
 *
 * Newline-delimited UTF-8 over one long-lived TCP connection. The gateway
 * dials the server; the server never dials out. Same text the gateway used to
 * print to the UART for the Pi bridge, so this was a transport swap and not a
 * protocol change.
 */
#ifndef LINK_H
#define LINK_H

#include <stdbool.h>

/* Start the link thread. Returns immediately; the thread brings the W5500 up,
 * connects, and reconnects forever. */
int link_init(void);

/* True once the socket is established and HELLO has gone out. */
bool link_up(void);

/*
 * Emit one line of telemetry. Printf semantics. Output is buffered until a
 * '\n' arrives, then the completed line goes to the server AND to the local
 * console, so a human on USB sees exactly what the server sees.
 *
 * Safe to call from any thread, including the radio receive path.
 */
void gw_emit(const char *fmt, ...);

#endif /* LINK_H */
