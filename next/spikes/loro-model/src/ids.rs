//! Deterministic randomness and ids.

use std::hash::{BuildHasher, Hasher};

/// SplitMix64: small, fast and deterministic across platforms.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
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

    /// A uuidv7-shaped id whose time part is `ms` and whose random part comes
    /// from this generator, so seeds are reproducible.
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

/// FNV-1a 64: a stable hash for deriving ids from strings.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// A random peer id from the OS-seeded std hasher. Peer ids must never
/// repeat across (device, document) pairs, so they are not derived from
/// anything deterministic.
pub fn random_peer_id() -> u64 {
    loop {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        h.write_u32(std::process::id());
        let v = h.finish();
        // Loro reserves u64::MAX; keep the top bit clear so no random peer can
        // equal a genesis peer (top bit set, see `genesis_peer`).
        let v = v & !(1 << 63);
        if v != 0 {
            return v;
        }
    }
}

/// The peer that writes a document's deterministic genesis change. The top
/// bit is set so it never collides with a random device peer. The genesis
/// version is part of the hash: two app versions with different genesis
/// content get different peers (a duplicate empty paragraph at worst), never
/// two different changes under one id.
pub fn genesis_peer(doc_id: &str, genesis_version: u32) -> u64 {
    let mut bytes = doc_id.as_bytes().to_vec();
    bytes.extend_from_slice(&genesis_version.to_le_bytes());
    (fnv1a64(&bytes) | (1 << 63)) & !1 // never u64::MAX
}
