//! Where each character of the sea sits: the language's passage laid over the
//! window one character to a cell.

use std::collections::HashMap;

/// What the sea is written in, as far as the layout needs it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Language {
    /// Cell size in CSS px.
    pub cell_width: f32,
    pub cell_height: f32,
    /// A right-to-left script: each row is laid from its right end.
    pub rtl: bool,
    /// The passage, one character to a cell.
    pub text: &'static str,
}

/// The sheet of cells over the window and the character in each.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub cols: usize,
    pub rows: usize,
    /// CSS px from the window's top left to the first cell's corner.
    pub origin_x: f32,
    pub origin_y: f32,
    pub cell_width: f32,
    pub cell_height: f32,
    /// Each distinct character once, in order of first use (at most 256).
    pub glyphs: Vec<char>,
    /// One glyph index per cell, row by row from the top left.
    pub map: Vec<u8>,
}

/// Arabic vowel marks combine with the letter before them; alone in a cell
/// they would draw on a dotted circle. U+064B–U+0670 (which takes in U+065F,
/// the 0.1 client's pattern names it as well).
fn is_combining_mark(ch: char) -> bool {
    matches!(ch, '\u{064B}'..='\u{0670}')
}

/// Offset of the first cell so that a cell centre falls on the window's centre.
fn centred_origin(extent: f32, cell: f32) -> f32 {
    let from_centre = extent / 2.0 - cell / 2.0;
    from_centre - cell * (from_centre / cell).floor()
}

/// Whole cells in `extent`, at least one.
fn whole_cells(extent: f32, cell: f32) -> usize {
    let count = (extent / cell).floor();
    if count >= 1.0 { count as usize } else { 1 }
}

/// Lays the language's passage over the window one character to a cell, in
/// reading order (right to left for right-to-left scripts). A cell centre sits
/// on the window's centre, as the dots of the startup placeholder do, so the
/// page the app opens on and the sea line up.
///
/// The first 255 distinct characters get an index each; any after them share
/// index 255 with the 256th. An empty passage (or one of marks only) lays a
/// space in every cell, so every index in `map` names a glyph.
pub fn layout(width: f32, height: f32, language: &Language) -> Layout {
    let Language {
        cell_width,
        cell_height,
        rtl,
        text,
    } = *language;
    let origin_x = centred_origin(width, cell_width);
    let origin_y = centred_origin(height, cell_height);
    let cols = whole_cells(width - origin_x, cell_width);
    let rows = whole_cells(height - origin_y, cell_height);
    let mut text: Vec<char> = text.chars().filter(|ch| !is_combining_mark(*ch)).collect();
    if text.is_empty() {
        text.push(' ');
    }
    let mut glyphs: Vec<char> = Vec::new();
    let mut index: HashMap<char, u8> = HashMap::new();
    let mut map = vec![0u8; cols * rows];
    for i in 0..cols * rows {
        let ch = text[i % text.len()];
        let at = match index.get(&ch) {
            Some(at) => *at,
            None => {
                let at = u8::try_from(glyphs.len()).unwrap_or(u8::MAX);
                if glyphs.len() < 256 {
                    index.insert(ch, at);
                    glyphs.push(ch);
                }
                at
            }
        };
        let row = i / cols;
        let col = i % cols;
        map[row * cols + if rtl { cols - 1 - col } else { col }] = at;
    }
    Layout {
        cols,
        rows,
        origin_x,
        origin_y,
        cell_width,
        cell_height,
        glyphs,
        map,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::fixtures::{AR, EN, ZH};

    #[test]
    fn centres_a_cell_on_the_window_as_the_startup_dots_do() {
        for (name, language) in [("zh", ZH), ("en", EN), ("ar", AR)] {
            for (width, height) in [(960.0, 600.0), (1512.0, 945.0), (1281.0, 799.0)] {
                let layout = layout(width, height, &language);
                let at = format!("{name} at {width}×{height}");
                assert!(layout.origin_x >= 0.0, "{at}");
                assert!(layout.origin_x < language.cell_width, "{at}");
                // toBeCloseTo(0, 6): within half a millionth.
                let across = f64::from(
                    (width / 2.0 - layout.origin_x - language.cell_width / 2.0)
                        / language.cell_width,
                ) % 1.0;
                let down = f64::from(
                    (height / 2.0 - layout.origin_y - language.cell_height / 2.0)
                        / language.cell_height,
                ) % 1.0;
                assert!(across.abs() < 5e-7, "{at}: {across}");
                assert!(down.abs() < 5e-7, "{at}: {down}");
                assert!(
                    layout.origin_x + layout.cols as f32 * language.cell_width <= width,
                    "{at}"
                );
                assert!(layout.glyphs.len() <= 256, "{at}");
                let top = layout.map.iter().copied().max().unwrap_or(0);
                assert!(usize::from(top) < layout.glyphs.len(), "{at}");
            }
        }
    }

    #[test]
    fn writes_in_reading_order_right_to_left_for_arabic_without_stray_marks() {
        let zh = layout(960.0, 600.0, &ZH);
        assert_eq!(
            zh.glyphs[usize::from(zh.map[0])],
            ZH.text.chars().next().unwrap_or_default()
        );
        let ar = layout(960.0, 600.0, &AR);
        assert_eq!(
            ar.glyphs[usize::from(ar.map[ar.cols - 1])],
            AR.text.chars().next().unwrap_or_default()
        );
        let marked = Language {
            text: "سَلامٌ", ..AR
        };
        assert_eq!(layout(100.0, 100.0, &marked).glyphs, ['س', 'ل', 'ا', 'م']);
    }

    #[test]
    fn a_passage_of_more_than_256_characters_shares_the_last_index() {
        // 300 distinct characters, CJK ideographs from U+4E00 on.
        let text: String = (0x4E00u32..0x4E00 + 300)
            .filter_map(char::from_u32)
            .collect();
        let language = Language {
            text: Box::leak(text.into_boxed_str()),
            ..ZH
        };
        let layout = layout(400.0, 200.0, &language);
        assert!(layout.cols * layout.rows >= 300);
        assert_eq!(layout.glyphs.len(), 256);
        assert_eq!(layout.map[255], 255);
        assert!(layout.map[256..300].iter().all(|at| *at == 255));
        // the passage starts again from its first character
        assert_eq!(layout.map[300], 0);
    }

    #[test]
    fn an_empty_passage_lays_spaces() {
        let language = Language { text: "ً", ..AR };
        let layout = layout(50.0, 30.0, &language);
        assert_eq!(layout.glyphs, [' ']);
        assert!(layout.map.iter().all(|at| *at == 0));
    }
}
