//! The characters drawn in the sheet's cells, and the cells the loading word
//! covers.

use super::{Layout, WATER_CELL};

// Changes a second per cell while it loads: under a rain head, in a rain
// trail, and in a cell of the loading word; and the slow drift of every cell.
const SWAP_HEAD: f32 = 14.0;
const SWAP_TRAIL: f32 = 2.5;
const SWAP_WORD: f32 = 0.8;
const SWAP_SEA: f32 = 1.0;

/// How much of a water cell the loading word must cover for the sheet cell
/// over it to count as the word's (the 0.1 client's default).
pub const COVER_THRESHOLD: f32 = 0.35;

/// A letter or a digit of any script, never punctuation or a space. The 0.1
/// client asked `/[\p{L}\p{N}]/u`; `is_numeric` is exactly `\p{N}`, and
/// `is_alphabetic` is `\p{L}` plus the few marks and symbols Unicode counts
/// as alphabetic (no passage has one: the layout takes the Arabic marks out).
fn is_letter(ch: char) -> bool {
    ch.is_alphabetic() || ch.is_numeric()
}

/// `Math.floor(random() * len)`, kept inside the list when an f32 draw rounds
/// up to 1. `len` is at least 1.
fn pick(random: &mut dyn FnMut() -> f32, len: usize) -> usize {
    ((random() * len as f32).floor() as usize).min(len - 1)
}

/// What one `Glyphs::tick` did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    /// Some cell is under the rain or the word, so it keeps changing.
    pub changing: bool,
    /// `live` changed.
    pub changed: bool,
}

/// The characters drawn in the sheet's cells. While the sea moves, every cell
/// now and then (about once a second) trades its own character for another
/// letter of the same passage (never punctuation), so the sea never stands
/// still as one text. Under the rain and in the loading word they change as
/// digital rain's do on top of that: a head swaps its cell's character many
/// times a second, a trail now and then, a cell of the word about once a
/// second. A cell the rain and the word have left shows its own character
/// again.
pub struct Glyphs {
    /// The glyph drawn in each cell, row by row (indices into the layout's glyphs).
    pub live: Vec<u8>,
    /// Each cell's own character, which drifts slowly through the passage's letters.
    pub own: Vec<u8>,
    /// The layout's glyphs that are letters.
    letters: Vec<u8>,
    random: Box<dyn FnMut() -> f32>,
}

impl Glyphs {
    /// Every cell showing the layout's character. `random` gives 0..1, as
    /// `Math.random` does (`Rand::boxed` in production).
    pub fn new(layout: &Layout, random: Box<dyn FnMut() -> f32>) -> Glyphs {
        let letters = layout
            .glyphs
            .iter()
            .enumerate()
            .filter(|(_, glyph)| is_letter(**glyph))
            .filter_map(|(index, _)| u8::try_from(index).ok())
            .collect();
        Glyphs {
            live: layout.map.clone(),
            own: layout.map.clone(),
            letters,
            random,
        }
    }

