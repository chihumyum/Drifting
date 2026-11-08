//! The part of the test kit (F8) that needs no store: one random number
//! generator ([`rng`]), one synthetic corpus ([`text`]) and one fingerprint
//! ([`digest`]).
//!
//! They are a crate of their own so that dr-store's tests can use them: the
//! rest of `dr-testkit` (seeds, samples, the crash harness, benches) writes
//! libraries through dr-store, and a dev-dependency of dr-store on it would
//! close a cycle in the workspace graph. Cargo allows that, but dx's hot
//! patching (`cargo xtask dev --hot`) sorts the crates it recompiles by
//! that graph, dev-dependencies included, and stops at any cycle.
//!
//! Use them as `dr_testkit::{rng, text, digest}` everywhere except in
//! crates `dr-testkit` itself depends on.

pub mod digest;
pub mod rng;
pub mod text;
