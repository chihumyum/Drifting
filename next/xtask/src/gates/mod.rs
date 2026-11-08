//! The gates `cargo xtask check` runs (simplifications.md §6).

use crate::repo::Repo;

mod audit;
pub mod debug_bridge;
mod evidence;
pub mod hot_reload;
mod large_files;
mod layers;
mod licenses;
pub mod metadata;
mod migrations;
mod privacy;
mod retired;
mod terms;

/// What one gate found.
#[derive(Debug, Default)]
pub struct Outcome {
    /// Each one fails the check.
    pub failures: Vec<String>,
    /// Printed, never failing (stale evidence, audit notices).
    pub notes: Vec<String>,
    /// One line on what was checked.
    pub summary: String,
}

impl Outcome {
    pub fn fail(&mut self, msg: impl Into<String>) {
        self.failures.push(msg.into());
    }

    pub fn note(&mut self, msg: impl Into<String>) {
        self.notes.push(msg.into());
    }
}

/// A gate.
pub struct Gate {
    pub name: &'static str,
    pub about: &'static str,
    pub run: fn(&Repo) -> Result<Outcome, String>,
}

/// Every gate, in the order they run.
pub fn all() -> Vec<Gate> {
    vec![
        Gate {
            name: "privacy",
            about: "no personal paths, credentials or attribution lines in next/ and docs/rust-rewrite/ (untracked files too)",
            run: privacy::run,
        },
        Gate {
            name: "large-files",
            about: "no binary file over 1 MiB in next/ or docs/rust-rewrite/",
            run: large_files::run,
        },
        Gate {
            name: "retired",
            about: "retired products stay out of next/",
            run: retired::run,
        },
        Gate {
            name: "terms",
            about: "构想 / Ideas; H1/H2/H3 keep their own names in copy, prompts and export",
            run: terms::run,
        },
        Gate {
            name: "migrations",
            about: "published migrations are pinned by hash",
            run: migrations::run,
        },
        Gate {
            name: "licenses",
            about: "AGPL by default, permissive crates use no dr-* crate, third-party licenses on the allow list",
            run: licenses::run,
        },
        Gate {
            name: "layers",
            about: "dependencies point from the interface to application services to data",
            run: layers::run,
        },
        Gate {
            name: "debug-bridge",
            about: "the debug bridge is opt-in: no default feature or release script turns it on",
            run: debug_bridge::run,
        },
        Gate {
            name: "hot-reload",
            about: "GPUI's hot reload is opt-in (no default feature or release script turns it on); no dependency cycle, dev-dependencies counted (dx patches in that order)",
            run: hot_reload::run,
        },
        Gate {
            name: "evidence",
            about: "measured evidence is well-formed (stale is reported, not failed)",
            run: evidence::run,
        },
        Gate {
            name: "audit",
            about: "cargo audit of next/Cargo.lock: no known vulnerability",
            run: audit::run,
        },
    ]
}

/// Whether `path` (from the repository root) is a test, a fixture or a
/// benchmark rather than product code: text gates on copy skip these. A
/// benchmark kept as an example (`examples/*bench*.rs`, or a file under
/// `examples/<…bench…>/`) is a benchmark.
pub fn is_test_path(path: &str) -> bool {
    let segs: Vec<&str> = path.split('/').collect();
    segs.iter()
        .any(|s| matches!(*s, "tests" | "fixtures" | "benches" | "fuzz"))
        || segs
            .iter()
            .position(|s| *s == "examples")
            .is_some_and(|i| segs[i + 1..].iter().any(|s| s.contains("bench")))
}

#[cfg(test)]
mod tests {
    use super::is_test_path;

    #[test]
    fn tests_fixtures_and_benchmarks_are_not_product_code() {
        for p in [
            "next/crates/a/tests/x.rs",
            "next/crates/a/fixtures/b.json",
            "next/crates/a/examples/index-bench.rs",
            "next/crates/dr-editor/examples/prose-bench/corpus.rs",
            "next/crates/dr-doc/fuzz/fuzz_targets/a.rs",
        ] {
            assert!(is_test_path(p), "{p}");
        }
        for p in [
            "next/crates/a/src/bench.rs",
            "next/crates/a/examples/gallery.rs",
            "next/crates/dr-ui/examples/gallery/main.rs",
        ] {
            assert!(!is_test_path(p), "{p}");
        }
    }
}
