# ADR-0002: Real QR boot via a local module resolver

- **Status:** Accepted (spike workaround)
- **Date:** 2026-10-24
- **Supersedes:** ADR-0001 G1/G3 assumptions for the QR path
- **Evidence:** `spike/lib/wa-bridge.js`, `spike/18-worker-polyfill.mjs`, `results/18-worker-polyfill.json`

## Context

WhatsApp Web's deferred bridge module `WAWebSetFrontendHandlerApi` never resolves on Obscura. The page's dynamic chunk defines it, but the Bootloader does not hand it back to `requireDeferred`, so `getDeviceInfo` is queued forever and the Noise finish frame is never sent.

The chunk also depends on `WAWebCryptoHkdf`, which this build never defines, plus three bridge modules absent from the served page:
`WAWebMemberLabelBridgeApi`, `WAWebNewsletterBridgeApi`, `WAWebThreadBridgeApi`.

`window.require` cannot see the dynamic chunk, so a plain alias is not enough.

## Decision

Use a same-page resolver in `wa-bridge.js`:

1. Wrap `__d` once the page's real loader is available, capturing `{deps, factory}` for every module.
2. Alias `WAWebCryptoHkdf` to `WACryptoHkdf`.
3. Stub the three missing bridge modules with empty exports.
4. Execute the genuine `WAWebDeviceInfoBridgeApi` factory through the captured registry.
5. Register only `getDeviceInfo` on the live `DynamicRouter` with `setHandlers("event", ...)`.

No fake device payload is used. The real `DeviceInfoBridgeApi` reads the page's OS/locale values.

The production bridge is `wa-bridge.js`. Diagnostics stay in `wa-diag.js` and are not injected in the QR path.

## Consequences

- WhatsApp Web reaches a real QR inside Obscura; the handshake matches Chromium:
  `43 → 350 → 363 → 698 → 37 → 93 → 66`.
- The resolver is a **workaround**, not a loader fix. The proper fix belongs in the page loader or upstream Obscura.
- Only `getDeviceInfo` is registered. Other bridge events are unavailable until the loader is fixed or the facade implements them.
- The three stubs must be revisited before messaging/history sync.
- Login is still unverified; post-pairing frames are the next gate.

## Alternatives considered

- **Fake `getDeviceInfo` values:** rejected as a long-term solution; it masks the loader bug and does not provide the rest of the bridge.
- **Patch the Bootloader/`requireDeferred`:** correct, but larger and not needed to prove the QR path.
- **Use `whatsapp-rust` instead of the page:** see ADR-0003; kept as the production backend option.
