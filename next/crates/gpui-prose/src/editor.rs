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
    layout::{BlockMetrics, Book, HeightIndex, ProseLayout, column, estimate_height, shape},
    platform::PlatformHooks,
    render::{CursorLayer, FrameCache, line_runs},
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
    pub(crate) selecting: bool,
    pub(crate) undo_chapters: Vec<usize>,
    pub(crate) redo_chapters: Vec<usize>,
    pub(crate) own_edit: bool,
    last_comp_origin: Option<Point<Pixels>>,
    paint_hooks: Vec<PaintHook>,
    pub(crate) hooks: Option<Rc<dyn PlatformHooks>>,
    pub(crate) extension: Option<Rc<dyn ProseExtension>>,
    pub(crate) input: crate::input::InputState,
    pub(crate) paint: crate::render::PaintState,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<EditorEvent> for ProseEditor {}

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
            selecting: false,
            undo_chapters: Vec::new(),
            redo_chapters: Vec::new(),
            own_edit: false,
            last_comp_origin: None,
            paint_hooks: Vec::new(),
            hooks: None,
            extension: None,
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

    /// Undoes the most recent author step of `chapter` only, for hosts whose
    /// chapters keep their own undo (Drifting's whole-book view: ⌘Z undoes
    /// in the chapter the caret is in). Returns whether anything changed.
    pub fn undo_in(&mut self, chapter: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.composition.is_some() || chapter >= self.book.chapters.len() {
            return false;
        }
        self.own_edit = true;
        let result = self.book.chapters[chapter].doc.undo();
        self.sync_chapter(chapter, cx);
        self.own_edit = false;
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
        self.own_edit = true;
        let result = self.book.chapters[chapter].doc.redo();
        self.sync_chapter(chapter, cx);
        self.own_edit = false;
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
        for (ix, chapter) in self.book.chapters.iter().enumerate() {
            items.push((
                None,
                BlockMetrics {
                    font_size: f32::from(self.style.title_size),
                    line_height: 0.,
                    pad_top: if ix == 0 { 56. } else { 96. },
                    pad_bottom: 28. + 42.,
                },
            ));
            for line in &chapter.doc.lines()[..chapter.doc.visible_lines()] {
                items.push((Some(line.text.clone()), self.style.metrics(line.kind)));
            }
        }
        let wrap = f32::from(wrap_width);
        let task = cx.background_executor().spawn(async move {
            items
                .iter()
                .map(|(text, metrics)| match text {
                    Some(text) => estimate_height(text, metrics, wrap),
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
        let doc = &self.book.chapters[chapter].doc;
        let Some(line) = doc.lines().get(line) else {
            return 0.;
        };
        let wrap = self.estimate_width.map_or(680., f32::from);
        estimate_height(&line.text, &self.style.metrics(line.kind), wrap)
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
                if self.selection.chapter == chapter {
                    for op in &set.ops {
                        self.selection.anchor = op.transform(self.selection.anchor);
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
        let doc = &mut self.book.chapters[self.selection.chapter].doc;
        let max = doc.max_cursor();
        self.selection.anchor = self.selection.anchor.min(max);
        self.selection.head = self.selection.head.min(max);
    }

    /// Runs an edit the editor makes on the selected chapter, then syncs.
    pub(crate) fn edit(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut ProseDoc, &mut Selection),
    ) {
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
            self.list
                .scroll_to_reveal_item(self.book.line_item(sel.chapter, line));
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
        let layer = editor.read(cx).cursor_layer.clone();
        div()
            .size_full()
            .relative()
            .child(crate::input::a11y::editor_view(editor, cx))
            .child(layer)
    }

    fn on_blur(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.cursor_layer.update(cx, |layer, cx| layer.stop(cx));
        if self.composition.is_some() {
            // Leaving with marked text: drop it here and in the input method,
            // so no half-typed pinyin stays behind (decided: discard, not
            // commit as typed).
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
        let metrics = self.style.metrics(line.kind);
        let wrap = self.estimate_width.unwrap_or(self.style.max_width);
        let runs = line_runs(
            line.text.len(),
            &line.spans,
            line.kind,
            &self.style,
            self.extension.as_deref(),
        );
        let shaped = shape(&line.text, px(metrics.font_size), &runs, wrap, window);
        Some((Rc::new(shaped), px(metrics.line_height)))
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
        let thumb = (total > 0. && f64::from(f32::from(viewport)) < total).then(|| {
            let view = f64::from(f32::from(viewport));
            let height = (view / total * view).max(24.);
            let top = (scroll_y / total * view).min(view - height);
            (px(top as f32), px(height as f32))
        });
        div()
            .id("prose-editor")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .size_full()
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
            .child(
                list(
                    self.list.clone(),
                    cx.processor(|this, ix, window, cx| this.render_item(ix, window, cx)),
                )
                .size_full(),
            )
            .child(self.scroll_ticks(cx))
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
