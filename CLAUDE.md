# Aetherfield — repo guide

**This is the only repo where work happens** (from 2026-11-10).
`~/aetherfield-platform` and `~/aetherfield-pixel` are frozen archive, along
with everything they had already frozen. Don't edit them. If something there
is needed, copy it here and add a line to `docs/CONSOLIDATION.md`.

## The product range

Aura One · Aura Lite (wearables) · Aura Tag (demo device) · Aura Marker
(fixed anchor) · Aura Link (gateway) · Aura Server (on-site) · aetherfield.cloud.
State of each: `README.md`.

**Device → Aura Link → Aura Server is the real-time path and must work with
the venue internet unplugged.** The cloud tolerates latency and never sits
between the lighting desk and the crowd.

## The cordon

`lab/` is for experiments. **Nothing outside `lab/` may reference it**:
CMake, #include, require/import, Kconfig, overlays.
`scripts/check-cordon.sh` enforces it in the pre-commit hook and CI. Lab may
use production code freely. To promote, move the code out of lab into
production and review it. Never link to it from production.

## Protocol rules (v2)

1. **`include/aura_radio.h` is the source of truth.** If `docs/PROTOCOL.md`
   or the whitepaper disagree with it, the doc is the bug.
2. Never hand-copy protocol constants. Include the header.
3. Every device app gets radio, CMD/SYNC, dedupe, groups, op_mode, beacons
   and animation from `firmware/common/aura_band.c`. **A device app supplies
   one render callback** (plus its inputs). If a board needs to touch the
   radio, the seam is in the wrong place. Raise it rather than working around it.
4. Downlink is broadcast and unacknowledged. Repeat 2–3×, devices dedupe on
   (src, seq). Delivery is measured from `last_cmd_seq` echoed in beacons.
5. Capability decides interpretation. Adding a message id is safe. Adding a
   field to CMD is a fleet-wide version bump.
6. Sleep is always duty-cycled. A device that can't hear the wake command
   is a brick.
7. Promiscuous mode is debug-only. Receivers filter on PAN 0xAE7F + address.
8. **FICR-derived addresses collide** (≈203 pairs at 5,000 devices). Fine
   for a demo handful; fleets get addresses assigned at flash time.

Groups (bitmask): `0x02` XIAO Pixel · `0x04` Holyiot Pixel · `0x08` Aura Tag.
Allocate new ones here.

**What an Aura device does: three things.** Receive behaviour commands,
detect motion, transmit its id and status. No button input. Aura Tag
exists to test exactly that set. Don't add inputs the products won't have.
Motion is `AURA_EVENT_MOTION` (value 1 started / 0 stopped, on transitions
only) plus the `AURA_FLAG_MOVING` level in every beacon.

## Build

nRF Connect SDK **v3.3.4**, built in VS Code (nRF Connect extension). Give
build configurations (board target, base conf, extra fragments), not west
command lines. Board roots are set in `.vscode/settings.json`.

| App | Board target | Extra fragment |
|---|---|---|
| `firmware/aura-link` | `xiao_nrf54lm20a/nrf54lm20a/cpuapp` | `gwNN.conf` (one per unit) |
| `firmware/aura-tag` | `holyiot_25008_nrf54l15/nrf54l15/cpuapp` | none |

## Known gaps — mark them ⚠ GAP in docs, never in the present tense

- Aura One, Aura Lite and Aura Marker firmware not started
- Battery life unmeasured on every device. Quote no figure until measured
- Positioning is zone-level (which Link) today. Marker proximity is designed
  but unbuilt, and metre-level accuracy is unproven. Don't write docs that
  imply otherwise
- Clock-sync accuracy never measured on hardware
- Channel agility, CONTACT/SOCIAL, ROLL_CALL slotting: specified, unbuilt
- aetherfield.cloud and the wiki: not started

## Environment traps (for Claude sessions)

- **Never run `git` in this folder through the device bridge**, not even
  `git status`. The bridge can't delete `.git/index.lock`, and a stranded
  lock silently breaks Benjamin's next commit. Git is his.
- The bridge cannot delete files. Move to `_to_delete/` instead.
- Verify firmware by building in the cloud container against NCS v3.3.4
  before handing it over.
- `build*/` and `node_modules/` are not review surface. Exclude them from searches.
