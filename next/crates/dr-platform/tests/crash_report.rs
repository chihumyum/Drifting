//! Crash reports end to end on this machine, against a stand-in for Sentry's
//! ingest on 127.0.0.1: nothing here reaches a real Sentry project, and the
//! DSN is made here from a loopback port, never read from anywhere.
//!
//! The crashing program is a copy of this test executable with its symbols
//! stripped (`strip -S -x`), as the shipped app is (f7-platform.md,
//! 「符号文件」), so it cannot name its own functions:
//!
//! 1. it panics with prose in the message; the record waits on disk;
//! 2. the next launch sends it: the ingest gets one envelope whose event is
//!    fatal, sanitized, tagged with the follow-up's crash id, and carries
//!    the stack's addresses and the loaded images;
//! 3. symbols: the event names the executable by the build UUID that its
//!    unstripped build (what the dSYM is made from) carries, and `atos`
//!    turns the event's addresses back into the panicking function, file
//!    and line, as Sentry does with the uploaded dSYM.
//!
//! `-- --native` also crashes natively (`abort`): the crash-reporter process
//! uploads an event with the minidump, which names the same build UUID. It
//! is not run by default because macOS keeps a crash report of every native
//! crash in the author's DiagnosticReports.
//!
//! macOS only (the tools are Xcode's); elsewhere it reports itself skipped.
//! Its own harness: the crash reporter re-runs this executable, which must
//! then be the reporter and nothing else.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use dr_platform::Channel;
use dr_platform::crash::{CrashConfig, init};
use serde_json::Value;

const MODE_ENV: &str = "DR_CRASH_REPORT_MODE";
const PORT_ENV: &str = "DR_CRASH_REPORT_PORT";
const DIR_ENV: &str = "DR_CRASH_REPORT_DIR";
/// Synthetic prose, never a real manuscript.
const PROSE: &str = "雨还在下，远处的灯一盏一盏地灭了";

fn main() {
    match std::env::var(MODE_ENV) {
        Ok(mode) => child(&mode),
        Err(_) if cfg!(target_os = "macos") => {
            let native = std::env::args().any(|a| a == "--native");
            driver(native);
            println!("crash_report: ok");
        }
        Err(_) => println!("crash_report: skipped (macOS only)"),
    }
}

// --- The crashing program -------------------------------------------------

fn child(mode: &str) {
    let port = std::env::var(PORT_ENV).expect("the ingest port");
    let dir = PathBuf::from(std::env::var_os(DIR_ENV).expect("the crashes folder"));
    // In the crash-reporter process, `init` runs the reporter and exits.
    let reporting = init(CrashConfig {
        dsn: Some(format!("http://probe@127.0.0.1:{port}/1")),
        channel: Channel::Development,
        consent: true,
        dev_opt_in: true,
        crashes_dir: Some(dir),
        release: "drifting@0.0.0-probe".into(),
        app_version: "0.0.0-probe".into(),
        environment: "probe",
        build_commit: Some("probe".into()),
    });
    assert_eq!(reporting.status(), Ok(()));
    match mode {
        "panic" => probe_panic(),
        "abort" => {
            // Let the crash reporter start and connect.
            std::thread::sleep(Duration::from_secs(2));
            std::process::abort();
        }
        "next-launch" => {
            assert!(reporting.flush(Duration::from_secs(10)), "sent in time");
            let follow_up = reporting.take_follow_up().expect("a follow-up");
            println!("follow-up {}", follow_up.id);
        }
        other => panic!("unknown mode {other}"),
    }
}

#[inline(never)]
fn probe_panic() {
    let index = std::hint::black_box(7);
    panic!("probe panic at {index} quoting prose: {}", PROSE.repeat(2));
}

// --- The driver ----------------------------------------------------------

