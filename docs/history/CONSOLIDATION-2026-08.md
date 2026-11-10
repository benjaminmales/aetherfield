# Consolidation Map

An inventory of every Aetherfield-related repository found on `benjamins-macbook-beast-local`, what is canonical, what is a snapshot, and what to do with each.

Generated 2026-08-17. Update as things move.

---

## 1. Repository inventory

| # | Path | What it is | Verdict |
|---|---|---|---|
| 1 | `~/aetherfield-platform` | `AURA/ GATEWAY/ NODE/ SERVER/ CLOUD/` + `PROTOCOL.md` + whitepaper | **Canonical platform.** Docs live here. |
| 2 | `~/Consultancy/Traitors` | Pitch material + the working Traitors demo (4 parts) | **Canonical Traitors.** Not yet in the platform tree. |
| 3 | `~/aetherfield-cloud-demo` | `local-server`, `cloud-controller-simulator`, `fan-simulator`, `operator`, `marketing-activation-studio`, `aura-registration`, `ÆTHERTICK` | **Canonical cloud/server prior art.** Source for the Server build. |
| 4 | `~/AURA-ONE-DEMO-2026` | Full monorepo: wristband, node, gateway nRF54 + Pi bridge, Activation Studio, registration, master-admin, Supabase migrations | **Canonical field-demo monorepo.** Best-documented tree. Runs v0. |
| 5 | `~/Aetherfield-coachella-sim` | A copy of Marketing Activation Studio | Duplicate — fold in or delete |
| 6 | `~/AETHERFIELD-DEV/traitors` | Older Traitors snapshot (holyiot boards) | Snapshot — fold in, then delete |
| 7 | `~/AETHERFIELD-DEV/traitors-new` | Older Traitors snapshot (wristband/gateway/visualiser) | Snapshot — fold in, then delete |
| 8 | `~/AETHERFIELD-DEV/aura-2` | PCB + firmware (hardware track) | Keep separate — hardware, not platform |
| 9 | `~/AuraGameshow` | `sports_game` (BLE trivia), `voteband-c6`, `Registration`, `visualiser`, `Prototypes` | Adjacent format experiment — assess, likely archive |
| 10 | `~/Consultancy/Traitors/Holyiot-Test` | Parallel hardware evaluation | Decide: keep or drop before it becomes a third protocol variant |

Plus siblings referenced but not audited: `Aurea`, `AURA-ONE`, `AURA-K7`, `AURA-JAN26`, `AURA-CRYSTAL`, `Aura_AI`, `aetherfield-usd-demo`, `ætherfield-bronze`, holding pages.

---

## 0a. Policy — decided 2026-08-19

**`aetherfield-platform` is the only repo work happens in.** Every other Aetherfield repo is **frozen archive**: not deleted, not maintained, not authoritative.

This replaces the earlier plan of retiring repos one by one. Retirement carried real risk — the audit found the only copies of the Wembley venue manifest, the revenue-attribution demo script and the Revenue Engine specs sitting in a repo that was a step away from being binned. Freezing gets the same outcome (one place to develop) with none of the deletion risk.

Anything worth keeping has been harvested into `docs/reference/`. If more turns up, copy it in and add a line here.

The `_to_delete/` folders created on 2026-08-17 hold two strict-subset Activation Studio copies and one build artefact. They can be restored or emptied — neither is urgent, and nothing depends on them.

---

## 0. Status — 2026-08-17 consolidation pass

| Done | Detail |
|---|---|
| ✅ Traitors firmware folded in | `wristband`, `gateway`, `visualiser` copied to `aetherfield-platform/DEMOS/traitors/`. **Commit and push the platform repo and the backup problem below is solved** — these three then live somewhere with a remote for the first time. Originals left in place at `~/Consultancy/Traitors/Demo`. `registration/` not copied: it already has its own GitHub remote. |
| ✅ Activation Studio resolved | Four copies → one. See §4. Build verified: 715 modules, clean. |
| ✅ Off-disk archive | `traitors-demo-backup.tar.gz` (540 files, all four components) delivered to Benjamin. |
| ⬜ **Push the platform repo** | Nothing is actually backed up until this happens. |
| ⬜ Retire `Aetherfield-coachella-sim` | Held deliberately — it is the source of the grafted components. Delete once the merged studio is confirmed working. |
| ⬜ Retire `AETHERFIELD-DEV/traitors`, `traitors-new` | Older snapshots, now superseded by `DEMOS/traitors/`. |

