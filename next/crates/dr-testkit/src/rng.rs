//! The one deterministic random number generator of the test kit:
//! dr-samples' SplitMix64 (the samples' fixed ids come from it), re-exported
//! so the seed, the benchmarks and the crash harness keep using
//! `dr_testkit::rng::Rng`.

pub use dr_samples::rng::Rng;
