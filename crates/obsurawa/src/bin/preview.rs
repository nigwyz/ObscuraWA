//! Local preview server for the Rust Obscura session.

use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use obsurawa::session::{SessionConfig, WhatsAppSession};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::sleep;
use tracing_subscriber::EnvFilter;

const INDEX_HTML: &str = include_str!("../preview.html");

#[derive(Clone)]
struct AppState {
    session: WhatsAppSession,
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SendRequest {
    chat_id: String,
    text: String,
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

    let session = WhatsAppSession::launch(SessionConfig::new(storage)).await?;
    let initial = session.wait_for_qr_or_auth(Duration::from_secs(90)).await?;
    tracing::info!(
        target: "obsurawa::preview",
        "page state: {}",
        serde_json::to_string(&initial)?
    );

    for attempt in 0..15 {
        let full = session.install_full_bridge().await.unwrap_or(Value::Null);
        let status = session
            .state()
            .await
            .ok()
            .and_then(|state| state.bridge_status);
        tracing::info!(
            target: "obsurawa::preview",
            "full bridge attempt {attempt}: {full} ({status:?})"
        );
        if status.as_deref() == Some("full") {
            break;
        }
        sleep(Duration::from_millis(1000)).await;
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/api/state", get(api_state))
        .route("/api/qr", get(api_qr))
        .route("/api/chats", get(api_chats))
        .route("/api/chats/{id}/messages", get(api_messages))
        .route("/api/send", post(api_send))
        .with_state(AppState {
            session: session.clone(),
        });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    tracing::info!(target: "obsurawa::preview", "preview: http://127.0.0.1:{port}/");
    let result = axum::serve(listener, app).await;

    let _ = session.collect_garbage().await;
    let _ = session.shutdown().await;
    result.context("preview server")
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn api_state(State(state): State<AppState>) -> Json<Value> {
    match state.session.state().await {
        Ok(value) => Json(serde_json::to_value(value).unwrap_or(Value::Null)),
        Err(error) => Json(json!({ "error": error.to_string() })),
    }
}

async fn api_qr(State(state): State<AppState>) -> Response {
    match state.session.qr_png().await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => {
            tracing::debug!(target: "obsurawa::preview", "qr screenshot failed: {error}");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn api_chats(State(state): State<AppState>) -> Json<Value> {
    match state.session.chats().await {
        Ok(value) => Json(value),
        Err(error) => Json(json!({ "error": error.to_string() })),
    }
}

async fn api_messages(
    State(state): State<AppState>,
    Path(chat_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(50).min(500);
    match state.session.messages(&chat_id, limit).await {
        Ok(value) => Json(value),
        Err(error) => Json(json!({ "error": error.to_string() })),
    }
}

async fn api_send(State(state): State<AppState>, Json(request): Json<SendRequest>) -> Json<Value> {
    match state
        .session
        .send_text(&request.chat_id, &request.text)
        .await
    {
        Ok(value) => Json(value),
        Err(error) => Json(json!({ "error": error.to_string() })),
    }
}
