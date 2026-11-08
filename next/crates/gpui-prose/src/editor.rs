//! The editor view: a virtualized scroll of paragraphs over one or more body
//! texts. This file holds the state and the frame; behaviour lives with its
//! sub-line (`input/` for keys, IME and mouse, `render/` for items and paint,
//! `layout/` for geometry, `text/` for the document).

use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
};

use gpui::{
    App, AppContext, Bounds, Context, CursorStyle, ElementInputHandler, Entity, EventEmitter,
    FocusHandle, Focusable, InteractiveElement, IntoElement, ListAlignment, ListOffset, ListState,
    MouseButton, ParentElement, Pixels, Point, Render, Styled, Subscription, Task, Window, canvas,
    div, list, prelude::FluentBuilder as _, px,
};

use crate::{
    extension::ProseExtension,
    input::{Composition, KEY_CONTEXT, Selection},
    layout::{BlockMetrics, Book, HeightIndex, ProseLayout, column, shape_set},
    platform::PlatformHooks,
    render::{CursorLayer, FrameCache},
    style::{EditorOptions, ProseStyle},
    text::{AnchorChange, BlockKind, MarkOverride, Marks, ProseDoc, segment},
};

/// What an editor reports to its host. None of these carries text: the
/// editor only writes the Loro documents, and anything derived from them
/// (outline, word counts, references, search) is computed by whoever owns
/// the documents from their Loro changes, not pushed back by the editor.
#[derive(Clone, Debug, PartialEq)]
pub enum EditorEvent {
    /// The author changed a chapter (for UI state such as a toolbar).
    Edited { chapter: usize },
    /// The selection or caret moved.
    SelectionChanged,
    /// An undo brought anchored text back and re-anchored these anchors on
    /// the restored characters. This is an edit of the anchors themselves
    /// (new cursors, which live outside the body text), so the host stores
    /// them where it keeps anchors.
    AnchorsChanged {
        chapter: usize,
        changes: Vec<AnchorChange>,
    },
}

/// The author wrote text: typed characters, an input method's confirmed
/// text, Enter. Not a paste, a drop, a deletion, an undo, an input method
/// still composing, nor a host's or an Agent's write. A host begins
/// immersive writing on it when the author starts writing (M26).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorTyped {
    pub chapter: usize,
}

type PaintHook = Box<dyn FnOnce(&mut Window, &mut App)>;

/// Pixels rendered above and below the viewport.
const OVERDRAW: f32 = 1200.;

pub struct ProseEditor {
    pub(crate) book: Book,
    pub(crate) list: ListState,
    pub(crate) focus: FocusHandle,
    pub(crate) style: ProseStyle,
    pub(crate) options: EditorOptions,
    pub(crate) selection: Selection,
    pub(crate) composition: Option<Composition>,
    /// Marks a bare caret's toggles (⌘B before typing) put on the next text.
    pub(crate) pending_marks: Vec<MarkOverride>,
    pub(crate) frame: Rc<RefCell<FrameCache>>,
    pub(crate) heights: Rc<RefCell<HeightIndex>>,
    /// Wrap width the current estimates were made for.
    pub(crate) estimate_width: Option<Pixels>,
    estimate_generation: u64,
    _estimate_task: Option<Task<()>>,
    /// The blinking caret, a separate view so a blink repaints only it.
    pub(crate) cursor_layer: Entity<CursorLayer>,
    /// Where the caret is, written by the paragraph that holds it.
    pub(crate) cursor_rect: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub(crate) autoscroll: bool,
    /// Typewriter scrolling's line moved (or it was turned on): the caret
    /// goes to it at the next frame, if the editor has the focus.
    realign_typewriter: bool,
    /// The view's height at the last frame (typewriter scrolling realigns
    /// when it changes).
    drawn_height: Option<Pixels>,
    pub(crate) selecting: bool,
    pub(crate) undo_chapters: Vec<usize>,
    pub(crate) redo_chapters: Vec<usize>,
    pub(crate) own_edit: bool,
    last_comp_origin: Option<Point<Pixels>>,
    paint_hooks: Vec<PaintHook>,
    pub(crate) hooks: Option<Rc<dyn PlatformHooks>>,
    pub(crate) extension: Option<Rc<dyn ProseExtension>>,
    /// The host's elements at each chapter's head and end.
    pub(crate) slots: Option<Rc<dyn crate::slots::ChapterSlots>>,
    /// The host's elements for embed paragraphs.
    pub(crate) embeds: Option<Rc<dyn crate::embeds::EmbedViews>>,
    /// The ancestor opacity the editor was last drawn under, when the host
    /// says ([`ProseEditor::element_at_opacity`]).
    pub(crate) drawn_opacity: Cell<Option<f32>>,
    pub(crate) input: crate::input::InputState,
    pub(crate) paint: crate::render::PaintState,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<EditorEvent> for ProseEditor {}
impl EventEmitter<AuthorTyped> for ProseEditor {}

/// How a host's edit ([`ProseEditor::edit_chapter`]) undoes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostStep {
    /// One undo step of its own.
    Own,
    /// Undone together with the last step.
    JoinLast,
}

