//! Obscura process lifecycle: one `obscura serve` per session storage dir.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout, Instant};

pub const DEFAULT_OBSCURA_BIN: &str = "/home/hp/.local/share/obscurawa/bin/obscura";

#[derive(Debug, Clone)]
pub struct ObscuraConfig {
    pub binary: PathBuf,
    pub storage_dir: PathBuf,
    pub ready_file: PathBuf,
    pub port: u16,
    pub startup_timeout: Duration,
}

impl ObscuraConfig {
    /// Build a config for `storage_dir`, choosing a free loopback port.
    pub async fn new(storage_dir: impl Into<PathBuf>) -> Result<Self> {
        let storage_dir = storage_dir.into();
        let binary = std::env::var_os("OBSCURA_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_OBSCURA_BIN));
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let ready_file = storage_dir.join(format!(".ready-{}-{stamp}", std::process::id()));
        Ok(Self {
            binary,
            storage_dir,
            ready_file,
            port: free_port().await?,
            startup_timeout: Duration::from_secs(60),
        })
    }

    pub fn with_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.binary = binary.into();
        self
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

/// A running `obscura serve` process.
pub struct ObscuraProcess {
    child: Child,
    pub port: u16,
    pub storage_dir: PathBuf,
    pub ready_file: PathBuf,
}

impl ObscuraProcess {
    pub async fn start(config: ObscuraConfig) -> Result<Self> {
        tokio::fs::create_dir_all(&config.storage_dir)
            .await
            .with_context(|| format!("create storage dir {}", config.storage_dir.display()))?;
        let _ = tokio::fs::remove_file(&config.ready_file).await;

        let mut child = Command::new(&config.binary)
            .arg("serve")
            .arg("--port")
            .arg(config.port.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--storage-dir")
            .arg(&config.storage_dir)
            .arg("--ready-file")
            .arg(&config.ready_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn {}", config.binary.display()))?;

        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(drain(stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain(stderr));
        }

        let deadline = Instant::now() + config.startup_timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                bail!("obscura exited during startup: {status}");
            }
            if tokio::fs::metadata(&config.ready_file).await.is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.start_kill();
                bail!(
                    "obscura did not become ready within {:?} (port {})",
                    config.startup_timeout,
                    config.port
                );
            }
            sleep(Duration::from_millis(150)).await;
        }
        let _ = tokio::fs::remove_file(&config.ready_file).await;

        Ok(Self {
            child,
            port: config.port,
            storage_dir: config.storage_dir,
            ready_file: config.ready_file,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn cdp_url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }

    pub async fn stop(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_some() {
            return Ok(());
        }
        if let Some(pid) = self.child.id() {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()
                .await;
        }
        match timeout(Duration::from_secs(10), self.child.wait()).await {
            Ok(status) => {
                status?;
            }
            Err(_) => {
                self.child.start_kill().ok();
                let _ = self.child.wait().await;
            }
        }
        Ok(())
    }
}

impl Drop for ObscuraProcess {
    fn drop(&mut self) {
        // `kill_on_drop(true)` handles the abnormal path; an explicit stop is
        // still preferred so the engine can flush its storage.
        let _ = self.child.start_kill();
    }
}

pub async fn free_port() -> Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

async fn drain<R>(reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::trace!(target: "obscura", "{line}");
    }
}

/// Wait until the engine's CDP endpoint accepts a TCP connection.
pub async fn wait_for_cdp(port: u16, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("CDP endpoint 127.0.0.1:{port} did not open");
        }
        sleep(Duration::from_millis(100)).await;
    }
}

pub fn default_storage_dir(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join("obsurawa-session")
}
