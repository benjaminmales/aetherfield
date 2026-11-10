# Reference material — harvested 2026-08-19

Salvaged from `aetherfield-cloud-demo` before that repo was retired. **None of this is live code.** It is kept because each item is the only copy of something expensive to recreate, or because it records a decision that is not derivable from the codebase.

| File | What it is | Why kept |
|---|---|---|
| `venue-manifest-wembley.json` | Multi-level Wembley digital twin: 3 levels with elevations, zones with polygon coords and density thresholds, revenue points with POS IDs and target uplift, gateway placements per level | **Richer than the Show Scenario v1 schema.** Has levels/elevation and revenue points, which `docs/SHOW-SCENARIO.md` lacks entirely. Should inform the next schema revision. |
| `demo-script-wembley.json` | Scripted investor demo: a fan moves pitch → concourse, receives a haptic + LED + push offer, walks to merch, transaction attributed | The only worked example of the **revenue-attribution** narrative. Also the only place `haptic`/`led` pattern names appear as a vocabulary. |
| `revenue-engine-dashboard-spec.md` | "ÆTHERFIELD Revenue Engine" dashboard PoC spec (v2.0) | Describes a **different commercial model** to the whitepaper — see the warning below. |
| `revenue-engine-implementation-requirements.md` | Build requirements for the "Interaction Sampler" | Companion to the above |
| `fan-simulator-architecture.md` | Crowd simulation architecture | Needed to load-test without 10k physical bands |
| `fan-simulator-wristband-protocol.md` | The protocol as the simulator models it | Cross-check against `include/aura_radio.h` — a third protocol description in the estate |
| `fan-simulator-control-adapter.js`, `fan-simulator-gateways.js` | Simulator gateway/control logic | Working reference for the Server's fan-out |

---

## ⚠ Unreconciled: there are two commercial models

This is the most important thing in this folder, and it is a **strategy question, not a code question**.

| | **Whitepaper §12 + Traitors deck** | **Revenue Engine spec** |
|---|---|---|
| What is sold | Bands and venue kits | Software / per-interaction fees |
| Revenue model | Cost per head per show (£0.10–5) | SaaS, "defensible margin" on interactions |
| Headline metric | Cost per head falling with reuse | **IRU** — Incremental Revenue Uplift |
| Pitch | Show infrastructure for producers | Infrastructure layer, **£4M seed**, global SaaS |
| Buyer | Producer, venue, touring production | Investor, then venue operator |
| Vocabulary | Aura / Gateway / Server / Cloud / Aurea | **CEL** (Creative Experience Layer), IRU, ITTR |

These are not variations on a theme — they are different businesses with different buyers, and they use **incompatible vocabulary for the same hardware**. The whitepaper does not mention CEL, IRU, or revenue attribution anywhere. The Revenue Engine spec does not mention DMX, synchronization, or show control.

### ✅ Resolved 2026-08-19 — both, and the relationship is the pitch

**Hardware sells; software monetises.** The bands and venue kit are how Aetherfield gets installed; attribution is how the installed base is charged for. Neither model is being dropped.

This is a decision, not a description — nothing in the codebase implies it, and it needs writing into the whitepaper rather than assumed. Open work:

| | Item |
|---|---|
| W1 | **§12 gains a second half.** Today it is purely hardware economics (unit cost, reuse, cost per head). It needs the software/attribution model beside it, and — critically — the argument for *why one leads to the other*. That argument exists nowhere today. |
| W2 | **Decide the vocabulary.** "CEL", "IRU" and "ITTR" are Revenue Engine terms with no presence in the whitepaper. Either promote them into the glossary as canonical, or restate the concepts in the whitepaper's existing language. Two vocabularies for one product is the thing to avoid. |
| W3 | **Attribution needs a home in the architecture.** §3's five-product stack has no layer that owns revenue attribution. It is closest to Cloud, but the Wembley manifest suggests it also needs venue-side spatial data the Show Scenario schema does not carry. |
| W4 | **Reconcile the venue models.** `venue-manifest-wembley.json` has levels, elevations, revenue points and POS IDs. `docs/SHOW-SCENARIO.md` has none of these. One venue schema, not two. |
| W5 | **Decide whether attribution is a demo.** There are two reference demos (Traitors, live music). The Wembley script is effectively a third — and it is the one that carries the commercial story. |

Sequencing note: W2 and W4 are cheap and unblock the rest. W1 is the writing job and should come after both.

---

## Also worth knowing

`local-server/`, `remote-server/` and `ÆTHERTICK/` in `aetherfield-cloud-demo` were **empty directories** — scaffolding that was never built. `docs/demos/live-music.md` previously cited `local-server` as a starting point for the Server; that was wrong and has been corrected. The Server starts from nothing.
