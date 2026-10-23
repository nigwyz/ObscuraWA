# ADR-0001: WhatsApp transport for DukkanAI

- **Status:** Proposed (owner sign-off required to start M1)
- **Date:** 2026-10-23
- **Milestone:** M0 — Obscura feasibility spike
- **Supersedes:** nothing
- **Evidence:** `results/` (gitignored, local), spike kit in `spike/`

## Context

DukkanAI is a multi-merchant WhatsApp commerce SaaS. Each merchant needs a
linked WhatsApp number that survives restarts, crashes and deploys without
re-pairing.

Two candidate transports:

1. **ObscuraWA** — run the real WhatsApp Web client inside the Obscura
   Rust headless browser engine (Apache-2.0), one OS process per session.
   Attractive if it works: a real Web client, no protocol library, and a
   claimed memory footprint far below Chromium.
2. **Baileys** — `@whiskeysockets/baileys` 6.7.24, a reverse-engineered
   WhatsApp multi-device client (no browser).

The question this spike answers: **can a linked WhatsApp Web session on
Obscura survive a restart well enough to run a multi-merchant SaaS connector?**

### Gate set agreed for M0

| Gate | Pass condition |
|------|----------------|
| G1 | Boot to authenticated shell or QR within 60 s, no fatal page errors |
| G2 | All critical browser-API probes pass |
| G3 | Pair a real account, receive inbound, send outbound with ack |
| G4 | Clean restart of the same storage dir: no re-pair, ready < 60 s |
| G5 | `kill -9` then restart: no re-pair |
| G6 | ≤ 150 MB RSS per session and ≤ 50 % of the Chromium baseline |
| G7 | 24 h soak, zero re-pairs, auto-reconnect after a network drop |

### Test environment