    /// Moves on by `dt` seconds. `rain` is `Rain::cells` (`None`: no rain),
    /// `word` the loading word's cells (`None`: no word). Returns whether any
    /// cell is still changing, and whether `live` changed.
    pub fn tick(&mut self, dt: f32, rain: Option<&[u8]>, word: Option<&[u8]>) -> Tick {
        let Glyphs {
            live,
            own,
            letters,
            random,
        } = self;
        let random: &mut dyn FnMut() -> f32 = random.as_mut();
        let mut changing = false;
        let mut changed = false;
        // The slow drift of the cells' own characters. It only runs while the
        // sea is drawn for something else, so on its own it never keeps the
        // sea awake.
        if !letters.is_empty() && !own.is_empty() {
            let expected = own.len() as f32 * SWAP_SEA * dt;
            let count = expected.floor() as usize + usize::from(random() < expected % 1.0);
            for _ in 0..count {
                let at = pick(random, own.len());
                own[at] = letters[pick(random, letters.len())];
            }
        }
        for (i, (cell, own)) in live.iter_mut().zip(own.iter()).enumerate() {
            let mut rate = 0.0f32;
            if let Some(rain) = rain {
                let head = rain.get(i * 2 + 1).copied().unwrap_or(0);
                let trail = rain.get(i * 2).copied().unwrap_or(0);
                rate = if head > 40 {
                    SWAP_HEAD
                } else if trail > 20 {
                    SWAP_TRAIL
                } else {
                    0.0
                };
            }
            if word.is_some_and(|word| word.get(i).is_some_and(|on| *on != 0)) {
                rate = rate.max(SWAP_WORD);
            }
            if rate > 0.0 && !letters.is_empty() {
                changing = true;
                if random() < rate * dt {
                    *cell = letters[pick(random, letters.len())];
                    changed = true;
                }
            } else if *cell != *own {
                *cell = *own;
                changed = true;
            }
        }
        Tick { changing, changed }
    }
}

