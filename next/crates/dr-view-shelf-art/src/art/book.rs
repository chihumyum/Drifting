//! The book as every cover style reads it (the 0.1 client's
//! `lib/shelf-cover/book.ts`): its chapters in reading order, how long each
//! runs next to the book's usual chapter, and each storyline's colour and
//! the chapters it carries. A book whose storylines carry no chapter yet is
//! read as one neutral strand through the whole book, so its cover still
//! shows its length.

use super::paint::{H, Rand, Rgb, WF, hex_color};

/// What a cover is drawn from.
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct CoverRequest {
    pub seed: u32,
    /// Chapters in the book, in reading order.
    pub chapters: usize,
    /// Each storyline's colour and chapters (indexes in reading order), in
    /// the author's order, at most [`MAX_STORYLINES`].
    pub storylines: Vec<StorylineCover>,
    /// Each chapter's words, in reading order.
    pub words: Vec<u64>,
    /// The title is written in Latin letters (the type a cover of
    /// characters sets).
    pub latin: bool,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct StorylineCover {
    /// `#rrggbb`.
    pub color: String,
    pub chapters: Vec<usize>,
}

/// The shelf draws at most this many storylines on a cover.
pub const MAX_STORYLINES: usize = 6;

/// A stable seed for a book from its id (FNV-1a over UTF-16 units, as the
/// 0.1 client's `coverSeed`).
pub fn cover_seed(id: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for unit in id.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Whether a title is written in Latin letters (its first letter is one).
pub fn is_latin(title: &str) -> bool {
    title
        .chars()
        .find(|c| c.is_alphanumeric())
        .is_some_and(|c| c.is_ascii_alphabetic())
}

pub struct Strand {
    pub rgb: Rgb,
    /// 1 for each chapter the storyline carries.
    pub on: Vec<u8>,
    /// Its presence down the book, softened, one value per row of the cover.
    pub level: Vec<f32>,
    pub neutral: bool,
}

pub struct CoverBook {
    pub chapters: usize,
    pub words: Vec<f32>,
    /// Each chapter's words over the book's mean (1 when nothing is counted).
    pub wn: Vec<f32>,
    /// `wn` down the book, softened, one value per row of the cover.
    pub word_level: Vec<f32>,
    pub strands: Vec<Strand>,
    pub latin: bool,
}

/// What a full-colour style draws: the whole cover, and whether it is dark
/// under the title.
pub type ArtStyle = fn(&mut super::paint::Ctx, &CoverBook, &mut Rand) -> bool;

/// A storyline's presence, softened, in `samples` steps down the book;
/// `own: None` is a neutral presence throughout; `weights` scale its
/// chapters.
pub fn presence(
    samples: usize,
    chapters: usize,
    own: Option<&[usize]>,
    weights: Option<&[f32]>,
) -> Vec<f32> {
    let n = chapters.max(1);
    let mut level = vec![0.0f32; n];
    match own {
        None => level.fill(0.55),
        Some(own) => {
            for (k, &index) in own.iter().enumerate() {
                if index < n {
                    level[index] = weights.map_or(1.0, |w| w[k]);
                }
            }
        }
    }
    let mut raw = vec![0.0f32; samples];
    for (y, r) in raw.iter_mut().enumerate() {
        let at = if n == 1 {
            0.0
        } else {
            (y as f32 / (samples - 1) as f32) * (n - 1) as f32
        };
        let i0 = (n - 1).min(at.floor() as usize);
        let i1 = (n - 1).min(i0 + 1);
        *r = level[i0] + (level[i1] - level[i0]) * (at - i0 as f32);
    }
    // A moving average, so a strand swells into its chapters rather than
    // stepping; beyond the ends counts as absent, so every strand tapers in
    // and out.
    let window = 3usize.max(((17 * samples) as f32 / H as f32 + 0.5).floor() as usize | 1);
    let half = window >> 1;
    let mut prefix = vec![0.0f32; samples + 1];
    for y in 0..samples {
        prefix[y + 1] = prefix[y] + raw[y];
    }
    (0..samples)
        .map(|y| {
            (prefix[samples.min(y + half + 1)] - prefix[y.saturating_sub(half)]) / window as f32
        })
        .collect()
}

/// Each chapter's words over the book's mean; 1 throughout when nothing is
/// counted.
pub fn relative_words(chapters: usize, words: &[u64]) -> Vec<f32> {
    let n = chapters.max(1);
    let counts: Vec<f32> = (0..n)
        .map(|c| words.get(c).copied().unwrap_or(0) as f32)
        .collect();
    let mean = counts.iter().sum::<f32>() / n as f32;
    counts
        .iter()
        .map(|&w| if mean > 0.0 { w / mean } else { 1.0 })
        .collect()
}

const NEUTRAL: &str = "#55524E";

pub fn read_cover_book(request: &CoverRequest) -> CoverBook {
    let n = request.chapters.max(1);
    let wn = relative_words(n, &request.words);
    let all: Vec<usize> = (0..n).collect();
    let strand = |color: &str, chapters: &[usize], neutral: bool| {
        let mut on = vec![0u8; n];
        for &c in chapters {
            if c < n {
                on[c] = 1;
            }
        }
        Strand {
            rgb: hex_color(color),
            on,
            level: presence(H, n, Some(chapters), None),
            neutral,
        }
    };
    let carried = request.storylines.iter().any(|l| !l.chapters.is_empty());
    CoverBook {
        chapters: n,
        words: all
            .iter()
            .map(|&c| request.words.get(c).copied().unwrap_or(0) as f32)
            .collect(),
        word_level: presence(H, n, Some(&all), Some(&wn)),
        wn,
        strands: if carried {
            request
                .storylines
                .iter()
                .map(|l| strand(&l.color, &l.chapters, false))
                .collect()
        } else {
            vec![strand(NEUTRAL, &all, true)]
        },
        latin: request.latin,
    }
}

// ---- small readings shared by the styles ----------------------------------

/// The cover row for a point `t` (0–1) down the book.
pub fn row_at(t: f32) -> usize {
    (t.clamp(0.0, 1.0) * (H - 1) as f32 + 0.5).floor() as usize
}

pub fn mean(values: &[f32], from: usize, to: usize) -> f32 {
    let sum: f32 = values[from..=to].iter().sum();
    sum / (to - from + 1) as f32
}

/// Where each of `n` strands sits across the cover, in the author's order.
pub fn lanes_of(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            WF * if n == 1 {
                0.5
            } else {
                0.22 + (0.56 * i as f32) / (n - 1) as f32
            }
        })
        .collect()
}

