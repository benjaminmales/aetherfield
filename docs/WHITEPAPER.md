# Aetherfield

**A platform for synchronized wearable experiences, at any scale.**
From 100-band brand activations to 80,000-person live shows.

White Paper · Version 2 (draft) · Technical & strategic overview

---

> **v2 change log — what moved since v1.docx**
>
> | Change | Where |
> |---|---|
> | Added **Aurea** as the fifth product; stack is now Aura → Gateway → Server → Cloud → Aurea | §3, §9.4, Glossary |
> | Added the architecture table §3 prose implied but never showed | §3.1 |
> | **§11 Roadmap** written (was empty) | §11 |
> | **Appendix A Protocol Quick Reference** written (was empty) | Appendix A |
> | §10 split into **two** reference demonstrations — Traitors (built) and Live Music (specified) | §10 |
> | Added §4.5 on the two band tiers (reusable / give-away) and commercial model | §4.5, §12 |
> | Added §9.4 on the privacy purge model proven in the Traitors demo | §9.4 |
> | Flagged: `SERVER/` is empty — §6 describes a component that does not yet exist | §6, §11 |
> | Flagged: v0 firmware still in the field pending the v2 migration | §4.2.1, Appendix A, R1 |
>
> Sections marked **⚠ GAP** are honest statements of what is designed but not built.

---

## Contents

