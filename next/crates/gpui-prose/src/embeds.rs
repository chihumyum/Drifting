//! Embeds: paragraphs the host draws itself (a table, an image).
//!
//! An embed paragraph is a lone U+FFFC ([`crate::schema::OBJECT`]) carrying
//! an `embed` mark whose value is the embed's id ([`crate::Line::embed`]);
//! what it shows lives outside the body text, with the host. With
//! [`EmbedViews`] set ([`ProseEditor::set_embed_views`]) the editor puts the
//! host's element in that paragraph's place, in the text column, measured at
//! its real height like a chapter slot. Without it, or while an input method
//! composes over it, the paragraph is drawn as text.
//!
//! For the caret an embed is one thing (ProseMirror's node selection):
//!
//! - a caret that lands in an embed paragraph selects the embed (its one
//!   character); the host draws the selection (`selected`);
//! - ← ↑ from a selected embed go to the end of the paragraph before it,
//!   → ↓ to the start of the paragraph after it;
//! - ↑ ↓ from the text next to an embed first offer the host the caret
//!   ([`EmbedViews::enter`]: a table puts it in its nearest cell), else
//!   select the embed;
//! - Backspace at the start of the paragraph after an embed, or Delete at
//!   the end of the one before it, selects the embed (an empty paragraph
//!   there goes first); with the embed selected they delete its paragraph;
//! - Enter with an embed selected opens an empty paragraph after it, and
//!   typing with an embed selected types there: an embed is never replaced
//!   by a keystroke.
//!
//! The selection's rules are in `input/objects.rs`.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    AnyElement, App, Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Styled,
    Window, canvas, div,
};

use crate::{ProseEditor, input::Selection, layout::HeightIndex};

/// The host's elements for embeds ([`ProseEditor::set_embed_views`]).
pub trait EmbedViews: 'static {
    /// The element for embed `id` in chapter `chapter`, drawn in the text
    /// column; `selected` while the selection covers it. `None` draws the
    /// paragraph as text (an embed kind the host does not know).
    fn view(
        &self,
        chapter: usize,
        id: &str,
        selected: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement>;

    /// The caret moves onto embed `id` by ↑ (`from_below`) or ↓: the host
    /// may take it inside (focus its own field) and return `true`; `false`
    /// selects the embed.
    fn enter(
        &self,
        _chapter: usize,
        _id: &str,
        _from_below: bool,
        _window: &mut Window,
        _cx: &mut App,
    ) -> bool {
        false
    }
}

/// An embed's list item: the host's element in the text column, its height
/// written to the height index, mouse presses kept inside.
pub(crate) fn embed_item(
    item_ix: usize,
    editor: &ProseEditor,
    pad_bottom: f32,
    element: AnyElement,
) -> AnyElement {
    let heights: Rc<RefCell<HeightIndex>> = editor.heights.clone();
    div()
        .w_full()
        .px(editor.style.gutter)
        .flex()
        .justify_center()
        .relative()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .max_w(editor.style.max_width)
                .w_full()
                .pb(gpui::px(pad_bottom))
                .child(element),
        )
        .child(
            canvas(
                move |bounds, _, _| {
                    heights
                        .borrow_mut()
                        .set_measured(item_ix, f32::from(bounds.size.height));
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .into_any_element()
}

impl ProseEditor {
    /// Lets the host draw embed paragraphs ([`EmbedViews`]), or draws them
    /// as text again (`None`).
    pub fn set_embed_views(&mut self, views: Option<Rc<dyn EmbedViews>>, cx: &mut Context<Self>) {
        self.embeds = views;
        self.list.remeasure();
        cx.notify();
    }

    /// The embed paragraph `line` of `chapter`: its id and first offset.
    pub fn embed_at(&self, chapter: usize, line: usize) -> Option<(String, usize)> {
        let doc = &self.book.chapters.get(chapter)?.doc;
        let id = doc.lines().get(line)?.embed()?.to_owned();
        Some((id, doc.line_start(line)))
    }

    /// The paragraph of embed `id` in `chapter`, if it is there.
    pub fn embed_line(&self, chapter: usize, id: &str) -> Option<usize> {
        let doc = &self.book.chapters.get(chapter)?.doc;
        doc.lines()[..doc.visible_lines()]
            .iter()
            .position(|l| l.embed() == Some(id))
    }

    /// The embed the selection is exactly on: `(chapter, line)`.
    pub fn selected_embed(&self) -> Option<(usize, usize)> {
        let sel = self.selection;
        if sel.spans_chapters() {
            return None;
        }
        let range = sel.range();
        if range.len() != 1 {
            return None;
        }
        let doc = &self.book.chapters[sel.chapter].doc;
        let line = doc.line_of(range.start);
        (doc.line_start(line) == range.start && doc.lines()[line].embed().is_some())
            .then_some((sel.chapter, line))
    }

    /// Selects embed paragraph `line` of `chapter` (the host's click on its
    /// frame) and takes the focus.
    pub fn select_embed(
        &mut self,
        chapter: usize,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((_, start)) = self.embed_at(chapter, line) else {
            return;
        };
        self.set_selection(Selection::new(chapter, start, start + 1), cx);
        window.focus(&self.focus, cx);
    }

    /// Puts the caret at `offset` of `chapter` and takes the focus (a host
    /// handing the caret back from inside an embed).
    pub fn focus_at(
        &mut self,
        chapter: usize,
        offset: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if chapter >= self.book.chapters.len() {
            return;
        }
        self.set_selection(Selection::caret(chapter, offset), cx);
        window.focus(&self.focus, cx);
    }

    /// Folds `items` items a host committed to `chapter`'s document outside
    /// its body text (a table cell's typing) into the author's undo history,
    /// so ⌘Z takes them back in order with the body's own steps. `new_step`
    /// starts a step of their own; otherwise they merge with the last step
    /// within the usual interval (a burst of typing in one cell).
    pub fn record_host_items(&mut self, chapter: usize, items: usize, new_step: bool) {
        if items == 0 || chapter >= self.book.chapters.len() {
            return;
        }
        let doc = &mut self.book.chapters[chapter].doc;
        let before = doc.undo_count();
        if new_step {
            doc.checkpoint();
        }
        doc.record_host_items(items);
        if doc.undo_count() != before {
            self.undo_chapters.push(chapter);
        }
        self.redo_chapters.clear();
    }

    /// The embed list item for paragraph `line` of `chapter`, if the host
    /// draws it.
    pub(crate) fn render_embed(
        &mut self,
        item_ix: usize,
        chapter: usize,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let views = self.embeds.clone()?;
        let (id, start) = self.embed_at(chapter, line)?;
        if self
            .composition
            .as_ref()
            .is_some_and(|c| c.chapter == chapter && (start..=start + 1).contains(&c.at))
        {
            return None;
        }
        let selected = self.selected_in(chapter).is_some_and(|(range, _)| {
            self.composition.is_none() && range.start <= start && range.end > start
        });
        let element = views.view(chapter, &id, selected, window, cx)?;
        let pad = self.style.metrics(crate::BlockKind::Body).pad_bottom;
        Some(embed_item(item_ix, self, pad, element))
    }
}
