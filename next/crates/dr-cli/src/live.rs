//! A scenario that drives the app: it runs under a development profile, so
//! it has a library, a lock and a bridge of its own and never touches the
//! author's.
//!
//! - Without `--profile`, the run makes a fresh profile (`accept-<hex>`),
//!   and removes its data and log folders afterwards unless `--keep`.
//! - `seed` writes a preset into the profile's library, which must be empty,
//!   and indexes it (word counts and search are whole before the launch).
//! - `launch` starts the given executable (built with `--features
//!   debug-bridge`) under the profile, with `DRIFTING_BOOK` and the step's
//!   `env`, its output going to `app-<n>.log` in the output folder, and
//!   waits until its bridge answers.
//! - `call` steps go through the bridge (`command.call`) while the app runs
//!   (it holds the library's lock), and to the library itself otherwise.
//! - `app` steps are bridge methods; `app.quit` also waits for the process
//!   to end. At the end a running app is quit (killed if it will not go).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use dr_debug_protocol::{BridgeError, Client, Connection, Paths, place};
use dr_workspace::Workspace;
use serde_json::{Value, json};

use crate::offline::APP_VERSION;

/// M10's synthetic 0.1 library (dr-import-v1's test fixture: one book,
/// 《阿Q正传》, built from the published 0.1 migrations and plain SQL).
#[allow(clippy::all, unused)]
#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod legacy_fixture;
use crate::scenario::{Backend, Offline, StepError};

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(90);
const QUIT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one bridge call may take (a `ui.wait` brings its own timeout).
const CALL_TIMEOUT: Duration = Duration::from_secs(180);

fn bridge(e: BridgeError) -> StepError {
    StepError::new(e.code, e.message)
}

fn io(e: impl std::fmt::Display) -> StepError {
    StepError::new("io", e.to_string())
}

struct Running {
    child: Child,
    client: Client,
}

pub struct Session {
    pub profile: String,
    pub instance: String,
    pub data: PathBuf,
    pub library: PathBuf,
    logs: Option<PathBuf>,
    /// The run made this profile: its folders go when it ends.
    throwaway: bool,
    keep: bool,
    exe: Option<PathBuf>,
    pub out: PathBuf,
    ws: Option<Workspace>,
    app: Option<Running>,
    launches: usize,
    /// The synthetic 0.1 libraries built for this run (removed with it).
    legacy: Vec<legacy_fixture::Old>,
    pub notes: Vec<String>,
}

fn fresh_profile() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
        ^ u128::from(std::process::id());
    format!(
        "accept-{:08x}",
        place::fnv1a64(&n.to_le_bytes()) & 0xFFFF_FFFF
    )
}

impl Session {
    /// `profile`: an existing development profile to use (its library is
    /// written to), or `None` for a fresh one.
    pub fn new(
        exe: Option<PathBuf>,
        profile: Option<String>,
        out: PathBuf,
        keep: bool,
    ) -> Result<Session, String> {
        let bundle = dr_platform::Identity::current().bundle_id;
        let (profile, throwaway) = match profile {
            Some(p) => (p, false),
            None => (fresh_profile(), true),
        };
        let instance = place::instance_name(bundle, Some(&profile));
        let data = place::data_dir(&instance).ok_or("this system has no local data folder")?;
        if throwaway && data.exists() {
            return Err(format!("{} exists already", data.display()));
        }
        if let Some(exe) = &exe
            && !exe.is_file()
        {
            return Err(format!(
                "--app {}: no such file (build it: cargo build -p drifting --features debug-bridge)",
                exe.display()
            ));
        }
        std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        // Absolute: the app is given paths in it (`launch` answers `out`).
        let out = std::path::absolute(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        Ok(Session {
            library: data.join("library"),
            logs: place::logs_dir(&instance),
            data,
            profile,
            instance,
            throwaway,
            keep,
            exe,
            out,
            ws: None,
            app: None,
            launches: 0,
            legacy: Vec::new(),
            notes: Vec::new(),
        })
    }

    fn running(&mut self) -> Result<&mut Running, StepError> {
        self.app
            .as_mut()
            .ok_or_else(|| StepError::new("not_running", "the app is not running: launch it first"))
    }

    fn offline(&mut self) -> Result<&Workspace, StepError> {
        if self.app.is_some() {
            return Err(StepError::new("busy", "the app holds the library"));
        }
        if self.ws.is_none() {
            self.ws = Some(
                Workspace::open_dir(&self.library, APP_VERSION)
                    .map_err(|e| StepError::new(e.code(), e.to_string()))?,
            );
        }
        Ok(self.ws.as_ref().expect("opened"))
    }

    fn close_offline(&mut self) -> Result<(), StepError> {
        if let Some(ws) = self.ws.take() {
            ws.shutdown()
                .map_err(|e| StepError::new(e.code(), e.to_string()))?;
        }
        Ok(())
    }

    fn log_tail(path: &Path) -> String {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(15)..].join("\n")
    }

