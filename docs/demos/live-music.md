# Demo — Live Music (DMX-driven synchronized crowd)

**Status:** Specified. Blocked on the Server, which does not exist.
**Proves:** The *output* half of the platform — lighting desk → Server → gateways → synchronized crowd.
**Control plane:** On-premise Server.
**Mirror demo:** [`traitors.md`](traitors.md) proves input; this proves output. Together they cover the architecture.

---

## 1. The claim being tested

> A single fader move on a lighting console re-colours the entire venue, in sync, from one radio frame.

If that holds at ten bands and two zones, the broadcast architecture says it holds at eighty thousand. The demo is deliberately the 80,000-person system at a scale of ten: same architecture, same protocol, same show format.

---

## 2. Bill of materials

| Qty | Item | Status |
|---|---|---|
| 10 | Aura One wristbands | Firmware exists (v0); needs v1 + phase clock |
| 2 | Gateways, one per zone | Firmware exists; needs v1 + clock distribution |
| 1 | **Server** | **Does not exist — `SERVER/` is empty** |
| 1 | DMX source (console or Art-Net/sACN generator) over Ethernet | Off the shelf |
| 1 | Local setup app on the Server | Not built |
| 1 | Registration app | Exists — reuse the Traitors app |
| 1 | Web dashboard, live activity summary | Partially exists — `cloud-controller-simulator` |

---

## 3. The Server — the centrepiece

This is the gap. Whitepaper §6 describes it in full and `aetherfield-platform/SERVER/` is an empty directory. Everything below is specification.

### 3.1 Pipeline

```
Lighting console
      │  Art-Net / sACN over Ethernet, ~40 Hz
      ▼
┌─────────────────────────────────────────────┐
│ SERVER                                      │
│                                             │
│  ingest ──► debounce ──► zone map ──► fan-out
│    │                                     │  │
│    └── master clock ────────────────────►│  │
└──────────────────────────────────────────┼──┘
                                           │  wired (Ethernet/UART)
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
                   Gateway A                             Gateway B
                   (zone 1)                              (zone 2)
                        │  802.15.4 broadcast                 │
                        ▼                                     ▼
                  bands in zone 1                      bands in zone 2
```

### 3.2 Ingest

Listen for Art-Net (UDP 6454) and sACN / E1.31 (UDP 5568, multicast). Accept both; a venue will have one or the other and the operator should not have to care. Track universes, expose which are live.

### 3.3 Gateway DMX personality

Each gateway is patched into the desk as a fixture with a DMX address and a fixed channel footprint. Proposed **8-channel personality**:

| Ch | Parameter | Range | Maps to |
|---:|---|---|---|
| 1 | Intensity / master dim | 0–255 | Scales RGB before transmit |
| 2 | Red | 0–255 | TLV `0x01` LED byte 2 |
| 3 | Green | 0–255 | TLV `0x01` LED byte 3 |
| 4 | Blue | 0–255 | TLV `0x01` LED byte 4 |
| 5 | Mode | stepped | Animation selector (solid, pulse, strobe, chase, …) |
| 6 | Rate | 0–255 | Interval / 10 ms |
| 7 | Group mask | stepped | TLV `0x0F` GROUP — which subgroups within the zone respond |
| 8 | Phase | 0–255 | 0 = unison; non-zero = per-group offset (the wave term, §5.1) |

Channel 8 is the interesting one. It exposes the unison/wave switch from the whitepaper's phase-clock model as a single fader — a lighting designer can morph a crowd from a unified strobe to a rolling wave without touching a menu. That is the moment that sells the system to an LD.

Two gateways at 8 channels = 16 DMX channels for a two-zone demo. Comfortably inside one universe.

### 3.4 Debounce — the critical rule

**DMX sets parameters; it does not stream frames.**

A console refreshes ~40×/s. The radio must not. The rule:

1. Sample the incoming DMX at console rate into a shadow state per gateway.
2. Compare against last-transmitted state.
3. Emit a CMD only when a parameter **actually changes**, subject to a minimum inter-frame interval (start at 50 ms, i.e. ≤20 Hz per gateway) and a maximum quiet period (heartbeat re-send every ~2 s so a late-joining band converges).
4. Coalesce: if several channels change inside one interval, send one CMD carrying all changed TLV blocks.
5. Repeat each CMD 2–3× per `PROTOCOL.md` — broadcast has no ACKs.

Getting this wrong is the most likely way the demo fails. Too eager and the radio saturates and bands miss frames; too lazy and fader moves feel sticky. **Instrument it**: log commands-per-second per gateway and surface it in the setup app. A three-hour show should be a few hundred commands, not a few hundred thousand.

### 3.5 Master clock

The Server holds the master clock and pushes it to gateways over the wired link. Gateways broadcast it in a NET message; bands discipline their local clock to each broadcast.

- Wired path (Server ↔ gateways) is deterministic — that's why the clock lives there.
- Only the final radio hop needs periodic correction.
- Both gateways share one master, so zone 1 and zone 2 stay mutually synchronized. **This is what the two-zone setup exists to prove.**
- Resync interval is the variable to tune. Target ≤20 ms device-to-device spread. Start at 10 s and back off.

