//! Hashes: SHA-256 for fingerprints (one function, used by the seed, the
//! evidence and the bench), FNV-1a for deriving ids and streams.

use sha2::{Digest, Sha256};

/// FNV-1a 64: stable across platforms and versions (dr-samples' own, which
/// its RNG streams use).
pub use crate::rng::fnv1a64;

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// A fingerprint over named parts, in the order given: each part is its name,
/// a NUL, its bytes and a NUL. Every fingerprint in the test kit (corpus,
/// sources) is one of these.
#[derive(Clone, Default)]
pub struct Fingerprint(Sha256);

impl Fingerprint {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn part(&mut self, name: &str, bytes: &[u8]) -> &mut Self {
        self.0.update(name.as_bytes());
        self.0.update([0]);
        self.0.update(bytes);
        self.0.update([0]);
        self
    }

    pub fn finish(&self) -> String {
        hex(&self.0.clone().finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        let mut a = Fingerprint::new();
        a.part("x", b"1").part("y", b"2");
        let mut b = Fingerprint::new();
        b.part("x", b"12").part("y", b"");
        assert_ne!(a.finish(), b.finish());
    }
}
