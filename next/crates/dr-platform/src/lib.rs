//! Drifting's platform services (foundation F7): the app's identity and
//! folders, logs, crash reports, the keychain, deep links and the single
//! running copy, automatic updates, and the feedback the author sends with
//! its diagnostic summary (M39).
//!
//! None of it depends on GPUI, so every piece is tested without a window; the
//! app (`app/drifting`) wires the few calls that need one, such as
//! `Application::on_open_urls`. The design, interfaces and hand-over from the
//! 0.1 Tauri client are in docs/rust-rewrite/foundations/f7-platform.md.
//!
//! Start-up order in `main`:
//!
//! 0. [`cli::parse`]: an `--mcp --connection <file>` launch (external Agents)
//!    leaves here, before any of the rest;
//! 1. [`crash::init`]: first, because in the crash-reporter process it never
//!    returns;
//! 2. [`logging::init`];
//! 3. [`single_instance::acquire`]: exit when another copy took the arguments;
//! 4. [`DeepLinks`]: queue the launch arguments, then GPUI's `on_open_urls`.
//!
//! Updates ([`update`]) are checked, downloaded and installed by M42
//! (`dr-view-update`); the app reopens itself after an update with
//! [`relaunch`].

pub mod cli;
pub mod crash;
pub mod deep_link;
pub mod diagnostics;
pub mod feedback;
pub mod identity;
pub mod logging;
pub mod paths;
pub mod relaunch;
pub mod sanitize;
pub mod secrets;
pub mod single_instance;
pub mod update;

pub use deep_link::DeepLinks;
pub use identity::{Channel, Identity};
pub use paths::AppDirs;
pub use secrets::{SecretError, SecretStore};

/// rustls with ring for every HTTPS client in the process (Sentry's and the
/// updater's); reqwest is built without a default provider.
#[cfg(feature = "network")]
pub(crate) fn install_tls_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
