//! Deterministic synthetic Chinese prose. No real book text: sentences are
//! drawn from a fixed character pool with a seeded generator, so the same seed
//! always yields the same corpus and the same fingerprint.

use prose_spike::doc::BlockKind;

/// xorshift64* — small, fast and stable across platforms.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    pub fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    pub fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
}

const POOL: &str = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理府研质名单志思资受南白变";

const NAMES: &[&str] = &[
    "林岚", "周默", "沈青", "许远", "陈立", "Lena", "K-7", "老韩", "苏晚", "阿禾",
];
const PLACES: &[&str] = &[
    "北站",
    "旧城",
    "河湾",
    "灯塔",
    "第三区",
    "Hotel Aurora",
    "盐田",
    "山口",
];

pub struct SynthChapter {
    pub title: String,
    pub paragraphs: Vec<(BlockKind, String)>,
}

impl SynthChapter {
    pub fn chars(&self) -> usize {
        self.paragraphs.iter().map(|(_, p)| p.chars().count()).sum()
    }
}

fn clause(rng: &mut Rng, pool: &[char], out: &mut String) {
    let len = rng.range(3, 14);
    for i in 0..len {
        if i == 1 && rng.chance(8) {
            out.push_str(NAMES[rng.below(NAMES.len())]);
        } else if i == 3 && rng.chance(4) {
            out.push_str(PLACES[rng.below(PLACES.len())]);
        } else if i == 2 && rng.chance(3) {
            out.push_str(&format!("{}", 1900 + rng.below(130)));
            out.push('年');
        } else {
            out.push(pool[rng.below(pool.len())]);
        }
    }
}

fn sentence(rng: &mut Rng, pool: &[char], out: &mut String) {
    let clauses = rng.range(1, 4);
    for c in 0..clauses {
        clause(rng, pool, out);
        if c + 1 < clauses {
            out.push(if rng.chance(85) { '，' } else { '、' });
        }
    }
    out.push(match rng.below(20) {
        0 => '！',
        1 => '？',
        2 => '…',
        _ => '。',
    });
}

fn paragraph(rng: &mut Rng, pool: &[char], target: usize) -> String {
    let mut out = String::new();
    let dialogue = rng.chance(18);
    if dialogue {
        out.push('“');
    }
    while out.chars().count() < target {
        sentence(rng, pool, &mut out);
    }
    if dialogue {
        out.push('”');
    }
    out
}

fn heading(rng: &mut Rng, pool: &[char]) -> String {
    let mut out = String::new();
    let len = rng.range(3, 10);
    for _ in 0..len {
        out.push(pool[rng.below(pool.len())]);
    }
    out
}

/// One chapter of about `target` characters. `long_paragraph` adds one
/// 5000-character paragraph in the middle (the IME matrix's long-paragraph case).
pub fn chapter(seed: u64, index: usize, target: usize, long_paragraph: bool) -> SynthChapter {
    let pool: Vec<char> = POOL.chars().collect();
    let mut rng = Rng::new(seed ^ ((index as u64 + 1) << 32));
    let mut paragraphs = Vec::new();
    let mut chars = 0;
    let mut placed_long = !long_paragraph;
    let mut kinds_seen = [false; 3];
    while chars < target {
        let roll = rng.below(100);
        let (kind, text) = if !placed_long && chars > target / 2 {
            placed_long = true;
            (BlockKind::Body, paragraph(&mut rng, &pool, 5000))
        } else if roll < 3 || (paragraphs.len() == 2 && !kinds_seen[0]) {
            kinds_seen[0] = true;
            (BlockKind::H1, heading(&mut rng, &pool))
        } else if roll < 7 || (paragraphs.len() == 9 && !kinds_seen[1]) {
            kinds_seen[1] = true;
            (BlockKind::H2, heading(&mut rng, &pool))
        } else if roll < 11 || (paragraphs.len() == 16 && !kinds_seen[2]) {
            kinds_seen[2] = true;
            (BlockKind::H3, heading(&mut rng, &pool))
        } else {
            let len = match rng.below(10) {
                0 => rng.range(8, 30),
                1..=6 => rng.range(40, 160),
                7 | 8 => rng.range(160, 320),
                _ => rng.range(320, 700),
            };
            (
                BlockKind::Body,
                paragraph(&mut rng, &pool, len.min(target - chars + 8)),
            )
        };
        chars += text.chars().count();
        paragraphs.push((kind, text));
    }
    SynthChapter {
        title: format!("第{}章　{}", index + 1, heading(&mut rng, &pool)),
        paragraphs,
    }
}

/// A book of `count` chapters, each 2–20 thousand characters, about `total`
/// characters in all (the heavy seed's prose: 100 chapters, 1.5 million).
pub fn book(seed: u64, count: usize, total: usize) -> Vec<SynthChapter> {
    let mut rng = Rng::new(seed);
    let raw: Vec<f64> = (0..count)
        .map(|_| {
            let u = (rng.below(1_000_000) as f64 + 0.5) / 1_000_000.0;
            2000.0 + 18000.0 * u.sqrt()
        })
        .collect();
    let sum: f64 = raw.iter().sum();
    let mut lengths: Vec<usize> = raw
        .iter()
        .map(|len| ((len * total as f64 / sum) as usize).clamp(2000, 20000))
        .collect();
    // Spread the rounding remainder over chapters with room.
    let mut remainder = total as i64 - lengths.iter().sum::<usize>() as i64;
    let mut ix = 0;
    while remainder != 0 && ix < count * 4 {
        let len = &mut lengths[ix % count];
        let step = remainder.signum() * remainder.abs().min(500);
        let next = (*len as i64 + step).clamp(2000, 20000);
        remainder -= next - *len as i64;
        *len = next as usize;
        ix += 1;
    }
    lengths
        .iter()
        .enumerate()
        .map(|(index, &len)| chapter(seed, index, len, index == 0))
        .collect()
}

/// FNV-1a 64 over titles, kinds and paragraphs.
pub fn fingerprint(chapters: &[SynthChapter]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for chapter in chapters {
        feed(chapter.title.as_bytes());
        for (kind, text) in &chapter.paragraphs {
            feed(&[kind.level().unwrap_or(0) as u8]);
            feed(text.as_bytes());
            feed(b"\n");
        }
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_sized() {
        let a = chapter(7, 0, 20_000, true);
        let b = chapter(7, 0, 20_000, true);
        assert_eq!(fingerprint(&[a]), fingerprint(&[b]));
        let one = chapter(7, 0, 20_000, true);
        assert!((20_000..21_000).contains(&one.chars()), "{}", one.chars());
        assert!(
            one.paragraphs
                .iter()
                .any(|(_, p)| p.chars().count() >= 5000)
        );
        for kind in [BlockKind::H1, BlockKind::H2, BlockKind::H3] {
            assert!(one.paragraphs.iter().any(|(k, _)| *k == kind));
        }
    }

    #[test]
    fn book_hits_the_heavy_seed_size() {
        let chapters = book(11, 100, 1_500_000);
        assert_eq!(chapters.len(), 100);
        let total: usize = chapters.iter().map(SynthChapter::chars).sum();
        assert!((1_500_000..1_520_000).contains(&total), "{total}");
        for chapter in &chapters {
            assert!(
                (2000..=26000).contains(&chapter.chars()),
                "{}",
                chapter.chars()
            );
        }
    }
}
