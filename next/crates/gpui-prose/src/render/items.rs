//! The editor's list items: chapter titles and paragraphs.

use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, TextRun,
    Window, div, px,
};

use super::{
    element::ParagraphElement,
    frame::CompSpan,
    runs::{line_runs, splice_composition},
};
use crate::{ProseEditor, layout::Affinity, layout::Item};

/// What a paragraph shows this frame.
pub(crate) struct Display {
    pub text: SharedString,
    pub runs: Vec<TextRun>,
    pub comp: Option<CompSpan>,
    /// Caret byte in `text`, if the caret is in this paragraph.
    pub cursor: Option<(usize, Affinity)>,
}

impl ProseEditor {
    pub(crate) fn render_item(
        &mut self,
        ix: usize,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> AnyElement {
        match self.book.item(ix) {
            Item::Title(chapter) => {
                let title = self.book.chapters[chapter].title.clone();
                let top = if chapter == 0 { px(56.) } else { px(96.) };
                div()
                    .w_full()
                    .flex()
                    .justify_center()
                    .pt(top)
                    .pb(px(28.))
                    .child(
                        div()
                            .max_w(self.style.max_width)
                            .w_full()
                            .text_size(self.style.title_size)
                            .font_family(self.style.font_family.clone())
                            .font_weight(FontWeight::BOLD)
                            .text_color(self.style.text)
                            .child(title),
                    )
                    .into_any_element()
            }
            Item::Line(chapter, line) => self.paragraph(ix, chapter, line).into_any_element(),
        }
    }

    /// The text, runs, composition and caret of one paragraph as shown now.
    pub(crate) fn display(&mut self, chapter: usize, line_ix: usize) -> Display {
        let extension = self.extension.clone();
        let doc = &mut self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix).clone();
        let line_end = line_start + line.chars;
        let runs = line_runs(
            line.text.len(),
            &line.spans,
            line.kind,
            &self.style,
            extension.as_deref(),
        );
        let comp = self
            .composition
            .as_ref()
            .filter(|comp| comp.chapter == chapter && (line_start..=line_end).contains(&comp.at));
        match comp {
            Some(comp) => {
                let at = line.byte_of_char(comp.at - line_start);
                let replaced_end = line.byte_of_char(comp.at - line_start + comp.replaced);
                let text = SharedString::from(format!(
                    "{}{}{}",
                    &line.text[..at],
                    comp.text,
                    &line.text[replaced_end..]
                ));
                let span = CompSpan {
                    at,
                    len: comp.text.len(),
                    replaced: replaced_end - at,
                };
                let runs = splice_composition(&runs, at, span.replaced, span.len, self.style.text);
                let cursor = (at + comp.selected.end, Affinity::Downstream);
                Display {
                    text,
                    runs,
                    comp: Some(span),
                    cursor: Some(cursor),
                }
            }
            None => {
                let sel = self.selection;
                let cursor = (sel.chapter == chapter
                    && self.composition.is_none()
                    && (line_start..=line_end).contains(&sel.head))
                .then(|| (line.byte_of_char(sel.head - line_start), sel.affinity));
                Display {
                    text: line.text.clone(),
                    runs,
                    comp: None,
                    cursor,
                }
            }
        }
    }

    pub(crate) fn paragraph(
        &mut self,
        item_ix: usize,
        chapter: usize,
        line_ix: usize,
    ) -> ParagraphElement {
        let display = self.display(chapter, line_ix);
        let doc = &mut self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix).clone();
        let metrics = self.style.metrics(line.kind);
        let line_end = line_start + line.chars;

        let sel = self.selection;
        let selection = if sel.chapter == chapter && !sel.is_empty() && self.composition.is_none() {
            let range = sel.range();
            if range.end <= line_start || range.start > line_end {
                None
            } else {
                let start = range.start.max(line_start);
                let end = range.end.min(line_end);
                let past_end = range.end > line_end;
                (start < end || past_end).then(|| {
                    (
                        line.byte_of_char(start - line_start)..line.byte_of_char(end - line_start),
                        past_end,
                    )
                })
            }
        } else {
            None
        };

        let show_cursor =
            display.cursor.is_some() && (self.selection.is_empty() || display.comp.is_some());
        ParagraphElement {
            item_ix,
            chapter,
            line: line_ix,
            rev: line.rev,
            text: display.text,
            runs: display.runs,
            font_size: px(metrics.font_size),
            line_height: px(metrics.line_height),
            pad_top: px(metrics.pad_top),
            pad_bottom: px(metrics.pad_bottom),
            max_width: self.style.max_width,
            gutter: self.style.gutter,
            selection,
            cursor: if show_cursor { display.cursor } else { None },
            cursor_out: self.cursor_rect.clone(),
            autoscroll: self.autoscroll && show_cursor,
            comp: display.comp,
            selection_color: self.style.selection,
            text_color: self.style.text,
            frame: self.frame.clone(),
            heights: self.heights.clone(),
        }
    }
}