| Component | Version |
|-----------|---------|
| Obscura | `v0.2.5` (`obscura-x86_64-linux.tar.gz`, sha256 `2116764b99bc084fae3668b68aa535b4cf456e4498845b47493ad4123e83ca36`) |
| Obscura upstream HEAD observed | `0979094` (2026-10-21, merge of #1325) |
| whatsapp-web.js | 1.34.7 |
| puppeteer-core | 25.16.0 (adapter run used whatsapp-web.js's bundled puppeteer 24.38.0) |
| Chromium baseline | Chrome for Testing 146.0.7680.31 |
| Baileys | 6.7.24 |
| Node | v20.20.2 |
| Host | 16 cores, 31 GB RAM |

Engine overrides used for the heavy SPA: `OBSCURA_SCRIPT_DEADLINE_MS=60000`,
`OBSCURA_MODULE_BUDGET_MS=15000`.

## Decision

**No-Go on ObscuraWA as the transport. Commit to Baileys 6.7.24 for the
connector.**

Obscura fails two independent, decisive gates, and misses the memory budget
while still failing to boot the app:

- **G4/G5 fail categorically.** Obscura persists only `cookies.json` and
  `localStorage/*.json` — about 12 KB of what a WhatsApp Web session wrote,
  versus 4.46 MB of browser profile in the Chromium control (which includes
  the `web.whatsapp.com` IndexedDB origin, Service Worker, Cache and
  Sessions). IndexedDB itself is in-memory and is lost on *both* a clean
  restart and `kill -9`. No amount of adapter work fixes this; it is the
  engine's storage model, not a tuning issue.
- **G1 fails.** WhatsApp Web loads its full document but never renders a QR
  or `#pane-side`. Its worker bootstrap dies on APIs Obscura does not
  implement.
- **G3 fails.** The intended adapter, whatsapp-web.js, throws during
  `Client.initialize()` on 4/4 recorded runs (11 attempts in total) and
  never reaches a QR.
- **G6 misses the absolute bar:** 260 MB for a session that never finished
  booting, against a ≤ 150 MB budget.

Re-evaluation trigger: upstream PR **#1158** (persistent localStorage + ACID
IndexedDB via redb + CacheStorage) merged **and** issue **#827**
(worker `importScripts`) closed → re-run `spike:00, 01, 02, 03, 14, 15`.

## Gate results

| Gate | Obscura 0.2.5 | Evidence |
|------|---------------|----------|
| G1 boot | **FAIL** — full document loads, no QR, no `#pane-side` after 120 s | `results/01-boot.json`, `results/13-ww-boot-blockers.json` |
| G2 browser APIs | **PASS** — 1 real critical gap (`crypto.subtle` ECDSA) + 1 non-critical (SW `getRegistration`) | `results/02-probe-apis.json` |
| G3 pair + send | **FAIL** — adapter `initialize()` threw 4/4, 0 QR | `results/03-pair-send-history.json` |
| G4 clean restart | **FAIL** — IndexedDB lost | `results/14-persistence.json` |
| G5 crash recovery | **FAIL** — IndexedDB lost after `kill -9` | `results/14-persistence.json` |
| G6 density | **FAIL** (absolute bar) — 260 MB, no working session | `results/01-boot.json`, `results/00-connect.json`, `results/07-chromium-baseline.json`, `results/15-baileys-baseline.json` |
| G7 24 h soak | **NOT RUN** — blocked by G1/G3 | — |

### G1 — boot: FAIL

Measured (`spike/01-boot.mjs`, `spike/13-ww-boot-blockers.mjs`):

- Navigation **1.7 s** (1712 ms), then a 120 s boot poll ended `not-ready`.
- Document loaded: **632 755** characters of body HTML, `#app` present,
  79 `<script>` tags, `title: WhatsApp`.
- `window.Debug` exists and `window.require` is a function, but
  `webpackChunkbuild` is undefined, **no QR canvas and no `#pane-side`**.
- 0 uncaught page errors, 0 failed requests — the failure is inside workers.
- Console (deduplicated):
  - `Worker error: Cannot read properties of undefined (reading 'locks')` ×16
  - `Worker error: Unexpected token '<'` ×6
  - `Worker error: importScripts is not defined` ×2
  - `ErrorUtils caught an error: window.removeEventListener is not a function`
  - `[storage] storage bucket persistence denied (aquire-persistent-storage-denied)`

In-worker capability probe (identical source run on Obscura and Chromium):

| Worker API | Obscura | Chromium (control) |
|------------|---------|--------------------|
| `importScripts` | **undefined** | `function` |
| `navigator.locks` | **undefined** | `object` |
| `navigator.storage` | **undefined** | `object` |
| `caches` (CacheStorage) | **undefined** | `object` |
| `self.removeEventListener` | **undefined** | `function` |
| `indexedDB`, `fetch`, `WebSocket`, `WebAssembly`, `crypto`, `postMessage` | present | present |

Chromium control on the same origin boots the app: QR in **9 548 ms** with
`Debug.VERSION = 2.3000.1051444067` (`results/16-chromium-globals.json`,
`results/07-chromium-baseline.json`).

Corroboration:

- `importScripts` appears in **no** Rust source file in the upstream repo.
- Open upstream issue **#827** — *"Web Workers: `importScripts()` not
  implemented"* (created 2026-09-04, still open), the exact failure observed.

### G2 — browser API battery: PASS with one gap

33 probes (`spike/lib/probe.mjs`) run on `example.com` and on
`web.whatsapp.com` (`results/02-probe-apis.json`).

Critical failures:

- `crypto.subtle.ecdsa p-256 keygen+sign` → `generateKey does not support
  ECDSA` — both contexts. Not on WhatsApp Web's critical path (it uses
  curve25519/X25519, not WebCrypto ECDSA), but it is a real WebCrypto gap.
- `fetch https` failed **only** on `example.com`, a CORS artifact of the probe
  itself (cross-origin fetch to `web.whatsapp.com`). It passed on
  `web.whatsapp.com`.

Non-critical failure: `navigator.serviceWorker.getRegistration` is not a
function (Chromium: `function`).

Passing: IndexedDB open/put/get plus binary + `CryptoKey` + `Map` records,
AES-GCM/HMAC/SHA-256, `randomUUID`, localStorage/sessionStorage round-trip,
`WebSocket` to `wss://web.whatsapp.com/ws/chat` (**open**), `fetch`,
`Worker`, `MessageChannel`, `Blob.text`, Resize/Intersection/Mutation
observers, `requestIdleCallback`, `WebAssembly.validate`, `Intl ar-MA`
timezone formatting, `structuredClone`, `TextEncoder/TextDecoder`, abort
semantics, `URL.createObjectURL`, canvas, `Notification`, permissions,
`getBoundingClientRect`, `performance.now`, `navigator.storage.estimate`
(quota 5 GB).

