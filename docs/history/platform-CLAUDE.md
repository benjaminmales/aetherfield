# Aetherfield — repo guide

> ## This repo is where work happens
>
> **All new development goes here.** As of 2026-08-19 the other Aetherfield repos
> (`aetherfield-cloud-demo`, `AURA-ONE-DEMO-2026`, `Aetherfield-coachella-sim`,
> `AuraGameshow`, `AETHERFIELD-DEV/*`, `Consultancy/Traitors`) are **frozen archive**.
> They are not deleted and not maintained. Do not add features to them, and do not
> treat them as authoritative — anything worth keeping has been harvested into
> `docs/reference/`.
>
> If you find something in an archived repo that this repo needs, copy it in here
> and note it in `docs/CONSOLIDATION.md`. Never edit it in place.

Platform for orchestrating large populations of wearable light-and-sensor devices in real time. Crowd-scale synchronized animation (output) plus gesture, presence and identity (input).

**Read [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) for the why. This file is the operational contract.**

---

## The five-product stack

`Aura → Gateway → Server → Cloud → Aurea`

| Product | Directory | State |
|---|---|---|
| **Aura** — the wearable | `AURA/` | Multiple form factors, all shipping v0 except `voteband` |
| **Gateway** — venue radio bridge | `GATEWAY/` | nRF54 firmware + Pi bridge, v0 |
| **Server** — on-premise show brain | `SERVER/` | ⚠ **EMPTY. Not built.** |
| **Cloud** — hosted control plane | `CLOUD/` | `EventBuilder` (Activation Studio) |
| **Aurea** — audience digital layer | *external* | Separate repo; seam is `/api/session-status` |

**Products 1–3 are the real-time path and must work with the venue's internet unplugged. 4–5 tolerate latency. Nothing in the Cloud may ever sit between the lighting desk and the crowd.**

---

## ⚠ Read this before touching radio code

**The protocol spec and the shipped firmware disagree.** This is the single most important fact about this codebase.

| | Speaks | Where |
|---|---|---|
| **v2** — the target | `include/aura_radio.h`, `PROTOCOL.md` | Spec only, as of 2026-08-31. Nothing implements it yet. |
| **v0** — what actually runs | Single-byte IDs, promiscuous byte-scan | Everything, including every demo that has run for a client |

**v2 replaced the v1 TLV design on 2026-08-31.** Flat fixed-layout payloads, `op_mode`/`anim_mode` as separate orthogonal fields, uplink split by msgid (BEACON/CONTACT/EVENT), SYNC for clock + channel hop. The v1 header is kept at `include/aura_radio_v1.h.bak` for reference only — do not include it.

**v0:** payload ID `3` = band broadcast, `4` = LED command, `5` = node relay. Gateway runs promiscuous and byte-scans frames for the ID at a fixed offset.

**v2:** PAN `0xAE7F` hardware-filtered, FCF `0x8841`, flat payloads with `msgid` at byte 0 and `ver` at byte 1. One 13-byte CMD carries the whole device state.

### Rules

1. **`include/aura_radio.h` is the source of truth for the protocol.** Not `PROTOCOL.md`, not the whitepaper. If a doc disagrees with the header, the header wins and the doc is a bug.
2. **Never hand-edit protocol constants in firmware.** Include the header. The `psdu[15..20]` fixed-offset parse in older band code is exactly the bug this exists to kill.
3. **Migration order is gateway → seeed band → pixel-xiao → holyiot → K7 → nodes.** The gateway must dual-accept v0 and v2 (`AURA_ACCEPT_V0_AT_GATEWAY`) for the whole transition, or field bands go dark mid-migration.
4. **Promiscuous mode is debug-only.** Receivers run hardware PAN + address filtering. The legacy FCF `0x2241` has malformed addressing-mode bits and only ever worked *because* filtering was off — it will not work with filters on.
5. **Downlink is broadcast, unacknowledged.** Repeat each CMD 2–3×; devices dedupe on `(src, seq)`. Never assume delivery.
6. **Capability decides interpretation.** A device acts on a CMD field only if it has the matching capability bit. A lanyard receives the full frame and ignores the animation fields — that is the mechanism, not a special case. Adding a *message id* is safe; adding a *field to CMD* is a fleet-wide version bump.
7. **Sleep is always duty-cycled.** There is no unbounded sleep in this protocol, deliberately. A device that can't hear the wake command is a brick.

### Key constants (from the header — do not duplicate, include it)

```c
AURA_PAN_ID          0xAE7F
AURA_CHANNEL_LIST    { 15, 20, 25, 26 }   /* default 15 */
AURA_FCF_DATA_NOACK  0x8841
AURA_MHR_LEN         9
AURA_VER             2
AURA_CMD_LEN         13
```

Message ids: `EVENT 0x02` · `BEACON 0x03` · `CMD 0x04` · `NODE_RELAY 0x05` · `CONTACT 0x06` · `SYNC 0x07`
CMD fields: `msgid, ver, seq, group, anim_mode, anim_param, op_mode, op_param, R, G, B, bright, dev_flags`

Addresses: gateway `0x0001` · nodes `0x0100–0x01FF` · bands `0x1000–0xFFFD` (FICR-derived) · broadcast `0xFFFF`.

**Device identity is the 16-bit MAC short address.** Derived from chip factory UID via `aura_band_addr_from_deviceid()` — deterministic, no provisioning step. Payloads carry no separate device ID. The same value is the radio address, the registration key and the analytics key.

---

## Directory map

