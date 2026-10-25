# ObscuraWA spike

Current status: **real WhatsApp Web QR boot inside Obscura**. Login is not yet verified; session persistence, messaging, and the Rust facade are pending.

The old "No-Go / commit to Baileys" conclusion is superseded. See
[ADR-0002](../docs/adr/0002-real-qr-bridge.md) and
[ADR-0003](../docs/adr/0003-backend-architecture.md).

## Gate status

| # | Gate | Result |
|---|---|---|
| G1 | Boot to QR | **PASS** — real QR, `43 → 350 → 363 → 698 → 37 → 93 → 66` |
| G2 | Browser APIs | **PASS with gaps** — public-key subtle is emulated by the page's JS curve25519 |
| G3 | Pair + messaging | **PARTIAL** — QR works, login/pairing not verified |
| G4 | Clean restart | **FAIL** — IndexedDB is in-memory |
| G5 | Crash recovery | **FAIL** — IndexedDB is in-memory |
| G6 | Density | **FAIL vs 150 MB** — engine ~210–240 MB PSS, total ~250–280 MB |
| G7 | 24 h soak | **NOT RUN** — blocked by G3/G4 |

## Active scripts

| Script | Purpose |
|---|---|
| `33-qr-live-cdp.mjs` | **Current live QR**: raw CDP, no Puppeteer, login detection, 30 s GC |
| `34-qr-ui.mjs` | Local auto-refreshing QR page and `/status` API |
| `32-qr-cdp.mjs` | One-shot raw CDP QR + PSS |
| `31-cdp-smoke.mjs` | Raw CDP client smoke test |
| `30-memory-profile.mjs` | Stage/PSS/GC/worker profiler |
| `29-obscura-pss.mjs` | Obscura PSS baseline |
| `28-chromium-pss.mjs` | Chrome/`whatsapp-web.js` PSS baseline |
| `24-subtle-polyfill-gate.mjs` | X25519/Ed25519 polyfill correctness gate (not needed by WhatsApp) |
| `18-worker-polyfill.mjs` | Diagnostics boot run with worker/page traces |
| `lib/wa-bridge.js` | Production bridge resolver |
| `lib/ws-bridge-raw.mjs` | Raw-CDP WebSocket bridge |
| `lib/cdp-client.mjs` | Minimal CDP client |
| `lib/memory-keeper.mjs` | Periodic low-memory GC |

## Baselines and diagnostics

`07` Chromium/`whatsapp-web.js`; `15` Baileys; `22` Chromium WS frames; `26` Chromium worker init; `19` request headers; `23` crypto probe; `25` worker bundle probe.

## Superseded

- `27-qr-live.mjs` — Puppeteer live QR; use `33`.
- `21-ws-tunnel.mjs` — older tunnel; use `lib/ws-bridge-raw.mjs`.
- `20-websocket-probe.mjs` — historical proof the native WS stub drops data.

## Running

```bash
pnpm install

KEEPALIVE_MS=1800000 node spike/33-qr-live-cdp.mjs
UI_PORT=8787 node spike/34-qr-ui.mjs
# http://127.0.0.1:8787/
```

`OBSCURA_BIN` overrides the engine binary. `SPIKE_VERBOSE=1` mirrors engine logs.

## Notes

- **One OS process per session.** `--storage-dir` is per `obscura serve`; cookies + localStorage only.
- **No secrets in logs or `results/`.** QR payloads are never written by the QR path. `sessions/`, `results/`, `vendor/`, and `.env` are gitignored.
- **CDP serialization.** Obscura serves CDP commands one at a time per session. Never await a host binding from inside a `Runtime.evaluate` that the host itself must settle.
- **UA.** WhatsApp serves a stripped legacy page to unrecognized/headless UAs; use a mainstream Chrome UA.
- **Engine tuning.** `OBSCURA_SCRIPT_DEADLINE_MS=60000`, `OBSCURA_MODULE_BUDGET_MS=15000`.
- **Loader probes.** `18` accepts `SPIKE_HANDLER_CHUNK_FILE` or `SPIKE_HANDLER_CHUNK_URL` to inject a cached handler chunk for deferred-module experiments; injection is skipped on `--control` runs.
- **Handler chunk.** `HANDLER_CHUNK_FILE=/tmp/wa-all/<hash>.js` with `33` installs the current build's `WAWebSetFrontendHandlerApi` resource as soon as the page loader is live. Without it the current build renders the QR shell but no QR canvas. `QR_TIMEOUT_MS` and `KEEP_STORAGE=1` are available for slow or reused profiles.
- **Periodic GC.** V8 grows at idle; call `HeapProfiler.collectGarbage` every 30 s. See `docs/operations/memory.md`.
- **IDB.** In-memory, 64 MB cap, lost on restart. This is the persistence blocker.