**Note on deletion:** files moved to `_to_delete/` folders rather than removed — this session can move files on the Mac but cannot delete them. Empty those folders yourself.

---

## 2. ⚠ Backup status

| Repo | Remote | Commits | Risk |
|---|---|---|---|
| `Traitors/Demo/gateway` | **none** | 1 | **Critical** |
| `Traitors/Demo/wristband` | **none** | 1 | **Critical** |
| `Traitors/Demo/visualiser` | **not a git repo at all** | — | **Critical** |
| `Traitors/Demo/registration` | `github.com/benjaminmales/traitors-registration` | — | OK |
| `aetherfield-platform` | `github.com/benjaminmales/aetherfield-platform` | many | OK |
| `aetherfield-cloud-demo` | `github.com/benjaminmales/aetherfield-cloud-demo` | — | OK |

The only firmware that has run a live client demonstration is on one disk. `gateway` and `wristband` are single-commit repos with no remote; **`visualiser` is not under version control at all** — 48 KB of working operator UI with no history and no copy.

```sh
cd ~/Consultancy/Traitors/Demo
git -C visualiser init && git -C visualiser add -A && git -C visualiser commit -m "Initial commit"
for c in gateway wristband visualiser; do
  gh repo create "benjaminmales/traitors-$c" --private --source="$c" --remote=origin --push
done
```

Roadmap **R0**. Do it before anything else.

---

## 3. Protocol drift

Three variants of the radio protocol are live across the estate.

| Repo | Speaks | Detail |
|---|---|---|
| `aetherfield-platform/PROTOCOL.md` + `include/aura_radio.h` | **v1** (spec) | Magic `0xA7`, TLV, hardware PAN filter `0xAE7F`, FCF `0x8841` |
| `aetherfield-platform/AURA/voteband*` | v1 | Beacon TX implemented — the "prove the link" build |
| `Traitors/Demo/*` | **v0** | IDs `0x03`/`0x04`, 4-byte uplink, promiscuous byte-scan |
| `AETHERFIELD-DEV/traitors-new/*` | v0 | Same, older |
| `AURA-ONE-DEMO-2026/*` | v0 | IDs 3 (band), 4 (LED), 5 (node relay) |

**The specification and the shipped code disagree.** The whitepaper describes v1; the demos run v0. Both reference demonstrations are specified against v1, which makes them the forcing function for the migration.

Migration order (from `PROTOCOL.md`):

1. Gateway — shared header, hardware filtering, parse v1 at offset 0, keep accepting v0 ID 3 behind `AURA_ACCEPT_WRISTBAND_AT_GATEWAY`
2. seeed band — v1 beacon TX, v1 CMD TLV parsing, drop the fragile `psdu[15..20]` fixed-offset parse
3. holyiot, then K7 (BUTTON events, FLASH_ASSET)
4. Nodes — NODE_RELAY firmware; flip the gateway to nodes-only when ready

Mapping v0 → v1 for the Traitors demo is tabulated in [`demos/traitors.md`](demos/traitors.md) §6.2. The LED command is close to a drop-in; the notable gain is `VOTE_CTRL` (TLV `0x04`), already specified and unimplemented, which moves round open/close state onto the band.

---

## 4. Duplicated components

### Activation Studio — ✅ resolved 2026-08-17

Diffing showed these were **not four versions of one thing**. Two were ancestors, and the remaining two had **forked functionally** — each held a feature the other lacked, so "pick the newest" would have silently destroyed working code.

| Copy | Unique content | Verdict |
|---|---|---|
| `aetherfield-platform/CLOUD/EventBuilder` | `PairDevice.jsx`, `LiveTelemetryTest.jsx` — the **real-hardware** path | **Canonical.** Base of the merge. |
| `Aetherfield-coachella-sim` | `ConsoleView.jsx`, `DemoOverlay.jsx` — the **presentation/sim** path | Grafted in, then retire |
| `aetherfield-cloud-demo/marketing-activation-studio` | none — strict subset | Retired → `_to_delete/` |
| `AURA-ONE-DEMO-2026/apps/activation-studio` | none — strict subset | Retired → `_to_delete/` |