    fn wait_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn quit(&mut self) -> Result<Value, StepError> {
        let Some(mut run) = self.app.take() else {
            return Err(StepError::new("not_running", "the app is not running"));
        };
        let answer = run.client.call("app.quit", json!({})).map_err(bridge);
        let started = Instant::now();
        match Self::wait_exit(&mut run.child, QUIT_TIMEOUT) {
            Some(status) => {
                let paths = Paths::for_instance(&self.instance).map_err(bridge)?;
                let left = paths.connection.exists();
                Ok(json!({
                    "quit": answer.is_ok(),
                    "exitCode": status.code(),
                    "ms": started.elapsed().as_millis() as u64,
                    "connectionFileLeft": left,
                }))
            }
            None => {
                let _ = run.child.kill();
                let _ = run.child.wait();
                Err(StepError::new(
                    "timeout",
                    format!(
                        "the app did not quit within {} s; killed",
                        QUIT_TIMEOUT.as_secs()
                    ),
                ))
            }
        }
    }

    /// Merges `patch` into the profile's `settings.json` (the shell's
    /// settings file: `{"account": {"language.ui_locale": "zh-CN"}}`), so the
    /// next launch starts with those settings.
    fn merge_settings(&mut self, patch: &Value) -> Result<(), StepError> {
        fn merge(into: &mut Value, patch: &Value) {
            match (into, patch) {
                (Value::Object(a), Value::Object(b)) => {
                    for (k, v) in b {
                        merge(a.entry(k.clone()).or_insert(Value::Null), v);
                    }
                }
                (slot, v) => *slot = v.clone(),
            }
        }
        if !patch.is_object() {
            return Err(StepError::new(
                "bad_request",
                "launch.settings: an object merged into settings.json",
            ));
        }
        std::fs::create_dir_all(&self.data).map_err(io)?;
        let file = self.data.join("settings.json");
        let mut current = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .unwrap_or_else(|| serde_json::json!({ "version": 1 }));
        merge(&mut current, patch);
        let text = serde_json::to_string_pretty(&current).map_err(io)?;
        std::fs::write(&file, text).map_err(io)
    }