1. [Executive Summary](#1-executive-summary)
2. [The World We're Building](#2-the-world-were-building)
3. [System Architecture](#3-system-architecture)
4. [The Wearables & Radio Layer](#4-the-wearables--radio-layer)
5. [On-Device Animation & Synchronization](#5-on-device-animation--synchronization)
6. [Show Control: Live DMX Integration](#6-show-control-live-dmx-integration)
7. [Deployment Models](#7-deployment-models)
8. [The Aetherfield Activation Studio](#8-the-aetherfield-activation-studio)
9. [Registration, Messaging & Privacy](#9-registration-messaging--privacy)
10. [Reference Demonstrations](#10-reference-demonstrations)
11. [Roadmap](#11-roadmap)
12. [Commercial Model](#12-commercial-model)
- [Appendix A — Protocol Quick Reference](#appendix-a--protocol-quick-reference)
- [Appendix B — Glossary](#appendix-b--glossary)

---

## 1. Executive Summary

Aetherfield is a platform for orchestrating large populations of wearable light-and-sensor devices in real time. A crowd — whether a hundred guests at a brand activation or eighty thousand fans at a stadium show — becomes a single, addressable, synchronized canvas. Every wristband, lanyard, or badge can change colour and animation on cue, react to the wearer's movement, and tie back to that person's identity for messaging and engagement.

The system is built in layers. At the edge are the wearables — led by the Aura One wristband — together with the Aetherfield radio protocol that drives them. Gateways bridge that radio mesh to a controller, and — because every gateway already measures signal strength on every packet it hears — several of them also give coarse, zone-level positioning at no extra hardware cost. Above the gateways, Aetherfield offers two complementary control planes: an on-premise **Server** for large, latency-critical productions driven live from a lighting desk over DMX, and the **Cloud** for brand activations, device registration, audience messaging, and analytics. The two interoperate through a single portable show-description format. Beyond the venue sits **Aurea**, the digital layer the audience takes home — the night replayed, collectible moments, and an identity that persists across shows.

This paper sets out the vision, the end-to-end architecture, the radio and synchronization model that makes crowd-scale animation possible, the DMX show-control integration, the cloud activation and messaging stack, and two reference demonstrations: one already proven on real hardware, one specified and ready to build.

---

## 2. The World We're Building

Audiences increasingly expect to be part of the spectacle rather than spectators to it. Coordinated-lighting wearables have shown what is possible at the very top end of touring production, but the technology has remained closed, single-purpose, and economically out of reach for anything below the largest shows. At the same time, brand activations and experiential marketing want the same magic at far smaller scale, with the added ability to capture identity, trigger personalized messaging, and measure engagement — capabilities that pure lighting hardware was never designed for.

Aetherfield closes that gap with one coherent stack that scales down to a pop-up of a hundred guests and up to a stadium, and that treats the wearable as both an output (synchronized animation) and an input (motion, gesture, presence, identity). The same band that flashes in time with the music can also detect a clap, mark its wearer present to a zone, and trigger a text message to that person's phone.

**Output.** Per-device colour and animation, synchronized across an entire venue, driven either from a pre-designed timeline or live from a lighting console.

**Input.** On-device motion and gesture sensing, presence and proximity reported back through the gateways, and an identity binding that links a physical wristband to a registered guest.

**Identity.** Optional registration ties a wristband to a name and phone number, unlocking targeted messaging and analytics without compromising the anonymity of an unregistered crowd.

**Persistence.** Aurea carries the experience past the exit door — what the guest did, what the room did around them, and a thread that connects one night to the next.

---

## 3. System Architecture

Aetherfield is organized as cooperating layers, each named for what it does. Each layer has a clear contract with the one above it, which is what lets the same devices serve a cloud activation one week and an arena show the next.

Devices never talk to the internet directly. They speak only the Aetherfield radio protocol to nearby gateways. The gateway is the trust and translation boundary: it holds network credentials, addresses the crowd by broadcast, and forwards presence data upward. This keeps the wearables cheap, low-power, and replaceable, and concentrates all networking, security, and show logic in a small number of managed gateways and one controller.

### 3.1 The five-product stack

| # | Product | What it is | Owns | Talks to |
|---|---|---|---|---|
| 1 | **Aura** | The wearable — wristband, lanyard, badge, coin beacon | Local animation rendering; gesture and audio inference; device identity | Gateway (802.15.4 only) |
| 2 | **Gateway** | Venue radio bridge, 8–12 per venue | Broadcast downlink; telemetry ingest; the trust boundary | Aura (radio) ↕ Server / Pi bridge (wired) |
| 3 | **Server** | On-premise show brain, 1 per venue | DMX ingest; zone mapping; master clock; low-latency cue execution | Gateways (wired) ↕ Cloud (optional uplink) |
| 4 | **Cloud** | Hosted control plane | Activation Studio; registration; messaging; fleet management; analytics | Server (uplink) ↕ Aurea |
| 5 | **Aurea** | The audience's digital layer | Post-show replay; collectible moments; cross-show guest identity | Cloud (shared data tier) |

**Latency discipline.** Products 1–3 are the real-time path and must work with the venue's internet disconnected. Products 4–5 are the identity and memory path and tolerate latency. Nothing in the Cloud ever sits between the lighting desk and the crowd.

### 3.2 Positioning: the gateway is the listener

Earlier drafts specified a separate **relay node** — a cheap listen-only device placed near a point of interest, forwarding band traffic upward with signal strength attached. It has been dropped, and the reasoning is worth recording.

A gateway already measures RSSI on every packet it receives. One gateway gives one reading per band, which describes a sphere and locates nothing. Several gateways give several simultaneous readings of the same band, and *which gateway hears it loudest, and by how much* is far more robust than any absolute threshold — per-device transmit variation and body attenuation are largely common-mode across receivers, so they cancel in the comparison.

Any venue large enough to want positioning already needs several gateways for radio coverage. Positioning therefore falls out of hardware that is being deployed anyway, and a whole device class — with its own firmware, provisioning, power and support burden — disappears from the product line.

Two consequences to hold onto:

- **Comparing receivers requires them to have heard the same packet.** A beacon carries no sequence number of its own today, so cross-gateway correlation would have to fall back on arrival time. A one-byte beacon counter would make it exact, and there is ample frame headroom. This is cheap now and expensive once bands are in the field.
- **RSSI is not distance.** It gives zone-level answers — which corner of the room — not "standing in front of *this* painting". Where exhibit-level precision is genuinely needed, the honest answer is a presence sensor at the exhibit (time-of-flight or mmWave) supplying the geometry while the radio supplies identity. That is a sensing problem, not a radio one.

`AURA_MSG_NODE_RELAY` (`0x05`) and the address range `0x0100–0x01FF` remain **reserved** rather than reclaimed. Reusing a message id later is how two incompatible meanings end up in the same field deployment.

---

## 4. The Wearables & Radio Layer

The wearables are built around Nordic nRF54-class radios running a single shared firmware. Rather than design a product from scratch each time, Aetherfield develops a small set of physical primitives — a core module of radio, LEDs, sensors and power — that can be cast into many form factors: a wristband, a lanyard, a badge, a coin beacon. The Aura One wristband is the flagship and the most fully-featured expression of the primitive; other shells reuse the same core, firmware and protocol, so a new product is largely a packaging and capability exercise rather than a new platform. That keeps engineering effort, certification, and tooling concentrated on a single proven core while the product line fans out.

A shared capability model is what makes this work over the air. Each form factor advertises which features it carries — RGB lighting, haptics, motion, microphone, NFC — and one broadcast command can address the whole mixed fleet at once: every device applies the parts of a command it supports and ignores the rest. Adding a new form factor doesn't change how the crowd is controlled.

### 4.1 Why broadcast scales

The defining architectural choice is that downlink is broadcast. A gateway does not address devices one by one; it emits a single radio frame that every device in range receives and acts upon. The cost of lighting one device and lighting ten thousand is therefore identical — one frame. This O(1) property is what makes crowd-scale animation tractable on a low-bandwidth radio. Targeting subsets of the crowd — a section, a colour group — is done with a group mask carried in the command, not with per-device messaging.

### 4.2 Protocol summary

The Aetherfield radio protocol runs on IEEE 802.15.4 in the 2.4 GHz band, hardware-filtered to a private network (PAN `0xAE7F`) so that foreign traffic is rejected by the radio itself. The 16-bit device address is the device's identity — derived deterministically from the chip's factory ID — so payloads carry no separate device identifier and there is no provisioning step.

Six message types cover the whole system. Downlink: a **CMD** carrying the complete device state in one 13-byte frame, and a **SYNC** carrying the master clock and any pending channel change. Uplink: a **BEACON** (presence, battery, capabilities, command-delivery echo), an **EVENT** (gesture, button, or NFC tap), and a **CONTACT** (one device detected another nearby). A sixth id, **NODE_RELAY**, is reserved but unused — see §3.2.

**Two orthogonal axes govern a device.** `op_mode` sets what the radio and power system are doing — normal, listen-only, roll-call, proximity scanning, low power, duty-cycled sleep, or identify. `anim_mode` sets what the light is doing. They are separate fields because the normal state during a performance is *listen-only and animating at the same time*; combining them into one setting would force a value for every combination of the two.

That separation is what makes `op_mode` the platform's capacity control. Downlink cost is fixed no matter how large the crowd, but uplink scales linearly with device count and is the binding constraint at tens of thousands of units. Putting the fleet into listen-only for a show reduces uplink traffic to zero; roll-call brings it back for a census when the operator wants one.

### 4.2.1 Protocol v2

v2 supersedes both the v1 specification and the v0 firmware that ran earlier demonstrations. Two changes matter.

**Command structure is flat and fixed rather than a sequence of tagged blocks.** Because a downlink frame reaches the entire venue in about four milliseconds regardless of crowd size, the airtime that variable-length encoding saved was never the constraint — while the cost, four independent parsers across firmware, gateway, bridge and browser, was real. Every device now receives every field and its capability set decides which ones it acts on.

**Hardware filtering replaces promiscuous byte-scanning.** v0's gateway examined every 802.15.4 frame in the venue — Zigbee, Thread, anyone else's equipment — searching for a marker at a fixed position. In contested spectrum that is the failure mode that bites first. v2 uses correct addressing so the radio itself rejects foreign traffic before software sees it.

The trade accepted in return: adding a field to the command frame is a fleet-wide firmware update rather than a silent extension. Every frame therefore carries a version byte, and reserved bits are held throughout.

### 4.3 Command model

One command frame carries the whole device state: group, animation and its rate, operational mode and its parameter, colour, master brightness, and device configuration. **A device acts on a field only if it has the matching capability** — that single rule is how one broadcast serves a fleet of mixed form factors. A lanyard with no addressable LED receives exactly the same frame as a full wristband and simply does not animate. Nothing about the command changes when a new form factor joins the fleet.

Brightness is a separate field applied after the animation renders, so an operator can dim the entire room without recomputing colours, and a device can cap itself as its battery falls.

Group addressing uses an 8-bit mask rather than an index, so a device can belong to several groups at once and one broadcast can address any union of them — "all traitors" and "everyone" are the same mechanism.

### 4.4 The device as a sensor

The wearables are not just lights. The Aura One carries an inertial sensor (LSM6DSO) and a PDM microphone, and runs Nordic Edge AI inference on-device for gesture recognition — currently **hand raise** and **clap**. Recognized gestures and presence are folded into the device's periodic beacon, so the controller learns what the crowd is doing without any per-device polling. This is the input half of the platform and the basis for interactive rules, audience voting, and analytics.

Critically, inference runs on the band. The radio carries a classification result — a bit — not a stream of sensor data. This is what keeps a crowd-scale sensor network inside the bandwidth budget of a low-power radio.

The same principle extends beyond gesture. In **proximity mode** a device reports when another Aetherfield device comes and stays within a signal-strength threshold, and again when it leaves — a contact event, not a continuous neighbour list. A lanyard in a busy room can see dozens of devices at once; sampling them continuously would be both a slow, biased picture and a waste of the uplink budget. Reporting only transitions keeps the traffic negligible while giving the controller enough to reconstruct who met whom, and for how long. On NFC-equipped devices a phone tap is reported the same way. Together these make the non-lighting form factors — the conference lanyard, the badge — first-class members of the fleet rather than passive decoration.

### 4.5 Two band tiers, one platform

| | **Aura Reusable** | **Aura Give-away** |
|---|---|---|
| Build | Rechargeable, fleet-managed | Paper/fabric band, minimal board |
| Lifetime | 50–200+ shows | One run, goes home with the guest |
| Feedback | Full RGB, haptics, sensing | 1–3 LEDs |
| Operations | Collected and charged between shows | None |
| Cost per head per show | £0.10–0.50 | £2.50–5 |
| Character | Show infrastructure | Merchandise that votes |

Same electronics family, same firmware, same protocol underneath. The radio silicon is roughly £2 at volume — strap, battery and assembly cost as much as the chip does. One board platform serves both tiers, so the non-recurring engineering is paid once and amortises across both.

---

## 5. On-Device Animation & Synchronization

Animation logic lives on the device, not in the network. A command does not stream pixels; it sets parameters — which animation, how fast, what colour, which group — and the device renders the effect itself. This is what keeps the radio quiet enough to scale: a three-hour show may send only a few hundred commands, while each device runs thousands of animation frames locally.

### 5.1 The phase-clock model

Each device computes its current animation frame as a pure function of a shared clock:

```
frame = f(sharedTime, mode, rate)
```

Because the function is identical on every device, any two devices that agree on the time also agree on the frame — they are, by construction, in sync. A single global flag switches between two regimes: **unison**, where every device uses the same clock with no offset and the whole crowd pulses together; and **wave**, where each group is given a deliberate phase offset so effects ripple across sections. Both are the same code path with a different phase term, which means a designer — or a live operator — can morph between a unified strobe and a rolling wave with a single parameter.

### 5.2 Distributing the clock

The only thing devices need, therefore, is a common timebase — not a phase instruction on every command. Gateways carry a master clock supplied by the controller over a wired link and broadcast it in a **SYNC** message every few seconds; devices discipline their local clock to each broadcast. A brisk heartbeat costs almost nothing — downlink is flat in crowd size — and because SYNC is the only guaranteed periodic downlink, it doubles as the signal by which a device knows the gateway is still there at all. Multiple gateways share one master, so zones across a large venue remain mutually synchronized: the tight, deterministic link is the wired path between server and gateways, and only the final radio hop needs periodic correction.

Because the clock is shared rather than commanded, a lighting cue never carries timing. The same SYNC message also carries the per-group phase offset that turns unison into a wave, and announces channel changes ahead of time.

### 5.3 Accuracy budget and drift

Human perception sets the target: unison flashes start to look ragged somewhere around 20–50 milliseconds of spread, tighter for fast strobes, so the working budget is on the order of **10–20 milliseconds device-to-device**. Low-cost timing crystals drift by tens of parts per million, which at typical figures means two free-running devices can wander a few milliseconds apart per minute — enough to break sync across a full set if the clock were set only once. Periodic resync — a timebase broadcast every tens of seconds — keeps the fleet inside budget regardless of show length.

> **⚠ GAP — the critical unvalidated experiment.** Validating this resync interval on real hardware is the single most important early experiment, and it has not yet been run. If a handful of devices hold unison for a minute, the broadcast nature of the protocol means the result scales to any crowd size. Until it is measured, every synchronization claim in this paper is design intent rather than a proven figure. This is roadmap item **R2**.

---

## 6. Show Control: Live DMX Integration

For large live productions, Aetherfield is driven the way the rest of the show is driven: from the lighting console. The Server ingests DMX over the network (Art-Net or sACN, via an Ethernet link from the lighting rig) and translates it into radio commands in real time.

> **⚠ GAP — the Server does not exist.** `aetherfield-platform/SERVER/` is an empty directory. Everything in this section is design, not implementation. A partial substitute exists — the gateway's `directDMX` mode and the Pi bridge — which is enough to demonstrate the idea at small scale but is not the architecture described here. Building the Server is roadmap item **R3** and is the centrepiece of the live music reference demonstration (§10.2).

### 6.1 The gateway as a lighting fixture

The organizing idea is that each gateway is patched into the lighting desk as if it were a fixture. The operator assigns it a DMX address and a fixed channel footprint — its "personality" — exactly as they would a moving head. This is deliberate: lighting designers already think in fixtures, addresses and personalities, so the wearable layer joins their existing workflow rather than demanding a new one. Because the command is already parameterized as mode, rate and colour, a compact personality maps almost one-to-one onto it.

Crucially, **DMX sets parameters; it does not stream frames**. A lighting console refreshes around forty times a second, far faster than a broadcast radio can or should retransmit to a crowd. The Server therefore samples the DMX, debounces it, and only emits a command when a parameter actually changes — the device's local animation engine and the shared phase clock do the rest. The result is that a single fader move re-colours the entire stadium, in sync, from one radio frame.

### 6.2 Zones and mapping

On the Server, an operator maps DMX inputs to outputs: which console channels drive which gateway, and how a gateway's coverage is divided into groups. Because each gateway owns a physical zone of the venue and group masks subdivide it further, the same console can paint different sections in different colours or run a wave that crosses zone boundaries — all from one coherent patch.

---

## 7. Deployment Models

Every deployment is a point on two axes: **how many gateways**, and **where the control plane lives**. Naming them as axes rather than as products matters, because it is what keeps this one system rather than four codebases that drift apart.

| | Gateways | Control plane | Internet | Typical use |
|---|---|---|---|---|
| **A** | One | On the gateway itself | None | Single-room activation, install, bench work |
| **B** | One | Cloud | Required | Brand activation, pop-up, experiential marketing |
| **C** | Many | Cloud | Required | Multi-room or multi-site activation |
| **D** | Many | On-premise server | Optional uplink | Arena, stadium, theatre, touring production |

The devices, the radio protocol, the command model and the show format are identical across all four. What changes is who holds the design, who evaluates the rules, and who the gateway answers to.

### 7.1 The latency rule

The real-time path — lighting desk or rule engine, to gateway, to band — must work with the venue's internet disconnected. Identity, messaging and analytics tolerate latency and benefit from being centralized. Nothing in the Cloud ever sits between a cue and the crowd.

This holds even in the cloud-controlled configurations, and it is what makes them safe to sell. A band renders its own animation from a phase clock, so a lost link means *"we cannot change the look right now"* rather than *"the show stops"*. Two design rules protect that property:

- **Telemetry queues; commands do not.** The bridge already spools telemetry to disk and replays it on reconnect. Downlink must never do this — a cue that arrives eight seconds late because a modem stalled is worse than a cue that never arrives. Commands carry an issue timestamp and are dropped past a maximum age.
- **Loss of the control plane is not a fault.** Gateways continue running the last commanded state. A heartbeat that blacks out the crowd on timeout would destroy the one property that makes the whole architecture defensible.

Per-gateway cellular (a USB 4G/5G dongle) removes venue IT, captive portals and shared-SSID congestion from the picture, and lets each gateway fail independently. It does not remove the WAN from the show path: a sold-out arena is precisely where public cellular capacity collapses, because peak load on the link and peak load on the show are the same moment. Cellular is an excellent uplink and a link the downlink must be designed to survive losing.

### 7.2 Where the design tool runs, and how it finds hardware

The Activation Studio is one application with two hosts.

**Locally**, it is served by whatever holds local authority — the gateway itself in configuration A, the on-premise server in D — and reached over the LAN. That host discovers gateways by DNS-SD (`_aetherfield._tcp`, with hardware id, short code, mode and firmware version in TXT records) and hands the browser a list.

**In the Cloud**, there is no discovery. A gateway is claimed by entering its printed identifier together with a pairing code that the operator sets in the gateway's own admin console — so possession of the label alone is not enough to claim someone else's hardware.

The split is forced by the browser, not chosen. A web page cannot perform mDNS discovery, cannot scan a subnet, and — when served over HTTPS — is blocked outright from making requests to a plain-HTTP address on the local network. Any design that has a cloud-hosted page talking directly to a gateway on a venue LAN is fighting the browser security model and will lose. Discovery therefore belongs to a local process; the browser only ever renders what that process found.

### 7.3 Control direction

Uplink is the easy direction: a gateway initiates outbound and reaches the Cloud from behind any NAT, including the carrier-grade NAT that cellular guarantees.

Downlink is the hard one, and CGNAT settles the design: nothing can reach a gateway inbound, so every control path must be gateway-initiated — a subscription it holds open, not an endpoint it exposes.

The same constraint has a happier consequence for local integrations. A rule that fires a webhook at a lighting controller, a media server or a TouchDesigner machine should fire it **from the gateway**, on the venue LAN, not from the Cloud. It is faster, it needs no tunnel on the receiving machine, and it keeps the physical reaction working when the internet does not. The Cloud's job is what only the Cloud can do: resolving identity and sending the message.

### 7.4 The show-description contract

The bridge between the design tools and the runtime is a single versioned interchange format — the **Show Scenario** (`aetherfield.showScenario.v1`). It describes the venue and its zones, the interaction rules, a bucketed timeline of expected activity, a runbook of timed cues (each a colour, mode and rate against a set of zones at a moment in time), and a set of campaign KPIs. The Cloud Activation Studio authors it; the operator show control imports and runs it. Unknown fields are ignored and missing optional fields fall back to safe defaults, so the format can evolve without breaking older tools.

The schema is specified in `aetherfield-cloud-demo/docs/show-control-scenario-contract.md` and should be promoted into this repository as the canonical copy (roadmap item **R4**).

---

## 8. The Aetherfield Activation Studio

The Activation Studio is the design surface. An operator uploads a venue plan, lays out zones, places gateways and activation nodes on the map, and defines the rules that connect sensing to action — for example, "when a registered guest is detected at this point, flash their wristband and message their phone." Rules carry targeting, cooldowns, time windows and priorities, and the studio can rehearse them in simulation before anything is deployed.

Physical hardware is linked to the design through a pairing flow, and it differs by where the Studio is running (§7.2). Locally, it lists the gateways it can actually see on the network and the operator picks one. In the Cloud, the operator enters the gateway's printed identifier together with a pairing code set in that gateway's admin console. Once paired, the device's live telemetry routes automatically to the right activation, and the Studio reflects its status. This is the connective tissue between a drawing on a screen and a box on a wall.

The gateway's own admin console is deliberately router-shaped: reached over a wired connection at a fixed address printed on the unit, authenticated with a per-unit password printed alongside it — never a shared default — and responsible for exactly three things: choosing local or Cloud mode, configuring the internet connection (Wi-Fi, Ethernet or cellular dongle), and setting Art-Net parameters for local DMX. Wired admin matters more than it looks: a single-radio gateway cannot host a setup hotspot and join the venue's Wi-Fi at the same time, so the cable is what makes it possible to configure the radio uplink without cutting off the machine doing the configuring.

> **⚠ Note — three copies exist.** The Activation Studio currently lives in three places: `aetherfield-platform/CLOUD/EventBuilder`, `AURA-ONE-DEMO-2026/apps/activation-studio`, and `Aetherfield-coachella-sim`. They have diverged. Consolidating to one canonical copy is roadmap item **R5**; see `CONSOLIDATION.md`.

---

## 9. Registration, Messaging & Privacy

Registration is what turns an anonymous light into an addressable guest. A short flow captures a name and mobile number and binds them to a device, so a detection in the field resolves straight back to a person.

That flow must live at a **public Cloud address**, never at a gateway's local one. A guest on mobile data, or on a venue network segregated from the gateways, cannot reach a private IP — and registration that only works within radio range of a gateway rules out the queue, the coach and the day before. The gateway learns about a binding on its next sync; it plays no part in making one.

Binding a person to a specific band can be done by printing a code on the strap, or — more pleasingly, and with no per-unit labelling step in manufacture — by asking the guest to **wave the band** once the form is submitted. The gesture already arrives at the gateway as an EVENT carrying the device address, so the pending registration binds to whoever waved. A band with NFC can go further and write its own registration URL at first boot from its factory UID, which removes the label-matching production step entirely.

### 9.1 Device identity

The band derives a 16-bit radio address from the chip's factory UID at boot. It is stable, needs no provisioning step, and requires no per-device manufacturing configuration — a band is itself the moment it powers on. Rendered as four hex characters (`A1B2`), it is short enough to print on a strap, encode in a QR code, and read aloud during a show.

**It is not, however, a safe registration key at scale.** The band address space holds 61,438 values, and derived addresses collide on the birthday schedule:

| Bands | Expected colliding pairs | Chance of at least one |
|---|---|---|
| 100 | ~0.1 | 8% |
| 1,000 | ~8 | ~100% |
| 5,000 | ~204 | ~100% |
| 20,000 | ~3,255 | ~100% |

For a show this is cosmetic: two bands animate together and no one notices. For registration it is a correctness failure — two guests bound to one identity, and a personal message sent to the wrong wrist.

The separation is therefore explicit: **registration and analytics key on the full factory UID, which is unique; the 16-bit value is a radio handle only.** The QR or NFC payload carries the long identifier, the Cloud maps long to short, and a collision degrades to radio ambiguity — two bands lighting together — rather than to a mis-addressed person.

Resolving that residual radio ambiguity, by assigning an address at registration, remains designed but unbuilt: the protocol has no address-assignment message today.

### 9.2 Messaging

With identity in place, a rule can do more than light a wristband: it can send a message. When the conditions of a messaging rule are met, the platform looks up the registered number for the device and dispatches over WhatsApp, falling back to SMS. This path is proven in production on a live Twilio number.

Message content can be generated rather than templated. In the Traitors demonstration, the Anthropic API writes an in-character verdict per guest that reflects what that specific guest actually did — whether they backed the traitor who was banished. This turns a broadcast notification into something that reads as personal, at no additional operational cost.

### 9.3 Consent

Identity is opt-in. An unregistered crowd remains anonymous — devices still animate and sense, they simply have no person attached. Registration, message content and frequency are governed by the activation's own consent terms, and phone numbers live in the controlled Cloud tier, never on the device or the radio.

### 9.4 The privacy purge model

The Traitors demonstration established a pattern that should become the platform default:

- **Personal data is short-lived by construction.** Guest rows carry an `expires_at` set to 30 minutes after registration and are **hard-deleted**, not soft-flagged.
- **Purge is lazy plus scheduled.** Every API call sweeps expired rows; a daily cron sweeps whatever the traffic missed. There is no window in which stale personal data sits waiting for a batch job.
- **Analytics survive the purge because they never contained personal data.** Vote-round logs record band identifiers and tallies only. The engagement record outlives the identity record by design, not by exception.

The commercial consequence is worth stating plainly: Aetherfield can offer a venue a personalized, identity-driven audience experience while holding personal data for the duration of one performance. That is a materially easier conversation with a producer's legal team than any model that retains a guest database.

---

## 10. Reference Demonstrations

Two demonstrations, deliberately chosen to exercise opposite ends of the platform. One is built and has run; the other is specified and is the next thing to build.

### 10.1 The Traitors — audience voting *(built)*

A client-facing pitch and working live demo built around *The Traitors* stage show. The audience wears an Aura band, **raises a hand to vote**, the band confirms in colour, and the result appears live backstage and on stage. No phones, no apps. After the round, the Cloud texts each guest a personalised, AI-written verdict.

This proves the **input** half of the platform and the full identity path end to end on real hardware: on-device inference → radio → gateway → visualiser → cloud → registered guest's phone.

Full specification: [`demos/traitors.md`](demos/traitors.md).

### 10.2 Live music — DMX-driven synchronized crowd *(specified)*

The near-term demonstration assembles a complete miniature of the large-show architecture:

- Ten Aura One wristbands
- Two gateways, each covering a zone
- One Server
- A DMX source feeding the Server over Ethernet (Art-Net / sACN)
- A local setup app on the Server: map DMX channels to animations and zones, configure cloud upload
- A registration app that captures a guest's name and number against a wristband
- A web dashboard showing a live summary of real-world activity

Together these exercise every layer: a lighting desk drives synchronized colour and animation across two zones via DMX into the Server and out over the radio to ten wristbands; guests register their devices to their phones; presence and activity flow back up through the gateways; and the dashboard reflects the crowd in real time. It is, deliberately, the 80,000-person system at a scale of ten — the same architecture, the same protocol, the same show format.

**What it validates.** Live DMX-to-radio control; multi-gateway zoning; on-device synchronized animation; the registration-to-identity binding; telemetry round-trip to a live dashboard; and the cloud-upload path.

Full specification: [`demos/live-music.md`](demos/live-music.md).

### 10.3 Why both

| | Traitors | Live music |
|---|---|---|
| Direction | Input — crowd drives the show | Output — show drives the crowd |
| Proves | Inference, voting, identity, messaging | Sync, DMX, zoning, scale |
| Control plane | Cloud | Server |
| Status | Built and demonstrated | Specified; blocked on the Server |
| Sells to | Producers, theatre, format owners | Touring production, lighting designers, festivals |

Between them they cover the whole architecture. Neither alone does.

---

## 11. Roadmap

Ordered by dependency, not by ambition. Items R1–R3 are prerequisites for everything else.

### Phase 0 — Rescue *(immediate)*

| | Item | Why |
|---|---|---|
| **R0** | Push the Traitors `gateway`, `wristband` and `visualiser` repos to remotes | Each is a local-only git repo with a single commit and **no remote**. The only firmware that has run a real demonstration is currently one disk failure from gone. Nothing else on this roadmap matters until this is done. |

### Phase 1 — Foundations

| | Item | Detail |
|---|---|---|
| **R1** | **Migrate v0 → v2 protocol** | Gateway first (hardware PAN/address filtering, parse v2 at offset 0, keep accepting v0 ID 3 behind a flag), then the seeed band, then the single-pixel module, then holyiot and K7. Removes the promiscuous-mode byte-scan that is the platform's main source of radio noise and fragility. The serial test bridge is built alongside the gateway so each stage can be verified on the bench before it reaches a venue. |
| **R2** | **Validate clock sync on hardware** | Measure device-to-device spread over a 60-second unison hold with the resync interval as the variable. Target ≤20 ms. Everything in §5 is unproven until this number exists. Cheap to run, high information value — do it before anything depends on it. |
| **R3** | **Build the Server** | Art-Net/sACN ingest → debounce → zone map → gateway fan-out, plus master clock distribution. `SERVER/` is empty; §6 currently describes vapour. Specified in `demos/live-music.md`. |

### Phase 2 — Consolidation

| | Item | Detail |
|---|---|---|
| **R4** | Promote the Show Scenario contract into this repo | Currently only in `aetherfield-cloud-demo/docs/`. Make it canonical and versioned alongside `PROTOCOL.md`. |
| **R5** | Collapse the three Activation Studio copies to one | See `CONSOLIDATION.md`. |
| **R6** | Promote reusable patterns to the platform | The 30-minute privacy purge, the chip-UID identity scheme, and the zero-build single-file Web Serial visualiser — all proven in Traitors, all currently trapped in a consultancy folder. |
| **R7** | Fold `traitors` / `traitors-new` snapshots into the canonical tree, then delete | Three copies of the same firmware in three places is a correctness hazard. |

### Phase 3 — Product

| | Item | Detail |
|---|---|---|
| **R8** | Run the live music reference demonstration | Ten bands, two gateways, one Server, one lighting desk. |
| **R9** | Give-away band tier | Minimal board, 1–3 LEDs, single-run. Unlocks the arena economics in §12. |
| **R10** | Server ↔ Cloud uplink | Presence and engagement streaming upward so a stadium audience can be registered and measured without the Cloud entering the show path. |
| **R11** | Aurea | Post-show replay, collectible moments, cross-show identity. The natural merge seam already exists: `/api/session-status` was built so Aurea can ask whether a guest is inside an active visit. |
| **R12** | Coarse positioning from multi-gateway RSSI | Compare the same beacon across gateways for zone-level location without per-device ranging or extra hardware. Needs the beacon counter (§3.2). |

---

## 12. Commercial Model

Aetherfield is sold twice into the same venue. The hardware is what gets it installed; the software is what makes the installation worth more than it cost. These are not alternative business models to choose between — the second is only reachable because of the first, and that dependency is the most defensible thing about the company.

Figures throughout are indicative and pre-quote.

### 12.1 Two layers of revenue

| | **Hardware layer** | **Software layer** |
|---|---|---|
| What is sold | Bands, gateways, a server | Attribution, targeting, measurement |
| Buyer | Producer, promoter, venue ops | Venue commercial director, brand partner |
| Bought because | The show needs it | The installation pays for itself |
| Charged as | Purchase, rental, per-head, sponsorship | Per interaction, or a share of measured uplift |
| Margin profile | Thin, hardware-like | Thick, software-like |
| Scales with | Number of shows | Number of *interactions* per show |

The hardware layer is a real business on its own — it is what the Traitors demonstration and every touring conversation is built on. But it is a hardware business, with hardware margins, competing on cost per head. The software layer is where the economics become interesting, and it is unreachable without the hardware already being on people's wrists.

### 12.2 The hardware layer — cost to deploy

| | Unit cost | Reuse | Cost per head per show |
|---|---|---|---|
| Reusable band | £12–25 | 50–200 shows | £0.10–0.50 |
| Give-away band | £2.50–5 | Single run | £2.50–5 |
| Venue kit (8–12 gateways + 1 server) | Low £000s | Years | Pennies |

A venue becomes Aetherfield-ready in a day. No venue Wi-Fi, no internet during the show, no per-seat cabling. The kit tours in one flight case; installed once, it serves every production that comes through.

**Four routes to pay**, mixable per production:

- **Purchase outright** — venue or producer owns the fleet and venue kit; Aetherfield services it.
- **Rental** — fleet hired like a lighting rig, with charging, spares and loss bundled.
- **Sponsorship** — the sponsor's mark on every wrist, going home with the audience; covers the give-away per-head cost.
- **Ticket / merchandise** — £1–3 per head in the ticket price; the guest returns the working band and buys the keepsake edition.

The economics compound in one direction: the reusable fleet's cost per show falls every night it works, while the give-away tier's non-recurring engineering amortises across volume. Both run on the same board platform, so neither subsidises a separate development track.

Note what the four routes have in common. Every one of them prices the band as a *cost to be recovered*. That framing has a ceiling, and the ceiling is the price of a wristband.

### 12.3 The software layer — attribution

Once a venue is instrumented, the same hardware answers a question the venue has never been able to answer: **which of our interventions actually caused someone to spend.**

Today that question is unanswerable in a live venue. Point-of-sale tells you what sold, not why. Wi-Fi and beacon analytics tell you bodies moved, but not who they were and not whether anything you did caused it. Apps can close the loop in principle, but depend on a download, an unlock and a glance at a screen — in a dark, loud room, during a show, by an audience who came to watch something else.

Aetherfield closes the loop because the band is simultaneously three things:

1. **An output** — it can *deliver* the intervention. A haptic pulse and a colour change on the wrist, which cannot be missed the way a notification in a pocket can.
2. **A sensor** — RSSI across gateways shows that the wearer then moved, and where to.
3. **An identity** — registration binds the band's device ID to a person and a phone number.

All three events — intervention, movement, transaction — carry the same 16-bit device identifier. That is a complete attribution chain in a single identity space, which is what nobody else in a venue has.

The headline metric is **IRU — Incremental Revenue Uplift**: revenue demonstrably caused by a triggered interaction, as opposed to revenue that would have occurred anyway. Two supporting measures make it credible rather than a vanity number:

- **Attribution confidence** — the share of transactions traceable through the full chain from trigger to movement to point of sale, rather than inferred.
- **Interaction efficiency** — measured uplift divided by the variable cost of the interactions that produced it.

A worked example is specified in `docs/reference/demo-script-wembley.json`: a guest in the Wembley pitch standing area receives a haptic and gold-fade cue with a reserved-item offer, moves to the Level 1 concourse, and completes a £65 transaction attributed back to the trigger that started it.

> **⚠ GAP.** This layer is unbuilt, and its numbers are unmeasured. The `target_uplift` values carried in `docs/reference/venue-manifest-wembley.json` (10–25% by revenue point) are **design targets in a demonstration file, not observed results**. Nothing in this section should be presented as evidence. What exists today is the mechanism — identity binding, gesture inference, presence, and a proven messaging path — not the measurement. Establishing a real baseline against a real point-of-sale system is the first honest milestone here, and it does not currently appear on the roadmap.

### 12.4 Why the two layers are inseparable

This is the argument the rest of the section rests on.

An attribution business that is not already on the wrist has to persuade a venue to deploy hardware for the sole purpose of measurement. That is a difficult sale with an uncertain payback, and it is why venue attribution has largely stalled at the level of footfall counting.

Aetherfield never has to make that sale. **The hardware is justified by the spectacle and paid for by the show.** The lighting designer wants a synchronized crowd; the producer wants an audience that is part of the event; the sponsor wants their mark on every wrist. Each of those buys the same infrastructure. Attribution then arrives as a capability of equipment that is already installed, already charged, already on ten thousand people — at no incremental hardware cost.

That is the moat, and it runs in only one direction. A competitor selling attribution cannot bootstrap their way to a synchronized light show, because that requires a radio protocol, a phase clock, DMX integration and a lighting-desk workflow. A competitor selling light shows has the hardware but not the identity binding, the on-device inference or the messaging path — and retro-fitting those is the harder half.

Stated plainly: **the spectacle pays for the sensor network, and the sensor network is the product.**

### 12.5 How this compounds

| | Pilot (1 show) | Season (resident) | Scale (arena run) |
|---|---|---|---|
| Band | Reusable × 500 | Reusable fleet × 1–2k | Give-away × 10k+ |
| Hardware cost/head/show | ~£1 (low reuse) | £0.10–0.50 | £2.50–5 |
| Infrastructure | 1 venue kit | Installed, amortised | Portable kit |
| Software layer | Not yet enabled | Attribution baseline established | Attribution at full scale |

The hardware line falls with every show the fleet survives. The software line does the opposite: it rises with audience size, with the number of interactions per show, and with each additional revenue point instrumented — none of which require new hardware spend. Over a resident season the two cross, and the venue's Aetherfield installation stops being a cost line and becomes a margin line.

That crossover is the commercial thesis. Everything before it is how you get to it.

---

> **Editorial notes for this section — remove before circulating.**
>
> **Vocabulary call made here (W2).** I kept **IRU**, because it names a metric a commercial director already understands and it earns its acronym. I retired **CEL** ("Creative Experience Layer") — it names a layer the whitepaper already calls Aura + Gateway + Server, and a second name for the same thing is how a pitch loses a room. I also dropped **ITTR**, which appears once in the Revenue Engine spec with no expansion given anywhere. Overrule any of these and I will restate throughout.
>
> **Still open elsewhere in the document:**
> - **W3** — §3's five-product stack has no layer owning attribution. It sits closest to Cloud but needs venue-side spatial data the Server holds. The stack table needs revisiting now that §12 claims this capability.
> - **W4** — `venue-manifest-wembley.json` has levels, elevations, revenue points and POS IDs; `docs/SHOW-SCENARIO.md` has none of them. §12.3 assumes the richer model. One schema, not two.
> - **Roadmap** — §11 has no item for the attribution layer. If §12 stands, R13 is "instrument one revenue point against a real POS and establish a baseline," and it is the gating experiment for everything in 12.3.
> - **Numbers I did not invent** — per-interaction pricing, expected conversion rates and the uplift share split. Those need your figures; I have deliberately left them out rather than guess.

---

## Appendix A — Protocol Quick Reference

> Derived from `include/aura_radio.h`, which is the source of truth. `PROTOCOL.md` carries the full specification. If any of them disagree, the header wins.

### A.1 — v2 (current)

**MAC layer**

| Item | Value |
|---|---|
| PAN ID | `0xAE7F` (hardware-filtered) |
| Channels | 15, 20, 25, 26 (default 15) |
| FCF | `0x8841` — data, no ACK, PAN compression, 16-bit dst+src |
| TX power | 8 dBm |
| MAC header | 9 bytes: `FCF(2) | seq(1) | dstPAN(2) | dst(2) | src(2)` |

**Address map**

| Range | Use |
|---|---|
| `0x0001` | Gateway |
| `0x0100–0x01FF` | *Reserved* (was: relay nodes — see §3.2) |
| `0x1000–0xFFFD` | Bands (derived from FICR DEVICEID) |
| `0xFFFE` | Unassigned |
| `0xFFFF` | Broadcast |

The source address **is** the device identity. It appears in no payload.

**Messages**

| Id | Name | Direction | Payload |
|---|---|---|---|
| `0x02` | EVENT | band → gw | `ver, event_type, value, strength` |
| `0x03` | BEACON | band → gw | `ver, caps, battery_pct, flags, last_cmd_seq` |
| `0x04` | CMD | gw → all | `ver, seq, group, anim_mode, anim_param, op_mode, op_param, R, G, B, bright, dev_flags` |
| `0x05` | NODE_RELAY | *reserved, unused* | `ver, band_addr(2), rssi_enc` + original payload |
| `0x06` | CONTACT | band → gw | `ver, peer_id(2), rssi_enc, event` |
| `0x07` | SYNC | gw → all | `ver, epoch_ms(4), hop_channel, hop_countdown, wave_step` |

**Operational modes** (`op_mode`, with `op_param`)

| Mode | Parameter | Behaviour |
|---|---|---|
| NORMAL | beacon period | listen and beacon |
| LISTEN_ONLY | — | receive only, zero uplink. Show mode. |
| ROLL_CALL | response window | beacon once, in a slot derived from the device address |
| SOCIAL | RSSI threshold | proximity detection, reports contacts |
| LOW_POWER | beacon period | slow beacon, brightness capped |
| SLEEP | wake interval | radio off, then a receive window |
| IDENTIFY | — | override the show, blink white — locate one device |

**Animation modes** (`anim_mode`): off, steady, flash, pulse, heartbeat, ramp, strobe, rainbow. Every device is treated as a single light source however many LEDs it carries; spatial modes are reserved so multi-LED effects can be added later without changing the frame.

**Capabilities** (BEACON): `RGB_LED, HP_LED, IMU, ACCEL, MIC, BUTTON, NFC, MULTI_LED`. The gateway learns fleet composition passively from beacons — there is no discovery handshake. Capabilities in the beacon are also what distinguish "a lanyard correctly ignoring the animation fields" from "a device that has failed".

**Reliability.** Commands are broadcast with no acknowledgement, so the gateway repeats each one three times and devices apply it once, deduplicating on sender and sequence number. Each beacon echoes the last command sequence the device acted on, which is the only delivery statistic obtainable on an unacknowledged broadcast protocol — one byte, no extra traffic, and it distinguishes "the show looked wrong" from "that section lost 40% of its commands".

**Failure behaviour.** No valid downlink for ten seconds and a device begins cycling the channel list. After sixty seconds it fades to idle, so a band that has lost its gateway does not sit at full brightness draining its cell. Unrecognised mode values hold the last good state — devices never fail dark mid-show.

**Sleep is always duty-cycled.** There is deliberately no unbounded sleep command in the protocol. A device that cannot hear the instruction to wake is unrecoverable, and a crate of fifty thousand unrecoverable lanyards is not a situation the platform should be able to enter. On NFC-equipped devices, a phone tap provides a second, out-of-band way back in.

**Roll-call scale limit.** Asking an entire fleet to report at once produces simultaneous transmissions and collision collapse, so each device responds in a slot derived from its own address. A 25-second window provides around 5,000 slots: a clean census for hundreds of devices, a lossy sample for tens of thousands. At full stadium scale, roll-call is issued group by group.

### A.2 — v0 (legacy, migration only)

Single-byte payload IDs, no version field, no hardware filtering — the gateway byte-scanned frames in promiscuous mode looking for an ID at a fixed offset. PAN `0x1234`, FCF `0x2241`.

| ID | Direction | Payload |
|---|---|---|
| `3` | band → gw | `device id (2), flags` |
| `4` | gw → band | `mode, rate, R, G, B` at fixed offset `psdu[15]` |
| `5` | node → gw | `node id, band id, RSSI, gesture` |

The gateway dual-accepts v0 and v2 throughout the migration, or field devices go dark part-way through. Migration order: gateway, then the seeed band, then the single-pixel module, then holyiot and K7.

### A.3 — Cloud interfaces

**Vote result** — `POST /api/vote-result`, `Authorization: Bearer <VOTE_RESULT_SECRET>`

```json
{ "votes": { "1": ["A1B2"], "2": ["C3D4"] }, "totalBands": 12 }
```

**Registration API surface**

| Endpoint | Purpose |
|---|---|
| `POST /api/register` | Bind name + mobile to a band uuid |
| `POST /api/vote-cast` | Instant reaction as a wrist rises |
| `POST /api/vote-result` | Round tally at Finish |
| `GET /api/session-status?cell=\|?d=` | Is this guest inside an active visit — the Aurea seam |
| `GET /api/registrations` | Operator view |
| `GET /api/purge` | Cron sweep of expired personal data |

**Show Scenario** — `aetherfield.showScenario.v1`, top-level keys: `metadata`, `venue`, `interactions`, `timeline`, `runbook`, `kpis`, `notes`. Unknown fields ignored; missing optional fields fall back to safe defaults.

---

## Appendix B — Glossary

**Aura One.** The wristband wearable — the device a guest wears. Runs animation locally and senses motion and gesture.

**Aurea.** The digital layer the audience takes home: the night replayed, collectible moments, and an identity that persists across shows.

**Activation Studio.** Design tool for venues, zones, gateways, activation nodes and interaction rules. Runs in the Cloud, or locally against a server or a gateway.

**Cloud.** The hosted control plane: Activation Studio, registration, messaging and analytics.

**Gateway.** A bridge between the radio mesh and a controller; broadcasts commands and ingests telemetry. The trust boundary — it holds credentials, the bands do not.

**Give-away band.** Single-run, minimal-cost tier: paper or fabric strap, 1–3 LEDs, goes home with the guest.

**Node.** In the Activation Studio, a point of interest on the venue plan — an artwork, a bar, a stage edge — with an activation radius and rules attached. (An earlier, unrelated use of the word for a relay device was dropped in favour of multi-gateway positioning; see §3.2.)

**Phase clock.** The shared timebase from which every device computes its animation frame, enabling crowd-wide synchronization.

**Reusable band.** Rechargeable, fleet-managed tier: full RGB, sensing, 50–200+ shows.

**Server.** On-premise controller for large live shows; ingests DMX and drives gateways with low latency. *Not yet built.*

**Show Scenario.** The versioned interchange format describing a show — zones, rules, timeline, cues and KPIs.

**Capability model.** Each device advertises what hardware it carries, and acts only on the command fields it has the hardware for. This is how one broadcast serves a fleet of mixed form factors. It replaced TLV (tag-length-value) block encoding in protocol v2.

**op_mode / anim_mode.** The two orthogonal axes of a command: what the radio and power system are doing, and what the light is doing. Separate because a device is normally both listen-only and animating at once.

**Unison / wave.** The two synchronization regimes — zero phase offset (crowd pulses together) versus per-group phase offset (effects ripple across sections). Same code path, different phase term.

---

*Aetherfield White Paper v2 — confidential draft. Figures and constants reflect the current prototype and are subject to change. Sections marked ⚠ GAP describe designed-but-unbuilt components and should be read as intent, not capability.*
