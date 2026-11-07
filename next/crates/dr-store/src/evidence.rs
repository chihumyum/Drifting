//! What is left of F2's evidence helpers, kept only for `dr-index`'s
//! `dr-index-bench` example, which still imports `machine` and `summarize`.
//! Measured evidence is dr-testkit's now (`dr_testkit::evidence`); delete
//! this module once that example moves there. Not part of the storage API.

fn command_output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The 1-minute load average, where the OS reports one. Timings taken while
/// other work keeps the machine busy are several times longer.
pub fn load_average() -> Option<f64> {
    command_output("sysctl", &["-n", "vm.loadavg"])?
        .trim_matches(|c| c == '{' || c == '}' || c == ' ')
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// CPU, memory, OS version and current load; nothing that identifies the
/// user.
pub fn machine() -> serde_json::Value {
    serde_json::json!({
        "loadAverage1m": load_average(),
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
