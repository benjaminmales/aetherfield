# lab/

Experiments, earlier devices and retired gateways. **Not built by CI, not
shipped, not a dependency of anything outside this folder.**

| Path | What | Note |
|---|---|---|
| `devices/seeedfirmware` | XIAO nRF54L15 band: LP5012 + IMU + EdgeAI clap, v2 | **Closest base for Aura One firmware** (same LED driver, similar IMU) |
| `devices/holyiot` | Holyiot 25008 with EdgeAI gesture | v0 protocol. Superseded by `firmware/aura-tag` |
| `devices/k7`, `devices/kkm` | KKM K7/K4 beacons | Board files in `boards/kkm` |
| `devices/voteband`, `devices/xiao-nrf52840` | nRF52840 voteband | |
| `devices/waveshield-esp32-c6` | ESP32-C6 voteband + IMU visualiser | |
| `devices/pixel-xiao-nrf54`, `devices/pixel-led-test` | Single-WS2812 pixel studies | |
| `devices/sniffer` | nRF52840 802.15.4 sniffer | Still the first tool to reach for when frames go missing |
| `devices/common` | Older copy of aura_band | Use `firmware/common` |
| `pixel/` | Allwyn Pixel apps (XIAO, Holyiot modified, K4) | Deal lost Nov 2026. Their aura_band is now `firmware/common` |
| `gateways/nrf54-firmware`, `gateways/pi-bridge` | UART gateway + Raspberry Pi bridge | Pre-Ethernet |
| `gateways/pixel-gateway*` | Older snapshot of Aura Link | Use `firmware/aura-link` |
| `gateways/nrf54-serialTestBridge` | Web Serial control page | Never tested on hardware |
| `hardware/nrf54-hat` | Pi HAT around the HOLYIOT-25007 | Paused |
| `node/` | Relay node firmware | Ideas feed into Aura Marker |
| `demos/traitors` | Audience-voting demo (v0) | |
| `scripts/` | flatten-firmware.sh | |

Lab builds may need path fixes: these trees came from two repos with
different layouts. That's acceptable here and nowhere else.