impl ProseEditor {
    pub fn new(book: Book, style: ProseStyle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        ProseEditor::with_options(book, style, EditorOptions::default(), window, cx)
    }

    pub fn with_options(
        book: Book,
        style: ProseStyle,
        options: EditorOptions,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        let count = book.item_count();
        let list = ListState::new(count, ListAlignment::Top, px(OVERDRAW));
        let default_height = style.metrics(BlockKind::Body);
        let heights = HeightIndex::new(
            (0..count).map(|_| default_height.line_height * 3. + default_height.pad_bottom),
        );
        let subscriptions = vec![
            cx.on_focus(&focus, window, |this, _window, cx| {
                this.reset_blink(cx);
            }),
            cx.on_blur(&focus, window, |this, window, cx| {
                this.on_blur(window, cx);
            }),
        ];
        let cursor_rect: Rc<Cell<Option<Bounds<Pixels>>>> = Rc::default();
        let cursor_layer =
            cx.new(|_| CursorLayer::new(cursor_rect.clone(), style.cursor, options.cursor_blink));
        ProseEditor {
            book,
            list,
            focus,
            style,
            options,
            selection: Selection::caret(0, 0),
            composition: None,
            pending_marks: Vec::new(),
            frame: Rc::default(),
            heights: Rc::new(RefCell::new(heights)),
            estimate_width: None,
            estimate_generation: 0,
            _estimate_task: None,
            cursor_layer,
            cursor_rect,
            autoscroll: false,
            realign_typewriter: false,
            drawn_height: None,
            selecting: false,
            undo_chapters: Vec::new(),
            redo_chapters: Vec::new(),
            own_edit: false,
            last_comp_origin: None,
            paint_hooks: Vec::new(),
            hooks: None,
            extension: None,
            slots: None,
            embeds: None,
            drawn_opacity: Cell::new(None),
            input: Default::default(),
            paint: Default::default(),
            _subscriptions: subscriptions,
        }
    }

    pub fn set_platform_hooks(&mut self, hooks: Rc<dyn PlatformHooks>) {
        self.hooks = Some(hooks);
    }

    pub fn set_extension(&mut self, extension: Rc<dyn ProseExtension>) {
        self.extension = Some(extension);
        self.list.remeasure();
    }

    /// Puts the host's elements at each chapter's head (in place of the
    /// title row) and end (after its last paragraph), or takes them away.
    /// Set it right after building the editor: the list starts over (the
    /// scroll goes back to the top).
    pub fn set_slots(
        &mut self,
        slots: Option<Rc<dyn crate::slots::ChapterSlots>>,
        cx: &mut Context<Self>,
    ) {
        self.book.set_ends(slots.is_some());
        self.slots = slots;
        let count = self.book.item_count();
        self.list.reset(count);
        let default = self.style.metrics(BlockKind::Body);
        *self.heights.borrow_mut() =
            HeightIndex::new((0..count).map(|_| default.line_height * 3. + default.pad_bottom));
        if let Some(width) = self.estimate_width {
            self.estimate_all(width, cx);
        }
        cx.notify();
    }

    /// The host's elements of `chapter` changed size (a title now wraps to
    /// two rows): they are measured again on the next frame.
    pub fn slots_changed(&mut self, chapter: usize, cx: &mut Context<Self>) {
        if chapter >= self.book.chapters.len() {
            return;
        }
        let head = self.book.chapter_item(chapter);
        self.list.remeasure_items(head..head + 1);
        if let Some(end) = self.book.end_item(chapter) {
            self.list.remeasure_items(end..end + 1);
        }
        cx.notify();
    }

    /// Puts the caret at the start of `chapter`'s text and focuses the
    /// editor (the host's title field hands over on Enter).
    pub fn focus_chapter_start(
        &mut self,
        chapter: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let chapter = chapter.min(self.book.chapters.len() - 1);
        self.cancel_composition();
        self.set_selection(Selection::caret(chapter, 0), cx);
        // The same reveal as typing's: a paragraph far off is put at the
        // top (the list cannot reveal what it never measured).
        self.reveal_cursor();
        window.focus(&self.focus, cx);
        self.reset_blink(cx);
        cx.notify();
    }

    /// Undoes the most recent author step of `chapter` only, for hosts whose
    /// chapters keep their own undo (Drifting's whole-book view: ⌘Z undoes
    /// in the chapter the caret is in). Returns whether anything changed.
    pub fn undo_in(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.composition.is_some() || chapter >= self.book.chapters.len() {
            return false;
        }
        // With the rest of its edit group (an edit across chapters).
        let result = self.undo_grouped(chapter, cx);
        let Some(cursor) = result else {
            return false;
        };
        if let Some(at) = self.undo_chapters.iter().rposition(|c| *c == chapter) {
            self.undo_chapters.remove(at);
        }
        self.redo_chapters.push(chapter);
        if let Some(cursor) = cursor {
            self.selection = Selection::caret(chapter, cursor);
            self.clamp_selection();
        }
        self.after_history_step(chapter, window, cx);
        true
    }

