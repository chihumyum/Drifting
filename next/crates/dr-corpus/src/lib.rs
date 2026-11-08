//! The text building blocks that need no store, shared by the built-in
//! sample books (`dr-samples`) and the test kit (`dr-testkit`):
//!
//! - [`rng`]: the one random number generator (SplitMix64; the samples'
//!   fixed ids and every seed come from it);
//! - [`para`]: a paragraph as the samples and the seed lay a book out;
//! - [`text`]: the synthetic corpus the seed and the tests write;
//! - [`digest`]: the one fingerprint.
//!
//! They are a crate of their own because both users write libraries
//! through dr-store, and dr-store's own tests need the random streams and
//! the corpus: a dev-dependency of dr-store on either would close a cycle
//! in the workspace graph. Cargo allows that, but dx's hot patching
//! (`cargo xtask dev --hot`) orders its rebuild by that graph,
//! dev-dependencies included, and stops at any cycle.
//!
//! Elsewhere use them as `dr_samples::{rng, para}` and
//! `dr_testkit::{rng, text, digest}`, which re-export these.

pub mod digest;
pub mod para;
pub mod rng;
pub mod text;
