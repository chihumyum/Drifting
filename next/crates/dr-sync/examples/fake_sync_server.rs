//! Loopback-only (`127.0.0.1:0`) fake Hosted Sync v2 server process for
//! isolated multi-window smoke verification.
//!
//! Prints one JSON line `{"base_url":"http://127.0.0.1:<port>","token":"..."}` to
//! stdout, then stays alive until stdin closes (EOF).

use std::io::{self, Read};

use dr_sync::FakeSyncServer;
use serde_json::json;

fn main() {
    let token = std::env::var("DRIFTING_FAKE_SYNC_TOKEN")
        .unwrap_or_else(|_| "synthetic-loopback-sync-token-0000".to_owned());
    let server = FakeSyncServer::start(&token);
    println!(
        "{}",
        json!({
            "base_url": server.base_url(),
            "token": token,
        })
    );
    let mut sink = Vec::new();
    let _ = io::stdin().read_to_end(&mut sink);
    drop(server);
}