```
include/aura_radio.h     ← PROTOCOL SOURCE OF TRUTH. Shared by band, gateway, node.
PROTOCOL.md              ← Human-readable spec. Must match the header.
docs/
  WHITEPAPER.md          ← Canonical whitepaper (supersedes the .docx)
  CONSOLIDATION.md       ← Repo inventory, drift table, what's canonical
  demos/traitors.md      ← Audience voting demo — BUILT
  demos/live-music.md    ← DMX demo — SPECIFIED, blocked on SERVER
AURA/
  voteband/              ← nRF52840 + button. v1 beacon TX. The "prove the link" build.
  voteband-c6/           ← ESP32-C6 touch variant
  seeedFirmware/         ← XIAO band
  holyiot/ K7/ Xiao-nRF52840/ Waveshield ESP32-C6/
  sniffer/               ← nRF52840-DK/dongle. Verify frames before debugging firmware.
GATEWAY/
  nrf54-firmware/        ← RX node relay, TX to bands, UART to Pi
  pi-bridge/             ← Node.js: serial, /api/led, telemetry, admin console
  registration/ labels/
NODE/node-firmware/      ← Listen to bands, relay to gateway with RSSI. Uplink only.
CLOUD/EventBuilder/      ← Activation Studio (Vite + Supabase). Merged from 4 forks
                            2026-08-17; main.jsx routes /pair, ?view=console,
                            ?insights=sim-scenario, ?demo. See docs/CONSOLIDATION.md.
DEMOS/traitors/          ← The Traitors audience-voting demo (v0 protocol)
  wristband/             ← nRF54L15, EdgeAI hand-raise + clap, LP5012 LED
  gateway/               ← RX + UART shell
  visualiser/            ← single-file Web Serial operator UI, no build step
SERVER/                  ← ⚠ EMPTY
scripts/flatten-firmware.sh
```

`DEMOS/traitors/registration/` is deliberately absent — it lives in its own repo
(`github.com/benjaminmales/traitors-registration`) and is deployed on Vercel.

---

## Build

Zephyr / nRF Connect SDK, `west`.

```sh
cd AURA/voteband
west build -b xiao_ble .
west flash                      # or copy build/zephyr/zephyr.uf2 to the mounted drive

west build -b xiao_ble . -- -DEXTRA_CONF_FILE=debug.conf   # RTT logs via SWD
```

Board targets in use: `xiao_ble`, `xiao_nrf54l15_nrf54l15_cpuapp`, `holyiot_25008_nrf54l15_nrf54l15_cpuapp`.

**Verify on the sniffer before debugging firmware.** Flash `AURA/sniffer` to an nRF52840-DK or dongle, then in its shell:

```
channel 15
receive
```

A v1 band beacon is 16 bytes, ~1/s. Byte 15 is the gesture byte.

---

## Known gaps — do not write docs that imply otherwise

| Gap | Impact |
|---|---|
| `SERVER/` is empty | Whitepaper §6 (DMX show control) describes an unbuilt component |
| Clock sync never measured on hardware | Every ≤20 ms sync claim is design intent, not a proven figure. Highest-value cheap experiment. |
| v0/v2 drift | See above. Blocks both reference demos. |
| Channel agility unimplemented | SYNC carries the hop fields; nothing acts on them. Needed before any real venue. |
| SOCIAL / CONTACT unimplemented | Specified in v2, built nowhere. The conference-lanyard use case depends on it. |
| ROLL_CALL slotting unimplemented | Specified in v2, built nowhere. |
| Activation Studio has 4 divergent copies | See `docs/CONSOLIDATION.md` |

When documenting an unbuilt component, mark it **⚠ GAP** rather than describing it in the present tense. The whitepaper follows this convention — keep it.

---

## Related repos (not yet folded in)

| Repo | Holds | Note |
|---|---|---|
| `~/Consultancy/Traitors` | The Traitors demo — band, gateway, visualiser, registration | **Canonical.** `AETHERFIELD-DEV/traitors*` are older snapshots. |
| `~/aetherfield-cloud-demo` | `local-server`, `cloud-controller-simulator`, `fan-simulator`, show scenario contract | Source material for the Server build |
| `~/AURA-ONE-DEMO-2026` | Full field-demo monorepo, best-documented tree | Runs v0 |

Full inventory and verdicts: [`docs/CONSOLIDATION.md`](docs/CONSOLIDATION.md).

---

## ⚠ Embedded git repos — the trap in this repo

VS Code creates a `.git` in project folders (the Source Control panel's "Initialize Repository", and some extensions). When that happens inside this tree, **`git add -A` silently commits the folder as a submodule pointer (`mode 160000`) instead of files.** The contents never reach the remote and a fresh clone finds an empty directory. It warns, but the warning scrolls past in a large `git status`.

This already happened once — `AURA/Xiao-nRF52840` went to the remote as a dangling gitlink on 2026-08-19.

A pre-commit hook guards against it. **Enable it once per clone:**

```sh
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

To check by hand, or when folding in new firmware:

```sh
find . -mindepth 2 -name .git -not -path "./node_modules/*"
```

Anything that turns up must have its `.git` removed before `git add`, or be added to `.gitignore` if it genuinely belongs elsewhere.

## Conventions

- **Firmware shares `include/aura_radio.h`.** Cross-tree constant duplication is a bug.
- **Docs cite real paths.** If a doc names a file, that file exists at that path — check before writing.
- **`build/` and `node_modules/` are not review surface.** Exclude from searches; they dominate `find` output and will time out directory walks.
- **Commit messages are terse and functional** (`adding directDMX mode`, `gateway: boot-window setup AP`). Match the existing style.
- Prefer `rg` over `find` in this tree for the reason above.
