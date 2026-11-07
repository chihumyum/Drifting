//! Vulnerability audit (rule 5): `cargo audit` over `next/Cargo.lock`
//! against the RustSec database. A vulnerability fails; unmaintained,
//! unsound and yanked notices are listed. An advisory database that cannot
//! be fetched fails too. Needs cargo-audit (CI installs it):
//! `cargo install cargo-audit --version 0.22.2 --locked`.

use serde_json::Value;

use super::Outcome;
use crate::repo::Repo;

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = std::process::Command::new(cargo)
        .current_dir(&repo.next)
        .args(["audit", "--file", "Cargo.lock", "--json"])
        .output()
        .map_err(|e| format!("cargo audit: {e}"))?;
    let report: Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("no such command") {
                return Err(
                    "cargo-audit is not installed: cargo install cargo-audit --version 0.22.2 --locked (or skip with --skip audit)"
                        .into(),
                );
            }
            return Err(format!("cargo audit did not run: {}", stderr.trim()));
        }
    };
    summarize(&report, &mut o);
    Ok(o)
}

pub fn summarize(report: &Value, o: &mut Outcome) {
    let vulns = report["vulnerabilities"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for v in &vulns {
        let patched = v["versions"]["patched"]
            .as_array()
            .map(|p| {
                p.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "no patched version".into());
        o.fail(format!(
            "{} {} {}: {} (fixed in {patched})",
            v["advisory"]["id"].as_str().unwrap_or("?"),
            v["package"]["name"].as_str().unwrap_or("?"),
            v["package"]["version"].as_str().unwrap_or("?"),
            v["advisory"]["title"].as_str().unwrap_or("?"),
        ));
    }
    let mut notices = 0;
    if let Some(w) = report["warnings"].as_object() {
        for (kind, list) in w {
            for n in list.as_array().into_iter().flatten() {
                notices += 1;
                o.note(format!(
                    "{kind} {} {} {}",
                    n["advisory"]["id"].as_str().unwrap_or(""),
                    n["package"]["name"].as_str().unwrap_or("?"),
                    n["package"]["version"].as_str().unwrap_or("?"),
                ));
            }
        }
    }
    let deps = report["lockfile"]["dependency-count"].as_u64().unwrap_or(0);
    o.summary = format!(
        "{deps} locked crates, {} vulnerabilities, {notices} notices",
        vulns.len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vulnerabilities_fail_and_warnings_are_notes() {
        let report = serde_json::json!({
            "lockfile": { "dependency-count": 3 },
            "vulnerabilities": { "list": [{
                "advisory": { "id": "RUSTSEC-0000-0001", "title": "bad" },
                "package": { "name": "x", "version": "1.0.0" },
                "versions": { "patched": [">=1.0.1"] }
            }]},
            "warnings": { "unmaintained": [{ "advisory": { "id": "RUSTSEC-0000-0002" }, "package": { "name": "y", "version": "0.1.0" } }] }
        });
        let mut o = Outcome::default();
        summarize(&report, &mut o);
        assert_eq!(o.failures.len(), 1);
        assert!(o.failures[0].contains("fixed in >=1.0.1"));
        assert_eq!(o.notes.len(), 1);
    }
}
