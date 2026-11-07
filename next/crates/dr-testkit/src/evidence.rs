//! Acceptance evidence for `next/` (simplifications.md §5).
//!
//! Two kinds, and only two:
//!
//! - **Contract evidence** (shapes, schemas, inventories) is never
//!   committed: the test that would have generated a JSON file asserts the
//!   same facts instead. When a human should review a diff (the command
//!   inventory), the test keeps an `insta` snapshot next to it, as
//!   dr-workspace does.
//! - **Measured evidence** (timings, memory) is committed only at a
//!   milestone or as a before/after pair, named `<milestone>-<name>.json`,
//!   in `docs/rust-rewrite/acceptance/`. Its fingerprint covers just what
//!   the numbers depend on: the corpus generator, the bench and the crate
//!   under test ([`Evidence::inputs`]). When one of those changes the file
//!   is reported **stale**, never failed: measurements are not refreshed
//!   after a merge.
//!
//! `cargo xtask evidence --check` (and `cargo xtask check`) runs [`check_dir`]
//! over every file; CI runs it on every change.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::digest::Fingerprint;

/// The `schema` of a measured evidence file.
pub const SCHEMA: &str = "dr-testkit/evidence/1";

/// Where measured evidence lives, relative to the `next/` workspace.
pub const DIR: &str = "../docs/rust-rewrite/acceptance";

/// The `next/` workspace directory of this checkout (compile-time).
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A measured evidence file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub schema: String,
    /// What was measured, `kebab-case` (`store-bench`).
    pub name: String,
    /// The milestone it was taken at (`f8-m1`), or `before-<x>` /
    /// `after-<x>` for an optimisation pair.
    pub milestone: String,
    /// The command that wrote it.
    pub generated_by: String,
    /// Fingerprint of each input (a file or directory under `next/`), so a
    /// stale report names what changed.
    pub inputs: BTreeMap<String, String>,
    /// The corpus: preset, seed and corpus fingerprint ([`crate::seed::Shape`]).
    pub corpus: Value,
    /// CPU, memory, OS and load; no paths or user names.
    pub machine: Value,
    pub results: Value,
}

impl Evidence {
    pub fn new(name: &str, milestone: &str, generated_by: &str) -> Self {
        Self {
            schema: SCHEMA.into(),
            name: name.into(),
            milestone: milestone.into(),
            generated_by: generated_by.into(),
            inputs: BTreeMap::new(),
            corpus: Value::Null,
            machine: machine(),
            results: Value::Null,
        }
    }

    /// Fingerprint `paths` (relative to `root`, the `next/` workspace) as
    /// this evidence's inputs.
    pub fn inputs(mut self, root: &Path, paths: &[&str]) -> std::io::Result<Self> {
        for p in paths {
            self.inputs
                .insert((*p).to_string(), fingerprint_path(root, p)?);
        }
        Ok(self)
    }

    pub fn file_name(&self) -> String {
        format!("{}-{}.json", self.milestone, self.name)
    }

    /// Write into `dir` as `<milestone>-<name>.json`.
    pub fn write(&self, dir: &Path) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(self.file_name());
        let mut s = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        s.push('\n');
        std::fs::write(&path, s)?;
        Ok(path)
    }
}

/// The fingerprint of one input: a file, or every file under a directory
/// (sorted, `target/` and dot files skipped), each as its `/`-separated
/// path and its bytes with `\r\n` read as `\n` (a Windows checkout hashes
/// the same).
pub fn fingerprint_path(root: &Path, rel: &str) -> std::io::Result<String> {
    let full = root.join(rel);
    let mut files = Vec::new();
    collect(&full, Path::new(rel), &mut files)?;
    if files.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("evidence input {rel} has no files"),
        ));
    }
    files.sort();
    let mut fp = Fingerprint::new();
    for f in files {
        let bytes = std::fs::read(root.join(&f))?;
        let name = f.to_string_lossy().replace('\\', "/");
        fp.part(&name, &normalize_newlines(&bytes));
    }
    Ok(fp.finish())
}

fn normalize_newlines(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn collect(full: &Path, rel: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let meta = std::fs::metadata(full)?;
    if meta.is_file() {
        out.push(rel.to_path_buf());
        return Ok(());
    }
    for entry in std::fs::read_dir(full)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s.starts_with('.') || name_s == "target" {
            continue;
        }
        collect(&entry.path(), &rel.join(&name), out)?;
    }
    Ok(())
}

/// What checking one evidence file found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Measured evidence whose inputs are unchanged.
    Fresh,
    /// Measured evidence taken from other sources: these inputs changed
    /// (or disappeared). Reported, not failed.
    Stale(Vec<String>),
    /// JSON in the evidence directory written before this module (P0, F1,
    /// F2, F4, M10): checked by its own program until its owner moves it
    /// here.
    Legacy,
    /// Not valid evidence: the reason. Fails the check.
    Invalid(String),
}

/// One file's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    pub file: String,
    pub status: Status,
}

/// Check every `*.json` in `dir` against the `next/` workspace at `root`.
pub fn check_dir(root: &Path, dir: &Path) -> std::io::Result<Vec<Checked>> {
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    Ok(names
        .into_iter()
        .map(|file| {
            let status = check_file(root, &dir.join(&file));
            Checked { file, status }
        })
        .collect())
}

