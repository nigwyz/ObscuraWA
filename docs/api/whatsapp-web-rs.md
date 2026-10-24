# whatsapp-web.rs facade

Proposed Rust API for the product. It mirrors the core of `whatsapp-web.js` and hides which backend is active.

## Types

```rust
pub struct Client { /* backend, event bus, config */ }

pub enum Event {
    Qr(String),
    Authenticated,
    Ready,
    Message(Message),
    MessageCreate(Message),
    Disconnected(String),
    StateChanged(State),
}

pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    pub timestamp: i64,
    pub from_me: bool,
    pub ack: u8,
    pub has_media: bool,
}

pub struct Chat {
    pub id: String,
    pub name: String,
    pub is_group: bool,
    pub unread_count: u32,
    pub timestamp: i64,
    pub last_message: Option<String>,
}

pub struct Contact {
    pub id: String,
    pub name: String,
    pub pushname: Option<String>,
    pub number: Option<String>,
    pub is_business: bool,
}

pub enum State { Unknown, Qr, Authenticated, Ready, Disconnected }
```

## Backend trait

```rust
#[async_trait]
pub trait Backend: Send + Sync {
    async fn initialize(&mut self) -> Result<()>;
    async fn state(&self) -> State;
    async fn qr(&self) -> Option<String>;
    async fn chats(&self) -> Result<Vec<Chat>>;
    async fn messages(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>>;
    async fn send_text(&mut self, chat_id: &str, text: &str) -> Result<Message>;
    async fn contacts(&self) -> Result<Vec<Contact>>;
    async fn logout(&mut self) -> Result<()>;
    async fn destroy(&mut self) -> Result<()>;
}
```

## Client

```rust
let client = Client::builder()
    .backend(BackendKind::Protocol) // or BackendKind::Obscura
    .storage("./data/tenant-1")
    .build()
    .await?;

let mut events = client.events();
client.initialize().await?;
client.send_text("123@s.whatsapp.net", "hello").await?;
```

Events are delivered over `tokio::sync::broadcast`. `initialize` is idempotent; `destroy` releases the engine/process and storage handles.

## Preview API

The preview server (Axum) exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | backend, state, QR presence |
| `GET` | `/api/qr` | PNG or 404 |
| `GET` | `/api/chats` | chat list |
| `GET` | `/api/chats/:id/messages?limit=` | recent messages |
| `POST` | `/api/send` | `{ chat_id, text }` |
| `GET` | `/ws` | events (`qr`, `ready`, `message`, `disconnected`) |

Bind to `127.0.0.1` by default; no auth in the local preview.

## Backend behavior

| Capability | ProtocolBackend | ObscuraBackend |
|---|---|---|
| QR / pairing code | yes | QR only initially |
| Persistent session | SQLite | cookies/localStorage; IDB pending |
| Text messaging | yes | page internals, later |
| History sync | yes | page state |
| Memory | low | 210–280 MB engine+controller |
| Fidelity | protocol | real page |

## Non-goals for the first API

Media, groups, calls, reactions, and full `whatsapp-web.js` parity. Add them after text messaging and session restore are stable.