#### Event-channel sub-gate: PASS for the real adapter pattern

whatsapp-web.js surfaces every event (qr, message, ack, disconnected) through
`page.exposeFunction`, so the channel was probed directly:

- `spike/08`: `Runtime.addBinding`, binding visibility, `bindingCalled`
  payload, `evaluate {awaitPromise}`, `callFunctionOn {awaitPromise}` and
  `exposeFunction` registration all **PASS**.
- `spike/10`: **FAIL** — Obscura serves CDP commands strictly one at a time
  *per session*: while a `callFunctionOn {awaitPromise}` awaits a promise only
  the host can settle, the session stops answering (`Runtime.evaluate` never
  returns). Deadlock.
- `spike/11` scopes the constraint: (a) same session **blocked**; (b) a second
  CDP session on the same page **works**; (c) a second browser connection
  **works**. So the serialization is per-session, not per-connection.
- `spike/12` proves whatsapp-web.js's actual pattern is unaffected and
  **passes 6/6**: exposeFunction installs, page→host→page resolves in **3 ms**,
  an event fired during a 1.5 s busy host command still round-trips (1503 ms),
  and a burst of **25/25** events all round-trip.

**Reading:** the constraint is real but does not break whatsapp-web.js, which
never awaits from the host a promise only the host can settle. Any future
re-evaluation must re-test this — other tooling could trip it.

### G3 — pair + send: FAIL (blocked, adapter cannot initialize)

No QR was ever produced, so the phone step was never reached. Running the
real adapter (`spike/03-pair-send.mjs`, whatsapp-web.js 1.34.7 against an
external Obscura endpoint) failed on **4/4 recorded runs, 0 QR**
(`results/03-pair-send-history.json`). Across all **11 attempts** made during
this spike the same two failure classes recurred: **6** were the 30 s
`callFunctionOn` timeout below and **5** were the stale-execution-context
rejection. Recorded runs:

| Runs | Failure | Where |
|------|---------|-------|
| 2/4 | `ProtocolError: Runtime.evaluate: Cannot find context with specified id: 3` | `Client.inject` (`Client.js:126`) — the `window.Debug?.VERSION` polling loop |
| 1/4 | `ProtocolError: Runtime.callFunctionOn: promise did not settle within 30000ms` | `Client.inject` (`Client.js:146`) |
| 1/4 | `ProtocolError: Runtime.callFunctionOn: exceeded 30000ms timeout` | `Client.inject` (`Client.js:146`) |

Reading:

- The `Client.js:146` call is `await this.pupPage.evaluate(async () => …)`
  waiting for `WAWebSocketModel.Socket` to leave
  `OPENING`/`UNLAUNCHED`/`PAIRING`. The socket never changes state because the
  app never finishes booting — a downstream symptom of G1.
- The `Client.js:126` failure is a **stale execution context**: Obscura
  replaced an execution context without puppeteer invalidating its cached id,
  so an in-flight `Runtime.evaluate` is rejected. This is a second, distinct
  engine defect and would bite any long-running CDP client, not just
  whatsapp-web.js.

The adapter never reached a QR in any run. G3 requires a human with a phone;
that step is moot until G1 passes.

### G4 / G5 — restart survival: FAIL (decisive)

`spike/14-persistence.mjs` writes a marker to localStorage, cookies and
IndexedDB, then re-reads after a clean `SIGTERM` shutdown and after `kill -9`
(the hard-kill case first triggers a navigation, so the profile *was* flushed):

| State | Clean restart | After `kill -9` |
|-------|---------------|-----------------|
| localStorage | preserved | preserved |
| cookies | preserved | preserved |
| **IndexedDB** | **lost** (`missing`) | **lost** (`missing`) |

Persisted footprint after a WhatsApp Web boot:

