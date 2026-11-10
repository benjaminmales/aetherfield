# Fan simulation architecture: scaling to 80k

## How the current “AI” works (today)

There is **no LLM**. Behaviour is fully deterministic:

- **One global tick** every ~80ms over all fans (`TICK_MS`, `FANS` env).
- Each fan has a **phase** (0–1), **cluster_id** (~200 clusters), **archetype_id** (~12), and **zone_id** (0–3: North/South/East/West from seat x,z).
- **Zone macro-state**: Per tick, each zone aggregates mean arousal/valence/compliance from its fans (EMA), then **mixes with neighboring zones** (stadium quadrants share edges). Fans blend their personal wave + cluster response with the **zonal energy/valence field** and contagion—so sections diverge without O(n²) neighbour graphs.
- **Events**: `POST /api/event` with `type`, optional `duration`, optional `zones` (subset). Durations are type-dependent defaults (see `DEFAULT_EVENT_DURATION` in **sim-engine.js**).
- **Output**: mode, r, g, b, gesture from arousal/valence + event strength + zone blend.

So: **80k lightweight records**, **cluster + archetype + zonal fields**, **scalable O(n) + O(Z)** per tick.

---

## Target: 4-layer design (your spec)

### 1. Venue layer

- **World state**: seating blocks, concourses, zones (audio, lighting, density).
- **Use**: which zone a fan is in → which show_state and local density they see. Not per-fan pathfinding; coarse zones and constraints.

### 2. Fan layer (80k lightweight agents)

Each fan has **state only** (no full “mind”):

- **Identity**: `fan_id`, `archetype_id`, `cluster_id`, `seat_section`, `x,y,z`.
- **Emotional dimensions** (small vector, e.g. 0–1):
  - `arousal`, `valence`, `attention`, `affiliation`, `compliance`.
- **Behavioural state**: `engagement`, `fatigue`, `arrival_state`, wearable state, etc.
- **No** natural language, no LLM calls. Updates from **numeric rules + neighbour influence + events**.

### 3. Cluster / tribe layer (100–500 “group minds”)

- **Clusters** own shared mood and response style (e.g. “front-standing superfans”, “corporate casual”, “content creators”).
- Each cluster has:
  - **Base identity** and **response profile** (how they react to bass drop, ballad, delay, prompt).
  - **Contagion sensitivity** and **synchronisation** behaviour.
- **80k fans** are **assigned** to a cluster (and optionally an archetype within it). Behaviour is computed from **cluster policy + archetype bias + local neighbours**, not 80k independent brains.

### 4. Director / event engine

- **Show state**: setlist moment, lighting, “bass drop”, “crowd prompt”, delay, etc.
- **Events** drive the sim: e.g. `{ type: "bass_drop" }`, `{ type: "wearable_pulse", section: "floor" }`.
- The **crowd** (fan + cluster logic) **reacts** to these; no need for 80k LLM calls.

---

## Key modelling idea

- **Do not** simulate 80k independent conversations.
- **Do** simulate:
  - **Individual state** (small vectors per fan).
  - **Local influence** (neighbours / section aggregates).
  - **Global event triggers** (show_state).
  - **Emotional contagion** (cluster + neighbourhood).
  - **Optional hero agents** (e.g. 100–1000) for richer narrative or social spread.

---

## Practical data structures (in code)

### Fan (per agent, 80k)

```js
{
  fan_id, archetype_id, cluster_id, section_id,
  x, y, z,
  arousal, valence, attention, affiliation, compliance,  // 0–1
  engagement, fatigue,
  mode, r, g, b, gesture,   // output for viewer
  phase,                     // for wave/sync
}
```

### Cluster (100–500)

```js
{
  cluster_id, name,
  responseProfile: { bassDrop: 1.2, ballad: 0.8, prompt: 1.0, delay: -0.5, ... },
  contagionSensitivity: 0.8,
  syncStrength: 0.9,
  moodVector: { arousal, valence, ... },  // shared, updated by events + members
}
```

### Archetype (50–200)

```js
{
  archetype_id, name,
  bias: { arousal, valence, ... },       // additive to cluster
  complianceBase: 0.7,
  likelihoodWave: 0.9, likelihoodFilm: 0.3, ...
}
```

### Show state (global)

