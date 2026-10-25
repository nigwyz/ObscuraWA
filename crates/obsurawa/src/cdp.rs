//! Minimal CDP client over the engine's root WebSocket.
//!
//! Obscura serves one flattened CDP session per page target. Commands carry a
//! top-level `sessionId`; responses carry the matching `id`; events carry
//! `method` and optionally `sessionId`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CdpError {
    #[error("CDP protocol error: {0}")]
    Protocol(String),
    #[error("CDP connection closed")]
    Closed,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>>;

pub struct CdpClient {
    tx: mpsc::UnboundedSender<Message>,
    pending: Pending,
    events: broadcast::Sender<CdpEvent>,
    next_id: AtomicU64,
}

impl CdpClient {
    pub async fn connect(port: u16) -> Result<Self> {
        let url = format!("ws://127.0.0.1:{port}");
        let (ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .context("connect to Obscura CDP")?;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(1024);

        let pending_task = pending.clone();
        let events_task = events.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    outgoing = rx.recv() => {
                        match outgoing {
                            Some(message) => {
                                if sink.send(message).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    incoming = stream.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => {
                                handle_message(&text, &pending_task, &events_task).await;
                            }
                            Some(Ok(Message::Binary(bytes))) => {
                                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                                    handle_message(&text, &pending_task, &events_task).await;
                                }
                            }
                            Some(Ok(Message::Ping(payload))) => {
                                let _ = sink.send(Message::Pong(payload)).await;
                            }
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(error)) => {
                                tracing::debug!(target: "obsurawa::cdp", "socket error: {error}");
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }

            let mut map = pending_task.lock().await;
            for (_, waiter) in map.drain() {
                let _ = waiter.send(Err(CdpError::Closed));
            }
        });

        Ok(Self {
            tx,
            pending,
            events,
            next_id: AtomicU64::new(1),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, CdpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (waiter, response) = oneshot::channel();
        self.pending.lock().await.insert(id, waiter);

        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }
        let text = message.to_string();
        if self.tx.send(Message::Text(text.into())).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(CdpError::Closed);
        }

        response.await.map_err(|_| CdpError::Closed)?
    }
}

async fn handle_message(text: &str, pending: &Pending, events: &broadcast::Sender<CdpEvent>) {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => {
            tracing::debug!(target: "obsurawa::cdp", "invalid message: {error}");
            return;
        }
    };

    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let waiter = pending.lock().await.remove(&id);
        if let Some(waiter) = waiter {
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown CDP error");
                let _ = waiter.send(Err(CdpError::Protocol(message.to_string())));
            } else {
                let _ = waiter.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
        return;
    }

    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let _ = events.send(CdpEvent {
            method: method.to_string(),
            params: value.get("params").cloned().unwrap_or(Value::Null),
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
}

#[derive(Debug, Clone)]
pub struct PageSession {
    pub target_id: String,
    pub session_id: String,
}

pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

impl PageSession {
    pub async fn create(client: &CdpClient) -> Result<Self> {
        let target = client
            .send("Target.createTarget", json!({ "url": "about:blank" }), None)
            .await
            .context("Target.createTarget")?;
        let target_id = target
            .get("targetId")
            .and_then(Value::as_str)
            .context("Target.createTarget returned no targetId")?
            .to_string();

        let attached = client
            .send(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await
            .context("Target.attachToTarget")?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .context("Target.attachToTarget returned no sessionId")?
            .to_string();

        client
            .send("Page.enable", json!({}), Some(&session_id))
            .await
            .context("Page.enable")?;
        client
            .send("Runtime.enable", json!({}), Some(&session_id))
            .await
            .context("Runtime.enable")?;

        Ok(Self {
            target_id,
            session_id,
        })
    }

    pub async fn set_user_agent(&self, client: &CdpClient, user_agent: &str) -> Result<()> {
        client
            .send(
                "Emulation.setUserAgentOverride",
                json!({
                    "userAgent": user_agent,
                    "acceptLanguage": "en-US,en",
                    "platform": "Linux",
                }),
                Some(&self.session_id),
            )
            .await
            .context("Emulation.setUserAgentOverride")?;
        Ok(())
    }

    pub async fn set_viewport(&self, client: &CdpClient, width: u32, height: u32) -> Result<()> {
        client
            .send(
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": 1,
                    "mobile": false,
                }),
                Some(&self.session_id),
            )
            .await
            .context("Emulation.setDeviceMetricsOverride")?;
        Ok(())
    }

    pub async fn add_script(&self, client: &CdpClient, source: &str) -> Result<()> {
        client
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": source }),
                Some(&self.session_id),
            )
            .await
            .context("Page.addScriptToEvaluateOnNewDocument")?;
        Ok(())
    }

    pub async fn navigate(&self, client: &CdpClient, url: &str) -> Result<()> {
        client
            .send(
                "Page.navigate",
                json!({ "url": url }),
                Some(&self.session_id),
            )
            .await
            .context("Page.navigate")?;
        Ok(())
    }

    pub async fn evaluate(&self, client: &CdpClient, expression: &str) -> Result<Value> {
        let result = client
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "awaitPromise": true,
                    "returnByValue": true,
                }),
                Some(&self.session_id),
            )
            .await
            .context("Runtime.evaluate")?;

        if let Some(details) = result.get("exceptionDetails") {
            let description = details
                .get("exception")
                .and_then(|value| value.get("description"))
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("evaluation failed");
            bail!("{description}");
        }

        Ok(result
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn screenshot(&self, client: &CdpClient) -> Result<Vec<u8>> {
        let result = client
            .send(
                "Page.captureScreenshot",
                json!({ "format": "png" }),
                Some(&self.session_id),
            )
            .await
            .context("Page.captureScreenshot")?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .context("Page.captureScreenshot returned no data")?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .context("decode screenshot")
    }

    pub async fn screenshot_clip(
        &self,
        client: &CdpClient,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<Vec<u8>> {
        let result = client
            .send(
                "Page.captureScreenshot",
                json!({
                    "format": "png",
                    "clip": { "x": x, "y": y, "width": width, "height": height, "scale": 1 },
                }),
                Some(&self.session_id),
            )
            .await
            .context("Page.captureScreenshot (clip)")?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .context("Page.captureScreenshot returned no data")?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .context("decode screenshot")
    }

    pub async fn collect_garbage(&self, client: &CdpClient) -> Result<()> {
        client
            .send(
                "HeapProfiler.collectGarbage",
                json!({}),
                Some(&self.session_id),
            )
            .await
            .context("HeapProfiler.collectGarbage")?;
        Ok(())
    }
}
