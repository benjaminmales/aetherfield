# Proximity-to-Screen via Bluetooth Channel Sounding — Design v0.1

**Context:** Aetherfield event lanyards (K7 / nRF54L15). When an attendee's lanyard
gets close to a screen, detect it *reliably* and play content related to that
attendee. The lanyard already speaks the Aetherfield 802.15.4 protocol (v1).

**Decisions baked in (from review):**
- A handful of lanyards (1–8) near any one screen at a time.
- Lanyards run an "always-on" proximity mode for the event duration, then sleep.
- This document precedes a proof-of-concept build.

---

## 1. Goal & requirements

- Detect "this specific lanyard is within ~1–1.5 m of screen N" **reliably**, in a
  crowded indoor RF environment, with body-worn tags.
- Sub-second to ~1–2 s response when someone walks up.
- Tie the detection to the lanyard's identity so the screen can play *related*
  content.
- Don't break the existing 802.15.4 / Aetherfield comms.
- Keep multi-year shelf life; event-day battery cost is acceptable but must be
  bounded.

## 2. Why Channel Sounding (not RSSI)

The cheap approach — screen advertises, read RSSI, "strong = close" — will be
unreliable here. A lanyard sits against a body (heavy 2.4 GHz attenuation) and
RSSI-to-distance in a hall full of people is dominated by multipath. Expect false
triggers and misses.

Bluetooth Channel Sounding (CS) measures true phase/time-of-flight distance
(sub-metre), which is the reliability the use case needs. **Use RSSI only as a
cheap gate** to decide *when* a CS measurement is worth doing — never as the
measurement itself.

## 3. Approach: coarse gate, then CS confirm

Two stages, lanyard-driven, connections kept transient:

1. **Coarse presence (connectionless, cheap).** Each screen anchor advertises a
   small BLE beacon carrying its screen/zone ID. The lanyard duty-cycle-scans for
   these beacons. A beacon above an RSSI gate = "maybe near screen N."
2. **Precise ranging (CS, on-demand).** The lanyard opens a brief BLE connection
   to that anchor and runs **one** CS procedure → a real distance. If under the
   threshold (e.g. < 1.5 m) and stable (hysteresis / N consistent reads), it's
   "at the screen."
3. **Trigger.** The near-event `{screen_id, lanyard_id, distance}` is reported to
   the content system. Screen plays the related content.
4. **Release.** Lanyard disconnects and returns to scanning. Distance hysteresis
   plus a dwell timeout decides when the attendee has "left."

Keeping the connection transient (connect → range → disconnect) is what makes
this scale — see §9.

## 4. Topology & roles

| Element        | Hardware                     | Power     | GAP role          | CS role     |
|----------------|------------------------------|-----------|-------------------|-------------|
| Lanyard tag    | K7 / nRF54L15                | battery   | Central (connects)| **Reflector** |
| Screen anchor  | nRF54L15 (DK or module)      | mains     | Peripheral (advertises) | **Initiator** |
| Aetherfield GW | existing nRF54 gateway       | mains     | n/a (802.15.4)    | n/a         |
| Content system | screen media player / CMS    | mains     | —                 | —           |

Notes:
- CS roles (Initiator/Reflector) are independent of GAP roles. The mains-powered
  anchor is the **Initiator** and does the ranging math; the lanyard is the cheap
  **Reflector**. This puts the cost where the power is.
- Lanyard as **Central** means it decides *when* to connect (based on its own RSSI
  gate), so the anchor isn't trying to chase every nearby tag.
- The anchor reports detections to the content system directly (lowest latency).
  The Aetherfield gateway remains the source of truth for fleet/LED/state over
  802.15.4; the two planes are decoupled.

## 5. Sequence

```
Lanyard (Central / CS Reflector)        Screen anchor (Peripheral / CS Initiator)
---------------------------------        -----------------------------------------
  [event mode: duty-cycle scan] <------- ADV: {screen_id, zone}   (continuous)
  RSSI > gate? --------------------------------> connect (ACL)
  CS Reflector role ----- CS subevents -----> CS Initiator computes distance d
                                              if d < threshold (stable):
                                                  report {screen_id, lanyard_id, d}
                                                  -> content system plays content
  disconnect <---------------------------------- disconnect / keep-until-dwell-out
  [back to scan]
```

The lanyard's identity (`lanyard_id` = its Aetherfield short address / FICR-derived
ID) is sent on connect (in the connectable ADV payload or a short GATT read).

## 6. Radio coexistence (one radio)

The nRF54L15 has a single 2.4 GHz radio, so BLE and 802.15.4 are **time-shared**,
never simultaneous. Two ways to run them; we use the first:

1. **MPSL dynamic multiprotocol (recommended).** Bring up the SoftDevice Controller
   (BLE + CS) and the 802.15.4 raw driver together; MPSL arbitrates timeslots and
   gives **BLE priority**. The 1 Hz Aetherfield beacon slots into the gaps, and a
   CS event briefly preempts it (a skipped beacon is harmless).
2. Sequential teardown/rebuild of stacks — matches the "switch over" mental model
   but is fiddly in NCS; not recommended.

**Caveat to validate:** Nordic currently lists CS as *not supporting radio
coexistence or front-end modules*. That refers to external-radio coex (PTA/FEM),
which we don't use. BLE+802.15.4 *multiprotocol timeslotting* is a separate, supported
mechanism — but we must confirm on our NCS version that 802.15.4 timeslots don't
disturb an in-progress CS procedure. Mitigation if needed: suspend 802.15.4
beaconing for the few ms of an active CS measurement.

