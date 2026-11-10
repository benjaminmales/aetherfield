# Aura Lite — firmware

⚠ GAP: not started.

Hardware: `hardware/aura-lite`. nRF54L05, one 5050 RGB LED (QLSP08RGB),
MC3630 accelerometer, CR2032 holder, chip antenna.

Starting point: `firmware/aura-tag`. Same shape (coin cell, one RGB light),
so the app is mostly a new render callback plus a board definition in
`firmware/boards/aetherfield/aura_lite/`. Check whether the LED pins are on
PWM-capable ports. On the Holyiot, red and blue weren't.
