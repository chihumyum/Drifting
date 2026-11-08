//! How each paragraph of the editor is set, from the editor's style (first-line
//! indent, justification, squeezing) and the paragraph's block look (its
//! alignment, how far an indent, quote, list, code block or callout sets it
//! in, and the gaps and pads of lists, code blocks and callouts in place of
//! the paragraph spacing); and typewriter scrolling.
//!
//! Every place that lays a paragraph out — the paragraph element, the
//! editor's off-screen `line_layout`, the input method's re-shaping, the
//! height estimates — takes its setting from here, so they agree.

use gpui::{Bounds, Pixels, point, px, size};

use super::{BlockMetrics, RowAlign, RowSetting, estimate_height};
use crate::{
    ProseEditor,
    render::blocks::{Align, BlockLook},
    text::BlockKind,
};

/// How one paragraph is set: its size, line height and spacing, how its
/// rows are set, and its block look (how far it is set in from the column's
/// edges, and what it draws).
#[derive(Clone, Copy, Debug)]
pub struct ParaSet {
    pub metrics: BlockMetrics,
    pub setting: RowSetting,
    pub look: BlockLook,
}

impl ParaSet {
    /// How much narrower than the column the paragraph wraps.
    pub fn narrowing(&self) -> Pixels {
        self.look.inset + self.look.inset_right
    }
}

impl ProseEditor {
    /// How paragraph `line` of `chapter` is set (see [`ParaSet`]).
    pub fn para_set(&self, chapter: usize, line: usize) -> ParaSet {
        let look = self.block_look(chapter, line);
        let kind = self.book.chapters[chapter].doc.line(line).kind;
        ParaSet {
            metrics: self.metrics_of(&look, kind),
            setting: self.setting_of(&look, kind),
            look,
        }
    }

    /// Paragraph `line`'s size, line height and spacing.
    pub fn para_metrics(&self, chapter: usize, line: usize) -> BlockMetrics {
        self.para_set(chapter, line).metrics
    }

    /// A paragraph of `kind`'s metrics as its block changes them: a code
    /// line's smaller face and tighter rows, and the pads and gaps of code
    /// blocks, callouts and lists in place of the paragraph spacing. The
    /// pads of a block go to its first and last paragraph, so the block's
    /// wash covers them and the paragraphs inside it touch.
    pub(crate) fn metrics_of(&self, look: &BlockLook, kind: BlockKind) -> BlockMetrics {
        let blocks = &self.paint.block_style;
        let body = f32::from(self.style.body_size);
        let em = |ems: f32| (body * ems).round();
        let mut m = self.style.metrics(kind);
        let spacing = m.pad_bottom;
        if look.code {
            // A heading's size and space above do not reach into code.
            m.font_size = body * blocks.code_size;
            m.line_height = (m.font_size * blocks.code_line_height).round();
            m.pad_top = 0.;
        }
        if look.callout && !look.callout_above {
            m.pad_top += em(blocks.callout_pad);
        }
        if look.code && !look.code_above {
            m.pad_top += em(blocks.code_pad);
        }
        m.pad_bottom = if look.code && look.code_below {
            0.
        } else if look.list_below {
            em(blocks.list_gap)
        } else if look.callout && look.callout_below {
            em(blocks.callout_gap)
        } else {
            spacing
        };
        if look.code && !look.code_below {
            m.pad_bottom += em(blocks.code_pad);
        }
        if look.callout && !look.callout_below {
            m.pad_bottom += em(blocks.callout_pad);
        }
        m
    }

    /// How a paragraph of `kind` with `look` is set on its rows. Only body
    /// paragraphs take the first-line indent, and not list items, code or
    /// rules; code is never justified or squeezed.
    pub(crate) fn setting_of(&self, look: &BlockLook, kind: BlockKind) -> RowSetting {
        let first_indent =
            if kind == BlockKind::Body && look.list.is_none() && !look.code && !look.rule {
                self.style.body_size * self.style.first_line_indent.clamp(0., 4.)
            } else {
                px(0.)
            };
        let align = match look.align {
            Align::Left => RowAlign::Left,
            Align::Center => RowAlign::Center,
            Align::Right => RowAlign::Right,
        };
        RowSetting {
            first_indent,
            align,
            justify: self.style.justify && !look.code,
            squeeze: self.style.squeeze && !look.code,
        }
    }

