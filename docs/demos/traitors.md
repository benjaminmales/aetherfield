# Demo — The Traitors (audience voting)

**Status:** Built and demonstrated. Runs on real hardware today.
**Proves:** The *input* half of the platform — on-device inference → radio → gateway → visualiser → cloud → the guest's phone.
**Control plane:** Cloud.
**Canonical source:** `~/Consultancy/Traitors` (see [`../CONSOLIDATION.md`](../CONSOLIDATION.md) — `AETHERFIELD-DEV/traitors` and `traitors-new` are older snapshots).

---

## 1. The pitch, in one line

> **Raise your hand. The show changes.**

The audience wears an Aura band. A guest raises a hand to vote; the band confirms in colour; the result appears live, backstage and on stage. Two-way, no phones, no apps. After the round, each guest's phone receives a personalised, AI-written verdict on how *they* voted.

Built around *The Traitors* stage show, but the mechanic is format-agnostic: any live show that wants the room to decide something.

---

## 2. Show beats

| # | Beat | What the guest does | What the system does |
|---|---|---|---|
| 1 | **Arrival** | Scans the QR on the band strap | `/register?d=A1B2` → name + mobile → Supabase; WhatsApp/SMS welcome |
| 2 | **Idle** | Wears the band | Band beacons ~1×/s; visualiser shows it join the active roster |
| 3 | **Round opens** | Sees the prompt on stage | Operator hits Start; bands are cleared and cued to voting colour |
| 4 | **The vote** | **Raises a hand** | On-band inference fires; flag set in the beacon; gateway parses; visualiser tallies live |
| 5 | **Confirmation** | Band turns their chosen colour | Downlink command confirms the vote was received — the feedback loop that makes it feel real |
| 6 | **Reveal** | Watches the tally resolve | Operator hits Finish; result POSTed to the cloud |
| 7 | **The sting** | Phone buzzes | Claude writes an in-character verdict per guest — did *they* back the banished traitor? |
| 8 | **Exit** | Leaves | Personal data hard-deleted 30 minutes after registration |

Beat 5 is the one that sells the product in the room. Every other audience-participation technology is one-way; the band answering back is what makes people lean in.

---

## 3. Components

### 3.1 `Demo/wristband/` — Aura band firmware

Zephyr / nRF Connect on **Seeed XIAO nRF54L15**.

| Aspect | Detail |
|---|---|
| Radio | Raw 802.15.4 (`IEEE802154_RAW_MODE`). No BLE, no Wi-Fi. |
| Sensing | LSM6DSO IMU + PDM microphone |
| Inference | Nordic Edge AI (`nrf_edgeai`) on-device → **hand raise** and **clap** |
| Output | LP5012 RGB LED driver over I²C; graceful no-op if no LED daughterboard is fitted |
| Identity | 16-bit id from chip factory UID at boot (`derive_device_id()`) → the `A1B2` uuid used everywhere downstream |
| Power | Serial, logging and USB all disabled for battery operation |

The inference-on-band decision is the architecturally important one: the radio carries a classification bit, not a sensor stream. That is what makes a crowd of these tractable.

### 3.2 `Demo/gateway/` — receiver

Same board. Listens for band broadcasts, prints parsed lines to serial, sends downlink colour/mode commands. Shell over UART for live operator control.

### 3.3 `Demo/visualiser/` — operator UI

Single-file `index.html`, ~49 KB, **no build step**. Connects to the gateway over **Web Serial** (Chromium only).

- Voting UI: Start round → bands raise → split-vote toggle → Finish → reveal
- Live signals panel: hand-raise and clap per band
- Active-band roster with battery readout, stale-band garbage collection, blacklist
- Simulation mode for rehearsing without hardware
- Settings pane holds the cloud endpoint and bearer secret; POSTs the round result on Finish

> **Worth promoting to the platform.** Zero build, zero deploy, zero dependency on a network. It opens from a file on a laptop in a venue with no internet, which is exactly the failure mode that kills demos. See roadmap R6.

### 3.4 `Demo/registration/` — cloud app

Next.js 14 on Vercel. Live at `https://traitors-registration.vercel.app`.

- QR on the strap → `/register?d=<uuid>` → name + mobile → Supabase
- Twilio: WhatsApp first, SMS fallback
- `@anthropic-ai/sdk` writes the personalised in-character verdict per guest
- `/qr` prints a sheet of band QR codes for strap application
- `theatre-intel/` holds show context: seat plan (`seats.xlsx`), production links, running times (19:30 / interval 21:00 / end 22:20)

---

## 4. Wire formats

### Uplink — band → gateway (4 bytes, **v0**)

```
[0] 0x03   UUID_BROADCAST_ID
[1] device id, low byte
[2] device id, high byte
[3] flags — bit1 = clap, bit2 = hand raised
```

### Downlink — gateway → band (6 bytes, **v0**)

```
[0] 0x04   command id
[1] mode
[2] rate   (interval / 10 ms)
[3] R
[4] G
[5] B
```

### Visualiser → cloud

`POST /api/vote-result`, `Authorization: Bearer <VOTE_RESULT_SECRET>`

```json
{ "votes": { "1": ["A1B2"], "2": ["C3D4"] }, "totalBands": 12 }
```

### Registration API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/register` | Bind name + mobile to a band uuid |
| `POST /api/vote-cast` | Instant reaction as a wrist rises |
| `POST /api/vote-result` | Round tally at Finish |
| `GET /api/session-status?cell=\|?d=` | Is this guest inside an active visit — **the Aurea seam** |
| `GET /api/registrations` | Operator view |
| `GET /api/purge` | Cron sweep |
| `POST /api/reset` | Clear state between rehearsal runs |

