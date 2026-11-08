//! M28: four routes over one HTTP client, SSE reader and three wire protocols.
mod anthropic;
pub mod catalog;
pub mod credentials;
mod deepseek;
mod error;
pub mod oauth;
mod responses;
mod sse;
mod transport;

pub use error::{ProviderError, Result};
pub use sse::{SseEvent, SseParser};
pub use transport::{Endpoints, HttpClient, ProviderDriver, RetryPolicy};
