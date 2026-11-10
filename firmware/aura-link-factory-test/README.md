# Aetherfield Gateway — Factory Test Firmware

**Target:** Seeed XIAO nRF54LM20A fitted to the XIAO W5500 Ethernet adapter
(in place of the XIAO ESP32-S3).
**Version:** 1.0.2. Built with **nRF Connect SDK v3.3.4**, the same SDK and
board files as the Aetherfield gateway firmware already running on this
hardware. The board files are included under `board-root/`.

This is a standalone test. It needs no server or other Aetherfield equipment:
only a USB-C cable, an Ethernet cable and (optionally) a PC.

---

## Contents

| File | What it is |
|---|---|
| `prebuilt/gateway-factory-test.hex` | Ready-to-flash image |
| `boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay` | W5500 pin assignment (the only file to edit) |
| `board-root/` | XIAO nRF54LM20A board definition used for the build |
| `src/` | Test source (W5500 driver, radio test, test sequence) |
| `prj.conf`, `CMakeLists.txt`, `dts/` | Build files |

---

## Pin assignment

The image matches the production XIAO W5500 Ethernet Adapter routing:

| W5500 | XIAO pin | nRF54LM20A |
|---|---|---|
| SCK | D8 | P1.04 (`spi23`) |
| MISO | D9 | P1.05 |
| MOSI | D10 | P1.06 |
| CS | D1 | P1.31 |
| INTn | not routed | not used |
| RSTn | not routed | none (software reset used) |

If the modified adapter routes CS differently, or brings INT/RST to the XIAO,
edit `boards/xiao_nrf54lm20a_nrf54lm20a_cpuapp.overlay` and rebuild. Please
tell us about any routing change, since the production firmware must match it.

**Fit the 2.4 GHz antenna** to the XIAO's u.FL connector before testing. The
XIAO nRF54LM20A has no onboard antenna.

---

## Flashing

The XIAO's onboard SAMD11 is a CMSIS-DAP probe, so no external debugger is needed.

**From source (nRF Connect SDK v3.3.4):**

```
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -p always -- -DBOARD_ROOT=$PWD/board-root
west flash
```

**Prebuilt hex with OpenOCD**, using the board's own `support/openocd.cfg`:

```
openocd -f board-root/boards/seeed/xiao_nrf54lm20a/support/openocd.cfg \
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
 AETHERFIELD GATEWAY FACTORY TEST  fw 1.0.2
 Board     XIAO nRF54LM20A + W5500
 Device ID 1A2B3C4D5E6F7081
 MAC       02:81:70:6F:5E:4D
 IP        192.168.1.200 / 255.255.255.0
==================================================================
[1] W5500 SPI       VERSIONR=0x04 (expect 0x04)                  PASS
[2] SPI integrity   72 bytes written/read, 0 mismatched          PASS
[3] Ethernet link   100M full-duplex                             PASS
[4] 802.15.4 TX     5/5 frames sent, ch 15, +8 dBm               PASS
[5] 802.15.4 RX     no peer yet (0 frames heard) - see status    INFO
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
| 2 | SPI integrity | 8 register bytes and a 64-byte buffer burst read back exactly (the first mismatch is printed) | Signal integrity on the SPI lines |
| 3 | Ethernet link | PHY reports link within 10 s; speed and duplex printed | Cable, switch, RJ45 magnetics, W5500 25 MHz crystal |
| 4 | 802.15.4 TX | 5 of 5 frames transmitted | Radio. TX completing does not prove the antenna; test 5 does. |
| 5 | 802.15.4 RX | Informational: passes when another unit running this test is heard | Run two units side by side, both on the same channel |

### Two more manual checks

- **Ethernet data path:** from a PC on 192.168.1.x, run `ping 192.168.1.200`.
  The W5500 answers ICMP in hardware. On a different subnet, set the address
  first at the console: `ip 10.0.0.50` (or `ip <addr> <mask> <gateway>`).
- **Radio RX:** power two units close together. Each one's status line shows
  the other's ID (`peer ...`) and RSSI. At about 1 m, expect roughly −30 to −55 dBm. Much weaker (below about −70 dBm at 1 m) usually means a missing or badly seated u.FL antenna.

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
