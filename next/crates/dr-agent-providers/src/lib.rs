//! M28: four routes and local servers over one HTTP client, SSE reader and
//! four wire protocols.
mod anthropic;
pub mod catalog;
mod chat;
mod conversation;
pub mod credentials;
mod deepseek;
mod error;
mod images;
#[cfg(test)]
mod internet_tests;
pub mod local;
pub mod oauth;
mod responses;
mod sse;
mod transport;

pub use error::{ProviderError, Result};
pub use sse::{SseEvent, SseParser};
pub use transport::{Endpoints, HttpClient, ProviderDriver, RetryPolicy};
