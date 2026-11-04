//! Relaunch a packaged macOS App through LaunchServices.
//!
//! `AppHandle::restart` spawns the bundle's executable directly. LaunchServices
//! never sees that launch, so macOS does not activate the new process: after a
//! library switch (signing in or out) or an installed update, the new window
//! opened behind whichever App the system activated when this one quit. A
//! detached helper instead waits for this process to exit and reopens the
//! bundle with `open -n`, which launches and activates it like a Dock click.
//! Waiting for the exit also keeps the old process's single-instance socket
//! and databases from overlapping the new one.

use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// `$1` is the process to wait for; the rest are `open` arguments.
const HELPER_SCRIPT: &str =
    "while kill -0 \"$1\" 2>/dev/null; do sleep 0.05; done; shift; exec /usr/bin/open \"$@\"";

/// The `.app` bundle that holds `executable` (`<bundle>/Contents/MacOS/<name>`).
pub(crate) fn bundle_of(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then_some(bundle)
}

/// `open` arguments for a new, activated instance of `bundle` that keeps this
/// process's `DRIFTING_*` configuration (an isolated database folder, for
/// example) and command-line arguments. LaunchServices otherwise starts it
/// with its own environment.
pub(crate) fn open_arguments(
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

/// Start the helper. The caller must then exit this process; the helper opens
/// the bundle once it has. Fails when this process does not run from an `.app`
/// bundle or the helper cannot start, and the caller falls back to
/// `AppHandle::restart`.
pub(crate) fn relaunch_after_exit() -> io::Result<()> {
    let executable = std::env::current_exe()?;
    let bundle = bundle_of(&executable).ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "not running from an .app bundle")
    })?;
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
        // Its own process group, so nothing that ends this App's group ends
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
    fn finds_the_bundle_of_its_executable() {
        assert_eq!(
            bundle_of(Path::new(
                "/Applications/Drifting.app/Contents/MacOS/Drifting"
            )),
            Some(Path::new("/Applications/Drifting.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/repo/src-tauri/target/debug/drifting")),
            None
        );
        assert_eq!(bundle_of(Path::new("/opt/Contents/MacOS/drifting")), None);
        assert_eq!(
            bundle_of(Path::new("/x/Drifting.app/Contents/Resources/drifting")),
            None
        );
    }

    #[test]
    fn opens_a_new_instance_with_the_apps_own_configuration() {
        let open = open_arguments(
            Path::new("/Users/example/Drifting Test.app"),
            [
                ("DRIFTING_DB_DIR".into(), "/tmp/db=1".into()),
                ("HOME".into(), "/var/empty".into()),
                (
                    "XPC_SERVICE_NAME".into(),
                    "application.cc.drifting.client".into(),
                ),
            ],
            Vec::<OsString>::new(),
        );
        assert_eq!(
            strings(&open),
            [
                "-n",
                "/Users/example/Drifting Test.app",
                "--env",
                "DRIFTING_DB_DIR=/tmp/db=1"
            ]
        );
    }

    #[test]
    fn passes_its_arguments_through() {
        let open = open_arguments(
            Path::new("/Applications/Drifting.app"),
            Vec::<(OsString, OsString)>::new(),
            ["--flag".into(), "value with space".into()],
        );
        assert_eq!(
            strings(&open),
            [
                "-n",
                "/Applications/Drifting.app",
                "--args",
                "--flag",
                "value with space"
            ]
        );
    }
}
