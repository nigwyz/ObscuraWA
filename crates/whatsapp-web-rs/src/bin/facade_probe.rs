use anyhow::Result;
use base64::Engine;
use whatsapp_web_rs::Client;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let storage = std::env::var("OBSCURA_STORAGE")
        .unwrap_or_else(|_| "results/facade-probe".to_string());
    let mut client = Client::obscura(storage);
    client.initialize().await?;

    let state = client.state().await;
    let qr = client.qr().await;
    let qr_bytes = qr
        .as_deref()
        .and_then(|url| url.strip_prefix("data:image/png;base64,"))
        .and_then(|payload| base64::engine::general_purpose::STANDARD.decode(payload).ok())
        .map(|bytes| bytes.len());

    println!(
        "{}",
        serde_json::json!({
            "state": state,
            "qr": qr.is_some(),
            "qrBytes": qr_bytes,
        })
    );

    client.destroy().await?;
    Ok(())
}
