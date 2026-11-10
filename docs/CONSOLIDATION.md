# Consolidation — 2026-11-10

This repo was seeded by **copying** (nothing moved or deleted) from three
folders, which are now frozen:

| Here | From | Note |
|---|---|---|
| `include/aura_radio.h` | aetherfield-pixel `include/` | Newer than the platform copy |
| `firmware/common/` | aetherfield-pixel `firmware/common/` | Live aura_band (1,036 lines, has addr override + load-gen hooks) |
| `firmware/boards/{holyiot,seeed}` | aetherfield-pixel `firmware/boards/` | |
| `firmware/aura-link/` | aetherfield-pixel `firmware/gateway/` | Incl. 1.1 status LED, `gw01–gw30.conf` |
| `firmware/aura-link-factory-test/` | aetherfield-pixel `firmware/gateway-factory-test/` | The image sent to Seeed |
| `firmware/aura-tag/` | aetherfield-pixel `firmware/aura-tag/` | Written 2026-11-09 |
| `server/` | aetherfield-pixel `server/` | Without node_modules or .env |
| `tools/`, `tools/stress/`, `deploy/` | aetherfield-pixel | |
| `hardware/aura-one/` | aura-2 `PCB/Board/` | KiCad, without lock files/backups |
| `hardware/aura-lite/` | aura-2 `PCB/Aura-Lite/` | |
| `hardware/library/` | aura-2 `PCB/Library/` | |
| `docs/PROTOCOL.md` | aetherfield-platform `PROTOCOL.md` | v2 radio spec |
| `docs/LINK-AND-DEPLOYMENT.md` | aetherfield-pixel `docs/PROTOCOL.md` | Gateway↔server line protocol, deployment profile |
| `docs/DEMO-RUNSHEET.md` | aetherfield-pixel `DEMO.md` | |
| `docs/WHITEPAPER.md`, `SHOW-SCENARIO.md`, `demos/`, `reference/` | aetherfield-platform `docs/` | |
| `docs/history/` | platform CLAUDE.md + Aug 2026 CONSOLIDATION.md | The earlier history, for context |
| `cloud/activation-studio/` | aetherfield-platform `CLOUD/EventBuilder/` | |
| `lab/…` | aetherfield-platform `AURA/`, `GATEWAY/`, `NODE/`, `DEMOS/`; aetherfield-pixel `firmware/pixels`, `boards/kkm` | See `lab/README.md` |

Not copied: build output, `node_modules`, `.env*` files, nested `.git`
directories, KiCad lock and backup files.
`aura-2/Firmware/` was empty.

Git history for the copied code stays in the frozen repos. aetherfield-pixel
had never been committed, per its own .gitignore note.
