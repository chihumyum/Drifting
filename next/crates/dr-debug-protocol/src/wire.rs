//! The messages, one JSON object per line.
//!
//! ```text
//! → {"hello": "drifting-debug-bridge/1", "token": "…"}
//! ← {"hello": "drifting-debug-bridge/1", "instance": "cc.drifting.next.dev.x", "pid": 4242, "version": "0.2.0-dev"}
//! → {"id": 1, "method": "state.get", "params": {}}
//! ← {"id": 1, "result": {…}}
//! → {"id": 2, "method": "nav.open", "params": {"target": "chapter:no-such"}}
//! ← {"id": 2, "error": {"code": "not_found", "message": "…"}}
//! ```
//!
//! A wrong token gets `{"error": {"code": "unauthorized", …}}` and the
//! connection closes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a method failed with: a stable code and a sentence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BridgeError {}

/// The error codes the transport and the bridge use. Methods add their own
/// (F3's command errors keep F3's codes).
pub mod codes {
    /// No connection file, or nothing listening at its address.
    pub const NOT_RUNNING: &str = "not_running";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    pub const IO: &str = "io";
    pub const TIMEOUT: &str = "timeout";
    pub const NOT_FOUND: &str = "not_found";
    /// The app has no workspace window (closed, or not open yet).
    pub const NO_WINDOW: &str = "no_window";
    /// The app runs without a library.
    pub const NO_LIBRARY: &str = "no_library";
    /// Typed text that nothing took: no text field has the focus.
    pub const NO_INPUT: &str = "no_input";
    /// This build cannot do it (a screenshot without the `screenshot`
    /// feature).
    pub const UNSUPPORTED: &str = "unsupported";
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub hello: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

impl Response {
    pub fn of(id: u64, outcome: Result<Value, BridgeError>) -> Self {
        match outcome {
            Ok(v) => Response {
                id,
                result: Some(v),
                error: None,
            },
            Err(e) => Response {
                id,
                result: None,
                error: Some(e),
            },
        }
    }

    pub fn into_result(self) -> Result<Value, BridgeError> {
        match (self.result, self.error) {
            (_, Some(e)) => Err(e),
            (Some(v), None) => Ok(v),
            (None, None) => Ok(Value::Null),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_are_one_object_each() {
        let r: Request = serde_json::from_value(json!({"id": 3, "method": "app.info"})).unwrap();
        assert_eq!(r.params, Value::Null);
        let ok = Response::of(3, Ok(json!({"a": 1})));
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"id": 3, "result": {"a": 1}})
        );
        let err = Response::of(4, Err(BridgeError::new("not_found", "no such chapter")));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({"id": 4, "error": {"code": "not_found", "message": "no such chapter"}})
        );
        assert_eq!(err.into_result().unwrap_err().code, "not_found");
    }
}
