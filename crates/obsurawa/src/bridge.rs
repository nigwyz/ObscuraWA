//! Page-driven WebSocket bridge over CDP bindings.
//!
//! The page adapter calls four bindings. The host owns the real socket, queues
//! inbound frames, and answers polls with `Runtime.evaluate`. No host command
//! ever waits on a page promise, so the per-session CDP serialization cannot
//! deadlock.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

use crate::cdp::{CdpClient, PageSession};

pub const WS_ADAPTER: &str = r#"(function () {
  window.__obscuraWsPendingOpen = {};
  window.__obscuraWsPendingPoll = {};
  window.__obscuraWsOpen = function (id, url, protos) {
    return new Promise(function (resolve, reject) {
      window.__obscuraWsPendingOpen[id] = { resolve: resolve, reject: reject };
      window.__obscuraWsOpenBinding(JSON.stringify([id, url, protos]));
    });
  };
  window.__obscuraWsResolveOpen = function (id, ok, err) {
    var p = window.__obscuraWsPendingOpen[id];
    if (!p) return;
    delete window.__obscuraWsPendingOpen[id];
    if (ok) p.resolve(true);
    else p.reject(new Error(err || 'open failed'));
  };
  window.__obscuraWsPoll = function (id) {
    return new Promise(function (resolve) {
      window.__obscuraWsPendingPoll[id] = resolve;
      window.__obscuraWsPollBinding(JSON.stringify([id]));
    });
  };
  window.__obscuraWsDeliver = function (id, json) {
    var r = window.__obscuraWsPendingPoll[id];
    if (!r) return;
    delete window.__obscuraWsPendingPoll[id];
    try { r(JSON.parse(json)); } catch (e) { r([]); }
  };
  window.__obscuraWsSend = function (id, b64) {
    window.__obscuraWsSendBinding(JSON.stringify([id, b64]));
    return Promise.resolve(true);
  };
  window.__obscuraWsClose = function (id, code, reason) {
    window.__obscuraWsCloseBinding(JSON.stringify([id, code, reason]));
    return Promise.resolve(true);
  };
})();"#;

const BINDINGS: [&str; 4] = [
    "__obscuraWsOpenBinding",
    "__obscuraWsPollBinding",
    "__obscuraWsSendBinding",
    "__obscuraWsCloseBinding",
];

const MAX_QUEUE: usize = 8192;

struct SocketState {
    tx: mpsc::UnboundedSender<Message>,
    queue: VecDeque<Value>,
    pending_poll: bool,
}

#[derive(Clone)]
pub struct WsBridge {
    cdp: Arc<CdpClient>,
    page: PageSession,
    sockets: Arc<Mutex<HashMap<u64, SocketState>>>,
}

impl WsBridge {
    /// Register the bridge bindings. Call before navigating the page.
    pub async fn install(cdp: Arc<CdpClient>, page: PageSession) -> Result<Self> {
        // tokio-tungstenite does not choose a rustls crypto provider when more
        // than one is compiled in. Pin ring once per process.
        let _ = rustls::crypto::ring::default_provider().install_default();

        for name in BINDINGS {
            cdp.send(
                "Runtime.addBinding",
                json!({ "name": name }),
                Some(&page.session_id),
            )
            .await
            .with_context(|| format!("Runtime.addBinding {name}"))?;
        }

        let bridge = Self {
            cdp,
            page,
            sockets: Arc::new(Mutex::new(HashMap::new())),
        };

        let listener = bridge.clone();
        let mut events = bridge.cdp.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        if event.method != "Runtime.bindingCalled" {
                            continue;
                        }
                        tracing::debug!(target: "obsurawa::bridge", "binding event");
                        if let Some(session_id) = &event.session_id {
                            if session_id != &listener.page.session_id {
                                continue;
                            }
                        }
                        let name = event
                            .params
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let payload = event
                            .params
                            .get("payload")
                            .and_then(Value::as_str)
                            .unwrap_or("[]");
                        let args: Vec<Value> = serde_json::from_str(payload).unwrap_or_default();
                        listener.handle_binding(name, args).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(target: "obsurawa::bridge", "CDP events lagged: {skipped}");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        Ok(bridge)
    }

