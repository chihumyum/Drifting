//! Paragraph typesetting: font runs, shaping, CJK punctuation spacing, line
//! breaking (UAX #14) and justification.
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use fontdb::Database;
use unicode_linebreak::{linebreaks, BreakOpportunity};

use super::fonts::FontSet;
use crate::manuscript_export::Align;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextStyle {
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub href: Option<String>,
}

impl TextStyle {
    pub(crate) fn plain(size: f32) -> Self {
        Self {
            size,
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            href: None,
        }
    }

    pub(crate) fn bold(size: f32) -> Self {
        Self {
            bold: true,
            ..Self::plain(size)
        }
    }
}

/// A run of text with one face and one style, before shaping.
pub(crate) struct FontRun {
    pub range: Range<usize>,
    pub face: usize,
    pub style: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Space,
    Newline,
    /// Ideographs, kana and hangul.
    Cjk,
    /// Full-width opening brackets and quotes.
    Open,
    /// Full-width commas, stops and closing brackets/quotes.
    Close,
    Other,
}

impl Kind {
    fn of(c: char) -> Self {
        match c {
            ' ' | '\t' => Self::Space,
            '\n' => Self::Newline,
            '（' | '「' | '『' | '【' | '《' | '〈' | '〔' | '〖' | '〘' | '“' | '‘' => {
                Self::Open
            }
            '，' | '。' | '、' | '；' | '：' | '）' | '」' | '』' | '】' | '》' | '〉' | '〕'
            | '〗' | '〙' | '”' | '’' | '．' => Self::Close,
            c if FontSet::is_cjk_char(c) => Self::Cjk,
            _ => Self::Other,
        }
    }

    fn is_cjk_like(self) -> bool {
        matches!(self, Self::Cjk | Self::Open | Self::Close)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Glyph {
    pub id: u16,
    /// Advance and offsets in ems of the run's size.
    pub advance: f32,
    pub x_offset: f32,
    pub y_offset: f32,
    pub range: Range<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct Cluster {
    pub face: usize,
    pub style: usize,
    pub size: f32,
    pub glyphs: Vec<Glyph>,
    pub kind: Kind,
    /// Width in points after punctuation compression.
    pub width: f32,
    /// A full-width closing mark whose trailing half may be dropped at a
    /// line end.
    pub end_trim: f32,
}

pub(crate) struct Shaped {
    pub text: Rc<str>,
    pub clusters: Vec<Cluster>,
    /// `allowed[i]`: a line may end before cluster `i` (len = clusters + 1).
    pub allowed: Vec<bool>,
    pub mandatory: Vec<bool>,
}

#[derive(Clone, Debug)]
pub(crate) struct Line {
    pub start: usize,
    /// Exclusive end of the drawn clusters (trailing spaces excluded).
    pub end: usize,
    /// Width in points, with the line-end trim applied.
    pub width: f32,
    /// True for the last line of a paragraph or one ended by a hard break.
    pub last: bool,
}

/// Assign a face to every character, keeping Latin words in the Latin face
/// of a CJK book and CJK punctuation in the CJK face.
pub(crate) fn font_runs(
    fonts: &mut FontSet,
    database: &Database,
    text: &str,
    spans: &[(Range<usize>, usize)],
    styles: &[TextStyle],
    cjk_book: bool,
) -> Vec<FontRun> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut latin_flags = vec![false; chars.len()];
    if cjk_book {
        let letter = |index: usize| {
            chars
                .get(index)
                .is_some_and(|&(_, c)| FontSet::is_latin_char(c))
        };
        let mut previous: Option<bool> = None;
        for index in 0..chars.len() {
            let c = chars[index].1;
            let flag = if FontSet::is_latin_char(c) {
                true
            } else if FontSet::is_cjk_char(c) {
                false
            } else if matches!(c, '‘' | '’' | '“' | '”' | '—' | '…') {
                index > 0 && letter(index - 1) && letter(index + 1)
            } else {
                previous.unwrap_or_else(|| {
                    chars[index + 1..]
                        .iter()
                        .find(|&&(_, c)| FontSet::is_latin_char(c) || FontSet::is_cjk_char(c))
                        .is_some_and(|&(_, c)| FontSet::is_latin_char(c))
                })
            };
            latin_flags[index] = flag;
            previous = Some(flag);
        }
    }
    let mut runs: Vec<FontRun> = Vec::new();
    let mut span_index = 0;
    for (index, &(offset, c)) in chars.iter().enumerate() {
        while span_index + 1 < spans.len() && spans[span_index].0.end <= offset {
            span_index += 1;
        }
        let style_id = spans.get(span_index).map(|span| span.1).unwrap_or(0);
        let style = &styles[style_id];
        let face = if c == '\n' {
            runs.last().map(|run| run.face).unwrap_or(fonts.chain[0])
        } else {
            let regular = fonts.face_for(c, latin_flags[index], cjk_book);
            fonts.variant(database, regular, style.bold, style.italic)
        };
        let end = offset + c.len_utf8();
        match runs.last_mut() {
            Some(run) if run.face == face && run.style == style_id && run.range.end == offset => {
                run.range.end = end;
            }
            _ => runs.push(FontRun {
                range: offset..end,
                face,
                style: style_id,
            }),
        }
    }
    runs
}

/// Parsed shaping faces, shared by every paragraph of one export.
pub(crate) struct Shaper<'f> {
    fonts: &'f FontSet,
    faces: HashMap<(usize, u32), rustybuzz::Face<'f>>,
}

impl<'f> Shaper<'f> {
    pub(crate) fn new(fonts: &'f FontSet) -> Self {
        Self {
            fonts,
            faces: HashMap::new(),
        }
    }

