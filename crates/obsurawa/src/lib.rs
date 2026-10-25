//! Rust controller for running WhatsApp Web inside Obscura.

pub mod bridge;
pub mod cdp;
pub mod process;

/// Page preludes shared with the feasibility spike.
pub const WS_SHIM: &str = include_str!("../../../spike/lib/ws-shim.js");
pub const WORKER_POLYFILL: &str = include_str!("../../../spike/lib/worker-polyfill.js");
pub const WA_BRIDGE: &str = include_str!("../../../spike/lib/wa-bridge.js");