    /// The estimated height of paragraph `line` of `chapter` in a column of
    /// `column` (its block insets and first-line indent taken off).
    pub(crate) fn estimate_set(&self, chapter: usize, line: usize, column: f32) -> f32 {
        let doc = &self.book.chapters[chapter].doc;
        let Some(text) = doc.lines().get(line).map(|l| l.text.clone()) else {
            return 0.;
        };
        let set = self.para_set(chapter, line);
        estimate_indented(
            &text,
            &set.metrics,
            column - f32::from(set.narrowing()),
            set.setting,
        )
    }
}

/// [`estimate_height`] for a paragraph set in by `setting`'s first-line
/// indent, in a column of `wrap` (the block inset already taken off).
pub fn estimate_indented(
    text: &str,
    metrics: &BlockMetrics,
    wrap: f32,
    setting: RowSetting,
) -> f32 {
    let wrap = wrap.max(40.);
    let indent = f32::from(setting.first_indent);
    if indent <= 0. {
        return estimate_height(text, metrics, wrap);
    }
    // The indent takes room on the first row like that many ems of text.
    let ems = (indent / metrics.font_size).round() as usize;
    let padded: String = std::iter::repeat_n('　', ems).chain(text.chars()).collect();
    estimate_height(&padded, metrics, wrap)
}

/// What to ask the list to reveal so the caret's row sits at `position`
/// (0.25–0.75) of the viewport's height: a box as tall as the viewport,
/// placed so that showing it whole puts the caret there. `None` when the
/// caret is already within a pixel of the line.
pub fn typewriter_bounds(
    caret: Bounds<Pixels>,
    viewport: Bounds<Pixels>,
    position: f32,
) -> Option<Bounds<Pixels>> {
    let line = viewport.top() + viewport.size.height * position.clamp(0.25, 0.75);
    let off = caret.center().y - line;
    (off.abs() >= px(1.)).then(|| {
        Bounds::new(
            point(caret.left(), viewport.top() + off),
            size(caret.size.width, viewport.size.height),
        )
    })
}

/// Room after the last paragraph for typewriter scrolling (the old editor's:
/// the part of the view below the typewriter line, plus 24 px).
pub fn typewriter_tail(viewport_height: Pixels, position: f32) -> Pixels {
    (viewport_height * (1. - position.clamp(0.25, 0.75)) + px(24.)).ceil()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_typewriter_box_puts_the_caret_on_the_line() {
        let viewport = Bounds::new(point(px(0.), px(100.)), size(px(800.), px(600.)));
        // A caret 400 px down the view, line at half: move up by 100 px.
        let caret = Bounds::new(point(px(50.), px(490.)), size(px(2.), px(20.)));
        let b = typewriter_bounds(caret, viewport, 0.5).unwrap();
        assert_eq!(b.size.height, px(600.));
        // Revealing the box whole aligns its bottom with the view's bottom:
        // the view scrolls down 100 px and the caret's centre is at 400.
        assert_eq!(b.top() - viewport.top(), px(100.));
        // Already on the line: nothing to do.
        let on = Bounds::new(point(px(50.), px(390.)), size(px(2.), px(20.)));
        assert!(typewriter_bounds(on, viewport, 0.5).is_none());
        // Positions outside the old editor's range are clamped.
        assert_eq!(typewriter_tail(px(600.), 0.9), px(150. + 24.));
    }

    #[test]
    fn estimates_count_the_first_line_indent() {
        let metrics = BlockMetrics {
            font_size: 10.,
            line_height: 20.,
            pad_top: 0.,
            pad_bottom: 0.,
        };
        // Ten ideographs in a ten-em column: one row; indented two ems: two.
        let text = "一二三四五六七八九十";
        let plain = RowSetting::default();
        let indented = RowSetting {
            first_indent: px(20.),
            ..RowSetting::default()
        };
        assert_eq!(estimate_indented(text, &metrics, 100., plain), 20.);
        assert_eq!(estimate_indented(text, &metrics, 100., indented), 40.);
    }
}
