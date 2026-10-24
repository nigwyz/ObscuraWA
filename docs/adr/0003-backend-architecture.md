# ADR-0003: Backend architecture for whatsapp-web.rs

- **Status:** Proposed
- **Date:** 2026-10-24
- **Related:** ADR-0001 (superseded), ADR-0002 (QR bridge)

## Context

The target is a logged-in WhatsApp client with persistent sessions, messaging, and a `whatsapp-web.rs` API plus preview UI. Obscura runs the real page and already reaches a QR, but login is unverified, IndexedDB is in-memory, and messaging via page internals is fragile.

`whatsapp-rust` 0.7 (MIT, active) already provides the full multi-device protocol: QR and pairing-code auth, persistent sessions, E2E direct/group messaging, media, history sync, groups, and SQLite storage. `whatsapp-web.js` defines the API shape to mirror.

Running both against the same phone creates two independent linked devices, not one shared session.

## Decision

Build `whatsapp-web-rs` as a facade with two backends, selecting **one backend per tenant**:

1. **`ProtocolBackend` (default for production)** — `whatsapp-rust` + SQLite. Fast path to session, messaging, history, and low memory.
2. **`ObscuraBackend` (fidelity/preview)** — the real WhatsApp Web page in Obscura over raw CDP and the WS bridge. Used for QR/login preview, web-only behavior, and anti-bot fidelity.

The facade exposes `Client`, `Event`, `Message`, `Chat`, `Contact`, `State`, and a `Backend` trait. The preview UI (Axum + static page) talks to the facade and works with either backend.

Do not pair the same account through both backends in one tenant. They are separate linked devices.

## Consequences

- A working logged-in client with sessions and messaging is achievable without waiting for the Obscura loader/IDB work.
- Obscura remains the browser engine for the fidelity/preview path and the project’s differentiator.
- The facade prevents lock-in; the protocol backend can be replaced if `whatsapp-rust` changes.
- Two backend implementations mean two test matrices; the preview UI must not assume page internals.
- ToS/account risk remains; use a test number.

## Rejected

- **Obscura-only for production now:** login is unproven, IDB is not persistent, and page-internal messaging is fragile.
- **Protocol-only:** loses the real-browser fidelity that motivated ObscuraWA.
- **Dual-run the same account:** creates two linked devices with independent state and confusing message acks.

## Open questions

- Does `whatsapp-rust` meet the memory and licensing bar for the target deployment?
- Which backend is the default for the first preview release?
- Is the Obscura path required for login/QR UX, or only for a separate fidelity mode?