    fn face(&mut self, id: usize) -> Option<&rustybuzz::Face<'f>> {
        let face = &self.fonts.faces[id];
        let key = (face.data.as_ptr() as usize, face.index);
        if !self.faces.contains_key(&key) {
            let parsed = rustybuzz::Face::from_slice(&face.data, face.index)?;
            self.faces.insert(key, parsed);
        }
        self.faces.get(&key)
    }

    /// Shape a paragraph into clusters with break opportunities.
    pub(crate) fn shape(
        &mut self,
        text: &str,
        runs: &[FontRun],
        styles: &[TextStyle],
        compress_punctuation: bool,
    ) -> Shaped {
        let mut clusters: Vec<Cluster> = Vec::new();
        let mut starts: Vec<usize> = Vec::new();
        for run in runs {
            let size = styles[run.style].size;
            let slice = &text[run.range.clone()];
            let units = self.fonts.faces[run.face].units_per_em;
            let Some(face) = self.face(run.face) else {
                continue;
            };
            let mut buffer = rustybuzz::UnicodeBuffer::new();
            buffer.push_str(slice);
            buffer.set_direction(rustybuzz::Direction::LeftToRight);
            buffer.guess_segment_properties();
            let output = rustybuzz::shape(face, &[], buffer);
            let infos = output.glyph_infos();
            let positions = output.glyph_positions();
            let mut index = 0;
            while index < infos.len() {
                let cluster = infos[index].cluster as usize;
                let mut next = index;
                while next < infos.len() && infos[next].cluster as usize == cluster {
                    next += 1;
                }
                let end = infos
                    .get(next)
                    .map(|info| info.cluster as usize)
                    .unwrap_or(slice.len());
                let range = run.range.start + cluster..run.range.start + end.max(cluster);
                let glyphs: Vec<Glyph> = (index..next)
                    .map(|glyph| Glyph {
                        id: infos[glyph].glyph_id as u16,
                        advance: positions[glyph].x_advance as f32 / units,
                        x_offset: positions[glyph].x_offset as f32 / units,
                        y_offset: positions[glyph].y_offset as f32 / units,
                        range: range.clone(),
                    })
                    .collect();
                let first = text[range.clone()].chars().next().unwrap_or(' ');
                let kind = Kind::of(first);
                let width = if kind == Kind::Newline {
                    0.0
                } else {
                    glyphs.iter().map(|glyph| glyph.advance).sum::<f32>() * size
                };
                starts.push(range.start);
                clusters.push(Cluster {
                    face: run.face,
                    style: run.style,
                    size,
                    glyphs,
                    kind,
                    width,
                    end_trim: 0.0,
                });
                index = next;
            }
        }
        if compress_punctuation {
            compress(&mut clusters);
        }
        let mut allowed = vec![false; clusters.len() + 1];
        let mut mandatory = vec![false; clusters.len() + 1];
        for (offset, opportunity) in linebreaks(text) {
            let index = if offset >= text.len() {
                clusters.len()
            } else {
                match starts.binary_search(&offset) {
                    Ok(index) => index,
                    Err(_) => continue,
                }
            };
            allowed[index] = true;
            mandatory[index] = opportunity == BreakOpportunity::Mandatory;
        }
        Shaped {
            text: Rc::from(text),
            clusters,
            allowed,
            mandatory,
        }
    }
}

