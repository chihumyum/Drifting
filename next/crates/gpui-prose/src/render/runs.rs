//! From a paragraph's marks to GPUI text runs: font weight and style for bold
//! and italic, colour and underline for links, underline and strikethrough
//! decorations, and the composition underline spliced in.

use gpui::{Hsla, StrikethroughStyle, TextRun, UnderlineStyle, px};

use crate::{
    ProseEditor,
    extension::ProseExtension,
    render::blocks::BlockLook,
    style::ProseStyle,
    text::{BlockKind, Line, Marks, Span},
};

/// What an extension may change about a run of marked text.
#[derive(Clone, Debug, PartialEq)]
pub struct RunStyle {
    pub bold: bool,
    pub italic: bool,
    pub color: Hsla,
    pub background: Option<Hsla>,
    pub underline: Option<Hsla>,
    pub strike: Option<Hsla>,
}

impl RunStyle {
    /// The default look of `marks` in `style`.
    pub fn from_marks(marks: &Marks, style: &ProseStyle) -> RunStyle {
        let link = marks.link().is_some();
        let color = if link { style.link } else { style.text };
        RunStyle {
            bold: marks.bold(),
            italic: marks.italic(),
            color,
            background: None,
            underline: (marks.underline() || link).then_some(color),
            strike: marks.strike().then_some(color),
        }
    }

    fn plain(style: &ProseStyle) -> RunStyle {
        RunStyle {
            bold: false,
            italic: false,
            color: style.text,
            background: None,
            underline: None,
            strike: None,
        }
    }

    fn run(&self, kind: BlockKind, len: usize, style: &ProseStyle) -> TextRun {
        TextRun {
            len,
            font: style.font_for(kind, self.bold, self.italic),
            color: self.color,
            background_color: self.background,
            underline: self.underline.map(|color| UnderlineStyle {
                color: Some(color),
                thickness: px(1.),
                wavy: false,
            }),
            strikethrough: self.strike.map(|color| StrikethroughStyle {
                color: Some(color),
                thickness: px(1.),
            }),
        }
    }
}

/// Text runs covering `len` bytes of a paragraph with `spans`.
pub fn line_runs(
    len: usize,
    spans: &[Span],
    kind: BlockKind,
    style: &ProseStyle,
    extension: Option<&dyn ProseExtension>,
) -> Vec<TextRun> {
    let mut runs = Vec::with_capacity(spans.len() * 2 + 1);
    let plain = RunStyle::plain(style);
    let mut at = 0;
    for span in spans {
        if span.range.start > at {
            runs.push(plain.run(kind, span.range.start - at, style));
        }
        let mut look = RunStyle::from_marks(&span.marks, style);
        if let Some(extension) = extension {
            extension.style_run(&span.marks, &mut look, style);
        }
        runs.push(look.run(kind, span.range.len(), style));
        at = span.range.end;
    }
    if len > at || runs.is_empty() {
        runs.push(plain.run(kind, len - at, style));
    }
    runs
}

impl ProseEditor {
    /// A paragraph's text runs: its marks, and a code line's monospace
    /// face (bold and italic kept).
    pub(crate) fn paragraph_runs(&self, line: &Line, look: &BlockLook) -> Vec<TextRun> {
        let kind = if look.code {
            BlockKind::Body
        } else {
            line.kind
        };
        let mut runs = line_runs(
            line.text.len(),
            &line.spans,
            kind,
            &self.style,
            self.extension.as_deref(),
        );
        if look.code {
            for run in &mut runs {
                run.font.family = self.style.mono_family.clone();
            }
        }
        runs
    }
}

/// Splices marked (composition) text into runs: `replaced` bytes at `at`
/// give way to `inserted` bytes styled like the character before (or after)
/// and underlined.
pub fn splice_composition(
    runs: &[TextRun],
    at: usize,
    replaced: usize,
    inserted: usize,
    underline: Hsla,
) -> Vec<TextRun> {
    let mut out = Vec::with_capacity(runs.len() + 2);
    let mut template: Option<&TextRun> = None;
    let mut offset = 0;
    for run in runs {
        let (start, end) = (offset, offset + run.len);
        offset = end;
        if start < at && at.min(end) > start {
            out.push(TextRun {
                len: at.min(end) - start,
                ..run.clone()
            });
        }
        let holds_before = at > 0 && start < at && at <= end;
        if template.is_none() && (holds_before || (at == 0 && start == 0)) {
            template = Some(run);
        }
    }
    if inserted > 0
        && let Some(template) = template.or(runs.first())
    {
        out.push(TextRun {
            len: inserted,
            underline: Some(UnderlineStyle {
                color: Some(underline),
                thickness: px(1.),
                wavy: false,
            }),
            strikethrough: None,
            ..template.clone()
        });
    }
    let mut offset = 0;
    for run in runs {
        let (start, end) = (offset, offset + run.len);
        offset = end;
        let from = (at + replaced).max(start);
        if end > from {
            out.push(TextRun {
                len: end - from,
                ..run.clone()
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::Marks;
    use loro::LoroValue;

    fn marks(keys: &[(&str, LoroValue)]) -> Marks {
        let map: Vec<(String, LoroValue)> = keys
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Marks::from_attributes(map.iter().map(|(k, v)| (k, v)))
    }

    #[test]
    fn runs_cover_the_text() {
        let style = ProseStyle::default();
        let spans = [
            Span {
                range: 3..6,
                marks: marks(&[("bold", true.into())]),
            },
            Span {
                range: 6..9,
                marks: marks(&[("link", "https://x".into())]),
            },
        ];
        let runs = line_runs(12, &spans, BlockKind::Body, &style, None);
        let lens: Vec<usize> = runs.iter().map(|r| r.len).collect();
        assert_eq!(lens, [3, 3, 3, 3]);
        assert_eq!(runs[1].font.weight, style.bold_weight);
        assert_eq!(runs[2].color, style.link);
        assert!(runs[2].underline.is_some());
        assert!(runs[3].underline.is_none());
    }

    #[test]
    fn composition_is_spliced_in() {
        let style = ProseStyle::default();
        let runs = line_runs(6, &[], BlockKind::Body, &style, None);
        // Replace bytes 3..6 with 2 marked bytes.
        let spliced = splice_composition(&runs, 3, 3, 2, style.text);
        let lens: Vec<usize> = spliced.iter().map(|r| r.len).collect();
        assert_eq!(lens, [3, 2]);
        assert!(spliced[1].underline.is_some());
        // At the very end.
        let spliced = splice_composition(&runs, 6, 0, 4, style.text);
        let lens: Vec<usize> = spliced.iter().map(|r| r.len).collect();
        assert_eq!(lens, [6, 4]);
        // At the start of an empty paragraph.
        let empty = line_runs(0, &[], BlockKind::Body, &style, None);
        let spliced = splice_composition(&empty, 0, 0, 3, style.text);
        let total: usize = spliced.iter().map(|r| r.len).sum();
        assert_eq!(total, 3);
    }
}
