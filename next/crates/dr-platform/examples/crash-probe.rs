//! Exercises crash reporting end to end on this machine, with nothing sent
//! anywhere: the DSN is a placeholder on a closed local port, not a Sentry
//! project, so every upload fails and the files stay for inspection.
//!
//! ```text
//! cargo run -p dr-platform --example crash-probe -- <dir> exit|panic|abort|follow-up
//! ```
//!
//! - `exit`: start the crash reporter, wait, exit normally (a clean quit must
//!   not crash the reporter);
//! - `panic`: panic with prose in the message; the record lands in
//!   `<dir>/pending/` and is sanitized;
//! - `abort`: crash natively; the reporter writes `<dir>/minidumps/*.dmp`
//!   and a follow-up in `<dir>/followups/`;
//! - `follow-up`: start again, send pending panics, print the follow-up F6
//!   would show.

use std::path::PathBuf;
use std::time::Duration;

use dr_platform::Channel;
use dr_platform::crash::{CrashConfig, init};

const PLACEHOLDER_DSN: &str = "http://placeholder@127.0.0.1:9/0";

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("crash-probe <dir> <mode>"));
    let mode = args.next().unwrap_or_else(|| "exit".into());
    let reporting = init(CrashConfig {
        dsn: Some(PLACEHOLDER_DSN.into()),
        channel: Channel::Development,
        consent: true,
        dev_opt_in: true,
        crashes_dir: Some(dir),
        release: "drifting@0.0.0-probe".into(),
        app_version: "0.0.0-probe".into(),
        environment: "probe",
        build_commit: None,
    });
    println!("pid {} status {:?}", std::process::id(), reporting.status());
    // Give the crash reporter time to start and connect.
    std::thread::sleep(Duration::from_secs(2));
    match mode.as_str() {
        "panic" => panic!(
            "probe panic quoting prose: {}",
            "雨还在下，远处的灯一盏一盏地灭了".repeat(2)
        ),
        "abort" => std::process::abort(),
        "follow-up" => println!("follow-up {:?}", reporting.take_follow_up()),
        _ => println!("clean exit"),
    }
}
