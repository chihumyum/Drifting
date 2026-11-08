//! The one deterministic random number generator: the samples' fixed ids
//! come from it, and dr-testkit's seed generator uses the same one
//! (`dr_testkit::rng` re-exports it).
//!
//! SplitMix64, as `dr-store`'s synthetic data and the P0-C seed already
//! used: small, fast, the same on every platform and Rust version. The
//! P0-B / F4 corpus used xorshift64*; it moves here when F4 adopts the seed
//! (its corpus fingerprint changes once, at that milestone).

/// FNV-1a 64: stable across platforms and versions (deriving streams and
/// ids; `dr_testkit::digest` re-exports it).
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// An independent stream for `(seed, label, index)`: generating one
    /// body never shifts the randomness of another, so adding a kind of
    /// entity leaves every existing body unchanged.
    pub fn stream(seed: u64, label: &str, index: u64) -> Self {
        let mut r = Self(seed ^ fnv1a64(label.as_bytes()));
        let a = r.next_u64();
        Self(a ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        ((self.next_u64() as u128 * n as u128) >> 64) as u64
    }

    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below((hi - lo + 1) as u64) as usize
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    /// A uuidv7-shaped id with time part `ms`; the rest comes from this
    /// generator, so ids are reproducible and still parse as uuidv7.
    pub fn uuid7(&mut self, ms: u64) -> String {
        let r = self.next_u64();
        let r2 = self.next_u64();
        let time_hi = (ms >> 16) & 0xFFFF_FFFF;
        let time_lo = ms & 0xFFFF;
        let ver = 0x7000 | (r & 0x0FFF);
        let var = 0x8000 | ((r >> 12) & 0x3FFF);
        let node = r2 & 0xFFFF_FFFF_FFFF;
        format!("{time_hi:08x}-{time_lo:04x}-{ver:04x}-{var:04x}-{node:012x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_matches_the_reference_sequence() {
        // The first outputs of SplitMix64 seeded with 0 (Vigna's reference).
        let mut r = Rng::new(0);
        assert_eq!(r.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(r.next_u64(), 0x6E78_9E6A_A1B9_65F4);
    }

    #[test]
    fn streams_are_independent_and_stable() {
        let a = Rng::stream(1, "chapter", 0).next_u64();
        let b = Rng::stream(1, "chapter", 1).next_u64();
        let c = Rng::stream(1, "element", 0).next_u64();
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, Rng::stream(1, "chapter", 0).next_u64());
    }

    #[test]
    fn ids_are_uuid_v7() {
        let id = Rng::new(7).uuid7(1_762_000_000_000);
        assert!(dr_model::id::is_uuid_v7(&id), "{id}");
    }

    #[test]
    fn fnv1a64_of_nothing_is_the_offset_basis() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    }
}