    async fn handle_binding(&self, name: &str, args: Vec<Value>) {
        match name {
            "__obscuraWsOpenBinding" => {
                let Some(id) = args.first().and_then(Value::as_u64) else {
                    return;
                };
                let url = args
                    .get(1)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let protocols = args
                    .get(2)
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                self.open(id, url, protocols).await;
            }
            "__obscuraWsPollBinding" => {
                if let Some(id) = args.first().and_then(Value::as_u64) {
                    self.poll(id).await;
                }
            }
            "__obscuraWsSendBinding" => {
                let id = args.first().and_then(Value::as_u64);
                let payload = args.get(1).and_then(Value::as_str);
                if let (Some(id), Some(payload)) = (id, payload) {
                    self.send(id, payload).await;
                }
            }
            "__obscuraWsCloseBinding" => {
                let id = args.first().and_then(Value::as_u64);
                let code = args.get(1).and_then(Value::as_u64).unwrap_or(1000) as u16;
                let reason = args.get(2).and_then(Value::as_str).unwrap_or_default();
                if let Some(id) = id {
                    self.close(id, code, reason).await;
                }
            }
            _ => {}
        }
    }

    async fn open(&self, id: u64, url: String, protocols: Vec<String>) {
        let cdp = self.cdp.clone();
        let page = self.page.clone();
        let sockets = self.sockets.clone();

        // Register before spawning or connecting. The page polls immediately
        // after the open binding; an absent socket means "unknown socket" and
        // the shim closes before the TLS handshake can finish.
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        sockets.lock().await.insert(
            id,
            SocketState {
                tx,
                queue: VecDeque::new(),
                pending_poll: false,
            },
        );

        tokio::spawn(async move {
            let request = match build_request(&url, &protocols) {
                Ok(request) => request,
                Err(error) => {
                    let message = error.to_string();
                    push_event(
                        &sockets,
                        &cdp,
                        &page,
                        id,
                        json!({ "t": "error", "m": message }),
                    )
                    .await;
                    push_event(
                        &sockets,
                        &cdp,
                        &page,
                        id,
                        json!({ "t": "close", "c": 1006, "r": message }),
                    )
                    .await;
                    sockets.lock().await.remove(&id);
                    let _ = resolve_open(&cdp, &page, id, false, Some(&message)).await;
                    return;
                }
            };

            let (ws, response) = match tokio_tungstenite::connect_async(request).await {
                Ok(connection) => connection,
                Err(error) => {
                    let message = error.to_string();
                    tracing::warn!(target: "obsurawa::bridge", "connect {id} failed: {message}");
                    push_event(
                        &sockets,
                        &cdp,
                        &page,
                        id,
                        json!({ "t": "error", "m": message }),
                    )
                    .await;
                    push_event(
                        &sockets,
                        &cdp,
                        &page,
                        id,
                        json!({ "t": "close", "c": 1006, "r": message }),
                    )
                    .await;
                    sockets.lock().await.remove(&id);
                    let _ = resolve_open(&cdp, &page, id, false, Some(&message)).await;
                    return;
                }
            };
            tracing::info!(target: "obsurawa::bridge", "socket {id} open: {url}");

            let protocol = response
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let (mut sink, mut stream) = ws.split();
            let _ = resolve_open(&cdp, &page, id, true, None).await;
            push_event(
                &sockets,
                &cdp,
                &page,
                id,
                json!({ "t": "open", "p": protocol }),
            )
            .await;

            let writer = tokio::spawn(async move {
                while let Some(message) = rx.recv().await {
                    if sink.send(message).await.is_err() {
                        break;
                    }
                }
            });

            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Binary(bytes)) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        push_event(
                            &sockets,
                            &cdp,
                            &page,
                            id,
                            json!({ "t": "message", "b": encoded }),
                        )
                        .await;
                    }
                    Ok(Message::Text(text)) => {
                        let encoded =
                            base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
                        push_event(
                            &sockets,
                            &cdp,
                            &page,
                            id,
                            json!({ "t": "message", "b": encoded }),
                        )
                        .await;
                    }
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame
                            .map(|frame| (u16::from(frame.code), frame.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        push_event(
                            &sockets,
                            &cdp,
                            &page,
                            id,
                            json!({ "t": "close", "c": code, "r": reason }),
                        )
                        .await;
                        break;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        push_event(
                            &sockets,
                            &cdp,
                            &page,
                            id,
                            json!({ "t": "error", "m": error.to_string() }),
                        )
                        .await;
                        break;
                    }
                }
            }

