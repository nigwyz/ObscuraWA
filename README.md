# ObscuraWA

Run real WhatsApp Web inside [Obscura](https://github.com/h4ckf0r0day/obscura), a Rust headless browser, then expose a Rust API and preview UI. Chromium is not used.

## Status

| Milestone | State |
|---|---|
| WhatsApp Web boots on Obscura | ✅ |
| Noise handshake + real QR | ✅ `43 → 350 → 363 → 698 → 37 → 93 → 66` |
| Raw CDP controller (no Puppeteer) | ✅ |
| Local QR preview UI | ✅ |
| Login / linked device | ⚠️ not verified |
| Session persistence | ❌ IndexedDB is in-memory |
| Send/receive messages | ❌ |
| `whatsapp-web.rs` API | ❌ |
| Multi-tenant | ❌ |

This repository is currently a **working feasibility spike**, not a shipping WhatsApp client.

## Memory

Measured at the QR screen, same state, PSS (not summed RSS):

| Stack | Engine | Controller | Total |
|---|---:|---:|---:|
| Chrome / `whatsapp-web.js` | 632 MB | 108 MB | **734 MB** |
| ObscuraWA | 210–240 MB | 30–40 MB | **~250–280 MB** |

V8 heap is ~77–81 MB; ~83 MB is native page state and ~52 MB is a V8 heap/partition block. The **150 MB** target is not met. ~200 MB engine is the practical floor with the current binary. Periodic GC is required: without it, idle memory grows from 213 MB to 251 MB in 120 s; with a 30 s GC it stays at 211–217 MB.

See [docs/operations/memory.md](docs/operations/memory.md).

## Quick start

```bash
pnpm install

# Terminal 1: keep a QR session alive (raw CDP, no Puppeteer)
KEEPALIVE_MS=1800000 node spike/33-qr-live-cdp.mjs

# Terminal 2: serve the auto-refreshing QR page
UI_PORT=8787 node spike/34-qr-ui.mjs
# open http://127.0.0.1:8787/
```

Override the engine with `OBSCURA_BIN=/path/to/obscura`. Results are written to `results/` and are gitignored.

The older Puppeteer-based live path is `spike/27-qr-live.mjs`; it is superseded by `33`.

## Repository layout

```
docs/adr/          architecture decisions
docs/api/          whatsapp-web.rs facade spec
docs/operations/   memory and multi-tenant notes
spike/             feasibility scripts and diagnostics
spike/lib/         worker, bridge, CDP and WS shims
results/           local evidence (gitignored)
sessions/          WhatsApp session material (never commit)
vendor/            local reference clones (never commit)
```

The Rust product crates (`crates/whatsapp-web-rs`, `crates/obsurawa`, `crates/preview`) are planned in [ROADMAP.md](ROADMAP.md) and [docs/adr/0003-backend-architecture.md](docs/adr/0003-backend-architecture.md); they do not exist yet.

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the boot, bridge and controller work
- [ROADMAP.md](ROADMAP.md) — login → session → messaging → API → multi-tenant
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, commits, evidence rules
- [SECURITY.md](SECURITY.md) — local UI, session data, ToS risk
- [docs/adr/0002-real-qr-bridge.md](docs/adr/0002-real-qr-bridge.md) — the bridge workaround
- [docs/adr/0003-backend-architecture.md](docs/adr/0003-backend-architecture.md) — protocol vs Obscura backend

## Security

Never commit QR payloads, cookies, `sessions/`, `results/`, or `.env`. The preview UI binds to `127.0.0.1` only. This is an unofficial WhatsApp client; use a test number and read [SECURITY.md](SECURITY.md).

## License

Not chosen yet. Obscura upstream is Apache-2.0; `whatsapp-rust` is MIT. Pick a license before publishing packages.
