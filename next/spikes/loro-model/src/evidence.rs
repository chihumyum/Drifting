//! Shared helpers for the evidence binaries: source fingerprint, machine
//! description (no paths, no user names), timing summaries.

use sha2::{Digest, Sha256};

/// Sources that define the measured behaviour, embedded at compile time so
/// the fingerprint does not depend on where the checkout lives.
const SOURCES: &[(&str, &str)] = &[
    ("Cargo.toml", include_str!("../Cargo.toml")),
    ("src/agent.rs", include_str!("agent.rs")),
    ("src/anchor.rs", include_str!("anchor.rs")),
    ("src/book.rs", include_str!("book.rs")),
    ("src/evidence.rs", include_str!("evidence.rs")),
    ("src/ids.rs", include_str!("ids.rs")),
    ("src/lib.rs", include_str!("lib.rs")),
    ("src/prose.rs", include_str!("prose.rs")),
    ("src/schema.rs", include_str!("schema.rs")),
    ("src/seed.rs", include_str!("seed.rs")),
    ("src/store.rs", include_str!("store.rs")),
    ("src/undo_cases.rs", include_str!("undo_cases.rs")),
    ("src/bin/p0c-bench.rs", include_str!("bin/p0c-bench.rs")),
    ("src/bin/p0c-crash.rs", include_str!("bin/p0c-crash.rs")),
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

/// Resident set size of this process in bytes, via `ps`.
pub fn rss_bytes() -> Option<u64> {
    let pid = std::process::id().to_string();
    command_output("ps", &["-o", "rss=", "-p", &pid])
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
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
        let i = ((n as f64 - 1.0) * q).round() as usize;
        s[i.min(n - 1)]
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
