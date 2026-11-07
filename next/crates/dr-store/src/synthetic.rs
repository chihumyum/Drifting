//! What is left of F2's own synthetic text, kept only for
//! `dr-index`'s `dr-index-bench` example, which still imports it. dr-store's
//! tests use dr-testkit's seeds; delete this module once that example moves
//! to dr-testkit. No manuscript text: characters are drawn from a fixed pool.
//! Not part of the storage API.

use loro::LoroDoc;

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

/// The text container edits go to.
pub const BODY: &str = "body";

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