## 7. Identity → content

- `lanyard_id` is the existing Aetherfield band short address (FICR-derived,
  no provisioning).
- At registration, `lanyard_id → attendee profile` is recorded (this is also where
  the planned NFC tap can bind a wristband to a person).
- Anchor emits `{screen_id, lanyard_id, distance, timestamp}`; the content system
  resolves `lanyard_id → profile → content` and plays it on `screen_id`.

## 8. Power model

Datasheet figures (nRF54L15 @ 3.0 V): System OFF ~0.8 µA, System ON idle ~2.6 µA,
RX/scan ~3.2 mA, TX +8 dBm ~10 mA. Cell = 800 mAh non-rechargeable.

- **Storage (between events):** System OFF ~0.8 µA → ~7 mAh/year. Years of shelf
  life regardless of event use.
- **Event mode (always-on proximity), continuous scan:** ~4 mA → ~200 h of
  continuous scanning total. A single 10 h event ≈ 40 mAh (~5 % of the cell); a
  3-day × 12 h festival ≈ ~145 mAh. Comfortably within budget for occasional events.
- **Event mode, duty-cycled scan (recommended):** e.g. 30 ms scan / 300 ms (10 %)
  ≈ ~0.45 mA → a 10 h event ≈ ~4.5 mAh. Negligible, and still sub-second to find a
  screen for a walk-up. **Prefer this over continuous scan** unless latency demands
  otherwise.
- **CS bursts:** a connection + one CS measurement is short (well under a second of
  radio activity); at a handful of screen encounters per attendee it's in the noise.

Net: continuous-scan event mode is affordable; duty-cycled scan makes it trivial.
Bound event mode to the event and return to System OFF for storage.

## 9. Reliability & tuning

- **Body / orientation blocking** is the dominant real-world risk (lanyard facing
  away from the screen). Validate physically; consider anchor placement at
  chest/lanyard height and on the approach side.
- **Multipath:** require N consistent CS reads and apply distance **hysteresis**
  (enter at < 1.5 m, exit at > 2.5 m) plus a dwell timeout so content doesn't flap
  as people mill.
- **RSSI gate** keeps CS off the air for faint/irrelevant beacons; tune the
  threshold so it fires slightly before the CS range of interest.
- **Anti-flap at the content layer:** debounce per `lanyard_id`/`screen_id` so a
  brief pass-through doesn't trigger a full content play.

## 10. Scaling (1–8 per screen)

With a handful per screen, **one anchor per screen** serialises easily: connect →
range → disconnect cycles through nearby tags in a fraction of a second each, so
walk-up latency stays sub-second to ~1–2 s. The hard limit is *concurrent*
connections (`BT_MAX_CONN` / `BT_CTLR_SDC_CS_COUNT` — single digits to low tens),
not measurement speed, and transient connections keep us well under it. If a screen
later needs denser crowds, add a second anchor or pre-filter the front row by
RSSI/802.15.4 before ranging.

## 11. Firmware impact

**Lanyard (K7):** today it's raw 802.15.4 + deep sleep. Add:
- `CONFIG_BT=y` + SoftDevice Controller, GAP **Central** + scanning.
- `CONFIG_BT_CTLR_CHANNEL_SOUNDING=y`, `CONFIG_BT_CTLR_SDC_CS_COUNT=1`, CS
  **Reflector** role.
- 802.15.4 raw driver kept, now running under MPSL alongside the BLE controller.
- Event-mode state machine: scan → gate → connect → CS → report → disconnect, with
  the existing beacon continuing between CS events.
- Flash/RAM: BLE stack adds tens of KB; fine on the L15 (1.5 MB RRAM / 256 KB RAM).

**Screen anchor (new, mains-powered):** GAP Peripheral advertiser + CS Initiator;
computes distance; reports detections to the content system (UART/USB/IP). Can be
an nRF54L15 DK for the PoC.

## 12. Requirements & caveats

- nRF Connect SDK **≥ 3.0.1** (CS qualified host+controller).
- CS supported on **nRF54L15**; Reflector role across the nRF54L series.
- CS currently **without** external radio coexistence / FEM (see §6).
- CS needs a CS-capable peer — the screen anchor (or, for testing, a Pixel 10-class
  phone, which Nordic has demoed).

## 13. Open questions / validation plan

1. Confirm our NCS version and that BLE+802.15.4 multiprotocol doesn't disturb CS
   timing (or gate the beacon during CS).
2. Bench-measure CS distance accuracy and variance with a lanyard worn on a body,
   at the real approach geometry.
3. Decide where the detection is reported (anchor → CMS directly vs via gateway).
4. Define the exact "enter/exit" thresholds and dwell logic with the content team.
5. Confirm how event mode is switched on in practice (staff action / NFC at
   check-in) and its timeout back to System OFF.

## 14. Proof-of-concept scope (next)

A minimal end-to-end ranging path:
- K7 lanyard build: 802.15.4 beacon (as now) **plus** a BLE CS **Reflector** under
  MPSL; enters event mode and connects to an anchor when its beacon is heard above
  the RSSI gate.
- Screen-anchor build (nRF54L15 DK): advertiser + CS **Initiator**, prints
  `{lanyard_id, distance}` over RTT/UART on each measurement.
- Success = stable sub-metre distance readings as the lanyard approaches, with the
  802.15.4 beacon still flowing.

> This PoC deliberately skips the content system, registration binding, and power
> optimisation of event mode — it exists only to prove the CS ranging path coexists
> with Aetherfield 802.15.4.