### 3.6 Zone and group mapping

Operator-editable map:

```
DMX universe/address  →  gateway  →  zone  →  group masks within the zone
```

A gateway owns a physical zone; group masks subdivide it. The same console can paint sections differently or run a wave that crosses zone boundaries from one coherent patch.

### 3.7 Cloud uplink (optional)

Presence and engagement events stream up to the Cloud so a stadium audience can also be registered, messaged and measured. **The uplink must never sit in the show path** — if the internet drops, the lighting keeps working and the uplink backfills.

---

## 4. What already exists to pull from

Scattered across four repos. Consolidating these is half the work.

| Asset | Where | Use |
|---|---|---|
| Show Scenario contract v1 | `docs/SHOW-SCENARIO.md` | ✅ promoted into this repo |
| Wembley venue manifest | `docs/reference/venue-manifest-wembley.json` | ✅ harvested. Multi-level venue model — richer than the Show Scenario schema |
| Fan simulator | `docs/reference/fan-simulator-*` | ✅ harvested. Load-test without 10k physical bands |
| `directDMX` mode | `aetherfield-platform` gateway (commit `e44566b`) | Existing DMX path — the Stage 1 shortcut |
| `operator` / `operator-interface-simulator` | `aetherfield-cloud-demo` | Operator UI patterns — assess before retiring the repo |

> **⚠ Correction (2026-08-19).** An earlier draft of this document cited `aetherfield-cloud-demo/local-server` as "the closest thing to a Server today — start here." That was wrong: `local-server/`, `remote-server/` and `ÆTHERTICK/` are all **empty directories**. There is no prior art for the Server. It starts from nothing, which makes roadmap R3 larger than previously implied.
| `directDMX` mode | `aetherfield-platform` gateway (commit `e44566b`) | Existing DMX path — the Stage 1 shortcut |
| `pi-bridge` | `AURA-ONE-DEMO-2026/gateway/pi-bridge` | Serial ↔ HTTP ↔ Supabase; the wired-link precedent |
| Activation Studio | Three divergent copies — see `../CONSOLIDATION.md` | Authors the Show Scenario |
| Registration app | `~/Consultancy/Traitors/Demo/registration` | Reuse wholesale |
| Supabase migrations | `AURA-ONE-DEMO-2026/supabase/migrations` | Devices, bindings, telemetry schema |

---

## 5. Build order

Each step is demonstrable on its own, so the demo degrades gracefully if time runs out.

| Step | Deliverable | Depends on |
|---|---|---|
| **0** | Protocol v1 on gateway + band (roadmap R1) | — |
| **1** | Clock sync validated: 10 bands, one gateway, hold unison 60 s, measure spread (R2) | 0 |
| **2** | Server skeleton: Art-Net/sACN ingest → log decoded channels. No radio yet. | — (parallel with 0/1) |
| **3** | Server → one gateway → one zone. One fader changes the colour of ten bands. | 0, 2 |
| **4** | Debounce + instrumentation. Commands/sec visible and sane under a fader sweep. | 3 |
| **5** | Second gateway, second zone, shared master clock. **Cross-zone sync is the money shot.** | 1, 3 |
| **6** | Group masks + phase channel. Unison ↔ wave on one fader. | 5 |
| **7** | Setup app: DMX map editor, zone config, cloud upload toggle. | 5 |
| **8** | Registration + dashboard: guests bind bands; presence round-trips; dashboard reflects the room. | 5 |

**Steps 0–1 are non-negotiable prerequisites.** Step 1 is cheap, fast, and the highest-information experiment in the whole programme — if the sync budget doesn't hold, the architecture needs revisiting before anything is built on top of it.

---

## 6. What this validates

- Live DMX-to-radio control with real console behaviour
- Multi-gateway zoning and cross-zone clock coherence
- On-device synchronized animation under the phase-clock model
- Registration-to-identity binding at show scale
- Telemetry round-trip to a live dashboard
- The cloud-upload path, without it entering the show path

---

## 7. ⚠ Risks

| Risk | Mitigation |
|---|---|
| **Clock sync doesn't hold to 20 ms** | Measure at step 1, before anything depends on it. If it fails, options are a shorter resync interval, a temperature-compensated oscillator, or accepting a looser budget for slow effects only. |
| **Debounce tuning saturates the radio** | Instrument commands/sec from day one; make the minimum interval a config value, not a constant. |
| **Zone handoff at the boundary** | Bands in overlap hear both gateways. Both must carry the same clock and compatible commands; decide precedence explicitly rather than letting last-frame-wins decide it. |
| **Venue 2.4 GHz congestion** | v1 channel agility (energy scan + `CHANNEL_HOP`) exists in spec, unimplemented. Needed before any real venue. |
| **Scope creep into the Cloud** | The Server must be demonstrable with the internet unplugged. Enforce that as an acceptance test, not a principle. |
| **Server is a genuinely from-scratch build** | There is no prior art — `local-server` and `remote-server` are empty. Stage 1 can fall back to `directDMX` + Pi bridge for something demoable while the real Server lands, but budget for a full build, not a port. |
