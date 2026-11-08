//! The Drifting 0.2 test kit (foundation F8).
//!
//! One of each thing every module's tests and measurements need:
//!
//! - [`seed`]: the deterministic seed generator, presets tiny / lite / heavy
//!   / showcase, written through dr-doc and optionally into a dr-store
//!   library; [`samples`]: the two sample books (dr-samples', which the
//!   product writes into a new library) and the showcase books from
//!   `fixtures/`;
//! - [`rng`], [`text`], [`digest`]: one random number generator, one
//!   synthetic corpus, one fingerprint (the generator, the book writer the
//!   seed uses and a body's paragraphs are dr-samples', re-exported here);
//! - [`evidence`]: measured evidence files and their freshness check
//!   (`cargo xtask evidence --check`); contract evidence is asserted by tests
//!   instead of committed;
//! - [`crash`]: kill a writer process at random moments, reopen, compare
//!   with a deterministic replay;
//! - [`bench`]: the benchmark convention (CI checks counts and shapes, the
//!   author's machine measures time) and the `bench` program.
//!
//! See `docs/rust-rewrite/foundations/f8-testkit.md`.

pub mod bench;
pub mod crash;
pub mod digest;
pub mod evidence;
pub mod rng;
pub mod samples;
pub mod seed;
pub mod text;