            writer.abort();
            sockets.lock().await.remove(&id);
        });
    }

    async fn poll(&self, id: u64) {
        let events = {
            let mut sockets = self.sockets.lock().await;
            match sockets.get_mut(&id) {
                None => vec![json!({ "t": "close", "c": 1006, "r": "unknown socket" })],
                Some(socket) => {
                    if socket.queue.is_empty() {
                        socket.pending_poll = true;
                        return;
                    }
                    socket.queue.drain(..).collect()
                }
            }
        };
        let _ = deliver(&self.cdp, &self.page, id, events).await;
    }

    async fn send(&self, id: u64, payload: &str) {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else {
            return;
        };
        let sender = {
            let sockets = self.sockets.lock().await;
            sockets.get(&id).map(|socket| socket.tx.clone())
        };
        if let Some(sender) = sender {
            let _ = sender.send(Message::Binary(bytes.into()));
        }
    }

    async fn close(&self, id: u64, code: u16, reason: &str) {
        let frame = CloseFrame {
            code: CloseCode::from(code),
            reason: reason.to_string().into(),
        };
        let sender = {
            let sockets = self.sockets.lock().await;
            sockets.get(&id).map(|socket| socket.tx.clone())
        };
        if let Some(sender) = sender {
            let _ = sender.send(Message::Close(Some(frame)));
        }
    }
}

async fn push_event(
    sockets: &Arc<Mutex<HashMap<u64, SocketState>>>,
    cdp: &Arc<CdpClient>,
    page: &PageSession,
    id: u64,
    event: Value,
) {
    let events = {
        let mut map = sockets.lock().await;
        let Some(socket) = map.get_mut(&id) else {
            return;
        };
        if socket.queue.len() >= MAX_QUEUE {
            return;
        }
        socket.queue.push_back(event);
        if socket.pending_poll {
            socket.pending_poll = false;
            socket.queue.drain(..).collect::<Vec<_>>()
        } else {
            return;
        }
    };
    let _ = deliver(cdp, page, id, events).await;
}

async fn resolve_open(
    cdp: &CdpClient,
    page: &PageSession,
    id: u64,
    ok: bool,
    error: Option<&str>,
) -> Result<()> {
    let error = match error {
        Some(error) => serde_json::to_string(error)?,
        None => "null".to_string(),
    };
    let expression = format!("window.__obscuraWsResolveOpen({id}, {ok}, {error})");
    page.evaluate(cdp, &expression).await.map(|_| ())
}

async fn deliver(cdp: &CdpClient, page: &PageSession, id: u64, events: Vec<Value>) -> Result<()> {
    let events = serde_json::to_string(&events)?;
    let literal = serde_json::to_string(&events)?;
    let expression = format!("window.__obscuraWsDeliver({id}, {literal})");
    page.evaluate(cdp, &expression).await.map(|_| ())
}

fn build_request(
    url: &str,
    protocols: &[String],
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut request = url
        .into_client_request()
        .with_context(|| format!("invalid WebSocket URL: {url}"))?;
    request.headers_mut().insert(
        "Origin",
        HeaderValue::from_static("https://web.whatsapp.com"),
    );
    request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static(crate::cdp::DEFAULT_USER_AGENT),
    );
    if !protocols.is_empty() {
        let value = HeaderValue::from_str(&protocols.join(", "))?;
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", value);
    }
    Ok(request)
}
