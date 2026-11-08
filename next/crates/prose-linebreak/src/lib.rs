//! Chinese line breaking as plain functions: no GPUI types, only text and
//! widths, so the same rules serve the editor (`gpui-prose`) and, later, the
//! PDF/EPUB export and `dr-text`.
//!
//! The rules (see Drifting's F4 notes, "中文断行：编辑器和 PDF 的统一规则"):
//!
//! 1. **Break opportunities** come from UAX #14 (ICU4X's line segmenter,
//!    strict), which already keeps Latin words and numbers whole, keeps
//!    「——」「……」 together and never breaks before 「，。、；：？！」 or
//!    closing brackets. Without the `icu` feature a small built-in table is used.
//! 2. **Chinese tailoring** on top (GB/T 15834, W3C clreq): UAX #14 cannot tell
//!    an opening 「“」 from a closing 「”」 (both are class QU), so a closing
//!    quote is never allowed at a row start and an opening quote never at a
//!    row end, and a break before an opening or after a closing quote next to
//!    full-width text is allowed; never inside an emoji or combining sequence.
//! 3. **Line ends** ([`Overflow`]): when a mark that may not start a row would
//!    overflow, the editor lets it *hang* past the edge (no reflow of earlier
//!    text while typing); print may instead *squeeze* away the blank half of
//!    a full-width closing mark to make it fit, and break earlier if it still
//!    does not. A clipped interface field may *wrap* earlier without squeezing.
//! 4. **Punctuation squeezing** inside a row ([`punctuation_squeeze`]): a
//!    full-width closing mark followed by another mark, or an opening mark
//!    after another opening mark, loses its blank half (「。」」 → 「。」」 at
//!    1.5 em). Print applies it; the editor does not yet (F4b).
//!
//! Positions are UTF-8 byte offsets into the paragraph text; widths are
//! plain `f32` in whatever unit the caller lays out in.

use std::ops::Range;

/// Marks that never start a row: 点号 and closing brackets and quotes
/// (GB/T 15834), plus their ASCII and Japanese counterparts.
pub const NO_START: &str = "，。、；：？！）］｝〕〉》」』】〙〗〟’”｠»‥・ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ,.;:?!)]}%";
/// Marks that never end a row (opening brackets and quotes).
pub const NO_END: &str = "（［｛〔〈《「『【〘〖〝‘“｟«([{";

/// Estimated advance of a character in ems. CJK ideographs, kana, hangul and
/// full-width punctuation are one em; Latin text about half.
pub fn advance_em(c: char) -> f32 {
    let u = c as u32;
    let wide = matches!(u,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x1F300..=0x1FAFF | 0x20000..=0x3FFFD);
    if wide {
        1.0
    } else if c.is_ascii_uppercase() || c.is_ascii_digit() {
        0.62
    } else if c.is_ascii() {
        0.5
    } else {
        0.6
    }
}

fn wide(c: char) -> bool {
    advance_em(c) >= 1.0
}

fn is_extender(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF
        | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F
        | 0xE0100..=0xE01EF)
}

/// The Chinese tailoring: whether a row may never start at `c` after `prev`,
/// whatever UAX #14 says.
fn forbidden(prev: char, c: char) -> bool {
    NO_START.contains(c)
        || NO_END.contains(prev)
        || (prev == c && matches!(c, '—' | '…' | '⋯'))
        || c == '\u{200D}'
        || prev == '\u{200D}'
        || is_extender(c)
}

/// The Chinese tailoring's other half: breaks UAX #14's quotation rules
/// (class QU) refuse but Chinese allows — before an opening quote and after a
/// closing one, next to full-width text.
#[cfg(feature = "icu")]
fn tailored_allow(prev: char, c: char) -> bool {
    (matches!(c, '“' | '‘') && wide(prev)) || (matches!(prev, '”' | '’') && wide(c))
}

/// The built-in table (used without ICU, and by the tests): whether a row may
/// start at `c`, right after `prev`.
pub fn can_break_between(prev: char, c: char) -> bool {
    fn word(c: char) -> bool {
        c.is_alphanumeric() && !wide(c) || matches!(c, '_' | '\'' | '’' | '-' | '.' | '@' | '#')
    }
    if forbidden(prev, c) {
        return false;
    }
    if prev == ' ' || prev == '\t' {
        return c != ' ';
    }
    if c == ' ' {
        return false;
    }
    if word(prev) && word(c) {
        return false;
    }
    wide(prev) || wide(c) || matches!(prev, '-' | '/' | '—')
}

