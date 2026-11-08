//! The editor's list items: chapter titles and paragraphs.

use std::ops::Range;

use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, TextRun,
    Window, div, px,
};

use super::{
    decor::{DecorationKey, Touch},
    element::ParagraphElement,
    frame::CompSpan,
    runs::splice_composition,
    state::{Live, ParaDeco, ParaKind},
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.paint.pending.is_empty() {
            self.flush_decoration_events(cx);
        }
        match self.book.item(ix) {
            Item::Title(chapter) => {
                // A small editor that fits its text has no title rows.
                if self.options.fit_content {
                    return crate::slots::slot_item(ix, self.heights.clone(), None);
                }
                if let Some(slots) = self.slots.clone()
                    && let Some(head) = slots.head(chapter, window, cx)
                {
                    return crate::slots::slot_item(ix, self.heights.clone(), Some(head));
                }
                let title = self.book.chapters[chapter].title.clone();
                let top = if chapter == 0 { px(56.) } else { px(96.) };
                // The paragraphs' column: the page gutter on both sides, then
                // at most `max_width`, centred.
                div()
                    .w_full()
                    .px(self.style.gutter)
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
            Item::Line(chapter, line) => {
                // An embed the host draws (`embeds.rs`).
                if let Some(embed) = self.render_embed(ix, chapter, line, window, cx) {
                    return embed;
                }
                let element = self.paragraph(ix, chapter, line, cx);
                if std::mem::take(&mut self.paint.animating) {
                    window.request_animation_frame();
                }
                element.into_any_element()
            }
            Item::End(chapter) => {
                let end = self
                    .slots
                    .clone()
                    .and_then(|slots| slots.end(chapter, window, cx));
                crate::slots::slot_item(ix, self.heights.clone(), end)
            }
        }
    }

    /// The text, runs, composition and caret of one paragraph as shown now.
    pub(crate) fn display(&mut self, chapter: usize, line_ix: usize) -> Display {
        let doc = &mut self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix).clone();
        let line_end = line_start + line.chars;
        let runs = self.paragraph_runs(&line, &self.block_look(chapter, line_ix));
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

    /// The decorations on one paragraph this frame, in display bytes.
    fn paragraph_decorations(
        &mut self,
        chapter: usize,
        line_ix: usize,
        comp: Option<CompSpan>,
        font_size: f32,
        now: std::time::Instant,
    ) -> Vec<ParaDeco> {
        let find_look = self.paint.find_look.clone();
        let layer = self.paint.layer_ref(chapter);
        if layer.is_none() && find_look.is_none() {
            return Vec::new();
        }
        let doc = &self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix);
        let line_end = line_start + line.chars;
        let wrap = f32::from(self.estimate_width.unwrap_or(self.style.max_width));
        let chars_per_row = wrap / font_size.max(1.);
        let lives: Vec<&Live> = layer
            .map(|layer| layer.overlapping(line_start, line_end).collect())
            .unwrap_or_default();
        // Find hits on this paragraph (F4c keeps them; the current one is the
        // selection), drawn with the host's look under everything else.
        let mut first_find = 0;
        let finds: Vec<(Range<usize>, bool)> = match &find_look {
            Some(_) if self.find_query().is_some() => {
                let matches = self.find_matches(chapter);
                let current = self.find_current().filter(|hit| hit.chapter == chapter);
                let first = matches.partition_point(|m| m.end <= line_start);
                first_find = first;
                matches[first..]
                    .iter()
                    .take_while(|m| m.start < line_end)
                    .map(|m| {
                        let is_current = current.as_ref().is_some_and(|hit| hit.range == *m);
                        (m.clone(), is_current)
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        if lives.is_empty() && finds.is_empty() {
            return Vec::new();
        }
        // Every start and end on this paragraph, turned into bytes in one
        // walk along its text (a paragraph can be thousands of characters).
        let mut offsets: Vec<usize> = lives
            .iter()
            .map(|l| &l.deco.range)
            .chain(finds.iter().map(|(r, _)| r))
            .flat_map(|r| {
                [
                    r.start.max(line_start) - line_start,
                    r.end.min(line_end).max(line_start) - line_start,
                ]
            })
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        let bytes = bytes_of_chars(&line.text, &offsets);
        // Committed text → display text (a composition shows inside it):
        // a range starting at the composition leaves it outside.
        let byte_of = |chars: usize, is_start: bool| {
            let byte = match offsets.binary_search(&chars) {
                Ok(ix) => bytes[ix],
                Err(_) => line.byte_of_char(chars),
            };
            match comp {
                Some(c) if byte > c.at || (is_start && byte == c.at) => {
                    if byte < c.at + c.replaced {
                        c.at + c.len
                    } else {
                        byte - c.replaced + c.len
                    }
                }
                _ => byte,
            }
        };
        let mut decos: Vec<ParaDeco> = Vec::with_capacity(finds.len() + lives.len());
        if let Some(look) = &find_look {
            for (ix, (range, current)) in finds.iter().enumerate() {
                let (start, end) = (range.start.max(line_start), range.end.min(line_end));
                let strength = if *current {
                    look.strength.hot
                } else {
                    look.strength.rest
                };
                decos.push(ParaDeco {
                    key: DecorationKey {
                        group: SharedString::new_static("find"),
                        id: SharedString::from((first_find + ix).to_string()),
                    },
                    bytes: byte_of(start - line_start, true)..byte_of(end - line_start, false),
                    kind: ParaKind::Wash {
                        brush: look.brush.clone(),
                        hot_brush: None,
                        color: look.color,
                        alpha: look.color.a * strength,
                        heat: 0.,
                        reach: look.reach,
                    },
                    touch: Touch::None,
                    seed: ix as u32,
                    drawn: None,
                });
            }
        }
        let mut animating = false;
        let decos_from_layer = lives.into_iter().filter_map(|live| {
            let part = live.para(line_start, line_end, chars_per_row, byte_of, line_ix, now);
            animating |= live.moving(now) || part.as_ref().is_some_and(|p| p.drawn.is_some());
            part
        });
        decos.extend(decos_from_layer);
        self.paint.animating |= animating;
        decos
    }

    pub(crate) fn paragraph(
        &mut self,
        item_ix: usize,
        chapter: usize,
        line_ix: usize,
        cx: &mut Context<Self>,
    ) -> ParagraphElement {
        let now = cx.background_executor().now();
        let display = self.display(chapter, line_ix);
        let doc = &mut self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix).clone();
        let line_end = line_start + line.chars;
        let set = self.para_set(chapter, line_ix);
        let metrics = set.metrics;

        let sel = self.selection;
        // What is selected in this chapter (a selection may span chapters:
        // then the chapter's end is selected like a line break).
        let selection = match self.selected_in(chapter) {
            Some((range, beyond)) if self.composition.is_none() => {
                let reach = range.end + usize::from(beyond);
                if reach <= line_start || range.start > line_end {
                    None
                } else {
                    let start = range.start.max(line_start);
                    let end = range.end.min(line_end);
                    let past_end = reach > line_end;
                    (start < end || past_end).then(|| {
                        (
                            line.byte_of_char(start - line_start)
                                ..line.byte_of_char(end - line_start),
                            past_end,
                        )
                    })
                }
            }
            _ => None,
        };

        // Immersive writing: the caret's paragraph keeps its ink.
        let alpha = if self.paint.focus.on.target() > 0. || self.paint.focus.moving(now) {
            let caret = match &self.composition {
                Some(comp) => (comp.chapter, comp.at),
                None => (sel.chapter, sel.head),
            };
            let caret_line = self.book.chapters[caret.0].doc.line_of(caret.1);
            self.paint.track_focus((caret.0, caret_line), now);
            self.paint.animating |= self.paint.focus.moving(now);
            self.paint.focus.alpha((chapter, line_ix), now)
        } else {
            1.
        };
        let decos =
            self.paragraph_decorations(chapter, line_ix, display.comp, metrics.font_size, now);
        let (block, setting) = (set.look, set.setting);
        let last = item_ix + 1 == self.book.item_count();

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
            block,
            block_style: self.paint.block_style.clone(),
            body_size: self.style.body_size,
            decos,
            alpha,
            editor: cx.weak_entity(),
            shared: self.paint.shared.clone(),
            settle_on_click: self.paint.any_unsettled_drawn(),
            setting,
            typewriter: self.style.typewriter,
            last,
        }
    }
}

/// The byte offsets of sorted character offsets in `text`, in one walk.
fn bytes_of_chars(text: &str, sorted: &[usize]) -> Vec<usize> {
    let mut out = Vec::with_capacity(sorted.len());
    let mut wanted = sorted.iter().peekable();
    for (chars, (byte, _)) in text.char_indices().enumerate() {
        while wanted.next_if(|w| **w == chars).is_some() {
            out.push(byte);
        }
        if wanted.peek().is_none() {
            return out;
        }
    }
    out.resize(sorted.len(), text.len());
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn character_offsets_become_bytes_in_one_walk() {
        let text = "甲a乙b丙";
        assert_eq!(
            super::bytes_of_chars(text, &[0, 1, 2, 5, 9]),
            [0, 3, 4, 11, 11]
        );
        assert_eq!(super::bytes_of_chars(text, &[]), Vec::<usize>::new());
    }
}
