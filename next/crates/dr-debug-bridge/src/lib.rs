//! dr-debug-bridge: F8's debug bridge, in development builds only.
//!
//! A development build started with `cargo xtask dev --debug-bridge` (the
//! app's `debug-bridge` feature) listens on a local socket. A tool that
//! reads the build's connection file and sends its token can then drive the
//! real window: open pages, type through GPUI's input path, press keys and
//! dispatch actions, call F3's commands on the library the window has open,
//! read the shell's state and a page's text, wait for a condition and take
//! a screenshot. `cargo drifting app …` and `cargo drifting workspace
//! scenario` are the clients (dr-cli).
//!
//! - Transport and connection file: [`dr_debug_protocol`] (no GPUI).
//! - Methods: [`call`]; each runs on GPUI's main thread, in a task of its
//!   own, so a long `ui.wait` holds nobody up.
//! - Finding what is on screen by its accessible name (`ui.find`,
//!   `ui.press`): `a11y`, which connects to GPUI's AccessKit tree from
//!   inside the app (macOS).
//! - The system's open and save panels (`panel.answer`): `panel`, which
//!   answers the app's next panel where AppKit hands the author's choice
//!   back (macOS).
//! - The shell is read through dr-shell's public interface
//!   (`with_workspace`, `Workspace`'s fields, `nav`, `quit`); the app adds
//!   one call after `dr_shell::init`:
//!
//! ```ignore
//! #[cfg(feature = "debug-bridge")]
//! dr_debug_bridge::start(cx);
//! ```
//!
//! Never in a release build: `cargo xtask check` (gate `debug-bridge`)
//! checks that nothing turns the feature on by default and that the release
//! scripts never ask for it; `cargo xtask check-binary <file>` checks a
//! built binary for [`dr_debug_protocol::PROTOCOL`].
//! Docs: `docs/rust-rewrite/foundations/f8-testkit.md` 「调试桥」.

mod a11y;
mod methods;
mod panel;

use std::sync::Arc;

use dr_debug_protocol::server::{self, Reply, Server};
use dr_debug_protocol::{BridgeError, Connection, Paths, Request};
use futures::StreamExt as _;
use gpui::{App, Global};

pub use dr_debug_protocol as protocol;
pub use methods::{METHODS, call};

struct Running(Arc<Server>);

impl Global for Running {}

/// Starts the bridge for this build's instance (`DRIFTING_PROFILE`). Logs
/// and carries on if it cannot listen: the app runs without it.
pub fn start(cx: &mut App) {
    let instance = dr_platform::Identity::current().instance_name();
    match Paths::for_instance(&instance).and_then(|paths| start_at(&paths, &instance, cx)) {
        Ok(c) => log::warn!(
            "debug bridge: listening at {} (pid {}); this build can be driven from outside",
            c.address,
            c.pid
        ),
        Err(e) => log::error!("debug bridge: could not start: {e}"),
    }
}

/// Starts the bridge at `paths` (tests use a folder of their own).
pub fn start_at(paths: &Paths, instance: &str, cx: &mut App) -> Result<Connection, BridgeError> {
    if cx.has_global::<Running>() {
        return Err(BridgeError::new(
            dr_debug_protocol::wire::codes::BAD_REQUEST,
            "the bridge is already running",
        ));
    }
    let version = cx
        .try_global::<dr_shell::ShellInfo>()
        .map_or("unknown", |i| i.version);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<(Request, Reply)>();
    let server = server::listen(paths, instance, version, &token, move |request, reply| {
        if let Err(e) = tx.unbounded_send((request, reply)) {
            let (_, reply) = e.into_inner();
            reply(Err(BridgeError::new(
                dr_debug_protocol::wire::codes::IO,
                "the app is closing",
            )));
        }
    })?;
    let connection = server.connection.clone();
    // Requests arrive on the connections' threads; each one runs on the
    // main thread in a task of its own.
    cx.spawn(async move |cx| {
        while let Some((request, reply)) = rx.next().await {
            cx.spawn(async move |cx| {
                reply(call(&request.method, request.params, cx).await);
            })
            .detach();
        }
    })
    .detach();
    let server = Arc::new(server);
    cx.set_global(Running(server.clone()));
    dr_shell::quit::before_quit(cx, move |_| server.close());
    Ok(connection)
}

/// Stops the bridge (tests; the app stops it when it quits).
pub fn stop(cx: &mut App) {
    if let Some(Running(server)) = cx.try_global::<Running>() {
        server.close();
        cx.remove_global::<Running>();
    }
}