    /// Quits a running app and removes a fresh profile's folders.
    pub fn finish(&mut self) {
        if self.app.is_some() {
            match self.quit() {
                Ok(_) => self.notes.push("the app was still running; quit it".into()),
                Err(e) => self.notes.push(format!("the app was still running: {e}")),
            }
        }
        if let Err(e) = self.close_offline() {
            self.notes.push(format!("closing the library: {e}"));
        }
        if self.keep {
            for old in self.legacy.drain(..) {
                let _ = old.dir.keep();
            }
        }
        if self.throwaway {
            if self.keep {
                self.notes.push(format!(
                    "kept profile {} (data in {})",
                    self.profile,
                    self.data.display()
                ));
            } else {
                for dir in [Some(self.data.clone()), self.logs.clone()]
                    .into_iter()
                    .flatten()
                {
                    if dir.exists()
                        && let Err(e) = std::fs::remove_dir_all(&dir)
                    {
                        self.notes
                            .push(format!("could not remove {}: {e}", dir.display()));
                    }
                }
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(run) = self.app.as_mut() {
            let _ = run.child.kill();
            let _ = run.child.wait();
        }
    }
}

impl Backend for Session {
    fn call(&mut self, actor: Option<&str>, name: &str, input: Value) -> Result<Value, StepError> {
        if self.app.is_some() {
            let mut params = json!({ "name": name, "input": input });
            if let Some(a) = actor {
                params["actor"] = json!(a);
            }
            let out = self
                .running()?
                .client
                .call("command.call", params)
                .map_err(bridge)?;
            return Ok(out["output"].clone());
        }
        let ws = self.offline()?;
        Offline(ws).call(actor, name, input)
    }

    fn undo(&mut self, actor: Option<&str>, redo: bool) -> Result<Value, StepError> {
        if self.app.is_some() {
            return Err(StepError::new(
                "busy",
                "while the app runs, undo is the editor's: press secondary-z (app input.key)",
            ));
        }
        let ws = self.offline()?;
        Offline(ws).undo(actor, redo)
    }

    fn app(&mut self, method: &str, params: Value) -> Result<Value, StepError> {
        if method == "app.quit" {
            return self.quit();
        }
        self.running()?.client.call(method, params).map_err(bridge)
    }

    fn legacy(&mut self, kind: &str) -> Result<Value, StepError> {
        let stamped = match kind {
            "sample" => true,
            "sample-stale" => false,
            other => {
                return Err(StepError::new(
                    "bad_request",
                    format!("legacy {other}: sample or sample-stale"),
                ));
            }
        };
        let old = legacy_fixture::build(stamped);
        let out = json!({
            "root": old.root.display().to_string(),
            "db": old.db.display().to_string(),
            "book": legacy_fixture::BOOK,
            "name": "阿Q正传",
            "chapter": legacy_fixture::CHAPTER,
            "element": legacy_fixture::ELEMENT,
        });
        if self.keep {
            self.notes
                .push(format!("kept the 0.1 library at {}", old.root.display()));
        }
        self.legacy.push(old);
        Ok(out)
    }

    fn seed(&mut self, preset: &str) -> Result<Value, StepError> {
        use dr_testkit::seed;
        if self.app.is_some() {
            return Err(StepError::new("busy", "seed before launching the app"));
        }
        self.close_offline()?;
        if self.library.join("library.sqlite").exists() {
            return Err(StepError::new(
                "not_empty",
                format!(
                    "{} has a library already; a seed goes into an empty one (run without --profile for a fresh profile)",
                    self.library.display()
                ),
            ));
        }
        let preset = seed::Preset::parse(preset)
            .ok_or_else(|| StepError::new("bad_request", format!("unknown seed {preset}")))?;
        let seeded = seed::generate(preset, seed::DEFAULT_SEED).map_err(io)?;
        let lib =
            dr_store::Library::open(&self.library, dr_workspace::library_options(APP_VERSION))
                .map_err(io)?;
        let n = seeded.write_to(&lib).map_err(io)?;
        // Index everything now, as a library the app has had open is: the
        // word counts and search a scenario reads before launching are then
        // whole (otherwise the app rebuilds them in the background).
        let indexed = lib.rebuild_stale_indexes().map_err(io)?;
        lib.close().map_err(io)?;
        Ok(json!({
            "documents": n, "indexed": indexed, "books": seeded.books.len(),
            "library": self.library.to_string_lossy(),
        }))
    }

    fn launch(&mut self, params: Value) -> Result<Value, StepError> {
        if self.app.is_some() {
            return Err(StepError::new("busy", "the app is running already"));
        }
        let exe = self.exe.clone().ok_or_else(|| {
            StepError::new(
                "needs_app",
                "give --app <drifting built with --features debug-bridge>",
            )
        })?;
        self.close_offline()?;
        if let Some(settings) = params.get("settings") {
            self.merge_settings(settings)?;
        }
        let paths = Paths::for_instance(&self.instance).map_err(bridge)?;
        // A connection file left by a run that never quit.
        let _ = std::fs::remove_file(&paths.connection);
        self.launches += 1;
        let log_path = self.out.join(format!("app-{}.log", self.launches));
        let log = std::fs::File::create(&log_path).map_err(io)?;
        let mut cmd = Command::new(&exe);
        cmd.env(dr_platform::identity::PROFILE_ENV, &self.profile)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(io)?)
            .stderr(log);
        if let Some(book) = params.get("book").and_then(Value::as_str) {
            cmd.env("DRIFTING_BOOK", book);
        }
        for (k, v) in params
            .get("env")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            cmd.env(k, v.as_str().map_or_else(|| v.to_string(), str::to_owned));
        }
        let timeout = params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .map_or(LAUNCH_TIMEOUT, Duration::from_millis);
        let started = Instant::now();
        let mut child = cmd
            .spawn()
            .map_err(|e| io(format!("{}: {e}", exe.display())))?;
        let client = loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(StepError::new(
                    "exited",
                    format!(
                        "the app exited ({status}) before its bridge answered; {}:\n{}",
                        log_path.display(),
                        Self::log_tail(&log_path)
                    ),
                ));
            }
            if let Ok(c) = Connection::read(&paths.connection)
                && c.pid == child.id()
                && let Ok(client) = Client::connect(&c)
            {
                break client;
            }
            if started.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(StepError::new(
                    "timeout",
                    format!(
                        "no bridge after {} s (built with --features debug-bridge?); {}:\n{}",
                        timeout.as_secs(),
                        log_path.display(),
                        Self::log_tail(&log_path)
                    ),
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut client = client;
        client.set_timeout(Some(CALL_TIMEOUT));
        let pid = child.id();
        self.app = Some(Running { child, client });
        Ok(json!({
            "pid": pid,
            "profile": self.profile,
            "instance": self.instance,
            // The run's output folder: files a scenario has the app write
            // (a backup, an exported book) go here, beside the screenshots.
            "out": self.out.to_string_lossy(),
            "ms": started.elapsed().as_millis() as u64,
            "log": log_path.to_string_lossy(),
        }))
    }

    fn save_png(&mut self, name: &str, png_base64: &str) -> Result<String, StepError> {
        if name.contains('/') || name.contains('\\') || !name.ends_with(".png") {
            return Err(StepError::new(
                "bad_request",
                format!("png {name}: a file name ending in .png"),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png_base64)
            .map_err(io)?;
        let path = self.out.join(name);
        std::fs::write(&path, bytes).map_err(io)?;
        Ok(path.to_string_lossy().into_owned())
    }
}