/// Check one evidence file.
pub fn check_file(root: &Path, path: &Path) -> Status {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => return Status::Invalid(e.to_string()),
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Status::Invalid(format!("not JSON: {e}")),
    };
    if value.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
        return Status::Legacy;
    }
    let ev: Evidence = match serde_json::from_value(value) {
        Ok(e) => e,
        Err(e) => return Status::Invalid(format!("not {SCHEMA}: {e}")),
    };
    let file = path
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    if file != ev.file_name() {
        return Status::Invalid(format!("should be named {}", ev.file_name()));
    }
    if ev.inputs.is_empty() {
        return Status::Invalid("names no inputs".into());
    }
    if ev.results.is_null() || ev.machine.is_null() {
        return Status::Invalid("has no results or no machine".into());
    }
    if let Some(bad) = ev
        .inputs
        .keys()
        .find(|p| p.starts_with('/') || p.contains(':') || p.contains(".."))
    {
        return Status::Invalid(format!("input {bad} is not a path inside next/"));
    }
    let changed: Vec<String> = ev
        .inputs
        .iter()
        .filter(|(p, want)| fingerprint_path(root, p).ok().as_ref() != Some(*want))
        .map(|(p, _)| p.clone())
        .collect();
    if changed.is_empty() {
        Status::Fresh
    } else {
        Status::Stale(changed)
    }
}

fn command_output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The one-minute load average where the OS reports it: timings taken
/// while other work keeps the machine busy are several times longer.
pub fn load_average() -> Option<f64> {
    command_output("sysctl", &["-n", "vm.loadavg"])?
        .trim_matches(|c| c == '{' || c == '}' || c == ' ')
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// CPU, cores, memory, OS and load: nothing that identifies the user.
pub fn machine() -> Value {
    serde_json::json!({
        "cpu": command_output("sysctl", &["-n", "machdep.cpu.brand_string"]),
        "cores": std::thread::available_parallelism().map(|n| n.get()).ok(),
        "memoryBytes": command_output("sysctl", &["-n", "hw.memsize"]).and_then(|s| s.parse::<u64>().ok()),
        "os": std::env::consts::OS,
        "osVersion": command_output("sw_vers", &["-productVersion"]),
        "arch": std::env::consts::ARCH,
        "loadAverage1m": load_average(),
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
    })
}

/// Percentiles of a set of samples (milliseconds, usually).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Summary {
    pub n: usize,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub mean: f64,
}

impl Summary {
    pub fn of(samples: &[f64]) -> Self {
        let mut s = samples.to_vec();
        s.sort_by(|a, b| a.total_cmp(b));
        let n = s.len();
        let at = |q: f64| {
            if n == 0 {
                0.0
            } else {
                s[(((n as f64 - 1.0) * q).round() as usize).min(n - 1)]
            }
        };
        let r = |x: f64| (x * 1000.0).round() / 1000.0;
        Self {
            n,
            p50: r(at(0.5)),
            p95: r(at(0.95)),
            max: r(s.last().copied().unwrap_or(0.0)),
            mean: r(if n == 0 {
                0.0
            } else {
                s.iter().sum::<f64>() / n as f64
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_evidence(root: &Path, dir: &Path) -> PathBuf {
        let mut e = Evidence::new("probe", "f8-test", "test")
            .inputs(root, &["src/a.rs", "src/sub"])
            .unwrap();
        e.results = serde_json::json!({ "ms": 1.0 });
        e.write(dir).unwrap()
    }

    #[test]
    fn measured_evidence_goes_stale_and_legacy_files_are_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("next");
        let dir = tmp.path().join("acceptance");
        std::fs::create_dir_all(root.join("src/sub")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() {}\r\n").unwrap();
        std::fs::write(root.join("src/sub/b.rs"), "fn b() {}\n").unwrap();
        let path = write_evidence(&root, &dir);
        assert_eq!(path.file_name().unwrap(), "f8-test-probe.json");
        std::fs::write(dir.join("p0-old.json"), "{\"probe\": 1}").unwrap();
        let got = check_dir(&root, &dir).unwrap();
        assert_eq!(got[0].status, Status::Fresh);
        assert_eq!(got[1].status, Status::Legacy);

        // Line endings do not matter; content does.
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        assert_eq!(check_file(&root, &path), Status::Fresh);
        std::fs::write(root.join("src/sub/b.rs"), "fn b() { 1; }\n").unwrap();
        assert_eq!(
            check_file(&root, &path),
            Status::Stale(vec!["src/sub".into()])
        );

        // A renamed file is invalid, so is one without inputs.
        std::fs::rename(&path, dir.join("other.json")).unwrap();
        assert!(matches!(
            check_file(&root, &dir.join("other.json")),
            Status::Invalid(_)
        ));
    }

    #[test]
    fn summaries_pick_nearest_ranks() {
        let s = Summary::of(&[3.0, 1.0, 2.0, 4.0]);
        assert_eq!((s.n, s.p50, s.max, s.mean), (4, 3.0, 4.0, 2.5));
        assert_eq!(Summary::of(&[]).n, 0);
    }
}