/// Which of the sheet's cells a water-grid shape covers (more than
/// `threshold` of it under the cell's centre, `COVER_THRESHOLD` in the 0.1
/// client), row by row: the cells of the loading word.
pub fn cells_covered(
    layout: &Layout,
    shape: &[f32],
    water_cols: usize,
    water_rows: usize,
    threshold: f32,
) -> Vec<u8> {
    let mut cells = vec![0u8; layout.cols * layout.rows];
    for row in 0..layout.rows {
        for col in 0..layout.cols {
            let x =
                ((layout.origin_x + (col as f32 + 0.5) * layout.cell_width) / WATER_CELL).floor();
            let y =
                ((layout.origin_y + (row as f32 + 0.5) * layout.cell_height) / WATER_CELL).floor();
            let on_grid = x >= 0.0 && y >= 0.0 && x < water_cols as f32 && y < water_rows as f32;
            if on_grid
                && shape
                    .get(y as usize * water_cols + x as usize)
                    .is_some_and(|share| *share > threshold)
            {
                cells[row * layout.cols + col] = 1;
            }
        }
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Water;
    use crate::model::fixtures::{ZH, seeded, ticks};
    use crate::model::layout;
    use std::collections::HashSet;

    /// What the 0.1 test's `/[\p{L}\p{N}]/u` let through, checked without
    /// `is_letter`: none of the passage's punctuation, no space.
    fn letter_like(glyph: char) -> bool {
        !glyph.is_whitespace() && !"，。“”、：；！？".contains(glyph)
    }

    #[test]
    fn changes_the_characters_under_the_rain_and_in_the_word_for_other_letters_and_puts_them_back_after()
     {
        let layout = layout(200.0, 100.0, &ZH);
        let mut glyphs = Glyphs::new(&layout, seeded(11));
        let cells = layout.cols * layout.rows;
        let mut rain = vec![0u8; cells * 2];
        let mut word = vec![0u8; cells];
        let head = 3;
        let trail = layout.cols + 3;
        let in_word = 2 * layout.cols + 8;
        rain[head * 2] = 255;
        rain[head * 2 + 1] = 255;
        rain[trail * 2] = 120;
        word[in_word] = 1;
        let mut seen_head = HashSet::new();
        let mut seen_trail = HashSet::new();
        let mut seen_word = HashSet::new();
        for _ in 0..ticks(2.0, 1.0 / 60.0) {
            assert!(glyphs.tick(1.0 / 60.0, Some(&rain), Some(&word)).changing);
            seen_head.insert(glyphs.live[head]);
            seen_trail.insert(glyphs.live[trail]);
            seen_word.insert(glyphs.live[in_word]);
        }
        // about 14 changes a second under a head, 2.5 in a trail, 0.8 in the word
        assert!(seen_head.len() > 12, "{}", seen_head.len());
        assert!(seen_trail.len() > 1, "{}", seen_trail.len());
        assert!(seen_trail.len() < seen_head.len());
        assert!(!seen_word.is_empty());
        for index in seen_head.iter().chain(&seen_trail) {
            let glyph = layout.glyphs[usize::from(*index)];
            assert!(is_letter(glyph) && letter_like(glyph), "{glyph}");
        }
        // once the rain and the word are gone every cell shows its own character again
        assert_eq!(
            glyphs.tick(1.0 / 60.0, None, None),
            Tick {
                changing: false,
                changed: true
            }
        );
        assert_eq!(glyphs.live, glyphs.own);
    }

    #[test]
    fn lets_every_cell_drift_through_the_passages_letters_about_once_a_second_without_keeping_the_sea_awake()
     {
        let layout = layout(200.0, 100.0, &ZH);
        let mut glyphs = Glyphs::new(&layout, seeded(5));
        let cells = layout.cols * layout.rows;
        let mut traded = vec![false; cells];
        for _ in 0..ticks(3.0, 1.0 / 60.0) {
            assert!(!glyphs.tick(1.0 / 60.0, None, None).changing);
            for (i, traded) in traded.iter_mut().enumerate() {
                if glyphs.own[i] != layout.map[i] {
                    *traded = true;
                }
            }
        }
        // Over three seconds nearly every cell has traded (1 - e^-3 ≈ 95%), always for a letter.
        let share = traded.iter().filter(|traded| **traded).count() as f32 / cells as f32;
        assert!(share > 0.85, "{share}");
        for (cell, index) in glyphs.own.iter().enumerate() {
            if traded[cell] {
                let glyph = layout.glyphs[usize::from(*index)];
                assert!(is_letter(glyph) && letter_like(glyph), "{glyph}");
            }
        }
        assert_eq!(glyphs.live, glyphs.own);
    }

    #[test]
    fn finds_the_sheet_cells_the_loading_word_covers() {
        let layout = layout(200.0, 100.0, &ZH);
        let water = Water::new(200.0, 100.0);
        let mut shape = vec![0.0f32; water.cols * water.rows];
        let x = ((layout.origin_x + 5.5 * layout.cell_width) / WATER_CELL).floor() as usize;
        let y = ((layout.origin_y + 2.5 * layout.cell_height) / WATER_CELL).floor() as usize;
        shape[y * water.cols + x] = 1.0;
        let cells = cells_covered(&layout, &shape, water.cols, water.rows, COVER_THRESHOLD);
        assert_eq!(cells[2 * layout.cols + 5], 1);
        assert_eq!(cells.iter().map(|on| u32::from(*on)).sum::<u32>(), 1);
    }

    #[test]
    fn a_draw_of_one_picks_the_last_letter_not_past_it() {
        // An f32 draw can round up to 1; the pick stays inside the list.
        let layout = layout(50.0, 30.0, &ZH);
        let mut glyphs = Glyphs::new(&layout, Box::new(|| 1.0));
        let word = vec![1u8; layout.cols * layout.rows];
        // two seconds at 0.8 a second: every cell of the word changes
        glyphs.tick(2.0, None, Some(&word));
        let last = *glyphs.letters.last().unwrap_or(&0);
        assert!(glyphs.live.iter().all(|index| *index == last));
        assert!(glyphs.own.contains(&last));
    }

    #[test]
    fn a_passage_without_letters_never_changes() {
        let layout = layout(
            50.0,
            30.0,
            &crate::model::Language {
                text: "，。", ..ZH
            },
        );
        let mut glyphs = Glyphs::new(&layout, seeded(1));
        let word = vec![1u8; layout.cols * layout.rows];
        let tick = glyphs.tick(1.0, None, Some(&word));
        assert_eq!(tick, Tick::default());
        assert_eq!(glyphs.live, layout.map);
        assert_eq!(glyphs.own, layout.map);
    }
}