```js
{
  showTime, setlistMoment, currentEvent,
  zones: { floor: { energy, sync }, upper: { ... } },
}
```

---

## Update loop (multi-resolution)

- **Fast loop** (e.g. 5–10 Hz): crowd waves, hand raises, cheer response, sync, **wearable visual output** (mode, r, g, b). This is what the viewer needs.
- **Slow loop** (e.g. every 10–30 s): mood, fatigue, intention, concession/leave behaviour, cluster mood drift.

Formula per fan (fast tick):

```text
fan_state(t+1) = f(
  fan_state(t),
  cluster_policy(cluster_id),
  archetype_bias(archetype_id),
  zone_state(section_id),
  show_state(currentEvent),
  neighbour_influence(local_fans),
  stochasticity
)
```

All of this can be **vectorised** (e.g. NumPy/JAX over arrays) or, in Node, **batched for-loops** over fans by cluster/section so we never do 80k “heavy” operations—only lightweight numeric updates.

---

## Where to use real AI (later)

- **Archetype / cluster design**: LLM generates 50–200 personas and cluster response styles; **compile to numeric policies** (no LLM at runtime).
- **Hero agents** (100–1k): optional richer agents with memory, influence, narrative; can be a separate subsystem.
- **After-action**: LLM summarises logs (“Section 114 lagged during acoustic set”, “sync peaked after prompt”).

---

## Phased implementation in this repo

| Phase | What | Scale |
|-------|------|--------|
| **1** | Global wave + basic events. | 80k fans. |
| **2 (in code)** | Clusters + archetypes; emotional dimensions; event types; mode/rgb from arousal/valence. | 80k, ~200 clusters, ~12 archetypes. |
| **3 (in code)** | **Zonal macro-state** (4 stadium quadrants): aggregation, neighbor mixing, fan blend; optional `ZONAL_CONFIG_PATH`; classical **zonal-optimizer.mjs** (quantum-ready hook). | Same 80k, O(Z) zone work. |
| **4** | Control server: **CONTROL_SERVER_URL** forwards batched gateway reports; optional hero agents / slow loop later. | 80k + integration. |

**GET /api/state** includes `zoneSummary` and `zonalParams` for debugging and downstream UIs.

---

## Wristband and gateway simulation

The simulator models the **physical layer** that a real venue would have: wristbands with LEDs and gesture sensing, and gateways that broadcast control and receive reports.

### Wristbands (per fan)

- **UUID**: `device_id` (e.g. `WB-00001`).
- **LED**: mode, r, g, b (driven by sim; gateways broadcast control that would set these).
- **Gestures**: detected locally on the wristband — `idle`, `wave`, `clap`, `hands_in_air`. In the sim these are driven by the behavior engine (arousal/event) so report data looks realistic.
- **RSSI**: the wristband can measure signal strength from each gateway and **prefer the nearest** (best RSSI) when receiving control; when reporting, it sends to that gateway.

### Gateways

- **Positions**: Placed over the venue (grid over seat bounding box, default 24). Exposed as **GET /api/gateways** (id, x, y, z).
- **Downlink**: Gateways broadcast control messages from the server (in sim, server drives behavior via events; no separate downlink sim).
- **Uplink**: Gateways receive reports from wristbands in range and forward them to the local server. In sim, each wristband is assigned to the gateway with best RSSI; each tick a subset of fans generates a report (uuid, gesture, rssi, gateway_id) and these are buffered.

### RSSI model

- **Distance → RSSI**: Log-distance path loss in dBm (e.g. -35 at very close, -75 at ~0.1 units). Used to assign each fan to a gateway and to attach an `rssi` value to each report.
- **Wristband preference**: “Nearest” gateway = highest RSSI; reports go to that gateway (as in real hardware where the wristband would pick the strongest gateway for uplink).

### Report stream (local server)

- **GET /api/reports**: Returns buffered wristband reports (as would be aggregated from gateways). Query params: `limit`, `since_tick`.
- Each report: `{ uuid, gesture, rssi, gateway_id, timestamp, tick }` — the data the server would use for analytics, sync checks, or replay.
- **Optional**: If **`CONTROL_SERVER_URL`** is set, the sim also **POST**s batched reports (grouped by `gateway_id`) on a fixed tick interval for integration testing with a control server (see **README.md**).
