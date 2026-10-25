use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use base64::Engine;
use obsurawa::session::{PageState, SessionConfig, WhatsAppSession};
use serde_json::Value;

use crate::backend::Backend;
use crate::types::{Chat, Contact, Message, State};

pub struct ObscuraBackend {
    config: SessionConfig,
    session: Option<WhatsAppSession>,
}

impl ObscuraBackend {
    pub fn new(config: SessionConfig) -> Self {
        Self {
            config,
            session: None,
        }
    }

    fn session(&self) -> Result<&WhatsAppSession> {
        self.session
            .as_ref()
            .context("Obscura backend is not initialized")
    }

    fn map_state(state: &PageState) -> State {
        if state.has_qr {
            State::Qr
        } else if state.ready {
            State::Ready
        } else if state.authenticated {
            State::Authenticated
        } else {
            State::Unknown
        }
    }
}

#[async_trait]
impl Backend for ObscuraBackend {
    async fn initialize(&mut self) -> Result<()> {
        if self.session.is_some() {
            return Ok(());
        }

        let session = WhatsAppSession::launch(self.config.clone()).await?;
        let _ = session.wait_for_qr_or_auth(Duration::from_secs(90)).await?;

        for _ in 0..15 {
            let _ = session.install_full_bridge().await;
            let status = session
                .state()
                .await
                .ok()
                .and_then(|state| state.bridge_status);
            if status.as_deref() == Some("full") {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        self.session = Some(session);
        Ok(())
    }

    async fn state(&self) -> State {
        match self.session.as_ref() {
            Some(session) => session
                .state()
                .await
                .map(|state| Self::map_state(&state))
                .unwrap_or(State::Disconnected),
            None => State::Unknown,
        }
    }

    async fn qr(&self) -> Option<String> {
        let session = self.session.as_ref()?;
        let state = session.state().await.ok()?;
        if !state.has_qr {
            return None;
        }
        let png = session.qr_png().await.ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ))
    }

    async fn chats(&self) -> Result<Vec<Chat>> {
        let value = self.session()?.chats().await?;
        serde_json::from_value(value).context("decode chat list")
    }

    async fn messages(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>> {
        let value = self.session()?.messages(chat_id, limit).await?;
        serde_json::from_value(value).context("decode message list")
    }

    async fn send_text(&mut self, chat_id: &str, text: &str) -> Result<Message> {
        let value = self.session()?.send_text(chat_id, text).await?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        Ok(Message {
            id,
            chat_id: chat_id.to_string(),
            from: "me".to_string(),
            to: chat_id.to_string(),
            body: text.to_string(),
            timestamp,
            from_me: true,
            ack: 1,
            has_media: false,
        })
    }

    async fn contacts(&self) -> Result<Vec<Contact>> {
        let value = self.session()?.contacts().await?;
        serde_json::from_value(value).context("decode contact list")
    }

    async fn logout(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            session.shutdown().await?;
        }
        Ok(())
    }

    async fn destroy(&mut self) -> Result<()> {
        self.logout().await
    }
}