/// Byte offsets inside `text` (never 0 or `text.len()`) where a row may start.
pub fn break_opportunities(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut prev = None;
    #[cfg(feature = "icu")]
    let uax14 = icu::opportunities(text);
    #[cfg(feature = "icu")]
    let mut next_ix = 0;
    for (byte, c) in text.char_indices() {
        if let Some(p) = prev {
            #[cfg(feature = "icu")]
            let allowed = {
                while next_ix < uax14.len() && uax14[next_ix] < byte {
                    next_ix += 1;
                }
                (uax14.get(next_ix) == Some(&byte) || tailored_allow(p, c)) && !forbidden(p, c)
            };
            #[cfg(not(feature = "icu"))]
            let allowed = can_break_between(p, c);
            if allowed {
                out.push(byte);
            }
        }
        prev = Some(c);
    }
    out
}

#[cfg(feature = "icu")]
mod icu {
    use icu_segmenter::{
        LineSegmenter, LineSegmenterBorrowed,
        options::{LineBreakOptions, LineBreakStrictness},
    };
    use std::sync::OnceLock;

    fn segmenter() -> &'static LineSegmenterBorrowed<'static> {
        static SEGMENTER: OnceLock<LineSegmenterBorrowed<'static>> = OnceLock::new();
        SEGMENTER.get_or_init(|| {
            let mut options = LineBreakOptions::default();
            options.strictness = Some(LineBreakStrictness::Strict);
            LineSegmenter::new_dictionary(options)
        })
    }

    /// UAX #14 opportunities, ascending, without 0 and the end.
    pub fn opportunities(text: &str) -> Vec<usize> {
        segmenter()
            .segment_str(text)
            .filter(|&b| b > 0 && b < text.len())
            .collect()
    }
}

/// What a row does with a mark that may not start the next row but does not
/// fit on this one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Overflow {
    /// Let it hang past the edge (the editor: nothing earlier reflows while
    /// typing).
    #[default]
    Hang,
    /// Break before the last legal opportunity, keeping the closing marks
    /// with the preceding text and their full advances (clipped UI fields).
    /// A segment with no legal break still stays together.
    Wrap,
    /// Drop the blank half of a full-width closing mark if that makes it fit;
    /// otherwise break before the last opportunity (print).
    Squeeze,
}

/// One visual row of a paragraph.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// Bytes of the paragraph text on this row.
    pub range: Range<usize>,
    /// The unwrapped x where the row starts.
    pub start_x: f32,
    /// How far the row's ink reaches past `wrap_width` (a hanging mark or
    /// trailing spaces); 0 if it fits.
    pub hang: f32,
    /// Width taken off the row's last mark ([`Overflow::Squeeze`]).
    pub squeeze: f32,
}

/// A line break inside a paragraph (Shift-Enter; a table cell's line).
pub const LINE_SEPARATOR: char = '\u{2028}';

