//! Helpers for the evidence programs (`f2-bench`, `f2-crash`): a source
//! fingerprint, a machine description with no paths or user names, and
//! timing summaries. Not part of the storage API.

use sha2::{Digest, Sha256};

/// Sources that define the measured behaviour, embedded at compile time so
/// the fingerprint does not depend on where the checkout lives.
const SOURCES: &[(&str, &str)] = &[
    ("Cargo.toml", include_str!("../Cargo.toml")),
    (
        "migrations/0000_baseline.sql",
        include_str!("../migrations/0000_baseline.sql"),
    ),
    ("src/asset.rs", include_str!("asset.rs")),
    ("src/error.rs", include_str!("error.rs")),
    ("src/evidence.rs", include_str!("evidence.rs")),
    ("src/file_io.rs", include_str!("file_io.rs")),
    ("src/history.rs", include_str!("history.rs")),
    ("src/holder.rs", include_str!("holder.rs")),
    ("src/index.rs", include_str!("index.rs")),
    ("src/lib.rs", include_str!("lib.rs")),
    ("src/library.rs", include_str!("library.rs")),
    ("src/migrate.rs", include_str!("migrate.rs")),
    ("src/origin.rs", include_str!("origin.rs")),
    ("src/synthetic.rs", include_str!("synthetic.rs")),
    ("src/bin/f2-bench.rs", include_str!("bin/f2-bench.rs")),
    ("src/bin/f2-crash.rs", include_str!("bin/f2-crash.rs")),
];

pub fn source_fingerprint() -> String {
    let mut h = Sha256::new();
    for (name, body) in SOURCES {
        h.update(name.as_bytes());
        h.update([0]);
        h.update(body.as_bytes());
        h.update([0]);
    }
    format!("{:x}", h.finalize())
}

fn command_output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// CPU, memory and OS version; nothing that identifies the user.
pub fn machine() -> serde_json::Value {
    serde_json::json!({
        "cpu": command_output("sysctl", &["-n", "machdep.cpu.brand_string"]),
        "cores": std::thread::available_parallelism().map(|n| n.get()).ok(),
        "memoryBytes": command_output("sysctl", &["-n", "hw.memsize"]).and_then(|s| s.parse::<u64>().ok()),
        "os": std::env::consts::OS,
        "osVersion": command_output("sw_vers", &["-productVersion"]),
        "arch": std::env::consts::ARCH,
    })
}

#[derive(Debug, Clone)]
pub struct Summary {
    pub n: usize,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub mean: f64,
}

pub fn summarize(samples: &[f64]) -> Summary {
    let mut s = samples.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let n = s.len();
    let at = |q: f64| -> f64 {
        if n == 0 {
            return 0.0;
        }
        s[(((n as f64 - 1.0) * q).round() as usize).min(n - 1)]
    };
    Summary {
        n,
        p50: at(0.5),
        p95: at(0.95),
        max: s.last().copied().unwrap_or(0.0),
        mean: if n == 0 {
            0.0
        } else {
            s.iter().sum::<f64>() / n as f64
        },
    }
}

impl Summary {
    pub fn json(&self) -> serde_json::Value {
        let r = |x: f64| (x * 1000.0).round() / 1000.0;
        serde_json::json!({
            "n": self.n, "p50": r(self.p50), "p95": r(self.p95), "max": r(self.max), "mean": r(self.mean)
        })
    }
}

/// Check an evidence file against this build: same fingerprint, and the
/// given top-level keys present. Returns a description of the mismatch.
pub fn check(path: &std::path::Path, keys: &[&str]) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let got = v["sourceFingerprint"].as_str().unwrap_or_default();
    let want = source_fingerprint();
    if got != want {
        return Err(format!(
            "{} was generated from other sources ({got} != {want}); rerun the program",
            path.display()
        ));
    }
    for key in keys {
        if v.get(*key).is_none() {
            return Err(format!("{} lacks {key}", path.display()));
        }
    }
    Ok(())
}