    /// Redoes the most recent undone step of `chapter` only.
    pub fn redo_in(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.composition.is_some() || chapter >= self.book.chapters.len() {
            return false;
        }
        let result = self.redo_grouped(chapter, cx);
        let Some(cursor) = result else {
            return false;
        };
        if let Some(at) = self.redo_chapters.iter().rposition(|c| *c == chapter) {
            self.redo_chapters.remove(at);
        }
        self.undo_chapters.push(chapter);
        if let Some(cursor) = cursor {
            self.selection = Selection::caret(chapter, cursor);
            self.clamp_selection();
        }
        self.after_history_step(chapter, window, cx);
        true
    }

    /// Changes sizes, spacing, width or colours (the host's settings and
    /// theme): every paragraph is measured and laid out again.
    pub fn set_style(&mut self, style: ProseStyle, cx: &mut Context<Self>) {
        if style == self.style {
            return;
        }
        let cursor = style.cursor;
        self.realign_typewriter |=
            style.typewriter.is_some() && style.typewriter != self.style.typewriter;
        self.style = style;
        self.estimate_width = None;
        self.list.remeasure();
        self.cursor_layer
            .update(cx, |layer, cx| layer.set_color(cursor, cx));
        cx.notify();
    }

    pub fn options(&self) -> &EditorOptions {
        &self.options
    }

    pub fn options_mut(&mut self) -> &mut EditorOptions {
        &mut self.options
    }

    pub fn book(&self) -> &Book {
        &self.book
    }

    pub fn book_mut(&mut self) -> &mut Book {
        &mut self.book
    }

    pub fn list_state(&self) -> &ListState {
        &self.list
    }

    pub fn selection(&self) -> Selection {
        self.selection
    }

    /// Whether a mouse drag is still choosing the selection.
    pub fn is_selecting(&self) -> bool {
        self.selecting
    }

    pub fn composition(&self) -> Option<&Composition> {
        self.composition.as_ref()
    }

    pub fn heights(&self) -> Rc<RefCell<HeightIndex>> {
        self.heights.clone()
    }

    pub fn style(&self) -> &ProseStyle {
        &self.style
    }

    /// The marks of the character at `offset` in `chapter` (for a click on a
    /// link or an entity).
    pub fn marks_at(&mut self, chapter: usize, offset: usize) -> Marks {
        self.book.chapters[chapter].doc.marks_before(offset + 1)
    }

