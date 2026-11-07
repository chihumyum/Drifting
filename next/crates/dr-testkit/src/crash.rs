//! The one crash harness: kill a writer process at random moments
//! (SIGKILL on Unix, TerminateProcess on Windows), reopen what it wrote,
//! and compare with a deterministic replay. P0-C and F2 each wrote one;
//! this is theirs, made generic.
//!
//! The writer is the test binary itself, run again with
//! [`CHILD_ENV`] set: one `#[test]` returns at once unless
//! [`child_root`] is `Some`, and then writes forever, reporting each step
//! it knows is durable through a [`Reporter`].
//!
//! ```no_run
//! use dr_testkit::crash::{self, Harness, Recovered};
//!
//! #[test]
//! fn writer() {
//!     let Some(root) = crash::child_root() else { return };
//!     let mut report = crash::Reporter::new();
//!     for step in 0.. {
//!         // … write step `step` durably under `root` …
//!         report.durable(step);
//!     }
//! }
//!
//! #[test]
//! fn killed_writer_recovers() {
//!     let dir = tempfile::tempdir().unwrap();
//!     let report = Harness::for_test("writer")
//!         .kills(10)
//!         .run(dir.path(), |kill, root| {
//!             // … reopen `root`, find the last step, compare with a replay …
//!             Ok(Recovered { step: 0 })
//!         })
//!         .unwrap();
//!     assert_eq!(report.kills, 10);
//! }
//! ```
//!
//! The harness checks the rule every store must keep: everything the writer
//! reported durable is there after the kill, and at most the one step it
//! was writing beyond that.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::evidence::Summary;
use crate::rng::Rng;

/// Set in the writer process: the directory to write in.
pub const CHILD_ENV: &str = "DR_TESTKIT_CRASH_CHILD";

const PREFIX: &str = "dr-crash ";

/// `Some(dir)` when this process is a writer the harness started.
pub fn child_root() -> Option<PathBuf> {
    std::env::var_os(CHILD_ENV).map(PathBuf::from)
}

/// The writer's side: one line per report, flushed at once, straight to
/// the standard output (not through the test harness's capture).
pub struct Reporter {
    out: std::io::Stdout,
}

impl Default for Reporter {
    fn default() -> Self {
        Self::new()
    }
}

impl Reporter {
    pub fn new() -> Self {
        let r = Self {
            out: std::io::stdout(),
        };
        r.line("ready");
        r
    }

    fn line(&self, s: &str) {
        let mut out = self.out.lock();
        let _ = writeln!(out, "{PREFIX}{s}");
        let _ = out.flush();
    }

    /// Step `step` is durable: a reopened store must have it.
    pub fn durable(&mut self, step: u64) {
        self.line(&format!("durable {step}"));
    }

    /// The writer enters a named phase (`compacting`); kills are counted by
    /// the last phase reported before them.
    pub fn phase(&mut self, name: &str) {
        self.line(&format!("phase {name}"));
    }
}

/// One kill, as the verifier sees it.
#[derive(Clone, Debug)]
pub struct Kill {
    pub index: usize,
    /// The last step reported durable, if any.
    pub durable: Option<u64>,
    /// The last phase reported after that step, or `between steps`.
    pub phase: String,
}

/// What the verifier found after reopening.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recovered {
    /// The last step the reopened store has, -1 for none.
    pub step: i64,
}

/// A harness run.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub kills: usize,
    pub by_phase: BTreeMap<String, usize>,
    /// Kills after which the store also had the step being written.
    pub one_step_beyond: usize,
    pub last_step: i64,
    /// Reopen and verify, per kill.
    pub verify_ms: Summary,
}

impl Report {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "kills": self.kills,
            "killsByPhase": self.by_phase,
            "lostDurableSteps": 0,
            "recoveredOneStepBeyondLastReport": self.one_step_beyond,
            "stepsAtEnd": self.last_step + 1,
            "verifyMs": self.verify_ms,
        })
    }
}

/// Kills a writer again and again.
#[derive(Clone, Debug)]
pub struct Harness {
    child_args: Vec<OsString>,
    kills: usize,
    delay_ms: (u64, u64),
    seed: u64,
    timeout: Duration,
}

