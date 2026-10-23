# Milestone 0 — Obscura feasibility spike

Disposable code. Nothing here becomes product code. Its only output is
evidence for `docs/ADR-0001-transport.md`.

**Result: No-Go on Obscura, commit to Baileys 6.7.24** — see the ADR for the
gate matrix. Re-run the whole kit when upstream PR #1158 (persistent IndexedDB)
merges and issue #827 (worker `importScripts`) closes.

## Question

Can a linked WhatsApp Web session on Obscura survive a restart well enough to
run a multi-merchant SaaS connector?

## Gates

| # | Gate | Pass condition | Result |
|---|------|----------------|--------|
| G1 | Boot | Authenticated shell or QR within 60 s, no fatal page errors | **FAIL** — document loads, no QR/`#pane-side` after 120 s |
| G2 | Browser APIs | All critical probes in `02-probe-apis.mjs` pass | **PASS** — 1 gap (`crypto.subtle` ECDSA), +1 non-critical (SW `getRegistration`) |
| G3 | Pair + messaging | Pair, inbound received, outbound acked | **FAIL** — adapter `initialize()` threw 4/4, 0 QR |
| G4 | Clean restart | Same storage dir, no re-pair, READY < 60 s | **FAIL** — IndexedDB lost |
| G5 | Crash recovery | `kill -9`, restart, no re-pair | **FAIL** — IndexedDB lost |
| G6 | Density | ≤ 150 MB RSS/session and ≤ 50 % of Chromium | **FAIL** — 260 MB (Chromium 1 482 MB, Baileys 117 MB) |
| G7 | Soak | 24 h, zero re-pairs, auto-reconnect after network drop | **NOT RUN** — blocked by G1/G3 |

G4/G5 were expected to fail: Obscura documents IndexedDB as in-memory only and
`--storage-dir` as cookies + localStorage only. WhatsApp Web keeps its session
state in IndexedDB, so this spike proved that in practice rather than assuming
it.

## Running

```bash
pnpm install

# No phone needed
pnpm spike:00     # CDP connect + exposeFunction round-trip
pnpm spike:01     # boot web.whatsapp.com (G1)
pnpm spike:02     # browser API battery (G2)
pnpm spike:07     # Chromium reference: whatsapp-web.js to QR (G6 baseline)
pnpm spike:15     # Baileys fallback: QR + RSS (G6 comparison)

# Diagnostics — event channel and boot blockers
pnpm spike:08     # exposeFunction primitives over raw CDP
pnpm spike:09     # bindingCalled executionContextId vs puppeteer's filter
pnpm spike:10     # per-session command serialization (the deadlock)
pnpm spike:11     # deadlock scope: session vs connection
pnpm spike:12     # whatsapp-web.js's real event pattern (6/6 PASS)
pnpm spike:13     # why WhatsApp Web does not boot on Obscura
pnpm spike:16     # Chromium control: globals + worker capabilities
pnpm spike:17     # where WhatsApp stores its state on disk

# Restart survival (G4/G5) — the decisive gate
pnpm spike:persistence

# Phone needed (only after G1 passes): re-evaluation entry point
SPIKE_PAIR=1 pnpm spike:03     # pair + optional SPIKE_SEND_TO=<number@s.whatsapp.net>
```

Results land in `results/` (gitignored). Set `OBSCURA_BIN` to override the
engine binary path; `SPIKE_VERBOSE=1` mirrors engine logs to stderr;
`SPIKE_WATCH=1` in `03` adds a second-connection page watcher (off by default
because a second connection changes context lifetimes).

## Notes for whoever re-runs this

- **One OS process per session.** `--storage-dir` is per `obscura serve`
  process; cookies + localStorage only.
- **No secrets in logs or `results/`.** The QR payload is printed to the
  terminal only. `sessions/`, `.wwebjs_auth/`, `results/` and `.env` are
  gitignored.
- **Engine tuning.** WhatsApp Web is a heavy SPA: set
  `OBSCURA_SCRIPT_DEADLINE_MS=60000` (default 30 s cap) and
  `OBSCURA_MODULE_BUDGET_MS=15000` before spawning.
- **CDP serialization.** Obscura serves CDP commands one at a time *per
  session*. Never, from the host, await a promise that only the host can
  settle (deadlock — see `10`/`11`). whatsapp-web.js never does this; see
  `12`.
- **whatsapp-web.js against an external endpoint** needs
  `authStrategy: new NoAuth()` (`LocalAuth` injects `userDataDir`, which
  `puppeteer.connect` ignores) and `webVersionCache: { type: 'none' }` to
  test against the live site.
- **WhatsApp blocks unrecognized/headless UAs** — it serves a stripped legacy
  page. Use a mainstream Chrome UA (see `16`).