/// Breaks one shaped paragraph into rows. A [`LINE_SEPARATOR`] always ends
/// its row.
///
/// - `glyphs`: `(byte, x)` of each glyph cluster in the unwrapped line, in
///   byte order (x is where the cluster starts; one entry per cluster);
/// - `line_width`: the unwrapped line's total width;
/// - `wrap_width`: the column width;
/// - `em`: the font size (for the half-em squeeze).
pub fn break_rows(
    text: &str,
    glyphs: &[(usize, f32)],
    line_width: f32,
    wrap_width: f32,
    em: f32,
    overflow: Overflow,
) -> Vec<Row> {
    let opportunities = break_opportunities(text);
    let can_start = |byte: usize| opportunities.binary_search(&byte).is_ok();
    // A line separator (U+2028, a line break inside a paragraph) always
    // ends its row (UAX #14's mandatory break): rows start right after each.
    let mandatory: Vec<usize> = text
        .match_indices(LINE_SEPARATOR)
        .map(|(b, s)| b + s.len())
        .collect();
    let mut next_mandatory = 0;
    let mut rows = Vec::new();
    let (mut start, mut start_x) = (0usize, 0f32);
    let mut candidate: Option<(usize, f32)> = None;
    let mut ix = 0;
    while ix < glyphs.len() {
        let (byte, x) = glyphs[ix];
        if let Some(&at) = mandatory.get(next_mandatory)
            && byte >= at
        {
            next_mandatory += 1;
            if at > start {
                rows.push(Row {
                    range: start..at,
                    start_x,
                    hang: 0.,
                    squeeze: 0.,
                });
                start = at;
                start_x = x;
                candidate = None;
            }
            continue;
        }
        let c = text[byte..].chars().next().unwrap_or(' ');
        if byte > start && can_start(byte) {
            candidate = Some((byte, x));
        }
        let next_x = glyphs.get(ix + 1).map_or(line_width, |(_, x)| *x);
        let overflows = next_x - start_x > wrap_width + 0.01 && byte > start;
        if overflows && !(c == ' ' || NO_START.contains(c)) {
            // Break at the last opportunity (or here, if there is none).
            let (at, at_x) = candidate.filter(|(at, _)| *at > start).unwrap_or((byte, x));
            let end_x = at_x;
            rows.push(Row {
                range: start..at,
                start_x,
                hang: (end_x - start_x - wrap_width).max(0.),
                squeeze: 0.,
            });
            start = at;
            start_x = at_x;
            candidate = None;
            // Re-examine from the new row start.
            ix = glyphs.partition_point(|(b, _)| *b < start);
            continue;
        }
        if overflows && overflow != Overflow::Hang && NO_START.contains(c) {
            let width = next_x - x;
            let squeezable =
                overflow == Overflow::Squeeze && closing_full_width(c) && width >= em * 0.9;
            if !(squeezable && next_x - start_x - em * 0.5 <= wrap_width + 0.01) {
                // Cannot fit even squeezed: break before the last opportunity.
                if let Some((at, at_x)) = candidate.filter(|(at, _)| *at > start) {
                    rows.push(Row {
                        range: start..at,
                        start_x,
                        hang: 0.,
                        squeeze: 0.,
                    });
                    start = at;
                    start_x = at_x;
                    candidate = None;
                    ix = glyphs.partition_point(|(b, _)| *b < start);
                    continue;
                }
            }
        }
        ix += 1;
    }
    // Separators after the last glyph (a trailing break): its rows end there.
    for &at in &mandatory[next_mandatory..] {
        if at > start {
            rows.push(Row {
                range: start..at,
                start_x,
                hang: 0.,
                squeeze: 0.,
            });
            start = at;
            start_x = line_width;
        }
    }
    // The last row; squeezes are settled below.
    let end_x = line_width;
    let last = Row {
        range: start..text.len(),
        start_x,
        hang: (end_x - start_x - wrap_width).max(0.),
        squeeze: 0.,
    };
    rows.push(last);
    if overflow == Overflow::Squeeze {
        for row in rows.iter_mut() {
            let last = text[row.range.clone()].chars().next_back();
            if row.hang > 0. && row.squeeze == 0. && last.is_some_and(closing_full_width) {
                row.squeeze = row.hang.min(em * 0.5);
                row.hang -= row.squeeze;
            }
        }
    }
    rows
}

fn closing_full_width(c: char) -> bool {
    matches!(
        c,
        '，' | '。'
            | '、'
            | '；'
            | '：'
            | '）'
            | '」'
            | '』'
            | '】'
            | '》'
            | '〉'
            | '〕'
            | '〗'
            | '〙'
            | '”'
            | '’'
            | '．'
            | '？'
            | '！'
    )
}

fn opening_full_width(c: char) -> bool {
    matches!(
        c,
        '（' | '「' | '『' | '【' | '《' | '〈' | '〔' | '〖' | '〘' | '“' | '‘'
    )
}

