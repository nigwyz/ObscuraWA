# Roadmap

## M0 — Login gate (current)

- Add post-698 frame tracing (lengths/directions only) and `PairSuccess`/ready detection.
- Separate `authenticated` (QR gone) from `ready` (chat list loaded).
- Verify one real account reaches the chat list and survives a 5-minute idle.
- **Gate:** login works, or the protocol backend becomes the default.

## M1 — `whatsapp-web-rs` facade + protocol backend

- Rust workspace: `crates/whatsapp-web-rs`.
- `Client`, `Event`, `Message`, `Chat`, `Contact`, `Backend` trait.
- `ProtocolBackend` over `whatsapp-rust` (MIT): QR/pairing code, SQLite session, text send/receive, chat list.
- **Gate:** send/receive text on a test number; restart and reconnect without QR.

## M2 — Preview UI

- Axum server + static page: QR, state, chat list, message pane, send box, WebSocket events.
- **Gate:** link, list chats, open a chat, send/receive text in the browser.

## M3 — Obscura backend parity

- `ObscuraBackend` over the existing raw CDP client and WS bridge.
- QR/login, chat list, message list, text send via page internals:
  `WAWebChatCollection`, `WAWebMsgCollection`, `WAWebSendMsgChatAction`, `WAWebSendTextMsg`, `WAWebFindChatAction`, `WAWebWidFactory`.
- **Gate:** the same preview UI works with `BackendKind::Obscura`.

## M4 — Persistence

- Disk-backed IndexedDB (redb) with a bounded LRU cache; remove the 64 MB in-memory cap.
- Cookies/localStorage/auth state per tenant.
- **Gate:** clean restart and `kill -9` restart restore the session without QR.

## M5 — API parity

- `sendMedia`, `createGroup`, `getChatById`, `getContactById`, acks/reactions.
- Protocol backend first; Obscura backend second.

## M6 — Multi-tenant

- Protocol backend: many sessions per process, SQLite per tenant.
- Obscura backend: process-per-tenant + suspend/resume; ~210–280 MB active, ~0 idle.
- **Gate:** 10 tenants with 3 active on one host; measure PSS/CPU.

## Decision gates

1. **Login:** if M0 does not pass, default to the protocol backend for production and keep Obscura as the preview/fidelity path.
2. **Persistence:** if disk-backed IDB is not viable, Obscura cannot be a restart-safe transport.
3. **Memory:** 150 MB engine is not reachable today; target 200–240 MB engine and 250–280 MB total.

## Non-goals (for now)

- Full `whatsapp-web.js` parity in one release.
- 50+ active Obscura tenants per host.
- Media/calls in the first preview.