fn is_full_width(cluster: &Cluster) -> bool {
    cluster.glyphs.len() == 1 && cluster.width >= cluster.size * 0.9
}

/// Simplified-Chinese/Japanese punctuation spacing: a closing mark followed
/// by another mark, or an opening mark after another opening mark, loses its
/// blank half; a closing mark at a line end may lose it too.
fn compress(clusters: &mut [Cluster]) {
    for index in 0..clusters.len() {
        let kind = clusters[index].kind;
        let next = clusters.get(index + 1).map(|cluster| cluster.kind);
        let previous = index.checked_sub(1).map(|previous| clusters[previous].kind);
        if !is_full_width(&clusters[index]) {
            continue;
        }
        let half = clusters[index].size * 0.5;
        if kind == Kind::Close && matches!(next, Some(Kind::Close | Kind::Open)) {
            let glyph = &mut clusters[index].glyphs[0];
            glyph.advance -= 0.5;
            clusters[index].width -= half;
        } else if kind == Kind::Open && previous == Some(Kind::Open) {
            let glyph = &mut clusters[index].glyphs[0];
            glyph.advance -= 0.5;
            glyph.x_offset -= 0.5;
            clusters[index].width -= half;
        } else if kind == Kind::Close {
            clusters[index].end_trim = half;
        }
    }
}

/// Greedy first-fit line breaking at UAX #14 opportunities.
pub(crate) fn break_lines(shaped: &Shaped, first_width: f32, width: f32) -> Vec<Line> {
    let clusters = &shaped.clusters;
    let count = clusters.len();
    let mut lines = Vec::new();
    let mut start = 0;
    if count == 0 {
        return vec![Line {
            start: 0,
            end: 0,
            width: 0.0,
            last: true,
        }];
    }
    while start < count {
        let available = if lines.is_empty() { first_width } else { width };
        let mut total = 0.0;
        let mut last_allowed: Option<usize> = None;
        let mut index = start;
        let mut stop: Option<(usize, bool)> = None;
        while index < count {
            if index > start && shaped.mandatory[index] {
                stop = Some((index, true));
                break;
            }
            total += clusters[index].width;
            let (content_end, content_width) = content(clusters, start, index + 1, total);
            let trim = clusters
                .get(content_end.wrapping_sub(1))
                .filter(|_| content_end > start)
                .map(|cluster| cluster.end_trim)
                .unwrap_or(0.0);
            if content_width - trim > available + 0.01 && index > start {
                stop = Some(match last_allowed {
                    Some(at) => (at, false),
                    None => (index, false),
                });
                break;
            }
            if shaped.allowed[index + 1] && index + 1 > start {
                last_allowed = Some(index + 1);
            }
            index += 1;
        }
        let (end, hard) = stop.unwrap_or((count, true));
        let sum: f32 = clusters[start..end]
            .iter()
            .map(|cluster| cluster.width)
            .sum();
        let (content_end, content_width) = content(clusters, start, end, sum);
        let trim = if content_end > start {
            clusters[content_end - 1].end_trim
        } else {
            0.0
        };
        // The blank half of a closing mark is dropped only when the line
        // needs it to fit.
        let trimmed_end = trim > 0.0 && content_width > available + 0.01;
        lines.push(Line {
            start,
            end: content_end,
            width: content_width - if trimmed_end { trim } else { 0.0 },
            last: hard || end >= count,
        });
        start = end;
    }
    lines
}

/// Drop trailing spaces and hard breaks from `[start, end)`.
fn content(clusters: &[Cluster], start: usize, end: usize, total: f32) -> (usize, f32) {
    let mut end = end;
    let mut width = total;
    while end > start && matches!(clusters[end - 1].kind, Kind::Space | Kind::Newline) {
        width -= clusters[end - 1].width;
        end -= 1;
    }
    (end, width)
}

