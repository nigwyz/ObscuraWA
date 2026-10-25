//! `whatsapp-web.rs` facade: one API over an Obscura-backed WhatsApp session.

pub mod backend;
pub mod obscura;
pub mod types;

use std::path::PathBuf;

use anyhow::Result;
use obsurawa::session::SessionConfig;
use tokio::sync::broadcast;

use crate::backend::Backend;
use crate::obscura::ObscuraBackend;
pub use crate::types::{Chat, Contact, Event, Message, State};

pub struct Client {
    backend: Box<dyn Backend>,
    events: broadcast::Sender<Event>,
}

impl Client {
    pub fn new(backend: impl Backend + 'static) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            backend: Box::new(backend),
            events,
        }
    }

    pub fn obscura(storage: impl Into<PathBuf>) -> Self {
        Self::new(ObscuraBackend::new(SessionConfig::new(storage)))
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub async fn initialize(&mut self) -> Result<()> {
        self.backend.initialize().await?;
        let state = self.backend.state().await;
        let _ = self.events.send(Event::StateChanged(state));
        Ok(())
    }

    pub async fn state(&self) -> State {
        self.backend.state().await
    }

    pub async fn qr(&self) -> Option<String> {
        self.backend.qr().await
    }

    pub async fn chats(&self) -> Result<Vec<Chat>> {
        self.backend.chats().await
    }

    pub async fn messages(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>> {
        self.backend.messages(chat_id, limit).await
    }

    pub async fn send_text(&mut self, chat_id: &str, text: &str) -> Result<Message> {
        self.backend.send_text(chat_id, text).await
    }

    pub async fn contacts(&self) -> Result<Vec<Contact>> {
        self.backend.contacts().await
    }

    pub async fn logout(&mut self) -> Result<()> {
        self.backend.logout().await
    }

    pub async fn destroy(&mut self) -> Result<()> {
        self.backend.destroy().await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Obscura,
}

pub struct ClientBuilder {
    kind: BackendKind,
    storage: PathBuf,
}

impl ClientBuilder {
    pub fn new(kind: BackendKind, storage: impl Into<PathBuf>) -> Self {
        Self {
            kind,
            storage: storage.into(),
        }
    }

    pub async fn build(self) -> Result<Client> {
        match self.kind {
            BackendKind::Obscura => Ok(Client::new(ObscuraBackend::new(SessionConfig::new(
                self.storage,
            )))),
        }
    }
}
