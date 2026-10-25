//! Local preview server for the Rust Obscura session.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use obsurawa::bridge::{WsBridge, WS_ADAPTER};
use obsurawa::cdp::{CdpClient, PageSession, DEFAULT_USER_AGENT};
use obsurawa::process::{wait_for_cdp, ObscuraConfig, ObscuraProcess};
use obsurawa::{WA_BRIDGE, WORKER_POLYFILL, WS_SHIM};
use serde_json::{json, Value};
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
    text: text.slice(0, 300),
  };
})()"#;

const BOX_EXPR: &str = r#"(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()"#;

const INDEX_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ObscuraWA</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b141a; color: #e9edef;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(92vw, 560px); padding: 28px; text-align: center; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; }
  .sub { margin: 0 0 20px; color: #8696a0; font-size: 13px; }
  #status { margin: 0 0 16px; color: #00a884; font-weight: 600; min-height: 22px; }
  #qr { display: none; width: min(78vw, 340px); image-rendering: pixelated;
    border-radius: 12px; background: #fff; padding: 10px; }
  #details { margin-top: 18px; color: #8696a0; font-size: 12px; white-space: pre-wrap; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #00a884; margin-right: 7px; vertical-align: 1px; }
</style>
</head>
<body>
<main>
  <h1>ObscuraWA</h1>
  <p class="sub">Real WhatsApp Web in Obscura — no Chromium</p>
  <p id="status"><span class="dot"></span>starting…</p>
  <img id="qr" alt="WhatsApp QR code">
  <div id="details"></div>
</main>
<script>
  const statusEl = document.getElementById('status');
  const qrEl = document.getElementById('qr');
  const detailsEl = document.getElementById('details');
  let lastQr = 0;

  async function tick() {
    let state = null;
    try { state = await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()); }
    catch (e) { statusEl.textContent = 'engine unavailable'; return; }

    if (state.error) {
      statusEl.textContent = 'error: ' + state.error;
      return;
    }

    if (state.hasQr) {
      statusEl.textContent = 'Scan the QR with your phone';
      qrEl.style.display = 'block';
      if (Date.now() - lastQr > 2000) {
        lastQr = Date.now();
        qrEl.src = '/api/qr?t=' + lastQr;
      }
    } else {
      qrEl.style.display = 'none';
      statusEl.textContent = state.authenticated ? 'Authenticating…' : 'Waiting for WhatsApp Web';
    }

    detailsEl.textContent = [
      'bridge: ' + (state.bridgeStatus || 'unknown'),
      'authenticated: ' + state.authenticated,
      'ready: ' + state.ready,
      (state.text || '').split('\n').slice(0, 3).join(' '),
    ].join('\n');
  }

  tick();
  setInterval(tick, 1500);
</script>
</body>
</html>"#;

#[derive(Clone)]
struct AppState {
    cdp: Arc<CdpClient>,
    page: PageSession,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let port = std::env::var("PREVIEW_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let storage =
        std::env::var("OBSCURA_STORAGE").unwrap_or_else(|_| "results/obsurawa-preview".to_string());
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

    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let state = page
            .evaluate(&client, STATE_EXPR)
            .await
            .unwrap_or(Value::Null);
        if state.get("hasQr").and_then(Value::as_bool) == Some(true)
            || state.get("authenticated").and_then(Value::as_bool) == Some(true)
        {
            tracing::info!(target: "obsurawa::preview", "page state: {state}");
            break;
        }
        if Instant::now() >= deadline {
            tracing::warn!("no QR after 90s; serving the status page anyway");
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }

    for attempt in 0..15 {
        let full = page
            .evaluate(
                &client,
                "window.__waInstallFullBridge ? window.__waInstallFullBridge() : 'missing'",
            )
            .await
            .unwrap_or(Value::Null);
        let status = page
            .evaluate(&client, "window.__waBridgeStatus || null")
            .await
            .unwrap_or(Value::Null);
        tracing::info!(
            target: "obsurawa::preview",
            "full bridge attempt {attempt}: {full} ({status})"
        );
        if status.as_str() == Some("full") {
            break;
        }
        sleep(Duration::from_millis(1000)).await;
    }

    let app_state = AppState { cdp: client, page };
    let app = Router::new()
        .route("/", get(index))
        .route("/api/state", get(api_state))
        .route("/api/qr", get(api_qr))
        .with_state(app_state.clone());

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    tracing::info!("preview: http://127.0.0.1:{port}/");
    let result = axum::serve(listener, app).await;

    let _ = app_state.page.collect_garbage(&app_state.cdp).await;
    let _ = engine.stop().await;
    result.context("preview server")
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn api_state(State(state): State<AppState>) -> Json<Value> {
    match state.page.evaluate(&state.cdp, STATE_EXPR).await {
        Ok(value) => Json(value),
        Err(error) => Json(json!({ "error": error.to_string() })),
    }
}

async fn api_qr(State(state): State<AppState>) -> Response {
    let bounds = state
        .page
        .evaluate(&state.cdp, BOX_EXPR)
        .await
        .unwrap_or(Value::Null);

    let png = match (
        bounds.get("x").and_then(Value::as_f64),
        bounds.get("y").and_then(Value::as_f64),
        bounds.get("width").and_then(Value::as_f64),
        bounds.get("height").and_then(Value::as_f64),
    ) {
        (Some(x), Some(y), Some(width), Some(height)) if width > 10.0 && height > 10.0 => {
            state
                .page
                .screenshot_clip(&state.cdp, x, y, width, height)
                .await
        }
        _ => state.page.screenshot(&state.cdp).await,
    };

    match png {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => {
            tracing::debug!("qr screenshot failed: {error}");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
