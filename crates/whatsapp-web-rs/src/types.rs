//! Public facade types, mirroring the core of whatsapp-web.js.

use serde::{Deserialize, Deserializer, Serialize};

fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Unknown,
    Qr,
    Authenticated,
    Ready,
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    #[serde(default, deserialize_with = "null_to_default")]
    pub id: String,
    #[serde(default, rename = "chatId", deserialize_with = "null_to_default")]
    pub chat_id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub from: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub to: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub body: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub timestamp: i64,
    #[serde(default, rename = "fromMe", deserialize_with = "null_to_default")]
    pub from_me: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    pub ack: u8,
    #[serde(default, rename = "hasMedia", deserialize_with = "null_to_default")]
    pub has_media: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Chat {
    #[serde(default, deserialize_with = "null_to_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub name: String,
    #[serde(default, rename = "isGroup", deserialize_with = "null_to_default")]
    pub is_group: bool,
    #[serde(default, rename = "unreadCount", deserialize_with = "null_to_default")]
    pub unread_count: u32,
    #[serde(default, deserialize_with = "null_to_default")]
    pub timestamp: i64,
    #[serde(default, rename = "lastMessage")]
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Contact {
    #[serde(default, deserialize_with = "null_to_default")]
    pub id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub name: String,
    #[serde(default)]
    pub pushname: Option<String>,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default, rename = "isBusiness", deserialize_with = "null_to_default")]
    pub is_business: bool,
}

#[derive(Debug, Clone)]
pub enum Event {
    Qr(String),
    Authenticated,
    Ready,
    Message(Message),
    MessageCreate(Message),
    Disconnected(String),
    StateChanged(State),
}
