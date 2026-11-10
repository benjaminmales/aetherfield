Superseded 2026-09-08.

These overlays existed to retry the K7-derived guess that the LED was on
P1.10/11/12 and active-low. The radio pin probe found the real answer:

    bottom status LED = P2.02, ACTIVE HIGH

Both halves of the K7 inference were wrong — wrong port and wrong polarity.
That is now the board default in
`boards/kkm/k4beacon_nrf54l15/k4beacon_nrf54l15-pinctrl.dtsi`, so nothing here
is needed. Kept only as a record of what was tried.
