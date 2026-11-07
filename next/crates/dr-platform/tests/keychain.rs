//! The real credential store, under a throwaway service name only:
//! `Drifting.test.<random>`. Nothing here reads, lists or changes the author's
//! items (service `Drifting` or `Drifting.cc.drifting.next.dev`).
//!
//! Ignored by default because it needs an unlocked login keychain (macOS) or
//! an interactive user session (Windows). Run it on purpose:
//!
//! ```text
//! cargo test -p dr-platform --test keychain -- --ignored
//! ```
//!
//! `keyring` 3.6 with the 0.1 client's platform stores stands in for the
//! Tauri client, so these prove both directions of the hand-over: what the old
//! client wrote reads back here, and what this client writes the old one
//! reads.

use dr_platform::SecretStore;

struct Service(String);

impl Service {
    fn new() -> Self {
        Self(format!("Drifting.test.{}", uuid::Uuid::new_v4().simple()))
    }
}

/// Deletes whatever a test left under its service, through the 0.1 layout
/// and ours, even when the test fails.
struct Cleanup<'a> {
    service: &'a Service,
    keys: &'a [&'a str],
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let store = SecretStore::system(&self.service.0);
        for key in self.keys {
            let _ = store.delete(key);
            if let Ok(entry) = keyring::Entry::new(&self.service.0, key) {
                let _ = entry.delete_credential();
            }
        }
    }
}

const KEYS: &[&str] = &[
    "byok.openai",
    "drifting.session_token",
    "oauth.openai-codex",
];

#[test]
#[ignore = "touches the real credential store (under a throwaway service)"]
fn reads_what_the_tauri_client_wrote() {
    let service = Service::new();
    let _cleanup = Cleanup {
        service: &service,
        keys: KEYS,
    };
    keyring::Entry::new(&service.0, "byok.openai")
        .unwrap()
        .set_password("sk-synthetic-片段")
        .unwrap();
    let store = SecretStore::system(&service.0);
    assert_eq!(
        store.get("byok.openai").unwrap().as_deref(),
        Some("sk-synthetic-片段")
    );
    assert!(store.contains("byok.openai").unwrap());
    assert!(!store.contains("drifting.session_token").unwrap());
}

#[test]
#[ignore = "touches the real credential store (under a throwaway service)"]
fn the_tauri_client_reads_what_this_one_writes() {
    let service = Service::new();
    let _cleanup = Cleanup {
        service: &service,
        keys: KEYS,
    };
    let store = SecretStore::system(&service.0);
    store
        .set("drifting.session_token", "session-synthetic")
        .unwrap();
    assert_eq!(
        keyring::Entry::new(&service.0, "drifting.session_token")
            .unwrap()
            .get_password()
            .unwrap(),
        "session-synthetic"
    );
    // Overwrite, then delete: both clients agree it is gone.
    store.set("drifting.session_token", "rotated").unwrap();
    assert_eq!(
        store.get("drifting.session_token").unwrap().as_deref(),
        Some("rotated")
    );
    store.delete("drifting.session_token").unwrap();
    store.delete("drifting.session_token").unwrap();
    assert!(matches!(
        keyring::Entry::new(&service.0, "drifting.session_token")
            .unwrap()
            .get_password(),
        Err(keyring::Error::NoEntry)
    ));
}

#[test]
#[ignore = "touches the real credential store (under a throwaway service)"]
fn a_long_token_round_trips() {
    let service = Service::new();
    let _cleanup = Cleanup {
        service: &service,
        keys: KEYS,
    };
    // Longer than one Windows credential (2560 bytes of UTF-16).
    let token: String = "eyJhbGciOiJSUzI1NiJ9.片段🙂"
        .chars()
        .cycle()
        .take(9000)
        .collect();
    let store = SecretStore::system(&service.0);
    store.set("oauth.openai-codex", &token).unwrap();
    assert_eq!(store.get("oauth.openai-codex").unwrap(), Some(token));
    store.delete("oauth.openai-codex").unwrap();
    assert_eq!(store.get("oauth.openai-codex").unwrap(), None);
}