    /// Runs a host's edit of `chapter`'s document as the author's (a picker
    /// inserting a link, automatic links, link repair) and folds it in like
    /// typing. `step` says how it undoes: [`HostStep::Own`] is one undo step
    /// of its own; [`HostStep::JoinLast`] is undone together with the last
    /// step (what the edit was derived from). `f` returns where the caret
    /// goes, if it moves. Nothing happens while text is being composed in
    /// that chapter (returns false; try again after the composition).
    pub fn edit_chapter(
        &mut self,
        chapter: usize,
        step: HostStep,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut ProseDoc) -> Option<usize>,
    ) -> bool {
        if chapter >= self.book.chapters.len()
            || self
                .composition
                .as_ref()
                .is_some_and(|c| c.chapter == chapter)
        {
            return false;
        }
        let before = self.book.chapters[chapter].doc.undo_count();
        let doc = &mut self.book.chapters[chapter].doc;
        match step {
            HostStep::Own => doc.checkpoint(),
            HostStep::JoinLast => doc.join_last_step(),
        }
        let caret = f(doc);
        // Not marked as the editor's own: the caret and the composition
        // follow the edit like anyone else's, unless `f` placed the caret.
        self.sync_chapter(chapter, cx);
        if let Some(at) = caret {
            self.pending_marks.clear();
            self.selection = Selection::caret(chapter, at);
            self.clamp_selection();
            self.reveal_cursor();
        }
        if self.book.chapters[chapter].doc.undo_count() != before {
            self.undo_chapters.push(chapter);
            self.redo_chapters.clear();
        }
        if step == HostStep::Own {
            self.book.chapters[chapter].doc.checkpoint();
        }
        window.notify_text_input_changed(&self.focus);
        cx.emit(EditorEvent::Edited { chapter });
        self.emit_selection_changed(cx);
        cx.notify();
        true
    }

    /// Where the caret was drawn in the last frame (window coordinates).
    pub fn caret_bounds(&self) -> Option<Bounds<Pixels>> {
        self.cursor_rect.get()
    }

    /// The box around `range` of `chapter` as drawn in the last frame
    /// (window coordinates): from the top of its first row to the bottom of
    /// its last, as wide as the text it covers when on one row, else the
    /// column. `None` when its first paragraph is not on screen.
    pub fn range_bounds(&self, chapter: usize, range: Range<usize>) -> Option<Bounds<Pixels>> {
        let doc = &self.book.chapters.get(chapter)?.doc;
        let frame = self.frame.borrow();
        let point = |offset: usize, affinity: crate::layout::Affinity| {
            let line_ix = doc.line_of(offset);
            let painted = frame.get(chapter, line_ix)?;
            let line = doc.lines().get(line_ix)?;
            let byte = line.byte_of_char(offset - doc.line_start(line_ix));
            let p = painted
                .layout
                .point_for_byte(byte, affinity, painted.line_height);
            Some((
                painted.origin + p,
                painted.line_height,
                painted.origin.x,
                painted.layout.wrap_width,
            ))
        };
        let (start, line_height, left, wrap) =
            point(range.start, crate::layout::Affinity::Downstream)?;
        let (end, end_height) = point(range.end, crate::layout::Affinity::Upstream)
            .map(|(p, h, _, _)| (p, h))
            .unwrap_or((start, line_height));
        let bottom = end.y + end_height;
        if (end.y - start.y).abs() < px(1.) {
            Some(Bounds::new(
                start,
                gpui::size((end.x - start.x).max(px(1.)), bottom - start.y),
            ))
        } else {
            Some(Bounds::new(
                gpui::point(left, start.y),
                gpui::size(wrap, bottom - start.y),
            ))
        }
    }

    /// Runs `hook` once, at the end of the next paint of this editor.
    pub fn after_next_paint(&mut self, hook: impl FnOnce(&mut Window, &mut App) + 'static) {
        self.paint_hooks.push(Box::new(hook));
    }

    /// Paragraphs painted in the last frame.
    pub fn painted_lines(&self) -> usize {
        self.frame.borrow().lines.len()
    }

    // ----- scripted input (benchmarks, tests, hosts) -----------------------------

    /// Sets the selection in `chapter` (scalar offsets) and reveals it.
    pub fn select(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_composition();
        self.set_selection(Selection::new(chapter, range.start, range.end), cx);
    }

    /// Enter, as the key binding does.
    pub fn press_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.on_newline(&crate::input::actions::Newline, window, cx);
    }

    /// Backspace, as the key binding does.
    pub fn press_backspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.on_backspace(&crate::input::actions::Backspace, window, cx);
    }

    // ----- navigation -------------------------------------------------------------

    /// Scrolls to the start of `chapter` and puts the cursor there.
    pub fn jump_to_chapter(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) {
        let chapter = chapter.min(self.book.chapters.len() - 1);
        self.cancel_composition();
        self.selection = Selection::caret(chapter, 0);
        self.list.scroll_to(ListOffset {
            item_ix: self.book.chapter_item(chapter),
            offset_in_item: px(0.),
        });
        window.focus(&self.focus, cx);
        self.reset_blink(cx);
        cx.notify();
    }

    /// Scrolls by `delta` pixels using the editor's own height index (so a
    /// jump can cross paragraphs the list has never measured).
    pub fn scroll_by_estimate(&mut self, delta: f64, cx: &mut Context<Self>) -> bool {
        let top = self.list.logical_scroll_top();
        let mut heights = self.heights.borrow_mut();
        let y = heights.top(top.item_ix) + f64::from(f32::from(top.offset_in_item)) + delta;
        let total = heights.total();
        let (item_ix, offset) = heights.item_at(y);
        drop(heights);
        self.list.scroll_to(ListOffset {
            item_ix,
            offset_in_item: px(offset as f32),
        });
        cx.notify();
        y < total
    }

    /// Scroll position in document pixels, by the editor's height index.
    pub fn scroll_y(&self) -> (f64, f64) {
        let top = self.list.logical_scroll_top();
        let mut heights = self.heights.borrow_mut();
        (
            heights.top(top.item_ix) + f64::from(f32::from(top.offset_in_item)),
            heights.total(),
        )
    }

    // ----- frame ------------------------------------------------------------------

    fn after_paint(&mut self, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        self.autoscroll = false;
        // Typewriter scrolling keeps the caret on its line when the line
        // moves or the view's height changes (the 0.1 client's), for the
        // editor with the focus and a caret only.
        let resized = self
            .drawn_height
            .replace(bounds.size.height)
            .is_some_and(|h| h != bounds.size.height);
        if (std::mem::take(&mut self.realign_typewriter) || resized)
            && self.style.typewriter.is_some()
            && self.selection.is_empty()
            && self.composition.is_none()
            && self.focus.is_focused(window)
        {
            self.autoscroll = true;
            cx.notify();
        }
        // The candidate window follows the marked text when it moves (scroll,
        // reflow); macOS re-asks `firstRectForCharacterRange` after this.
        if let Some(comp) = &self.composition {
            let origin = self
                .frame
                .borrow()
                .get(
                    comp.chapter,
                    self.book.chapters[comp.chapter].doc.line_of(comp.at),
                )
                .map(|painted| painted.origin);
            if origin != self.last_comp_origin {
                self.last_comp_origin = origin;
                window.invalidate_character_coordinates();
            }
        }
        let (wrap_width, _) = column(bounds.size.width, self.style.max_width, self.style.gutter);
        if self.estimate_width != Some(wrap_width) {
            self.estimate_width = Some(wrap_width);
            self.estimate_all(wrap_width, cx);
        }
        for hook in std::mem::take(&mut self.paint_hooks) {
            hook(window, cx);
        }
    }

    /// Estimates every paragraph's height on a background thread.
    fn estimate_all(&mut self, wrap_width: Pixels, cx: &mut Context<Self>) {
        self.estimate_generation += 1;
        let generation = self.estimate_generation;
        let mut items = Vec::with_capacity(self.book.item_count());
        let wrap = f32::from(wrap_width);
        let slot = |height: f32| {
            (
                None,
                BlockMetrics {
                    font_size: 0.,
                    line_height: 0.,
                    pad_top: height,
                    pad_bottom: 0.,
                },
                wrap,
                Default::default(),
            )
        };
        for (ix, chapter) in self.book.chapters.iter().enumerate() {
            match &self.slots {
                Some(slots) => items.push(slot(slots.head_estimate(ix))),
                None => items.push((
                    None,
                    BlockMetrics {
                        font_size: f32::from(self.style.title_size),
                        line_height: 0.,
                        pad_top: if ix == 0 { 56. } else { 96. },
                        pad_bottom: 28. + 42.,
                    },
                    wrap,
                    Default::default(),
                )),
            }
            for (line_ix, line) in chapter.doc.lines()[..chapter.doc.visible_lines()]
                .iter()
                .enumerate()
            {
                // Set like the paragraph (block insets, first-line indent,
                // the gaps and pads of its block).
                let set = self.para_set(ix, line_ix);
                items.push((
                    Some(line.text.clone()),
                    set.metrics,
                    wrap - f32::from(set.narrowing()),
                    set.setting,
                ));
            }
            if let Some(slots) = self.book.has_ends().then_some(()).and(self.slots.as_ref()) {
                items.push(slot(slots.end_estimate(ix)));
            }
        }
        let task = cx.background_executor().spawn(async move {
            items
                .iter()
                .map(|(text, metrics, wrap, setting)| match text {
                    Some(text) => crate::layout::estimate_indented(text, metrics, *wrap, *setting),
                    None => metrics.pad_top + metrics.pad_bottom,
                })
                .collect::<Vec<f32>>()
        });
        self._estimate_task = Some(cx.spawn(async move |this, cx| {
            let heights = task.await;
            this.update(cx, |this, cx| {
                if this.estimate_generation == generation {
                    this.heights.borrow_mut().reset_estimates(&heights);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    fn estimate_line(&self, chapter: usize, line: usize) -> f32 {
        let wrap = self.estimate_width.map_or(680., f32::from);
        self.estimate_set(chapter, line, wrap)
    }

    // ----- change bookkeeping -------------------------------------------------------

    /// Folds a chapter's applied changes into the list, the height index, and
    /// (for changes the editor did not make) the selection and composition.
    pub(crate) fn sync_chapter(&mut self, chapter: usize, cx: &mut Context<Self>) {
        let anchor_changes = self.book.chapters[chapter].doc.take_anchor_changes();
        if !anchor_changes.is_empty() {
            cx.emit(EditorEvent::AnchorsChanged {
                chapter,
                changes: anchor_changes,
            });
        }
        let changes = self.book.chapters[chapter].doc.take_changes();
        if changes.is_empty() {
            return;
        }
        for set in &changes {
            self.paint.follow(chapter, set, self.own_edit, cx);
            if !self.own_edit {
                // Each end in its own chapter (a selection may span chapters).
                for op in &set.ops {
                    if self.selection.anchor_chapter == chapter {
                        self.selection.anchor = op.transform(self.selection.anchor);
                    }
                    if self.selection.chapter == chapter {
                        self.selection.head = op.transform(self.selection.head);
                    }
                }
                if let Some(comp) = self.composition.as_mut()
                    && comp.chapter == chapter
                {
                    for op in &set.ops {
                        comp.follow(|p| op.transform(p));
                    }
                }
            }
            for splice in &set.splices {
                let listed = self.book.listed[chapter];
                let start = splice.start.min(listed);
                let old = splice.old.min(listed - start);
                let item = self.book.line_item(chapter, start);
                if old == 1 && splice.new == 1 {
                    self.list.remeasure_items(item..item + 1);
                    let estimate = self.estimate_line(chapter, start);
                    self.heights.borrow_mut().set_estimate(item, estimate);
                } else {
                    self.list.splice(item..item + old, splice.new);
                    let estimates: Vec<f32> = (start..start + splice.new)
                        .map(|line| self.estimate_line(chapter, line))
                        .collect();
                    self.heights
                        .borrow_mut()
                        .splice(item..item + old, estimates);
                }
                self.book.listed[chapter] = listed - old + splice.new;
            }
        }
        // The hidden empty line after the trailing newline can appear or go.
        let visible = self.book.chapters[chapter].doc.visible_lines();
        let listed = self.book.listed[chapter];
        if listed != visible {
            let base = self.book.line_item(chapter, 0);
            if listed > visible {
                self.list.splice(base + visible..base + listed, 0);
                self.heights
                    .borrow_mut()
                    .splice(base + visible..base + listed, []);
            } else {
                self.list
                    .splice(base + listed..base + listed, visible - listed);
                let estimates: Vec<f32> = (listed..visible)
                    .map(|line| self.estimate_line(chapter, line))
                    .collect();
                self.heights
                    .borrow_mut()
                    .splice(base + listed..base + listed, estimates);
            }
            self.book.listed[chapter] = visible;
        }
        self.book.recompute_starts();
        self.clamp_selection();
    }

    pub(crate) fn clamp_selection(&mut self) {
        let last = self.book.chapters.len() - 1;
        let sel = &mut self.selection;
        sel.chapter = sel.chapter.min(last);
        sel.anchor_chapter = sel.anchor_chapter.min(last);
        sel.head = sel
            .head
            .min(self.book.chapters[sel.chapter].doc.max_cursor());
        sel.anchor = sel
            .anchor
            .min(self.book.chapters[sel.anchor_chapter].doc.max_cursor());
        // A caret never rests inside an embed (`input/objects.rs`).
        self.select_embed_under_caret();
    }

    /// Runs an edit the editor makes on the selected chapter, then syncs.
    pub(crate) fn edit(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut ProseDoc, &mut Selection),
    ) {
        // Edits of a selection across chapters go through `input/span.rs`;
        // here the selection is in one chapter.
        debug_assert!(!self.selection.spans_chapters());
        if self.selection.spans_chapters() {
            self.selection.collapse();
        }
        let chapter = self.selection.chapter;
        let before = self.book.chapters[chapter].doc.undo_count();
        let mut selection = self.selection;
        self.own_edit = true;
        f(&mut self.book.chapters[chapter].doc, &mut selection);
        self.sync_chapter(chapter, cx);
        self.own_edit = false;
        selection.goal_x = None;
        self.selection = selection;
        self.clamp_selection();
        if self.book.chapters[chapter].doc.undo_count() != before {
            self.undo_chapters.push(chapter);
            self.redo_chapters.clear();
        }
        self.reveal_cursor();
        self.reset_blink(cx);
        window.notify_text_input_changed(&self.focus);
        cx.emit(EditorEvent::Edited { chapter });
        self.emit_selection_changed(cx);
        cx.notify();
        self.present_now(window);
    }

    /// After an undo or redo moved the caret.
    pub(crate) fn after_history_step(
        &mut self,
        chapter: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reveal_cursor();
        self.reset_blink(cx);
        window.notify_text_input_changed(&self.focus);
        cx.emit(EditorEvent::Edited { chapter });
        self.emit_selection_changed(cx);
        cx.notify();
        self.present_now(window);
    }

    pub(crate) fn present_now(&self, window: &Window) {
        if self.options.present_now
            && let Some(hooks) = &self.hooks
        {
            hooks.present_now(window);
        }
    }

    pub(crate) fn emit_selection_changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(EditorEvent::SelectionChanged);
    }

    /// Moves the selection (navigation), reveals the caret and ends the undo
    /// step; pending mark toggles are dropped.
    pub(crate) fn set_selection(&mut self, selection: Selection, cx: &mut Context<Self>) {
        self.set_selection_with(selection, true, cx);
    }

    pub(crate) fn set_selection_with(
        &mut self,
        selection: Selection,
        reveal: bool,
        cx: &mut Context<Self>,
    ) {
        if selection != self.selection {
            self.pending_marks.clear();
            self.book.chapters[selection.chapter].doc.checkpoint();
        }
        self.selection = selection;
        self.clamp_selection();
        if reveal {
            self.reveal_cursor();
        }
        self.reset_blink(cx);
        self.emit_selection_changed(cx);
        cx.notify();
    }

    /// Writes into a chapter as the Agent would: committed directly, with an
    /// `agent:` origin that the author's undo skips.
    pub fn agent_write(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        text: &str,
        session: &str,
        cx: &mut Context<Self>,
    ) {
        let origin = format!("{}{session}", crate::text::ORIGIN_AGENT_PREFIX);
        self.book.chapters[chapter]
            .doc
            .replace(range, text, &origin);
        self.sync_chapter(chapter, cx);
        cx.notify();
    }

    /// Imports remote updates into a chapter (sync, another device), for
    /// sources that import themselves.
    pub fn import_remote(&mut self, chapter: usize, bytes: &[u8], cx: &mut Context<Self>) {
        let _ = self.book.chapters[chapter].doc.import(bytes);
        self.sync_chapter(chapter, cx);
        cx.notify();
    }

    /// Folds in changes a chapter's source made outside the editor (sync, an
    /// Agent writing through the command layer): call after them.
    pub fn refresh_chapter(&mut self, chapter: usize, cx: &mut Context<Self>) {
        self.book.chapters[chapter].doc.drain();
        self.sync_chapter(chapter, cx);
        cx.notify();
    }

    pub(crate) fn reveal_cursor(&mut self) {
        self.autoscroll = true;
        let sel = self.selection;
        let line = self.book.chapters[sel.chapter].doc.locate(sel.head).0;
        if self.frame.borrow().get(sel.chapter, line).is_none() {
            let item = self.book.line_item(sel.chapter, line);
            // The list reveals from the heights it measured; past its
            // overdraw it has measured nothing and stops short (the caret
            // stays off screen, and no autoscroll can fix that). There, put
            // the paragraph at the top: it is laid out, and its autoscroll
            // (or typewriter scrolling) places it.
            let (scroll_y, _) = self.scroll_y();
            let top = self.heights.borrow_mut().top(item);
            let view = f64::from(f32::from(self.list.viewport_bounds().size.height));
            let reach = f64::from(OVERDRAW);
            if top >= scroll_y - reach && top <= scroll_y + view + reach {
                self.list.scroll_to_reveal_item(item);
            } else {
                self.list.scroll_to(ListOffset {
                    item_ix: item,
                    offset_in_item: px(0.),
                });
            }
        }
    }

    pub(crate) fn reset_blink(&mut self, cx: &mut Context<Self>) {
        self.cursor_layer.update(cx, |layer, cx| layer.restart(cx));
    }

    /// The caret layer to place over the editor (see [`ProseEditor::element`]).
    pub fn cursor_layer(&self) -> Entity<CursorLayer> {
        self.cursor_layer.clone()
    }

    /// The editor as it should be embedded: the paragraphs as a cached view
    /// (replayed untouched when nothing in them changed) with the caret layer
    /// on top, so a blink repaints a 2 px quad instead of every paragraph.
    pub fn element(editor: &Entity<ProseEditor>, cx: &App) -> impl IntoElement + use<> {
        let this = editor.read(cx);
        let layer = this.cursor_layer.clone();
        if this.options.fit_content {
            // As tall as its text: not a cached view, whose size would come
            // from its style alone.
            return div().w_full().relative().child(editor.clone()).child(layer);
        }
        div()
            .size_full()
            .relative()
            .child(crate::input::a11y::editor_view(editor, cx))
            .child(layer)
    }

    /// [`ProseEditor::element`] for a host that draws the editor under an
    /// opacity of its own that changes (a page fading in). GPUI replays a
    /// cached view's last frame exactly as drawn, opacity included, so an
    /// editor nobody notified would stay at the first frame's faintness.
    /// Here the editor is drawn afresh on every frame `opacity` differs from
    /// the last one, and replayed again once it holds still.
    pub fn element_at_opacity(
        editor: &Entity<ProseEditor>,
        opacity: f32,
        cx: &App,
    ) -> impl IntoElement + use<> {
        let this = editor.read(cx);
        let changed = this.drawn_opacity.replace(Some(opacity)) != Some(opacity);
        let layer = this.cursor_layer.clone();
        let view = if changed {
            div().size_full().child(editor.clone()).into_any_element()
        } else {
            crate::input::a11y::editor_view(editor, cx)
        };
        div().size_full().relative().child(view).child(layer)
    }

    fn on_blur(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.cursor_layer.update(cx, |layer, cx| layer.stop(cx));
        if self.composition.is_some() {
            // Leaving with marked text: drop it here and in the input method,
            // so no half-typed pinyin stays behind (decided: discard, not
            // commit as typed).
            self.log_ime(format_args!("blur: marked text dropped"));
            self.cancel_composition();
            if let Some(hooks) = &self.hooks {
                hooks.discard_marked_text();
            }
        }
        cx.notify();
    }

    pub(crate) fn cancel_composition(&mut self) {
        self.composition = None;
        self.last_comp_origin = None;
    }

    // ----- layout queries -------------------------------------------------------------

    /// The wrapped layout of a line: from this frame if painted and current,
    /// otherwise shaped now at the last known width.
    pub(crate) fn line_layout(
        &mut self,
        chapter: usize,
        line_ix: usize,
        window: &mut Window,
    ) -> Option<(Rc<ProseLayout>, Pixels)> {
        let rev = self.book.chapters[chapter].doc.lines().get(line_ix)?.rev;
        if let Some(painted) = self.frame.borrow().get(chapter, line_ix)
            && painted.rev == rev
            && painted.comp.is_none()
        {
            return Some((painted.layout.clone(), painted.line_height));
        }
        let line = self.book.chapters[chapter].doc.line(line_ix).clone();
        // Set as the paragraph element sets it (block insets, row setting).
        let set = self.para_set(chapter, line_ix);
        let wrap =
            (self.estimate_width.unwrap_or(self.style.max_width) - set.narrowing()).max(px(40.));
        let runs = self.paragraph_runs(&line, &set.look);
        let shaped = shape_set(
            &line.text,
            px(set.metrics.font_size),
            &runs,
            wrap,
            set.setting,
            window,
        );
        Some((Rc::new(shaped), px(set.metrics.line_height)))
    }

    /// The chapter offset under a window position (nearest painted paragraph),
    /// snapped to a grapheme boundary.
    pub(crate) fn hit_test(&mut self, position: Point<Pixels>) -> Option<(usize, usize)> {
        let frame = self.frame.borrow();
        let painted = frame
            .lines
            .iter()
            .min_by_key(|painted| {
                let b = painted.bounds;
                if position.y < b.top() {
                    f32::from(b.top() - position.y) as i64
                } else if position.y >= b.bottom() {
                    f32::from(position.y - b.bottom()) as i64 + 1
                } else {
                    0
                }
            })?
            .clone();
        drop(frame);
        let local = position - painted.origin;
        let (byte, _affinity) = painted.layout.byte_for_point(local, painted.line_height);
        let byte = painted.comp.map_or(byte, |comp| comp.to_line_byte(byte));
        let doc = &mut self.book.chapters[painted.chapter].doc;
        let line = doc.line(painted.line);
        let byte = segment::snap_grapheme(&line.text, byte);
        let inner = line.char_of_byte(byte);
        Some((painted.chapter, doc.line_start(painted.line) + inner))
    }
}

impl Focusable for ProseEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ProseEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.frame.borrow_mut().lines.clear();
        self.cursor_rect.set(None);
        let entity = cx.entity();
        let (scroll_y, total) = self.scroll_y();
        let viewport = self.list.viewport_bounds().size.height;
        let fit = self.options.fit_content;
        let thumb = (!fit && total > 0. && f64::from(f32::from(viewport)) < total).then(|| {
            let view = f64::from(f32::from(viewport));
            let height = (view / total * view).max(24.);
            let top = (scroll_y / total * view).min(view - height);
            (px(top as f32), px(height as f32))
        });
        div()
            .id("prose-editor")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .when(fit, |root| root.w_full())
            .when(!fit, |root| root.size_full())
            .relative()
            .bg(self.style.background)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::on_move_left))
            .on_action(cx.listener(Self::on_move_right))
            .on_action(cx.listener(Self::on_move_up))
            .on_action(cx.listener(Self::on_move_down))
            .on_action(cx.listener(Self::on_select_left))
            .on_action(cx.listener(Self::on_select_right))
            .on_action(cx.listener(Self::on_select_up))
            .on_action(cx.listener(Self::on_select_down))
            .on_action(cx.listener(Self::on_move_word_left))
            .on_action(cx.listener(Self::on_move_word_right))
            .on_action(cx.listener(Self::on_select_word_left))
            .on_action(cx.listener(Self::on_select_word_right))
            .on_action(cx.listener(Self::on_move_to_line_start))
            .on_action(cx.listener(Self::on_move_to_line_end))
            .on_action(cx.listener(Self::on_select_to_line_start))
            .on_action(cx.listener(Self::on_select_to_line_end))
            .on_action(cx.listener(Self::on_move_to_chapter_start))
            .on_action(cx.listener(Self::on_move_to_chapter_end))
            .on_action(cx.listener(Self::on_select_to_chapter_start))
            .on_action(cx.listener(Self::on_select_to_chapter_end))
            .on_action(cx.listener(Self::on_select_all))
            .on_action(cx.listener(Self::on_backspace))
            .on_action(cx.listener(Self::on_delete))
            .on_action(cx.listener(Self::on_delete_word_backward))
            .on_action(cx.listener(Self::on_delete_word_forward))
            .on_action(cx.listener(Self::on_delete_to_line_start))
            .on_action(cx.listener(Self::on_newline))
            .on_action(cx.listener(Self::on_undo))
            .on_action(cx.listener(Self::on_redo))
            .on_action(cx.listener(Self::on_copy))
            .on_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_paste))
            .on_action(cx.listener(Self::on_set_body))
            .on_action(cx.listener(Self::on_set_h1))
            .on_action(cx.listener(Self::on_set_h2))
            .on_action(cx.listener(Self::on_set_h3))
            .on_action(cx.listener(Self::on_toggle_bold))
            .on_action(cx.listener(Self::on_toggle_italic))
            .on_action(cx.listener(Self::on_toggle_underline))
            .on_action(cx.listener(Self::on_toggle_strikethrough))
            .map(|root| self.input_layer(root, window, cx))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .map(|root| {
                if fit {
                    // A few paragraphs, all drawn: a plain column as tall as
                    // they are.
                    let items: Vec<_> = (0..self.book.item_count())
                        .map(|ix| self.render_item(ix, window, cx))
                        .collect();
                    root.child(div().w_full().flex().flex_col().children(items))
                } else {
                    root.child(
                        list(
                            self.list.clone(),
                            cx.processor(|this, ix, window, cx| this.render_item(ix, window, cx)),
                        )
                        .size_full(),
                    )
                }
            })
            .when(!fit, |root| root.child(self.scroll_ticks(cx)))
            .children(thumb.map(|(top, height)| {
                div()
                    .absolute()
                    .right(px(3.))
                    .top(top)
                    .w(px(6.))
                    .h(height)
                    .rounded(px(3.))
                    .bg(self.style.muted.opacity(0.35))
            }))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, cx| {
                        let focus = entity.read(cx).focus.clone();
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, entity.clone()),
                            cx,
                        );
                        entity.update(cx, |this, cx| this.after_paint(bounds, window, cx));
                    },
                )
                .absolute()
                .size_full(),
            )
    }
}