All four shared an identical dependency set (Vite + React Three Fiber + Supabase), so the graft needed no dependency changes.

**The merge** — `CLOUD/EventBuilder/src/main.jsx` now routes all four entry points:

| Route | Component | From |
|---|---|---|
| `/pair` | `PairDevice` | EventBuilder |
| `?view=console` | `ConsoleView` | coachella-sim |
| `?insights=sim-scenario` | `SimScenarioPopoutShell` | both |
| default | `App` + `DemoOverlay` when `?demo` or `VITE_DEMO_MODE=1` | merged |

Verified with `vite build`: 715 modules transformed, no errors.

> Keep `Aetherfield-coachella-sim` until you have run the merged studio and confirmed the console and demo overlay behave. It is the only other copy of those two components.

### Registration — two copies

| Copy | Notes |
|---|---|
| `Traitors/Demo/registration` | Next.js 14, deployed, Twilio + Anthropic, privacy purge. **The good one.** |
| `aetherfield-cloud-demo/aura-registration` | Earlier variant with a USD viewer |
| `AURA-ONE-DEMO-2026/apps/registration` | Kept "for local/demo parity" |

Production registration is noted as still living outside all of these (`~/AURA-ONE/Interface/register-action`) because printed QR assets are in circulation. Resolve before the next print run.

---

## 5. Target structure

```
aetherfield-platform/
├── PROTOCOL.md                  ← canonical radio protocol (v1)
├── include/aura_radio.h         ← shared constants
├── docs/
│   ├── WHITEPAPER.md            ← canonical whitepaper (was v1.docx)
│   ├── CONSOLIDATION.md         ← this file
│   ├── SHOW-SCENARIO.md         ← promote from aetherfield-cloud-demo (R4)
│   └── demos/
│       ├── traitors.md
│       └── live-music.md
├── AURA/                        ← band firmware, all form factors
├── GATEWAY/
├── NODE/
├── SERVER/                      ← ⚠ EMPTY — roadmap R3
├── CLOUD/EventBuilder/          ← Activation Studio (merged, canonical)
└── DEMOS/
    └── traitors/                ← folded in 2026-08-17
        ├── wristband/           ← was unbacked-up
        ├── gateway/             ← was unbacked-up
        └── visualiser/          ← was not in git at all
```

Notion keeps roadmap, commercial framing and idea capture. Markdown here stays canonical for anything that names a file, a byte layout or an endpoint. Export to `.docx`/PDF for external sharing rather than maintaining a parallel document.

---

## 6. Patterns to promote

Proven in Traitors, currently trapped in a consultancy folder. Roadmap **R6**.

| Pattern | Why |
|---|---|
| 30-minute hard-delete privacy purge | Turns a legal conversation into a short one. Should be the platform default. |
| Chip-UID → 4-hex identity (`derive_device_id()`) | No provisioning step, no manufacturing config. Already the v1 address scheme; this is the reference implementation. |
| Single-file zero-build Web Serial visualiser | Opens from a file, in a venue, with no internet. The right shape for any venue-side operator tool. |
| `/api/session-status` | Purpose-built Aurea seam — "is this guest inside an active visit?" |
| `pitch-ai-instructions.md` | House deck spec: dark theme, one accent, tables stay tables. |

---

## 7. Immediate actions

1. **Commit and push `aetherfield-platform`.** This is R0 now — the Traitors firmware is in `DEMOS/traitors/` and one push puts it somewhere with a remote. Until then it is still one-disk.
2. Run the merged Activation Studio; confirm `?view=console` and `?demo` work. Then retire `Aetherfield-coachella-sim`.
3. Empty the three `_to_delete/` folders (this session can move but not delete).
4. Retire `AETHERFIELD-DEV/traitors` and `traitors-new` — superseded by `DEMOS/traitors/`.
5. Promote the Show Scenario contract into `docs/` as a JSON Schema.
6. Resolve where production registration actually lives before the next QR print run.
7. Decide on `Holyiot-Test/` and `AuraGameshow` — active tracks or archive.
