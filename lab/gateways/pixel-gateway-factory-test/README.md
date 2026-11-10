# Aetherfield Gateway — Factory Test Firmware

**Target:** Seeed XIAO nRF54LM20A fitted to the XIAO W5500 Ethernet adapter
(in place of the XIAO ESP32-S3).
**Version:** 1.0.0. Built with nRF Connect SDK v3.4.1 and the Seeed board files
from `Seeed-Studio/platform-seeedboards` (`zephyr/nrf`).

This is a standalone test. It needs no server or other Aetherfield equipment:
only a USB-C cable, an Ethernet cable and (optionally) a PC.

---

## Contents

| File | What it is |
|---|---|
| `prebuilt/gateway-factory-test.hex` | Ready-to-flash image |
| `boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay` | **Pin assignment for W5500 CS / INT / RST** (the only file to edit) |
| `src/` | Test source (W5500 driver, radio test, test sequence) |
| `prj.conf`, `CMakeLists.txt`, `dts/` | Build files |

---

## ⚠ Pin assignment: please confirm before running

SCK, MISO and MOSI use the XIAO SPI header, **D8 / D9 / D10** (P1.04 / P1.05 /
P1.06, `spi23`). These are fixed.

The prebuilt image assumes:

| W5500 | XIAO pin | nRF54LM20A |
|---|---|---|
| CS | D0 | P1.00 |
| INTn | D1 | P1.31 |
| RSTn | D2 | P1.30 |

**If the modified adapter routes these differently, the `.hex` will fail test 1.**
Edit the D-numbers in `boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay`
(D11–D18 are the back pads) and rebuild. If INT or RST is not connected to
the XIAO at all, delete that line. The test then skips the INT check or uses
a software reset, and says so in its report.

Please send us the final pin mapping so we can match it in the production
firmware.

---

## Flashing

The XIAO's onboard SAMD11 is a CMSIS-DAP probe, so no external debugger is needed.

**From source (nRF Connect SDK v3.4.1 or later):**

```
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -p always -- -DBOARD_ROOT=<platform-seeedboards>/zephyr/nrf
west flash
```

**Prebuilt hex with OpenOCD**, using the board's own `support/openocd.cfg`:

```
openocd -f <platform-seeedboards>/zephyr/nrf/boards/seeed/xiao_nrf54lm20a/support/openocd.cfg \
        -c "init; halt; nrf54lm20a-load prebuilt/gateway-factory-test.hex; reset run; shutdown"
```

Or use whatever programming method Seeed already uses for XIAO nRF54LM20A
production.

---

## Running the test

1. Power the board from **5 V / PoE**, not only from the XIAO's 3V3. The W5500
   draws about 150 mA with the link up.
2. Plug an Ethernet cable into a switch or straight into a PC.
3. Open the XIAO's USB-C serial port at **115200 8N1**.
4. Reset the board. The test runs automatically about 1.5 s after boot.

### LED (XIAO RGB LED)

| LED | Meaning |
|---|---|
| Blue | Test running |
| Green, blinking once per second | **All tests passed** |
| Red, fast blinking | One or more tests failed (see console) |

### Console report (example)

```
==================================================================
 AETHERFIELD GATEWAY FACTORY TEST  fw 1.0.0
 Board     XIAO nRF54LM20A + W5500
 Device ID 1A2B3C4D5E6F7081
 MAC       02:81:70:6F:5E:4D
 IP        192.168.1.200 / 255.255.255.0
==================================================================
[1] W5500 SPI       VERSIONR=0x04 (expect 0x04)                  PASS
[2] SPI integrity   70 bytes written/read, 0 mismatched          PASS
[3] Ethernet link   100M full-duplex                             PASS
[4] W5500 INT       asserted and released                        PASS
[5] 802.15.4 TX     5/5 frames sent, ch 15, +8 dBm               PASS
[6] 802.15.4 RX     no peer yet (0 frames heard) - see status    INFO
------------------------------------------------------------------
 RESULT: PASS  (0 failures)
------------------------------------------------------------------
```

After the report, a status line prints every 5 seconds:

```
[status] eth up 100M | radio ch15 tx 42/42 rx 40 | peer 5E6F7081 x38 rssi -41 | PASS
```

### What each test checks

| # | Test | Pass condition | If it fails |
|---|---|---|---|
| 1 | W5500 SPI | VERSIONR reads 0x04 after reset | SCK/MISO/MOSI, CS pin, W5500 3V3 supply. 0x00 or 0xFF means no response. |
| 2 | SPI integrity | 6 register bytes and a 64-byte buffer burst read back exactly | Signal integrity on the SPI lines |
| 3 | Ethernet link | PHY reports link within 10 s; speed and duplex printed | Cable, switch, RJ45 magnetics, W5500 25 MHz crystal |
| 4 | W5500 INT | INTn goes low when an interrupt is raised and high when cleared | INT pin assignment / routing. SKIP if no INT pin is defined, or if there is no Ethernet link. |
| 5 | 802.15.4 TX | 5 of 5 frames transmitted | Radio / antenna path |
| 6 | 802.15.4 RX | Informational: passes when another unit running this test is heard | Run two units side by side, both on the same channel |

### Two more manual checks

- **Ethernet data path:** from a PC on 192.168.1.x, run `ping 192.168.1.200`.
  The W5500 answers ICMP in hardware. On a different subnet, set the address
  first at the console: `ip 10.0.0.50` (or `ip <addr> <mask> <gateway>`).
- **Radio RX:** power two units close together. Each one's status line shows
  the other's ID (`peer ...`) and RSSI. At about 1 m, expect roughly −30 to −55 dBm.

### Console commands

| Command | Action |
|---|---|
| `test` | Run the full test again |
| `ip <a.b.c.d> [mask] [gw]` | Change the static IP (default 192.168.1.200/24) |
| `chan <11-26>` | Change the radio test channel (default 15) |
| `help` | List commands |

---

## Notes

- The MAC address comes from the nRF54LM20A factory device ID with the
  locally administered bit set (02:xx:xx:xx:xx:xx), so it is unique per unit.
- Radio test frames use PAN ID 0xFAC7, broadcast, at +8 dBm on channel 15.
- The W5500 is driven through its own hardware TCP/IP engine over SPI. The
  Zephyr IP stack is not used, which matches the production gateway firmware.
