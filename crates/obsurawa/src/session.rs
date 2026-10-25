//! One live WhatsApp Web page: engine, CDP page, and WebSocket bridge.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};

use crate::bridge::{WsBridge, WS_ADAPTER};
use crate::cdp::{CdpClient, PageSession, DEFAULT_USER_AGENT};
use crate::process::{wait_for_cdp, ObscuraConfig, ObscuraProcess};
use crate::{WA_API, WA_BRIDGE, WORKER_POLYFILL, WS_SHIM};

pub const STATE_EXPR: &str = r#"(() => {
  const qr = document.querySelector('div[data-testid="qrcode"]') || document.querySelector('canvas');
  const rect = qr ? qr.getBoundingClientRect() : null;
  const text = document.body?.innerText || '';
  const hasQr = !!(rect && rect.width > 10 && rect.height > 10);
  const scan = text.includes('Scan to log in');
  const chatList = !!document.querySelector('#side, #pane-side, [data-testid="chat-list"], div[aria-label="Chat list"]');
  return {
    hasQr,
    authenticated: !hasQr && !scan && (chatList || text.includes('Loading your chats')),
    ready: chatList,
    bridgeStatus: window.__waBridgeStatus || null,
    bridgeErrors: (window.__waBridgeErrors || []).slice(0, 4),
    text: text.slice(0, 300),
  };
})()"#;

pub const BOX_EXPR: &str = r#"(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()"#;

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub storage_dir: PathBuf,
    pub handler_chunk: Option<PathBuf>,
    pub width: u32,
    pub height: u32,
    pub user_agent: String,
}

impl SessionConfig {
    pub fn new(storage_dir: impl Into<PathBuf>) -> Self {
        let handler_chunk = std::env::var_os("HANDLER_CHUNK_FILE")
            .map(PathBuf::from)
            .or_else(|| {
                let default = PathBuf::from("results/handler-chunk.js");
                default.exists().then_some(default)
            });
        Self {
            storage_dir: storage_dir.into(),
            handler_chunk,
            width: 900,
            height: 700,
            user_agent: DEFAULT_USER_AGENT.to_string(),
        }
    }

