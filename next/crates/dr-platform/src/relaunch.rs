//! Reopening the app once this process has quit (macOS), as the 0.1
//! client's `src-tauri/src/macos_relaunch.rs` does it.
//!
//! Spawning the bundle's executable directly is a launch Launch Services
//! never sees, so macOS does not activate it and the window opens behind
//! whatever app came forward. A detached helper instead waits for this
//! process to exit and reopens the bundle with `open -n`, which launches and
//! activates it like a Dock click. Waiting for the exit also keeps the old
//! process's library lock from overlapping the new one.
//!
//! On Windows the update installer reopens the app itself (`/R`).

use std::ffi::OsString;
use std::path::Path;

/// `$1` is the process to wait for; the rest are `open` arguments.
pub const HELPER_SCRIPT: &str =
    "while kill -0 \"$1\" 2>/dev/null; do sleep 0.05; done; shift; exec /usr/bin/open \"$@\"";

/// `open` arguments for a new, activated instance of `bundle` that keeps
/// this process's `DRIFTING_*` configuration (a development profile, for
/// example) and command-line arguments; Launch Services otherwise starts
/// it with its own environment.
pub fn open_arguments(
    bundle: &Path,
    environment: impl IntoIterator<Item = (OsString, OsString)>,
    arguments: impl IntoIterator<Item = OsString>,
) -> Vec<OsString> {
    let mut open = vec![OsString::from("-n"), bundle.as_os_str().to_owned()];
    for (name, value) in environment {
        if name
            .to_str()
            .is_some_and(|name| name.starts_with("DRIFTING_"))
        {
            let mut assignment = name;
            assignment.push("=");
            assignment.push(value);
            open.push("--env".into());
            open.push(assignment);
        }
    }
    let arguments: Vec<OsString> = arguments.into_iter().collect();
    if !arguments.is_empty() {
        open.push("--args".into());
        open.extend(arguments);
    }
    open
}

/// Starts the helper that reopens `bundle` once this process has exited.
/// The caller then quits.
#[cfg(target_os = "macos")]
pub fn after_exit(bundle: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt as _;
    use std::process::{Command, Stdio};

    Command::new("/bin/sh")
        .arg("-c")
        .arg(HELPER_SCRIPT)
        .arg("drifting-relaunch")
        .arg(std::process::id().to_string())
        .args(open_arguments(
            bundle,
            std::env::vars_os(),
            std::env::args_os().skip(1),
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group, so nothing that ends this app's group ends
        // the helper with it.
        .process_group(0)
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[OsString]) -> Vec<&str> {
        values.iter().map(|value| value.to_str().unwrap()).collect()
    }

    #[test]
    fn reopens_the_bundle_with_its_drifting_settings_and_arguments() {
        let open = open_arguments(
            Path::new("/Applications/Drifting.app"),
            [
                ("DRIFTING_PROFILE".into(), "f7".into()),
                ("HOME".into(), "/var/empty".into()),
            ],
            ["--instance".into(), "b".into()],
        );
        assert_eq!(
            strings(&open),
            [
                "-n",
                "/Applications/Drifting.app",
                "--env",
                "DRIFTING_PROFILE=f7",
                "--args",
                "--instance",
                "b"
            ]
        );
        assert_eq!(
            strings(&open_arguments(
                Path::new("/A.app"),
                std::iter::empty(),
                std::iter::empty()
            )),
            ["-n", "/A.app"]
        );
    }

    /// The helper waits for the process it was given, then runs `open` with
    /// the rest: checked with a stand-in for `open` and a child process.
    #[cfg(unix)]
    #[test]
    fn the_helper_waits_for_the_process_to_exit() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("opened");
        let script = HELPER_SCRIPT.replace(
            "exec /usr/bin/open \"$@\"",
            &format!("echo \"$@\" > '{}'", out.display()),
        );
        let mut waited = std::process::Command::new("/bin/sleep")
            .arg("0.3")
            .spawn()
            .unwrap();
        let pid = waited.id();
        // Reaped as soon as it exits: a zombie still answers `kill -0`.
        let reaper = std::thread::spawn(move || waited.wait());
        let started = std::time::Instant::now();
        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .arg("drifting-relaunch")
            .arg(pid.to_string())
            .args(["-n", "/A.app"])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(started.elapsed() >= std::time::Duration::from_millis(250));
        assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "-n /A.app");
        reaper.join().unwrap().unwrap();
    }
}