/// Punctuation squeezing inside a row (标点挤压): `(byte, amount)` for every
/// full-width mark that loses its blank half — a closing mark followed by
/// another closing or opening mark, or an opening mark after another opening
/// mark — with `amount` = half an em. The caller applies it (print does; the
/// editor not yet).
pub fn punctuation_squeeze(text: &str, em: f32) -> Vec<(usize, f32)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = Vec::new();
    for (ix, &(byte, c)) in chars.iter().enumerate() {
        let next = chars.get(ix + 1).map(|(_, c)| *c);
        let prev = ix.checked_sub(1).map(|p| chars[p].1);
        let squeezed = (closing_full_width(c)
            && next.is_some_and(|n| closing_full_width(n) || opening_full_width(n)))
            || (opening_full_width(c) && prev.is_some_and(opening_full_width));
        if squeezed {
            out.push((byte, em * 0.5));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_separator_always_ends_its_row() {
        let text = "听见两声\u{2028}第二声";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 500., 10., Overflow::Hang);
        let parts: Vec<&str> = rows.iter().map(|r| &text[r.range.clone()]).collect();
        assert_eq!(parts, ["听见两声\u{2028}", "第二声"]);
        let after = g
            .iter()
            .find(|(b, _)| text[*b..].starts_with('第'))
            .unwrap()
            .1;
        assert_eq!(rows[1].start_x, after, "the next row starts after it");
        // Two in a row, and one at the end: an empty row each.
        let text = "甲\u{2028}\u{2028}乙\u{2028}";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 500., 10., Overflow::Hang);
        let parts: Vec<&str> = rows.iter().map(|r| &text[r.range.clone()]).collect();
        assert_eq!(parts, ["甲\u{2028}", "\u{2028}", "乙\u{2028}", ""]);
        // Wrapping still applies inside each row.
        let text = "一二三四五\u{2028}六";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 30., 10., Overflow::Hang);
        let parts: Vec<&str> = rows.iter().map(|r| &text[r.range.clone()]).collect();
        assert_eq!(parts, ["一二三", "四五\u{2028}", "六"]);
    }

    #[test]
    fn chinese_line_breaking_rules() {
        // Between ideographs: yes.
        assert!(can_break_between('天', '色'));
        // Never before a comma, full stop or closing quote; never after an opening one.
        assert!(!can_break_between('只', '，'));
        assert!(!can_break_between('了', '。'));
        assert!(!can_break_between('话', '”'));
        assert!(!can_break_between('“', '你'));
        assert!(!can_break_between('《', '书'));
        // After a closing mark the next ideograph may start a row.
        assert!(can_break_between('，', '十'));
        // Dashes and ellipses stay whole.
        assert!(!can_break_between('—', '—'));
        assert!(!can_break_between('…', '…'));
        // Latin words and numbers are not split; a space or a CJK neighbour breaks.
        assert!(!can_break_between('a', 'b'));
        assert!(!can_break_between('1', '9'));
        assert!(can_break_between(' ', 'L'));
        assert!(can_break_between('被', 'L'));
        assert!(can_break_between('a', '中'));
        // Not inside an emoji sequence.
        assert!(!can_break_between('👨', '\u{200D}'));
        assert!(!can_break_between('\u{200D}', '👩'));
        assert!(!can_break_between('👍', '\u{1F3FD}'));
    }

    /// The opportunities the editor and print share, with the Chinese
    /// tailoring over UAX #14.
    #[test]
    fn opportunities_follow_uax14_and_the_chinese_tailoring() {
        let text = "他说：“你好，Hello world——再见……”然后";
        let starts: Vec<&str> = break_opportunities(text)
            .into_iter()
            .map(|b| &text[b..])
            .collect();
        let at = |s: &str| starts.iter().any(|t| t.starts_with(s));
        // Never before the colon, the comma or the closing quote; never right
        // after the opening quote; never inside "Hello", "——" or "……".
        assert!(!at("："));
        assert!(!at("，"));
        assert!(!at("”"));
        assert!(!at("你好"));
        assert!(!at("ello"));
        assert!(!at("—再"));
        assert!(!at("…”"));
        // Between ideographs, after the closing quote, before "world".
        assert!(at("说"));
        assert!(at("好，"));
        assert!(at("world"));
        assert!(at("然后"));
    }

    fn glyphs(text: &str, em: f32) -> (Vec<(usize, f32)>, f32) {
        let mut x = 0.;
        let glyphs = text
            .char_indices()
            .map(|(b, c)| {
                let at = (b, x);
                x += advance_em(c) * em;
                at
            })
            .collect();
        (glyphs, x)
    }

    fn rows_text(text: &str, rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| text[r.range.clone()].to_owned())
            .collect()
    }

    #[test]
    fn rows_hang_a_comma_in_the_editor() {
        // Ten ideographs per row at 10 px in a 100 px column; the comma that
        // would start row two hangs on row one instead.
        let text = "一二三四五六七八九十，下一行";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 100., 10., Overflow::Hang);
        assert_eq!(rows_text(text, &rows), ["一二三四五六七八九十，", "下一行"]);
        assert!((rows[0].hang - 10.).abs() < 0.01);
        assert_eq!(rows[1].hang, 0.);
    }

    #[test]
    fn rows_squeeze_or_break_earlier_in_print() {
        // Squeezing half the comma is not enough for a full em of overflow,
        // so print breaks before 十 and keeps 十， together on row two.
        let text = "一二三四五六七八九十，下一行";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 100., 10., Overflow::Squeeze);
        assert_eq!(rows_text(text, &rows), ["一二三四五六七八九", "十，下一行"]);
        // A 105 px column: the comma's blank half is squeezed away instead.
        let rows = break_rows(text, &g, width, 105., 10., Overflow::Squeeze);
        assert_eq!(rows_text(text, &rows), ["一二三四五六七八九十，", "下一行"]);
        assert!((rows[0].squeeze - 5.).abs() < 0.01);
        assert_eq!(rows[0].hang, 0.);
    }

    #[test]
    fn rows_wrap_closing_marks_without_squeezing_or_changing_the_editor() {
        // The plot-cell regression: an excerpt from the bundled 阿Q sample.
        let text = "你算是什么东西！”";
        let (g, width) = glyphs(text, 10.);
        let hung = break_rows(text, &g, width, 70., 10., Overflow::Hang);
        assert_eq!(rows_text(text, &hung), [text]);
        assert!(hung[0].hang > 0.);
        for wrap in [70., 75.] {
            let rows = break_rows(text, &g, width, wrap, 10., Overflow::Wrap);
            assert_eq!(rows_text(text, &rows), ["你算是什么东", "西！”"]);
            assert!(rows.iter().all(|r| r.hang == 0. && r.squeeze == 0.));
            for row in &rows {
                let end_x = g
                    .iter()
                    .find(|(byte, _)| *byte == row.range.end)
                    .map_or(width, |(_, x)| *x);
                assert!(end_x - row.start_x <= wrap, "the full glyph advances fit");
            }
        }
    }

    #[test]
    fn wrapping_keeps_legal_clusters_and_mandatory_breaks() {
        let text = "一二三四五“Hello！”\u{2028}👩‍💻！”";
        // The emoji is one shaped cluster. Its continuation code points
        // must never become row starts when a closing mark overflows.
        let clusters = [
            "一",
            "二",
            "三",
            "四",
            "五",
            "“",
            "H",
            "e",
            "l",
            "l",
            "o",
            "！",
            "”",
            "\u{2028}",
            "👩‍💻",
            "！",
            "”",
        ];
        let mut at = 0;
        let mut x = 0.;
        let g: Vec<_> = clusters
            .iter()
            .map(|c| {
                let glyph = (at, x);
                at += c.len();
                x += 10.;
                glyph
            })
            .collect();
        let rows = break_rows(text, &g, x, 100., 10., Overflow::Wrap);
        assert_eq!(
            rows_text(text, &rows),
            ["一二三四五", "“Hello！”\u{2028}", "👩‍💻！”"]
        );
        assert!(rows.iter().all(|r| r.hang == 0. && r.squeeze == 0.));
        // If the whole cluster and its marks are wider than the field,
        // there is no legal split; preserve them and terminate normally.
        let rows = break_rows(
            "👩‍💻！”",
            &[(0, 0.), (11, 10.), (14, 20.)],
            30.,
            10.,
            10.,
            Overflow::Wrap,
        );
        assert_eq!(rows_text("👩‍💻！”", &rows), ["👩‍💻！”"]);
    }

    #[test]
    fn rows_keep_opening_quotes_with_what_follows() {
        let text = "一二三四五六七八九“十”字";
        let (g, width) = glyphs(text, 10.);
        let rows = break_rows(text, &g, width, 100., 10., Overflow::Hang);
        assert_eq!(rows_text(text, &rows), ["一二三四五六七八九", "“十”字"]);
    }

    #[test]
    fn squeeze_inside_a_row() {
        let text = "他说：“好。”（注）";
        let squeezed: Vec<&str> = punctuation_squeeze(text, 10.)
            .into_iter()
            .map(|(b, _)| &text[b..b + 3])
            .collect();
        assert_eq!(squeezed, ["：", "。", "”"]);
    }
}
