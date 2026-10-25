use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use obsurawa::bridge::{WsBridge, WS_ADAPTER};
use obsurawa::cdp::{CdpClient, PageSession, DEFAULT_USER_AGENT};
use obsurawa::process::{wait_for_cdp, ObscuraConfig, ObscuraProcess};
use obsurawa::{WA_BRIDGE, WORKER_POLYFILL, WS_SHIM};
use serde_json::Value;
use tokio::time::{sleep, Instant};
use tracing_subscriber::EnvFilter;

const STATE_EXPR: &str = r#"(() => {
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
    handler: (() => {
      try { return typeof window.require('WAWebSetFrontendHandlerApi') === 'object'; }
      catch (e) { return false; }
    })(),
    chunk: window.__waHandlerChunkStatus || null,
    bindings: {
      open: typeof window.__obscuraWsOpenBinding,
      poll: typeof window.__obscuraWsPollBinding,
      send: typeof window.__obscuraWsSendBinding,
      close: typeof window.__obscuraWsCloseBinding,
    },
    namespaces: (window.__waBridge && window.__waBridge.getHandledNamespaces)
      ? window.__waBridge.getHandledNamespaces()
      : null,
    ws: window.__obscuraWsShim
      ? {
          created: window.__obscuraWsShim.created.length,
          sent: window.__obscuraWsShim.sent,
          received: window.__obscuraWsShim.received,
          errors: window.__obscuraWsShim.errors.slice(0, 4),
          closes: window.__obscuraWsShim.closes.slice(0, 4),
          frames: window.__obscuraWsShim.frames.slice(0, 3),
        }
      : null,
    text: text.slice(0, 220),
  };
})()"#;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let storage =
        std::env::var("OBSCURA_STORAGE").unwrap_or_else(|_| "/tmp/obsurawa-whatsapp".to_string());
    let chunk_file = std::env::var("HANDLER_CHUNK_FILE")
        .unwrap_or_else(|_| "results/handler-chunk.js".to_string());
    let chunk = tokio::fs::read_to_string(&chunk_file).await.ok();
    if chunk.is_none() {
        tracing::warn!("handler chunk {chunk_file} not found; the QR canvas may not render");
    }

    let mut engine = ObscuraProcess::start(ObscuraConfig::new(storage).await?).await?;
    wait_for_cdp(engine.port, Duration::from_secs(10)).await?;

    let client = Arc::new(CdpClient::connect(engine.port).await?);
    let page = PageSession::create(&client).await?;
    page.set_user_agent(&client, DEFAULT_USER_AGENT).await?;
    page.set_viewport(&client, 900, 700).await?;

    // Bindings must exist before navigation; the adapter and shim are preludes.
    let _bridge = WsBridge::install(client.clone(), page.clone()).await?;
    page.add_script(&client, WS_ADAPTER).await?;
    page.add_script(&client, WS_SHIM).await?;
    page.add_script(&client, WORKER_POLYFILL).await?;
    if let Some(chunk) = &chunk {
        let source = format!(
            "window.__waHandlerChunkSource = {};",
            serde_json::to_string(chunk)?
        );
        page.add_script(&client, &source).await?;
    }
    page.add_script(&client, WA_BRIDGE).await?;
    page.navigate(&client, "https://web.whatsapp.com/").await?;

    let wait_ms = std::env::var("WAIT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(45_000);
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let mut state = Value::Null;
    let mut last_log = Instant::now();
    while Instant::now() < deadline {
        state = page
            .evaluate(&client, STATE_EXPR)
            .await
            .unwrap_or(Value::Null);
        if last_log.elapsed() > Duration::from_secs(5) {
            tracing::info!(target: "obsurawa::whatsapp", "state {}", state);
            last_log = Instant::now();
        }
        if state.get("hasQr").and_then(Value::as_bool) == Some(true) {
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }

    let full = page
        .evaluate(
            &client,
            "window.__waInstallFullBridge ? window.__waInstallFullBridge() : 'missing'",
        )
        .await
        .unwrap_or(Value::Null);
    tracing::info!(target: "obsurawa::whatsapp", "full bridge: {full}");
    state = page.evaluate(&client, STATE_EXPR).await.unwrap_or(state);

    println!("{}", serde_json::to_string_pretty(&state)?);
    let png = page.screenshot(&client).await.context("screenshot")?;
    tokio::fs::write("/tmp/obsurawa-rust-qr.png", png).await?;

    page.collect_garbage(&client).await.ok();
    engine.stop().await?;
    Ok(())
}
