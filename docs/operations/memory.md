# Memory baseline and policy

## Method

- Measure **PSS** from `/proc/<pid>/smaps_rollup`, not summed `VmRSS`.
- Same state: WhatsApp QR shown, no screenshots, 8–10 s settle.
- Report engine, controller and total separately.
- Run three times; keep the median. Single runs vary by 20–30 MB.
- Force GC once, then sample again.

## Results at QR + 8 s

| Stack | Engine PSS | Controller PSS | Total PSS |
|---|---:|---:|---:|
| Chrome / `whatsapp-web.js` | 632 MB | 108 MB | **734 MB** |
| ObscuraWA | 210–240 MB | 30–40 MB | **~250–280 MB** |

`whatsapp-web.js` summed RSS is 1,482 MB; PSS is the fair number.

## Rust controller

Single run at QR against the patched engine (2026-10-26), same method:

| Stack | Engine PSS | Controller PSS | Total PSS |
|---|---:|---:|---:|
| Rust `obsurawa` + patched Obscura | 225.6 MB | 16.8 MB | **~242 MB** |

The Rust controller replaces the Node controller and removes its runtime; it is
~14–23 MB smaller than the raw-CDP Node controller. This is one sample, not a
median; engine PSS varies by 20–30 MB between runs. The patched engine is a
local `0.1.0-dev` build, so compare it to the stock 0.2.5 numbers with care.

## Where the engine memory goes

| Region | Size |
|---|---:|
| V8 heap used | 77–81 MB |
| Native anon beyond V8 | ~83 MB |
| Page file mappings | ~19 MB |
| Engine baseline | ~32 MB |
| Largest anon mapping | ~52 MB (V8 heap/partition; not JIT) |

## What was tested

| Lever | Result |
|---|---|
| Remove diagnostics / minimal bridge | **−40–55 MB PSS** |
| Dedupe backend worker retries | **−27 MB**, 6 workers → 3 |
| Periodic GC (30 s) | **flat 211–217 MB** over 120 s; without GC: 213 → 251 MB |
| `--max-old-space-size=128` | boots, PSS unchanged |
| `--jitless` | worse (220 MB) |
| `--single-threaded` | worse (233 MB) |
| `--memory-reducer` | already default; no effect at idle |
| Block images/fonts | no measurable win |
| Block WASM | not worthwhile; only a tiny feature detect |
| Puppeteer → raw CDP | controller 66 → 30–40 MB |
| Node raw CDP → Rust controller | controller 30–40 → ~17 MB |

## Current policy

- Keep diagnostics out of the QR path.
- Dedupe live workers by name.
- Run `HeapProfiler.collectGarbage` every 30 s after QR.
- Do not claim 150 MB; target 200–240 MB engine, 250–280 MB total.

## Reproduce

```bash
PROFILE_LABEL=idle120 PROFILE_IDLE_MS=120000 node spike/30-memory-profile.mjs
PROFILE_LABEL=idle120-gc PROFILE_IDLE_MS=120000 PROFILE_GC_INTERVAL_MS=30000 \
  node spike/30-memory-profile.mjs
node spike/28-chromium-pss.mjs   # Chrome reference
node spike/29-obscura-pss.mjs    # Obscura reference
```