/// Runs of chapters a strand carries, as (first, last).
pub fn runs(on: &[u8]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut c = 0;
    while c < on.len() {
        if on[c] == 0 {
            c += 1;
            continue;
        }
        let first = c;
        while c + 1 < on.len() && on[c + 1] != 0 {
            c += 1;
        }
        out.push((first, c));
        c += 1;
    }
    out
}

/// Runs joined where no more than `gap` chapters part them.
pub fn merge_runs(list: &[(usize, usize)], gap: usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for &(a, b) in list {
        match out.last_mut() {
            Some(last) if a as isize - last.1 as isize - 1 <= gap as isize => last.1 = b,
            _ => out.push((a, b)),
        }
    }
    out
}

/// A seeded shuffle of `list`, for styles that hand out shapes or angles.
pub fn shuffled<T: Clone>(list: &[T], rand: &mut Rand) -> Vec<T> {
    let mut out = list.to_vec();
    for i in (1..out.len()).rev() {
        let j = (rand.next_f64() * (i + 1) as f64).floor() as usize;
        out.swap(i, j);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_and_runs_are_the_old_clients() {
        // coverSeed('book-1') in JavaScript.
        assert_eq!(cover_seed("book-1"), 2_430_922_394);
        assert_eq!(cover_seed("慢钟"), 482_093_582);
        assert_eq!(runs(&[1, 1, 0, 1, 0, 0, 1, 1, 1]), [(0, 1), (3, 3), (6, 8)]);
        assert_eq!(merge_runs(&[(0, 1), (3, 3), (6, 8)], 1), [(0, 3), (6, 8)]);
        assert!(is_latin("The Slow Clock"));
        assert!(!is_latin("慢钟"));
        assert!(!is_latin("「慢钟」"));
    }
}