/// Extra space after each cluster of a line, and the line's x offset.
pub(crate) fn distribute(
    shaped: &Shaped,
    line: &Line,
    available: f32,
    align: Align,
) -> (f32, Vec<f32>) {
    let count = line.end - line.start;
    let mut extra = vec![0.0; count];
    let slack = available - line.width;
    match align {
        Align::Center => return ((slack / 2.0).max(0.0), extra),
        Align::Right => return (slack.max(0.0), extra),
        Align::Left => return (0.0, extra),
        Align::Justify => {}
    }
    if line.last || slack <= 0.0 || slack > available * 0.3 {
        return (0.0, extra);
    }
    let clusters = &shaped.clusters[line.start..line.end];
    let mut slots = Vec::new();
    for index in 0..count.saturating_sub(1) {
        let (a, b) = (clusters[index].kind, clusters[index + 1].kind);
        let stretch = a == Kind::Space
            || (b != Kind::Space
                && (a.is_cjk_like() || b.is_cjk_like())
                && a != Kind::Open
                && b != Kind::Close);
        if stretch {
            slots.push(index);
        }
    }
    if slots.is_empty() {
        return (0.0, extra);
    }
    let share = slack / slots.len() as f32;
    for slot in slots {
        extra[slot] = share;
    }
    (0.0, extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cluster(kind: Kind, width: f32) -> Cluster {
        Cluster {
            face: 0,
            style: 0,
            size: 10.0,
            glyphs: vec![Glyph {
                id: 1,
                advance: width / 10.0,
                x_offset: 0.0,
                y_offset: 0.0,
                range: 0..1,
            }],
            kind,
            width,
            end_trim: 0.0,
        }
    }

    fn shaped(kinds: &[Kind]) -> Shaped {
        let mut clusters: Vec<Cluster> = kinds.iter().map(|&kind| cluster(kind, 10.0)).collect();
        compress(&mut clusters);
        let count = clusters.len();
        Shaped {
            text: Rc::from(""),
            clusters,
            allowed: vec![true; count + 1],
            mandatory: (0..=count).map(|index| index == count).collect(),
        }
    }

    #[test]
    fn closing_marks_lose_their_blank_half_before_other_marks_and_at_line_ends() {
        use Kind::*;
        let text = shaped(&[Cjk, Close, Open, Cjk, Close, Close]);
        let widths: Vec<f32> = text.clusters.iter().map(|cluster| cluster.width).collect();
        assert_eq!(widths, vec![10.0, 5.0, 10.0, 10.0, 5.0, 10.0]);
        assert_eq!(text.clusters[5].end_trim, 5.0);
        let opens = shaped(&[Open, Open, Cjk]);
        assert_eq!(opens.clusters[1].width, 5.0);
        assert_eq!(opens.clusters[1].glyphs[0].x_offset, -0.5);
    }

    #[test]
    fn a_trailing_closing_mark_may_hang_into_its_blank_half_to_fit() {
        use Kind::*;
        // Four ideographs and a comma are 50pt; the comma's trim fits 45pt.
        let text = shaped(&[Cjk, Cjk, Cjk, Cjk, Close, Cjk]);
        let lines = break_lines(&text, 45.0, 45.0);
        assert_eq!((lines[0].start, lines[0].end), (0, 5));
        assert_eq!(lines[0].width, 45.0);
        assert_eq!((lines[1].start, lines[1].end, lines[1].last), (5, 6, true));
    }

    #[test]
    fn justification_skips_gaps_after_opening_and_before_closing_marks() {
        use Kind::*;
        let text = shaped(&[Cjk, Open, Cjk, Close, Cjk, Cjk]);
        let line = Line {
            start: 0,
            end: 6,
            width: 60.0,
            last: false,
        };
        let (_, extra) = distribute(&text, &line, 66.0, Align::Justify);
        // Gaps: Cjk|Open, Open|Cjk (no), Cjk|Close (no), Close|Cjk, Cjk|Cjk.
        assert_eq!(extra, vec![2.0, 0.0, 0.0, 2.0, 2.0, 0.0]);
        let last = Line { last: true, ..line };
        assert!(distribute(&text, &last, 66.0, Align::Justify)
            .1
            .iter()
            .all(|gap| *gap == 0.0));
    }
}