    pub fn with_handler_chunk(mut self, path: impl Into<PathBuf>) -> Self {
        self.handler_chunk = Some(path.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
    pub has_qr: bool,
    pub authenticated: bool,
    pub ready: bool,
    pub bridge_status: Option<String>,
    pub bridge_errors: Vec<String>,
    pub text: String,
}

struct SessionInner {
    engine: Mutex<ObscuraProcess>,
    cdp: Arc<CdpClient>,
    page: PageSession,
    bridge: WsBridge,
}

#[derive(Clone)]
pub struct WhatsAppSession {
    inner: Arc<SessionInner>,
}

impl WhatsAppSession {
    pub async fn launch(config: SessionConfig) -> Result<Self> {
        let engine = ObscuraProcess::start(ObscuraConfig::new(&config.storage_dir).await?).await?;
        wait_for_cdp(engine.port, Duration::from_secs(10)).await?;

        let cdp = Arc::new(CdpClient::connect(engine.port).await?);
        let page = PageSession::create(&cdp).await?;
        page.set_user_agent(&cdp, &config.user_agent).await?;
        page.set_viewport(&cdp, config.width, config.height).await?;

        let bridge = WsBridge::install(cdp.clone(), page.clone()).await?;
        page.add_script(&cdp, WS_ADAPTER).await?;
        page.add_script(&cdp, WS_SHIM).await?;
        page.add_script(&cdp, WORKER_POLYFILL).await?;
        if let Some(path) = &config.handler_chunk {
            match tokio::fs::read_to_string(path).await {
                Ok(chunk) => {
                    let source = format!(
                        "window.__waHandlerChunkSource = {};",
                        serde_json::to_string(&chunk)?
                    );
                    page.add_script(&cdp, &source).await?;
                }
                Err(error) => {
                    tracing::warn!("handler chunk {} not readable: {error}", path.display());
                }
            }
        } else {
            tracing::warn!("no handler chunk configured; the QR canvas may not render");
        }
        page.add_script(&cdp, WA_BRIDGE).await?;
        page.add_script(&cdp, WA_API).await?;
        page.navigate(&cdp, "https://web.whatsapp.com/").await?;

        Ok(Self {
            inner: Arc::new(SessionInner {
                engine: Mutex::new(engine),
                cdp,
                page,
                bridge,
            }),
        })
    }

    pub async fn state(&self) -> Result<PageState> {
        let value = self
            .inner
            .page
            .evaluate(&self.inner.cdp, STATE_EXPR)
            .await?;
        Ok(PageState {
            has_qr: value.get("hasQr").and_then(Value::as_bool).unwrap_or(false),
            authenticated: value
                .get("authenticated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            ready: value.get("ready").and_then(Value::as_bool).unwrap_or(false),
            bridge_status: value
                .get("bridgeStatus")
                .and_then(Value::as_str)
                .map(str::to_string),
            bridge_errors: value
                .get("bridgeErrors")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            text: value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        self.inner.page.evaluate(&self.inner.cdp, expression).await
    }

    pub async fn qr_png(&self) -> Result<Vec<u8>> {
        let bounds = self.evaluate(BOX_EXPR).await.unwrap_or(Value::Null);
        match (
            bounds.get("x").and_then(Value::as_f64),
            bounds.get("y").and_then(Value::as_f64),
            bounds.get("width").and_then(Value::as_f64),
            bounds.get("height").and_then(Value::as_f64),
        ) {
            (Some(x), Some(y), Some(width), Some(height)) if width > 10.0 && height > 10.0 => {
                self.inner
                    .page
                    .screenshot_clip(&self.inner.cdp, x, y, width, height)
                    .await
            }
            _ => self.inner.page.screenshot(&self.inner.cdp).await,
        }
    }

    pub async fn install_full_bridge(&self) -> Result<Value> {
        self.evaluate("window.__waInstallFullBridge ? window.__waInstallFullBridge() : 'missing'")
            .await
    }

    /// Poll until a QR is visible or the session is authenticated.
    pub async fn wait_for_qr_or_auth(&self, timeout: Duration) -> Result<PageState> {
        let deadline = Instant::now() + timeout;
        loop {
            let state = self.state().await?;
            if state.has_qr || state.authenticated {
                return Ok(state);
            }
            if Instant::now() >= deadline {
                return Ok(state);
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn wait_for_ready(&self, timeout: Duration) -> Result<PageState> {
        let deadline = Instant::now() + timeout;
        loop {
            let state = self.state().await?;
            if state.ready {
                return Ok(state);
            }
            if Instant::now() >= deadline {
                return Ok(state);
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn shutdown(&self) -> Result<()> {
        let mut engine = self.inner.engine.lock().await;
        engine.stop().await
    }

    pub fn page(&self) -> &PageSession {
        &self.inner.page
    }

    pub fn cdp(&self) -> &Arc<CdpClient> {
        &self.inner.cdp
    }

    pub fn bridge(&self) -> &WsBridge {
        &self.inner.bridge
    }

    pub async fn debug_state(&self) -> Result<Value> {
        self.evaluate(STATE_EXPR).await
    }

    pub async fn send_text(&self, chat_id: &str, text: &str) -> Result<Value> {
        let expression = format!(
            "window.__waSendText({}, {})",
            serde_json::to_string(chat_id)?,
            serde_json::to_string(text)?
        );
        self.evaluate(&expression).await
    }

    pub async fn chats(&self) -> Result<Value> {
        self.evaluate("window.__waChats ? window.__waChats() : []")
            .await
    }

    pub async fn messages(&self, chat_id: &str, limit: usize) -> Result<Value> {
        let expression = format!(
            "window.__waMessages ? window.__waMessages({}, {}) : []",
            serde_json::to_string(chat_id)?,
            limit
        );
        self.evaluate(&expression).await
    }

    pub async fn contacts(&self) -> Result<Value> {
        self.evaluate("window.__waContacts ? window.__waContacts() : []")
            .await
    }

    pub async fn collect_garbage(&self) -> Result<()> {
        self.inner.page.collect_garbage(&self.inner.cdp).await
    }
}
