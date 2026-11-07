//! The gates `cargo xtask check` runs (simplifications.md §6).

use crate::repo::Repo;

mod audit;
mod evidence;
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
/// benchmark rather than product code: text gates on copy skip these.
pub fn is_test_path(path: &str) -> bool {
    path.split('/')
        .any(|seg| seg == "tests" || seg == "fixtures" || seg == "benches" || seg == "fuzz")
}
