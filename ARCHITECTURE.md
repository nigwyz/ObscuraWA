# Architecture

## Goal

Run the real WhatsApp Web page inside Obscura, keep it alive with a real WebSocket, and expose a Rust API plus a preview UI. Obscura is the browser engine; no Chromium or Puppeteer is used in the current path.

## Components

| Component | File | Role |
|---|---|---|
| Engine supervisor | `spike/lib/obscura.mjs` | spawns `obscura serve`, storage dir, CDP endpoint |
| Raw CDP client | `spike/lib/cdp-client.mjs` | targets, sessions, `Runtime.evaluate`, screenshots, GC |
| WebSocket bridge | `spike/lib/ws-bridge-raw.mjs` | page → host frames via `Runtime.addBinding`; host → page via `Runtime.evaluate` |
| Page WS shim | `spike/lib/ws-shim.js` | implements `WebSocket` over the bridge |
| Worker prelude | `spike/lib/worker-polyfill.js` | emulates `Worker`, `importScripts`, locks, storage, caches |
| Bridge prelude | `spike/lib/wa-bridge.js` | resolves the missing WhatsApp bridge modules |
| QR UI | `spike/34-qr-ui.mjs` | auto-refreshing local page and status API |
| Live QR | `spike/33-qr-live-cdp.mjs` | boots, captures QR, detects login, keeps session alive |

## Boot path

1. Start Obscura and connect a raw CDP WebSocket.
2. Create a target/session and inject the page preludes with `Page.addScriptToEvaluateOnNewDocument`.
3. Register `Runtime.addBinding` functions for the WS bridge.
4. Navigate to `https://web.whatsapp.com/`.
5. WhatsApp's Noise handshake runs in the page:
   `43 out → 350 in → 363 out → 698 in → 37 → 93 → 66`, then the QR canvas renders.

## Why the bridge exists

Obscura's `WebSocket` is a stub. `ws-bridge-raw.mjs` gives the page a real socket without host-initiated CDP calls:

- page calls `__obscuraWsOpenBinding`, `__obscuraWsPollBinding`, `__obscuraWsSendBinding`, `__obscuraWsCloseBinding` (JSON strings);
- host owns the `ws` socket and answers by evaluating `__obscuraWsResolveOpen` / `__obscuraWsDeliver` in the page.

Only frame **lengths and first bytes** are logged; payloads are never logged.

## Why the bridge module resolver exists

WhatsApp's deferred `WAWebSetFrontendHandlerApi` chunk never resolves on Obscura because this build omits `WAWebCryptoHkdf` and three bridge modules. `wa-bridge.js`:

1. captures every `__d(name, deps, factory)` in a local registry;
2. aliases `WAWebCryptoHkdf` to `WACryptoHkdf`;
3. stubs `WAWebMemberLabelBridgeApi`, `WAWebNewsletterBridgeApi`, `WAWebThreadBridgeApi`;
4. executes the real `WAWebDeviceInfoBridgeApi` and registers `getDeviceInfo` on the live `DynamicRouter`.

This is a workaround. The proper fix is in the page loader or upstream Obscura; see [ADR-0002](docs/adr/0002-real-qr-bridge.md).

## Workers

Obscura's `Worker` is same-thread JavaScript, not an isolate. The prelude adds `importScripts`, `navigator.locks`, `navigator.storage`, `caches`, and correct `MessagePort` transfer semantics. WhatsApp creates three workers at boot: `RSTWebWorker`, `WAWebFtsWorkerBundle`, and `WAWebBackendWorker-*`. The backend retries four times; the prelude deduplicates live workers by name.

## Memory model

- V8 heap: ~77–81 MB used at QR.
- Native page state: ~83 MB (DOM/CSS/network/V8 code/partition).
- Page file mappings: ~19 MB.
- Engine baseline: ~32 MB.
- Periodic `HeapProfiler.collectGarbage` is required; the default V8 memory reducer does not reclaim idle garbage within 120 s.

See [operations/memory.md](docs/operations/memory.md).

## Storage

Obscura persists `cookies.json` and `localStorage/*.json`. **IndexedDB is in-memory only**, capped at 64 MB, and lost on restart (`crates/obscura-js/src/indexed_db.rs` in the engine source). WhatsApp keeps its Signal keys and app state in IndexedDB, so login will not survive a restart until storage is disk-backed. This is the main persistence blocker.

## Controller

The current controller is a raw CDP client over `ws`; Puppeteer is no longer used in the QR path. `puppeteer-core` remains only for the Chromium/`whatsapp-web.js` baseline and old spike scripts. Controller PSS is 30–40 MB versus ~66 MB with Puppeteer.

## What is not built

- Login verification and post-pairing frame handling.
- Disk-backed IndexedDB and restart survival.
- Messaging via page internals.
- Rust facade, preview server, protocol backend.
- Multi-tenant lifecycle.