impl Harness {
    /// Re-run this test binary with only the test `name` (the writer).
    pub fn for_test(name: &str) -> Self {
        Self::with_args(
            [name, "--exact", "--nocapture", "--test-threads=1"]
                .iter()
                .map(OsString::from)
                .collect(),
        )
    }

    /// Re-run this executable with `args` (a program's writer subcommand).
    pub fn with_args(args: Vec<OsString>) -> Self {
        Self {
            child_args: args,
            kills: 20,
            delay_ms: (5, 250),
            seed: 0x5EED,
            timeout: Duration::from_secs(60),
        }
    }

    pub fn kills(mut self, n: usize) -> Self {
        self.kills = n;
        self
    }

    /// Kill between `min` and `max` milliseconds after the writer is ready.
    pub fn delay_ms(mut self, min: u64, max: u64) -> Self {
        self.delay_ms = (min, max.max(min));
        self
    }

    pub fn seed(mut self, seed: u64) -> Self {
        self.seed = seed;
        self
    }

    /// Run: start the writer on `root`, kill it, call `verify`, repeat. The
    /// writer continues from what it finds each time; `verify` reopens,
    /// compares with a replay and returns the last step present.
    pub fn run(
        &self,
        root: &Path,
        mut verify: impl FnMut(&Kill, &Path) -> Result<Recovered, String>,
    ) -> Result<Report, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut rng = Rng::new(self.seed);
        let mut by_phase = BTreeMap::new();
        let mut beyond = 0;
        let mut last = -1;
        let mut verify_ms = Vec::new();
        for index in 0..self.kills {
            let mut child = Command::new(&exe)
                .args(&self.child_args)
                .env(CHILD_ENV, root)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("start the writer: {e}"))?;
            let lines = Arc::new(Mutex::new(Vec::<String>::new()));
            let stdout = child.stdout.take().ok_or("the writer has no stdout")?;
            let reader = {
                let lines = lines.clone();
                std::thread::spawn(move || {
                    for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Some(rest) = l.strip_prefix(PREFIX) {
                            lines
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .push(rest.to_string());
                        }
                    }
                })
            };
            let start = Instant::now();
            while lines.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
                if start.elapsed() > self.timeout {
                    let _ = child.kill();
                    return Err("the writer never reported ready".into());
                }
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("the writer exited before the kill: {status}"));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(
                self.delay_ms.0 + rng.below(self.delay_ms.1 - self.delay_ms.0 + 1),
            ));
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("the writer exited before the kill: {status}"));
            }
            child.kill().map_err(|e| format!("kill: {e}"))?;
            let _ = child.wait();
            let _ = reader.join();
            let lines = lines.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let durable = lines
                .iter()
                .rev()
                .find_map(|l| l.strip_prefix("durable ").and_then(|k| k.parse().ok()));
            let phase = match lines.last() {
                Some(l) if l.starts_with("phase ") => l["phase ".len()..].to_string(),
                _ => "between steps".to_string(),
            };
            *by_phase.entry(phase.clone()).or_insert(0) += 1;
            let kill = Kill {
                index,
                durable,
                phase,
            };
            let t = Instant::now();
            let got = verify(&kill, root).map_err(|e| format!("kill {index}: {e}"))?;
            verify_ms.push(t.elapsed().as_secs_f64() * 1e3);
            let reported = durable.map_or(-1, |d| d as i64);
            if got.step < reported {
                return Err(format!(
                    "kill {index}: lost durable step {reported} (reopened at {})",
                    got.step
                ));
            }
            if got.step > reported + 1 {
                return Err(format!(
                    "kill {index}: reopened at {} beyond the step being written ({})",
                    got.step,
                    reported + 1
                ));
            }
            beyond += usize::from(got.step == reported + 1);
            last = last.max(got.step);
        }
        Ok(Report {
            kills: self.kills,
            by_phase,
            one_step_beyond: beyond,
            last_step: last,
            verify_ms: Summary::of(&verify_ms),
        })
    }
}
