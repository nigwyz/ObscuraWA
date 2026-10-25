use anyhow::Result;
use async_trait::async_trait;

use crate::types::{Chat, Contact, Message, State};

#[async_trait]
pub trait Backend: Send + Sync {
    async fn initialize(&mut self) -> Result<()>;
    async fn state(&self) -> State;
    async fn qr(&self) -> Option<String>;
    async fn chats(&self) -> Result<Vec<Chat>>;
    async fn messages(&self, chat_id: &str, limit: usize) -> Result<Vec<Message>>;
    async fn send_text(&mut self, chat_id: &str, text: &str) -> Result<Message>;
    async fn contacts(&self) -> Result<Vec<Contact>>;
    async fn logout(&mut self) -> Result<()>;
    async fn destroy(&mut self) -> Result<()>;
}
