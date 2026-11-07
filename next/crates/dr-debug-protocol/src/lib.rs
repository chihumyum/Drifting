//! dr-debug-protocol: how development tools talk to a running development
//! build of Drifting through its debug bridge (F8).
//!
//! - [`PROTOCOL`]: the protocol's name, sent in the first message both ways.
//!   It is also the marker the release check looks for: a binary that
//!   contains it has the bridge built in (`cargo xtask check-binary`).
//! - [`place`]: where a build leaves its connection file (its data folder,
//!   per development profile) and its socket; the profile a checkout's
//!   builds use.
//! - [`wire`]: one JSON object per line. A request
//!   `{"id": 1, "method": "state.get", "params": {}}` gets
//!   `{"id": 1, "result": …}` or `{"id": 1, "error": {"code", "message"}}`.
//! - [`Client`]: a blocking client (dr-cli's `cargo drifting app …`).
//! - [`server`]: the listening half without GPUI: accepts connections,
//!   checks the token, hands each request to a callback and writes the
//!   reply. dr-debug-bridge puts GPUI behind the callback.
//!
//! No GPUI here, so the command line and xtask build without a window.
//! The bridge itself and its methods: `dr-debug-bridge`;
//! `docs/rust-rewrite/foundations/f8-testkit.md` 「调试桥」.

pub mod place;
pub mod server;
pub mod transport;
pub mod wire;

pub use place::{Connection, Paths};
pub use transport::Client;
pub use wire::{BridgeError, Request, Response};

/// The protocol's name and version. Changing the wire format bumps it.
pub const PROTOCOL: &str = "drifting-debug-bridge/1";
