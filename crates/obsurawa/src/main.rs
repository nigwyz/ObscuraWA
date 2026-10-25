use std::time::Duration;

use anyhow::{Context, Result};
use obsurawa::cdp::{CdpClient, PageSession};
use obsurawa::process::{wait_for_cdp, ObscuraConfig, ObscuraProcess};
use tokio::time::{sleep, Instant};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let storage =
        std::env::var("OBSCURA_STORAGE").unwrap_or_else(|_| "/tmp/obsurawa-probe".to_string());
    let mut engine = ObscuraProcess::start(ObscuraConfig::new(storage).await?).await?;
    wait_for_cdp(engine.port, Duration::from_secs(10)).await?;

    let client = CdpClient::connect(engine.port).await?;
    let page = PageSession::create(&client).await?;
    page.set_user_agent(&client, obsurawa::cdp::DEFAULT_USER_AGENT)
        .await?;
    page.set_viewport(&client, 900, 700).await?;
    page.navigate(&client, "https://example.com/").await?;

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let state = page
            .evaluate(&client, "document.readyState")
            .await
            .unwrap_or_default();
        if state == "complete" || state == "interactive" {
            break;
        }
        if Instant::now() >= deadline {
            anyhow::bail!("page did not load within 15s");
        }
        sleep(Duration::from_millis(200)).await;
    }

    let value = page
        .evaluate(
            &client,
            "({ title: document.title, url: location.href, ua: navigator.userAgent })",
        )
        .await
        .context("probe evaluate")?;
    println!("{value}");

    page.collect_garbage(&client).await.ok();
    engine.stop().await?;
    Ok(())
}