- Obscura `--storage-dir`: `cookies.json` (2 cookies) +
  `localStorage/…json` (11 keys) ≈ **12 KB**. Keys observed: `Session`,
  `WAWebEncKeySalt`, `WANoiseInfoIv`, `WALangPhonePref`, `post-logout`, …
- Chromium profile for the same workload: **4.46 MB**, including
  `IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb`, `Service Worker/`,
  `Cache/`, `Sessions/`, `blob_storage/`, `Local Storage/`, `Cookies`
  (`results/17-wweb-storage-footprint.json`).

Obscura's own source confirms the model: `context.rs` writes only
`{storage_dir}/cookies.json` and `{storage_dir}/localStorage/*.json`;
`indexed_db.rs` has no flush/persist path.

Upstream knows: **#1157** (RFC: persistent storage architecture) and PR
**#1158** (*persistent localStorage, ACID IndexedDB via redb, and
CacheStorage*) are both **open**, plus PR **#876** (IndexedDB interface
globals + schema persistence). None merged as of this spike.

### G6 — density: FAIL against the absolute bar

| Configuration | RSS (peak, process tree) | Notes |
|---------------|--------------------------|-------|
| Obscura, 1 page (`example.com`) | **51 MB** | `spike/00` |
| Obscura, WhatsApp Web loaded | **260 MB** | `spike/01` — app never finished booting |
| Chromium + whatsapp-web.js → QR | **1 482 MB** (Chrome alone 1 388 MB) | `spike/07`, QR in 9 761 ms |
| **Baileys → QR** | **117 MB** | `spike/15`, QR in **777 ms**, no browser |

- Obscura is ≈ 18 % of Chromium's footprint — the *relative* bar (≤ 50 %)
  would pass — but **260 MB exceeds the ≤ 150 MB per-session budget**, and
  that number is for a session that never became usable.
- Baileys passes both bars (117 MB ≤ 150 MB, ≈ 8 % of Chromium) **and
  actually works**.

### G7 — 24 h soak: NOT RUN

Blocked by G1/G3: there is no session to soak. Re-run as part of any
re-evaluation.

### Fallback verified

`spike/15-baileys-baseline.mjs`: Baileys 6.7.24 connects to WhatsApp
(`connected to WA`), produces a QR in **777 ms** (237 characters), peak RSS
**117 MB**, single Node process, no browser. QR printed to the terminal only;
never written to disk.

**Honest limit:** pairing was not exercised on Baileys either — G3 needs a
human with a phone, and no QR could be scanned on Obscura in the first place.
What is verified for Baileys is transport + QR + footprint; inbound/outbound
messaging is untested here and is a required check in M1.

## Consequences

### Accepted

- **Unofficial client risk.** Baileys is a reverse-engineered protocol
  client; WhatsApp can change behaviour or enforcement at any time.
  *Mitigation:* pin `6.7.24`, quarantine session files outside git, monitor
  upstream releases, keep this spike kit so a transport switch can be
  re-evaluated without re-deriving the gates.
- **Multi-account shape.** One Baileys socket per linked number; a session
  store, reconnect policy and quota layer are required (M1 `connector-core`).
- **WhatsApp Web parity features deferred.** Real Web features (rich Web UI,
  web-only capabilities) would need Chromium + whatsapp-web.js at ≈ 1.48 GB
  per session — a cost decision for later, not a spike result.

### Follow-ups

- M1: `packages/connector-core` on Baileys — session store, reconnect,
  inbound/outbound pipeline, per-merchant isolation.
- Keep the spike kit and `results/` as the baseline for the re-evaluation
  trigger (PR #1158 merged **and** issue #827 closed).

### Rejected

- **ObscuraWA as M2's transport.** Fails G1, G3, G4, G5 and G6; the G4/G5
  failure is architectural (in-memory IndexedDB), not a tuning issue.
- **Chromium + whatsapp-web.js as the default.** Works (G1 verified: QR in
  9.5 s), but 1.48 GB per session and a full browser to operate per
  merchant, against 117 MB for Baileys.

## Not decided here

- Whether to `git init` this repository (currently not a git repo;
  `results/`, `sessions/` and `.env` are already gitignored).
- M1 scope and milestone sequencing beyond the transport choice.
