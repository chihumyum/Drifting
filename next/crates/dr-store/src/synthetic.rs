//! Deterministic synthetic text and edits for tests, the crash probe and the
//! benchmark. No manuscript text: characters are drawn from a fixed pool.
//! Not part of the storage API.

use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};

/// SplitMix64: small, fast and the same on every platform.
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
}

const POOL: &str = "春夏秋冬风花雪月山川河流日月星辰云雨江湖人间天地长短来去说话走看";

fn pool() -> Vec<char> {
    POOL.chars().collect()
}

/// `n` characters from the pool.
pub fn han(rng: &mut Rng, n: usize) -> String {
    let p = pool();
    (0..n)
        .map(|_| p[rng.below(p.len() as u64) as usize])
        .collect()
}

/// A chapter of about `chars` characters in paragraphs of 60–300, each
/// ending with `\n`.
pub fn chapter(rng: &mut Rng, chars: usize) -> String {
    let mut s = String::with_capacity(chars * 3 + chars / 60);
    let mut written = 0;
    while written < chars {
        let n = rng.range(60, 300).min(chars - written).max(1);
        s.push_str(&han(rng, n));
        s.push('\n');
        written += n;
    }
    s
}

/// A style configuration shaped like loro-schema v0 (paragraph attributes
/// without expansion, bold expanding after), for documents in tests.
pub fn configure(doc: &LoroDoc) {
    let mut map = StyleConfigMap::new();
    map.insert(
        "heading".into(),
        StyleConfig {
            expand: ExpandType::None,
        },
    );
    map.insert(
        "bold".into(),
        StyleConfig {
            expand: ExpandType::After,
        },
    );
    doc.config_text_style(map);
}

/// The text container edits go to.
pub const BODY: &str = "body";

/// Edit number `k` of the crash probe: a pure function of `k` and the
/// document, so a replay of edits `0..=k` reproduces the document exactly.
/// Records `k` in `meta.k`.
pub fn crash_edit(doc: &LoroDoc, k: i64) {
    let mut r = Rng::new(0xC0FF_EE00 ^ k as u64);
    let text = doc.get_text(BODY);
    if k == 0 {
        // A large first edit so snapshots (and compactions) take real time.
        text.insert(0, &chapter(&mut r, 30_000)).expect("insert");
        text.insert(text.len_unicode(), "\n").expect("insert");
    } else {
        let len = text.len_unicode();
        let last = len.saturating_sub(1);
        match r.below(10) {
            0..=5 => {
                let n = r.range(1, 12);
                let s = han(&mut r, n);
                text.insert(r.range(0, last), &s).expect("insert");
            }
            6 | 7 => {
                let at = r.range(0, last.saturating_sub(1));
                let n = r.range(1, 30).min(last - at);
                if n > 0 {
                    text.delete(at, n).expect("delete");
                }
            }
            8 => {
                text.insert(r.range(0, last), "\n").expect("split");
            }
            _ => {
                let at = r.range(0, last.saturating_sub(1));
                let n = r.range(1, 40).min(last - at);
                if n > 0 {
                    text.mark(at..at + n, "bold", true).expect("mark");
                }
            }
        }
    }
    doc.get_map("meta").insert("k", k).expect("meta");
}

/// The last crash edit recorded in a document, or -1.
pub fn last_crash_edit(doc: &LoroDoc) -> i64 {
    match doc.get_map("meta").get("k") {
        Some(loro::ValueOrContainer::Value(loro::LoroValue::I64(k))) => k,
        _ => -1,
    }
}

/// One keystroke-sized edit: insert 1–6 characters, or (one time in six)
/// delete 1–3, near `cursor`. Returns the new cursor.
pub fn keystroke(doc: &LoroDoc, rng: &mut Rng, cursor: usize) -> usize {
    let text = doc.get_text(BODY);
    let len = text.len_unicode();
    let at = cursor.min(len.saturating_sub(1));
    if rng.below(6) == 0 && at > 3 {
        let n = rng.range(1, 3);
        text.delete(at - n, n).expect("delete");
        at - n
    } else {
        let n = rng.range(1, 6);
        let s = han(rng, n);
        text.insert(at, &s).expect("insert");
        at + s.chars().count()
    }
}

/// A deriver for tests and benchmarks: one block per line of `body`, no
/// block ids, every character a word. Counts its calls and how many of them
/// were given diffs.
#[derive(Default)]
pub struct LinesDeriver {
    pub calls: std::sync::atomic::AtomicUsize,
    pub with_changes: std::sync::atomic::AtomicUsize,
}

impl crate::index::Deriver for LinesDeriver {
    fn derive(&self, input: &crate::index::DeriveInput<'_>) -> Option<crate::index::DerivedUpdate> {
        use std::sync::atomic::Ordering;
        self.calls.fetch_add(1, Ordering::Relaxed);
        if input.changes.is_some() {
            self.with_changes.fetch_add(1, Ordering::Relaxed);
        }
        let text = input.doc.get_text(BODY).to_string();
        let blocks: Vec<crate::index::BlockRow> = text
            .split_terminator('\n')
            .map(|line| crate::index::BlockRow {
                block_id: None,
                heading: 0,
                chars: line.chars().count() as u32,
                text: line.to_string(),
            })
            .collect();
        let chars = blocks.iter().map(|b| b.chars as u64).sum();
        Some(crate::index::DerivedUpdate::Full(crate::index::Derived {
            words: chars,
            chars,
            blocks,
            references: Vec::new(),
        }))
    }
}
