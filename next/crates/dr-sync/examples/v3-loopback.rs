//! Long-lived offline helper for real-window acceptance. It never holds a
//! library between requests: close App A/B before `sync`, then reopen them.
//! Run: cargo run -p dr-sync --example v3-loopback -- --sandbox <isolated-root>
//! Repeat --sandbox for two isolated App profiles. Only those roots are allowed.
//! One JSON request per stdin line: {"command":"info"},
//! {"command":"sync","root":".../library","data":"..."}, or {"command":"quit"}.
//! stdout is JSONL. Uses only its own loopback FakeSyncServer and synthetic token.
use dr_store::{Device, Library};
use dr_sync::{FakeSyncServer, SyncEngine};
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

const TOKEN: &str = "synthetic-native-v3-loopback";
fn inside(sandboxes: &[PathBuf], value: &Value, key: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = Path::new(
        value
            .get(key)
            .and_then(Value::as_str)
            .ok_or("missing path")?,
    )
    .canonicalize()?;
    if !sandboxes
        .iter()
        .any(|sandbox| path.starts_with(sandbox) && (path != *sandbox || key == "data"))
    {
        return Err("path must be strictly inside the isolated sandbox".into());
    }
    Ok(path)
}
fn request(
    server: &FakeSyncServer,
    sandboxes: &[PathBuf],
    value: &Value,
) -> Result<Value, Box<dyn Error>> {
    match value.get("command").and_then(Value::as_str) {
        Some("info") => Ok(
            json!({"base_url":server.base_url(),"objects":server.stored_object_count(),"automatic_app_sync":false}),
        ),
        Some("sync") => {
            let root = inside(sandboxes, value, "root")?;
            let data = inside(sandboxes, value, "data")?;
            let mut options = dr_testkit::seed::library_options(env!("CARGO_PKG_VERSION"));
            options.device = Some(Device::open(data)?);
            // Library::open retains its exclusive lock. An open App causes a
            // normal lock error; there is no second-store/lock bypass here.
            let library = Library::open(root, options)?;
            let result = (|| -> Result<Value, Box<dyn Error>> {
                let mut engine = SyncEngine::new(server.base_url(), &library)?;
                let report = engine.sync_once(&library, TOKEN)?;
                Ok(
                    json!({"report":report,"cursor":engine.cursor(),"objects":server.stored_object_count(),"documents":library.docs(None,None)?.len()}),
                )
            })();
            let closed = library.close();
            closed?;
            result
        }
        Some("quit") => Ok(json!({"quit":true})),
        _ => Err("unknown command".into()),
    }
}
fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty()
        || args.len() % 2 != 0
        || args.as_chunks::<2>().0.iter().any(|p| p[0] != "--sandbox")
    {
        return Err("expected --sandbox <isolated-root> [--sandbox <second-isolated-root>]".into());
    }
    let sandboxes = args
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| Path::new(&pair[1]).canonicalize())
        .collect::<Result<Vec<_>, _>>()?;
    let server = FakeSyncServer::start(TOKEN);
    let mut out = io::stdout().lock();
    writeln!(
        out,
        "{}",
        json!({"ready":true,"base_url":server.base_url()})
    )?;
    out.flush()?;
    for line in io::stdin().lock().lines() {
        let result = serde_json::from_str::<Value>(&line?)
            .map_err(|e| -> Box<dyn Error> { Box::new(e) })
            .and_then(|v| request(&server, &sandboxes, &v));
        let quit = result.as_ref().is_ok_and(|v| v["quit"] == true);
        let response = match result {
            Ok(value) => json!({"ok":true,"result":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        writeln!(out, "{response}")?;
        out.flush()?;
        if quit {
            break;
        }
    }
    Ok(())
}