fn driver(native: bool) {
    let ingest = Ingest::start();
    let work = tempfile::tempdir().unwrap();
    let crashes = work.path().join("crashes");
    let original = std::env::current_exe().unwrap();
    // What ships: the same build, stripped.
    let shipped = work.path().join("drifting-probe");
    std::fs::copy(&original, &shipped).unwrap();
    tool("strip", &["-S", "-x", shipped.to_str().unwrap()]);
    let uuid = build_uuid(&original);
    assert_eq!(build_uuid(&shipped), uuid, "stripping keeps the build UUID");

    // 1. The panic is recorded, not sent.
    let out = run(&shipped, "panic", ingest.port, &crashes);
    assert!(!out.status.success());
    let pending: Vec<_> = std::fs::read_dir(crashes.join("pending"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(pending.len(), 1, "one panic record");
    let record = std::fs::read_to_string(&pending[0]).unwrap();
    assert!(!record.contains("远处的灯"), "the record is sanitized");

    // 2. The next launch sends it.
    let out = run(&shipped, "next-launch", ingest.port, &crashes);
    assert!(out.status.success(), "{out:?}");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let crash_id = stdout
        .lines()
        .find_map(|l| l.strip_prefix("follow-up "))
        .expect("the follow-up's id")
        .trim()
        .to_owned();
    assert!(
        std::fs::read_dir(crashes.join("pending"))
            .unwrap()
            .next()
            .is_none()
    );

    let request = ingest.next_with(|r| r.item("event").is_some());
    assert_eq!(request.path, "/api/1/envelope/");
    assert!(
        request
            .header("x-sentry-auth")
            .is_some_and(|a| a.contains("sentry_key=probe")),
        "{:?}",
        request.headers
    );
    let raw = String::from_utf8_lossy(&request.body).into_owned();
    assert!(!raw.contains("远处的灯"), "nothing of the prose leaves");
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().into_owned();
        assert!(home.len() < 2 || !raw.contains(&home), "no home folder");
    }
    let event: Value = serde_json::from_slice(&request.item("event").unwrap()).unwrap();
    assert_eq!(event["level"], "fatal");
    assert_eq!(event["release"], "drifting@0.0.0-probe");
    assert_eq!(event["tags"]["drifting.crash_id"], crash_id.as_str());
    assert_eq!(event["tags"]["build.commit"], "probe");
    assert!(event.get("server_name").is_none_or(Value::is_null));
    assert!(event.get("user").is_none_or(Value::is_null));
    let exception = &event["exception"]["values"][0];
    assert_eq!(exception["type"], "panic");
    assert!(
        exception["value"]
            .as_str()
            .unwrap()
            .starts_with("probe panic at 7 quoting prose: [text]"),
        "{}",
        exception["value"]
    );

    // 3. Symbols: the stripped program could not name its own function…
    let frames = exception["stacktrace"]["frames"].as_array().unwrap();
    assert!(!frames.is_empty());
    assert!(
        !frames.iter().any(|f| f["function"]
            .as_str()
            .is_some_and(|n| n.contains("probe_panic"))),
        "the shipped program is stripped"
    );
    // …but it names its build, and the build's symbols name the frames.
    let image = event["debug_meta"]["images"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| {
            i["name"]
                .as_str()
                .is_some_and(|f| f.ends_with("/drifting-probe"))
        })
        .expect("the executable among the images");
    assert_eq!(image["type"], "symbolic");
    assert_eq!(
        image["id"].as_str().unwrap().to_ascii_uppercase(),
        uuid,
        "the event names the build the symbols belong to"
    );
    let load = image["image_addr"].as_str().unwrap();
    let addresses: Vec<&str> = frames
        .iter()
        .filter_map(|f| f["instruction_addr"].as_str())
        .collect();
    let mut args = vec!["-o", original.to_str().unwrap(), "-l", load];
    args.extend(&addresses);
    let named = tool("atos", &args);
    let line = named
        .lines()
        .find(|l| l.contains("probe_panic"))
        .unwrap_or_else(|| panic!("atos did not find probe_panic:\n{named}"));
    assert!(line.contains("crash_report.rs:"), "{line}");
    println!(
        "crash_report: panic {crash_id} sent, {} frames, build {uuid}; atos: {}",
        frames.len(),
        line.trim()
    );

    if native {
        native_crash(&ingest, &shipped, &crashes, &uuid);
    }
}

/// `-- --native`: the crash reporter uploads a minidump at once.
fn native_crash(ingest: &Ingest, shipped: &Path, crashes: &Path, uuid: &str) {
    let out = run(shipped, "abort", ingest.port, crashes);
    assert!(!out.status.success());
    let request = ingest.next_with(|r| r.item("attachment").is_some());
    let event: Value = serde_json::from_slice(&request.item("event").expect("an event")).unwrap();
    let minidump = request.item("attachment").unwrap();
    assert_eq!(&minidump[..4], b"MDMP");
    // The crash reporter wrote the follow-up under the event's crash id.
    let follow_ups: Vec<Value> = std::fs::read_dir(crashes.join("followups"))
        .unwrap()
        .map(|e| serde_json::from_slice(&std::fs::read(e.unwrap().path()).unwrap()).unwrap())
        .collect();
    let follow_up = follow_ups
        .iter()
        .find(|f| f["kind"] == "native")
        .expect("a native follow-up");
    assert_eq!(event["tags"]["drifting.crash_id"], follow_up["id"]);
    // The module list names the build (its UUID as a CodeView GUID).
    let raw = uuid_bytes(uuid);
    let mut guid = raw;
    guid[..4].reverse();
    guid[4..6].reverse();
    guid[6..8].reverse();
    assert!(
        contains(&minidump, &raw) || contains(&minidump, &guid),
        "the minidump names the build"
    );
    println!(
        "crash_report: native crash {} sent with a {} KiB minidump",
        follow_up["id"],
        minidump.len() / 1024
    );
}

fn run(exe: &Path, mode: &str, port: u16, crashes: &Path) -> std::process::Output {
    Command::new(exe)
        .env(MODE_ENV, mode)
        .env(PORT_ENV, port.to_string())
        .env(DIR_ENV, crashes)
        .env_remove("DRIFTING_CRASH_REPORTER")
        .output()
        .unwrap()
}

fn tool(name: &str, args: &[&str]) -> String {
    let out = Command::new(name).args(args).output().unwrap();
    assert!(out.status.success(), "{name}: {out:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// `dwarfdump --uuid`: `UUID: 1A2B…-… (arm64) <path>`.
fn build_uuid(exe: &Path) -> String {
    let out = tool("dwarfdump", &["--uuid", exe.to_str().unwrap()]);
    let arch = if cfg!(target_arch = "aarch64") {
        "(arm64)"
    } else {
        "(x86_64)"
    };
    out.lines()
        .find(|l| l.contains(arch))
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or_else(|| panic!("no UUID in {out}"))
        .to_ascii_uppercase()
}

fn uuid_bytes(uuid: &str) -> [u8; 16] {
    let hex: String = uuid.chars().filter(char::is_ascii_hexdigit).collect();
    let mut bytes = [0; 16];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
    }
    bytes
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

// --- A stand-in for Sentry's ingest ---------------------------------------

struct Request {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// The payload of the envelope's first item of type `ty`.
    fn item(&self, ty: &str) -> Option<Vec<u8>> {
        let mut rest = self.body.as_slice();
        // The envelope's own header.
        rest = &rest[line(rest).1..];
        while !rest.is_empty() {
            let (end, next) = line(rest);
            let header: Value = serde_json::from_slice(&rest[..end]).ok()?;
            rest = &rest[next..];
            let payload = match header["length"].as_u64() {
                Some(length) => {
                    let length = length as usize;
                    let payload = rest[..length].to_vec();
                    rest = &rest[length..];
                    rest = rest.strip_prefix(b"\n").unwrap_or(rest);
                    payload
                }
                None => {
                    let (end, next) = line(rest);
                    let payload = rest[..end].to_vec();
                    rest = &rest[next..];
                    payload
                }
            };
            if header["type"] == ty {
                return Some(payload);
            }
        }
        None
    }
}

/// The end of the first line and where the next one starts.
fn line(bytes: &[u8]) -> (usize, usize) {
    match bytes.iter().position(|&b| b == b'\n') {
        Some(i) => (i, i + 1),
        None => (bytes.len(), bytes.len()),
    }
}

struct Ingest {
    port: u16,
    received: mpsc::Receiver<Request>,
}

impl Ingest {
    /// Answers every request with 200 until the test ends.
    fn start() -> Ingest {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, received) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut headers = Vec::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
                    }
                }
                let length = headers
                    .iter()
                    .find(|(n, _)| n == "content-length")
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                if reader.read_exact(&mut body).is_err() {
                    continue;
                }
                let mut stream = reader.into_inner();
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                );
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                let _ = sender.send(Request {
                    path,
                    headers,
                    body,
                });
            }
        });
        Ingest { port, received }
    }

    /// The first request that `wanted` accepts, within 30 seconds (others,
    /// such as client reports, are skipped).
    fn next_with(&self, wanted: impl Fn(&Request) -> bool) -> Request {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let request = self
                .received
                .recv_timeout(left)
                .expect("the ingest received the report in time");
            if wanted(&request) {
                return request;
            }
        }
    }
}
