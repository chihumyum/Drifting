//! Peer ids.
//!
//! Three kinds share the 64-bit space without overlapping:
//!
//! | kind | top bit | how it is made |
//! | --- | --- | --- |
//! | genesis peer | set | hash of (document id, genesis version) |
//! | import peer | clear, lowest bit set | hash of `import:<document id>` |
//! | device peer | clear | random, persisted per (device, document) by storage (F2) |
//!
//! A device peer must never be derived from anything deterministic, and a
//! library copied or restored from a backup must rotate its peers (storage's
//! epoch, `loro-schema.md` "对等方 ID").

use std::hash::{BuildHasher, Hasher};

/// A Loro peer id.
pub type PeerId = u64;

const TOP: u64 = 1 << 63;

/// FNV-1a 64: stable across platforms and versions.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The peer that writes a document's genesis change. The genesis version is
/// part of the hash, so a change of genesis content gets a new peer (a
/// duplicate empty paragraph at worst), never two different changes under one
/// op id. Never `u64::MAX`, which Loro reserves.
pub fn genesis_peer(doc_id: &str, genesis_version: u32) -> PeerId {
    let mut bytes = doc_id.as_bytes().to_vec();
    bytes.extend_from_slice(&genesis_version.to_le_bytes());
    (fnv1a64(&bytes) | TOP) & !1
}

/// The deterministic peer an import (old library, `.driftingbook`) writes a
/// document with, so the same library imported on two devices produces
/// identical changes that Loro dedupes.
pub fn import_peer(doc_id: &str) -> PeerId {
    (fnv1a64(format!("import:{doc_id}").as_bytes()) & !TOP) | 1
}

/// Whether `peer` may be used as a device's own peer: not reserved by Loro,
/// not zero, top bit clear (so never a genesis peer).
pub fn is_device_peer(peer: PeerId) -> bool {
    peer != 0 && peer & TOP == 0
}

/// A random device peer (top bit clear). Storage allocates and persists these;
/// this helper is for tests and tools.
pub fn random_device_peer() -> PeerId {
    loop {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        h.write_u32(std::process::id());
        let v = h.finish() & !TOP;
        if v != 0 {
            return v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_kinds_do_not_overlap() {
        let g = genesis_peer("node:x", 1);
        assert_eq!(g, genesis_peer("node:x", 1));
        assert_ne!(g, genesis_peer("node:x", 0));
        assert_ne!(g, genesis_peer("node:y", 1));
        assert!(!is_device_peer(g));
        assert_ne!(g, u64::MAX);
        let i = import_peer("node:x");
        assert!(is_device_peer(i));
        assert_eq!(i & 1, 1);
        let r = random_device_peer();
        assert!(is_device_peer(r));
        assert_ne!(r, random_device_peer());
    }
}
