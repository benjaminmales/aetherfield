# Aura One — firmware

⚠ GAP: not started.

Hardware: `hardware/aura-one`. nRF54L05, LP5012 driving 4× RGB (CLV1A) plus
3× HSMF-C115, LSM6DSRX 6-axis IMU, MCP73832 LiPo charger, USB-C, chip antenna.

Starting point: `lab/devices/seeedfirmware`, the XIAO nRF54L15 band. It uses
the same LP5012 driver and a similar ST IMU, and already runs v2 on
`firmware/common`. Promote it here once ported to the Aura One board.

Watch for:
- **nRF54L05 is the smallest part in the family** (500 KB RRAM, 96 KB RAM vs
  the L15's 1.5 MB / 256 KB). Aura Tag uses ~60 KB RAM on the L15, so check
  the EdgeAI model fits before promising gestures.
- Needs a board definition in `firmware/boards/aetherfield/aura_one/`.
- Battery % needs the VBAT sense path from the schematic.