### Database — Supabase (shared project with Aurea)

`traitors_registrations` — `device_id` (unique), `name`, `cell`, `expires_at` (default `NOW() + 30 min`), timestamps. Indexed on `device_id` and `expires_at`.

`traitors_vote_rounds` — `winner` (`Traitor I` | `Traitor II` | `Tied`), `tally_1`, `tally_2`, `total_bands`, `payload` (JSONB), `sent_count`, `created_at`.

Full DDL: `Demo/registration/schema.sql`.

---

## 5. Privacy model

The pattern to carry into the platform (roadmap R6):

- Guest rows carry `expires_at` = registration + 30 minutes (`SESSION_MINUTES`) and are **hard-deleted**, not soft-flagged.
- Purge runs **lazily on every API call**, plus a daily Vercel cron at 03:00. No window where stale personal data waits for a batch job.
- **Vote-round logs survive the purge because they never contained personal data** — band uuids and tallies only. The engagement record outlives the identity record by design.

Commercially this means Aetherfield can offer an identity-driven, personalised audience experience while holding personal data for the length of one performance. That is a much easier conversation with a producer's legal team than any model that retains a guest database.

---

## 6. ⚠ Gaps and required work

### 6.1 Rescue the firmware — do this first

`Demo/gateway` and `Demo/wristband` are **local-only git repos with a single "Initial commit" and no remote**. `Demo/visualiser` is **not under version control at all** — 48 KB of working operator UI with no history and no copy anywhere. Only `Demo/registration` has an origin.

The only firmware that has run a live client demonstration exists on one disk.

```sh
cd ~/Consultancy/Traitors/Demo
git -C visualiser init && git -C visualiser add -A && git -C visualiser commit -m "Initial commit"
for c in gateway wristband visualiser; do
  gh repo create "benjaminmales/traitors-$c" --private --source="$c" --remote=origin --push
done
```

Nothing else on this list matters until this is done. Roadmap **R0**.

### 6.2 Migrate to protocol v1

The demo runs v0 — the promiscuous-mode byte-scan the platform is migrating away from. In a theatre with contested 2.4 GHz this is the first thing that breaks.

| Current (v0) | Target (v1) | Notes |
|---|---|---|
| Byte-scan for `0x03` at a fixed offset | Parse app header `0xA7` at payload offset 0 | Gateway first, dual-accept during transition |
| Promiscuous mode | Hardware PAN `0xAE7F` + address filter | Radio drops foreign traffic before the CPU sees it |
| Flags byte, bits 1–2 | BEACON `gesture` byte | `caps(1) battery(1) gesture(1) flags(1)` |
| ID `0x04` LED payload | CMD `0x8` + TLV `0x01` LED | Same `mode, rate, R, G, B` value — a near drop-in |
| No round concept on-band | TLV `0x04` VOTE_CTRL `action, round_id` | **Already specified in `PROTOCOL.md` and unimplemented.** Moves round state onto the band, so a band knows whether its raise counts. |
| No dedupe | `(src, seq)` dedupe, CMD repeated 2–3× | Broadcast has no ACKs |

**Migration order:** gateway (dual-accept v0 + v1) → wristband → drop v0 acceptance.

**Note the free win:** `VOTE_CTRL` already exists in the v1 spec. Migrating gets round open/close semantics on the band, which the current design fakes in the visualiser.

### 6.3 Other open items

| Item | Why it matters |
|---|---|
| Clock sync unvalidated | Voting doesn't need tight sync, but any lighting cue during the show does. Blocked on roadmap R2. |
| Single gateway | The demo runs one. A real auditorium needs 8–12 with overlapping coverage and no dead seats. Zone handoff is untested. |
| Web Serial is Chromium-only | Acceptable for an operator laptop; document it as a venue requirement rather than discovering it on the night. |
| Bearer secret in a settings pane | Fine for a demo, not for a touring product. Needs to move to a provisioned config. |
| `Holyiot-Test/` is a parallel track | Alternative hardware evaluation, not the main line. Decide whether to keep or drop before it becomes a third protocol variant. |
| No band-count sanity check | `totalBands` comes from the visualiser's own roster. A stale or blacklisted band skews the denominator. |

---

## 7. What to reuse elsewhere

| Pattern | Where it goes |
|---|---|
| 30-minute hard-delete privacy purge | Platform default for all registration (R6) |
| Chip-UID → 4-hex-char identity | Already the v1 address scheme; the Traitors implementation is the reference (`derive_device_id()`) |
| Single-file, zero-build Web Serial operator UI | The pattern for any venue-side tool that must work without internet |
| `pitch-ai-instructions.md` | House deck-generation spec — dark theme, one accent, tables stay tables |
| `/api/session-status` | The Aurea integration seam; built for exactly this |

---

## 8. Assets

| File | What it is |
|---|---|
| `deck-copy-brief.md` | The canonical 8-slide narrative |
| `deck-copy-audience-voting.md` | Long-form source (18 KB) the brief was cut from |
| `pitch-ai-instructions.md` | Slide generation spec |
| `aura-cost-model-v3.xlsx` | Current cost model (v1/v2 in `Archive/`) |
| `symbol-*.svg` | Icon set: aura-wristband, aetherfield-gateway, aetherfield-server, aurea |

**Show references:** [thetraitorsonstage.com](https://www.thetraitorsonstage.com/) · [London venue announcement](https://www.londontheatre.co.uk/theatre-news/news/the-traitors-stage-play-announces-london-venue)
