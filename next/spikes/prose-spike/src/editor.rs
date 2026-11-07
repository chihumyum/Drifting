//! The editor view: a virtualized scroll of paragraphs over one or more body
//! texts, with selection, IME composition, undo and keyboard/mouse actions.
//!
//! Positions are `(chapter, scalar offset in that chapter's text)`. The IME
//! sees the focused chapter as its text storage, in UTF-16, with the marked
//! text spliced in at the composition anchor. The marked text never reaches
//! Loro: only the confirmed text is written, in one commit.

use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
    time::Duration,
};

use gpui::{
    App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, FontWeight, Hsla, KeyBinding, ListAlignment,
    ListOffset, ListState, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    Point, Render, SharedString, StyleRefinement, Subscription, Task, TextRun, UTF16Selection,
    UnderlineStyle, Window, actions, canvas, div, fill, font, hsla, list, prelude::*, px, size,
};

use crate::{
    book::{Book, Item},
    doc::{BlockKind, ORIGIN_USER, ProseDoc},
    element::{Affinity, CompSpan, FrameCache, ParagraphElement, ProseLayout, column, shape},
    heights::{BlockMetrics, HeightIndex, estimate_height},
};

actions!(
    prose_editor,
    [
        MoveLeft,
        MoveRight,
        MoveUp,
        MoveDown,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        MoveToLineStart,
        MoveToLineEnd,
        SelectToLineStart,
        SelectToLineEnd,
        MoveToChapterStart,
        MoveToChapterEnd,
        SelectAll,
        Backspace,
        Delete,
        Newline,
        Undo,
        Redo,
        Copy,
        Cut,
        Paste,
        SetBody,
        SetH1,
        SetH2,
        SetH3,
    ]
);

/// The key context of the editor. Only non-printable keys and chords with ⌘
/// are bound, so every printable key reaches the input method first.
pub const KEY_CONTEXT: &str = "ProseEditor";

pub fn bind_keys(cx: &mut App) {
    let ctx = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("left", MoveLeft, ctx),
        KeyBinding::new("right", MoveRight, ctx),
        KeyBinding::new("up", MoveUp, ctx),
        KeyBinding::new("down", MoveDown, ctx),
        KeyBinding::new("shift-left", SelectLeft, ctx),
        KeyBinding::new("shift-right", SelectRight, ctx),
        KeyBinding::new("shift-up", SelectUp, ctx),
        KeyBinding::new("shift-down", SelectDown, ctx),
        KeyBinding::new("cmd-left", MoveToLineStart, ctx),
        KeyBinding::new("cmd-right", MoveToLineEnd, ctx),
        KeyBinding::new("home", MoveToLineStart, ctx),
        KeyBinding::new("end", MoveToLineEnd, ctx),
        KeyBinding::new("cmd-shift-left", SelectToLineStart, ctx),
        KeyBinding::new("cmd-shift-right", SelectToLineEnd, ctx),
        KeyBinding::new("cmd-up", MoveToChapterStart, ctx),
        KeyBinding::new("cmd-down", MoveToChapterEnd, ctx),
        KeyBinding::new("cmd-a", SelectAll, ctx),
        KeyBinding::new("backspace", Backspace, ctx),
        KeyBinding::new("delete", Delete, ctx),
        KeyBinding::new("enter", Newline, ctx),
        KeyBinding::new("cmd-z", Undo, ctx),
        KeyBinding::new("cmd-shift-z", Redo, ctx),
        KeyBinding::new("cmd-c", Copy, ctx),
        KeyBinding::new("cmd-x", Cut, ctx),
        KeyBinding::new("cmd-v", Paste, ctx),
        KeyBinding::new("cmd-0", SetBody, ctx),
        KeyBinding::new("cmd-1", SetH1, ctx),
        KeyBinding::new("cmd-2", SetH2, ctx),
        KeyBinding::new("cmd-3", SetH3, ctx),
    ]);
}

/// Platform hooks the editor cannot reach through GPUI v1.27; the app
/// supplies them (a GPUI patch could make them unnecessary).
pub trait PlatformHooks: 'static {
    /// Tell the system input method to drop its marked text
    /// (`[NSTextInputContext discardMarkedText]` on macOS,
    /// `ImmNotifyIME(…, CPS_CANCEL)` on Windows).
    fn discard_marked_text(&self);

    /// Ask for this frame to be drawn now instead of on the next display-link
    /// tick (on macOS: `[view setNeedsDisplay:YES]`, which makes Core Animation
    /// call GPUI's `displayLayer:` when the current event finishes). Called
    /// after every edit and composition update.
    fn present_now(&self, _window: &Window) {}
}

/// Visual style of the prose. Defaults follow the current Drifting editor:
/// 17.5 px body at 1.75 line height, paragraph spacing 1.1 em, H1/H2/H3 at
/// 28/22/18 px weight 500.
#[derive(Clone, Debug)]
pub struct ProseStyle {
    pub font_family: SharedString,
    pub body_size: Pixels,
    pub body_line_height: f32,
    pub heading_sizes: [Pixels; 3],
    pub heading_line_height: f32,
    pub heading_weight: FontWeight,
    pub paragraph_spacing: f32,
    pub heading_space_above: f32,
    pub title_size: Pixels,
    pub max_width: Pixels,
    pub gutter: Pixels,
    pub text: Hsla,
    pub muted: Hsla,
    pub background: Hsla,
    pub selection: Hsla,
    pub cursor: Hsla,
}

impl Default for ProseStyle {
    fn default() -> Self {
        ProseStyle {
            font_family: "PingFang SC".into(),
            body_size: px(17.5),
            body_line_height: 1.75,
            heading_sizes: [px(28.), px(22.), px(18.)],
            heading_line_height: 1.4,
            heading_weight: FontWeight(500.),
            paragraph_spacing: 1.1,
            heading_space_above: 0.8,
            title_size: px(30.),
            max_width: px(680.),
            gutter: px(48.),
            text: hsla(0., 0., 0.13, 1.),
            muted: hsla(0., 0., 0.45, 1.),
            background: hsla(40. / 360., 0.3, 0.985, 1.),
            selection: hsla(210. / 360., 0.9, 0.55, 0.22),
            cursor: hsla(210. / 360., 0.9, 0.45, 1.),
        }
    }
}

impl ProseStyle {
    pub fn font_size(&self, kind: BlockKind) -> Pixels {
        match kind {
            BlockKind::Body => self.body_size,
            BlockKind::H1 => self.heading_sizes[0],
            BlockKind::H2 => self.heading_sizes[1],
            BlockKind::H3 => self.heading_sizes[2],
        }
    }

    pub fn metrics(&self, kind: BlockKind) -> BlockMetrics {
        let font_size = f32::from(self.font_size(kind));
        let spacing = f32::from(self.body_size) * self.paragraph_spacing;
        match kind {
            BlockKind::Body => BlockMetrics {
                font_size,
                line_height: (font_size * self.body_line_height).round(),
                pad_top: 0.,
                pad_bottom: spacing.round(),
            },
            _ => BlockMetrics {
                font_size,
                line_height: (font_size * self.heading_line_height).round(),
                pad_top: (font_size * self.heading_space_above).round(),
                pad_bottom: spacing.round(),
            },
        }
    }

    fn run(&self, kind: BlockKind, len: usize) -> TextRun {
        let mut run_font = font(self.font_family.clone());
        if kind != BlockKind::Body {
            run_font.weight = self.heading_weight;
        }
        TextRun {
            len,
            font: run_font,
            color: self.text,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }
}

/// The selection; offsets are scalars in `chapter`'s text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub chapter: usize,
    pub anchor: usize,
    pub head: usize,
    pub affinity: Affinity,
    goal_x: Option<Pixels>,
}

impl Selection {
    pub fn caret(chapter: usize, offset: usize) -> Selection {
        Selection {
            chapter,
            anchor: offset,
            head: offset,
            affinity: Affinity::Downstream,
            goal_x: None,
        }
    }

    pub fn range(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}

/// Marked text from the input method, shown but not yet written.
#[derive(Clone, Debug)]
pub struct Composition {
    pub chapter: usize,
    /// Where the marked text sits (scalar offset in the committed text).
    pub at: usize,
    /// Committed scalars after `at` that the marked text replaces once confirmed
    /// (a selection typed over). They stay in Loro until then.
    pub replaced: usize,
    pub text: String,
    /// The input method's selection inside the marked text, in bytes.
    pub selected: Range<usize>,
}

/// A position in the IME's view of the focused chapter.
enum VirtualPos {
    Doc(usize),
    Marked(usize),
}

type PaintHook = Box<dyn FnOnce(&mut Window, &mut App)>;

pub struct ProseEditor {
    book: Book,
    list: ListState,
    focus: FocusHandle,
    style: ProseStyle,
    selection: Selection,
    composition: Option<Composition>,
    frame: Rc<RefCell<FrameCache>>,
    heights: Rc<RefCell<HeightIndex>>,
    /// Wrap width the current estimates were made for.
    estimate_width: Option<Pixels>,
    estimate_generation: u64,
    _estimate_task: Option<Task<()>>,
    /// The blinking caret, a separate view so a blink repaints only it.
    cursor_layer: Entity<CursorLayer>,
    /// Where the caret is, written by the paragraph that holds it.
    cursor_rect: Rc<Cell<Option<Bounds<Pixels>>>>,
    autoscroll: bool,
    selecting: bool,
    undo_chapters: Vec<usize>,
    redo_chapters: Vec<usize>,
    own_edit: bool,
    last_comp_origin: Option<Point<Pixels>>,
    paint_hooks: Vec<PaintHook>,
    hooks: Option<Rc<dyn PlatformHooks>>,
    /// Print every input-method call to stderr (real-IME testing).
    pub ime_log: bool,
    _subscriptions: Vec<Subscription>,
}

const BLINK_INTERVAL: Duration = Duration::from_millis(530);
/// Pixels rendered above and below the viewport.
const OVERDRAW: f32 = 1200.;

impl ProseEditor {
    pub fn new(book: Book, style: ProseStyle, window: &mut Window, cx: &mut Context<Self>) -> Self {
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
        let cursor_layer = cx.new(|_| CursorLayer {
            rect: cursor_rect.clone(),
            color: style.cursor,
            visible: false,
            epoch: 0,
            _task: None,
        });
        ProseEditor {
            book,
            list,
            focus,
            style,
            selection: Selection::caret(0, 0),
            composition: None,
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
            ime_log: false,
            _subscriptions: subscriptions,
        }
    }

    fn log_ime(&self, call: std::fmt::Arguments) {
        if self.ime_log {
            eprintln!(
                "[ime] {call} | comp={:?} sel={:?}",
                self.composition
                    .as_ref()
                    .map(|c| (&c.text, c.at, c.replaced)),
                self.selection.range()
            );
        }
    }

    pub fn set_platform_hooks(&mut self, hooks: Rc<dyn PlatformHooks>) {
        self.hooks = Some(hooks);
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

    /// Runs `hook` once, at the end of the next paint of this editor.
    pub fn after_next_paint(&mut self, hook: impl FnOnce(&mut Window, &mut App) + 'static) {
        self.paint_hooks.push(Box::new(hook));
    }

    /// Paragraphs painted in the last frame.
    pub fn painted_lines(&self) -> usize {
        self.frame.borrow().lines.len()
    }

    // ----- scripted input (benchmarks, tests) --------------------------------

    /// Sets the selection in `chapter` (scalar offsets) and reveals it.
    pub fn select(
        &mut self,
        chapter: usize,
        range: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_composition();
        let mut sel = Selection::caret(chapter, range.start);
        sel.head = range.end;
        self.set_selection(sel, cx);
    }

    /// Enter, as the key binding does.
    pub fn press_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.newline(&Newline, window, cx);
    }

    /// Backspace, as the key binding does.
    pub fn press_backspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.backspace(&Backspace, window, cx);
    }

    // ----- navigation --------------------------------------------------------

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

    // ----- frame -------------------------------------------------------------

    fn render_item(
        &mut self,
        ix: usize,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
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

    fn paragraph(&mut self, item_ix: usize, chapter: usize, line_ix: usize) -> ParagraphElement {
        let doc = &mut self.book.chapters[chapter].doc;
        let line_start = doc.line_start(line_ix);
        let line = doc.line(line_ix).clone();
        let metrics = self.style.metrics(line.kind);
        let line_end = line_start + line.chars;

        let comp = self
            .composition
            .as_ref()
            .filter(|comp| comp.chapter == chapter && (line_start..=line_end).contains(&comp.at));
        let (text, runs, comp_span, cursor) = match comp {
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
                let base = self.style.run(line.kind, 0);
                let mut runs = Vec::with_capacity(3);
                if at > 0 {
                    runs.push(TextRun {
                        len: at,
                        ..base.clone()
                    });
                }
                if span.len > 0 {
                    runs.push(TextRun {
                        len: span.len,
                        underline: Some(UnderlineStyle {
                            color: Some(self.style.text),
                            thickness: px(1.),
                            wavy: false,
                        }),
                        ..base.clone()
                    });
                }
                let rest = text.len() - at - span.len;
                if rest > 0 {
                    runs.push(TextRun { len: rest, ..base });
                }
                let cursor = (at + comp.selected.end, Affinity::Downstream);
                (text, runs, Some(span), Some(cursor))
            }
            None => {
                let runs = vec![self.style.run(line.kind, line.text.len())];
                let sel = self.selection;
                let cursor = (sel.chapter == chapter
                    && self.composition.is_none()
                    && (line_start..=line_end).contains(&sel.head))
                .then(|| (line.byte_of_char(sel.head - line_start), sel.affinity));
                (line.text.clone(), runs, None, cursor)
            }
        };

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

        let show_cursor = cursor.is_some() && (self.selection.is_empty() || comp_span.is_some());
        ParagraphElement {
            item_ix,
            chapter,
            line: line_ix,
            rev: line.rev,
            text,
            runs,
            font_size: px(metrics.font_size),
            line_height: px(metrics.line_height),
            pad_top: px(metrics.pad_top),
            pad_bottom: px(metrics.pad_bottom),
            max_width: self.style.max_width,
            gutter: self.style.gutter,
            selection,
            cursor: if show_cursor { cursor } else { None },
            cursor_out: self.cursor_rect.clone(),
            autoscroll: self.autoscroll && show_cursor,
            comp: comp_span,
            selection_color: self.style.selection,
            frame: self.frame.clone(),
            heights: self.heights.clone(),
        }
    }

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
                    font_size: 30.,
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

    // ----- change bookkeeping -----------------------------------------------

    /// Folds a chapter's applied changes into the list, the height index, and
    /// (for changes the editor did not make) the selection.
    fn sync_chapter(&mut self, chapter: usize) {
        let changes = self.book.chapters[chapter].doc.take_changes();
        if changes.is_empty() {
            return;
        }
        for set in &changes {
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
                        let end = op.transform(comp.at + comp.replaced);
                        comp.at = op.transform(comp.at);
                        comp.replaced = end.saturating_sub(comp.at);
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

    fn clamp_selection(&mut self) {
        let doc = &mut self.book.chapters[self.selection.chapter].doc;
        let max = doc.max_cursor();
        self.selection.anchor = self.selection.anchor.min(max);
        self.selection.head = self.selection.head.min(max);
    }

    /// Runs an edit the editor makes on the selected chapter, then syncs.
    fn edit(
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
        self.sync_chapter(chapter);
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
        cx.notify();
        self.present_now(window);
    }

    fn present_now(&self, window: &Window) {
        if let Some(hooks) = &self.hooks {
            hooks.present_now(window);
        }
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
        let origin = format!("{}{session}", crate::doc::ORIGIN_AGENT_PREFIX);
        let _ = self.book.chapters[chapter]
            .doc
            .replace(range, text, &origin);
        self.sync_chapter(chapter);
        cx.notify();
    }

    /// Imports remote updates into a chapter (sync, another device).
    pub fn import_remote(&mut self, chapter: usize, bytes: &[u8], cx: &mut Context<Self>) {
        let _ = self.book.chapters[chapter].doc.import(bytes);
        self.sync_chapter(chapter);
        cx.notify();
    }

    fn reveal_cursor(&mut self) {
        self.autoscroll = true;
        let sel = self.selection;
        let line = doc_line_of(&mut self.book.chapters[sel.chapter].doc, sel.head);
        if self.frame.borrow().get(sel.chapter, line).is_none() {
            self.list
                .scroll_to_reveal_item(self.book.line_item(sel.chapter, line));
        }
    }

    fn reset_blink(&mut self, cx: &mut Context<Self>) {
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
            .child(
                editor
                    .clone()
                    .cached(StyleRefinement::default().size_full()),
            )
            .child(layer)
    }

    fn on_blur(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.cursor_layer.update(cx, |layer, cx| layer.stop(cx));
        if self.composition.is_some() {
            // Leaving with marked text: drop it here and in the input method,
            // so no half-typed pinyin stays behind.
            self.cancel_composition();
            if let Some(hooks) = &self.hooks {
                hooks.discard_marked_text();
            }
        }
        cx.notify();
    }

    fn cancel_composition(&mut self) {
        self.composition = None;
        self.last_comp_origin = None;
    }

    // ----- layout queries ----------------------------------------------------

    /// The wrapped layout of a line: from this frame if painted and current,
    /// otherwise shaped now at the last known width.
    fn line_layout(
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
        let runs = [self.style.run(line.kind, line.text.len())];
        let shaped = shape(&line.text, px(metrics.font_size), &runs, wrap, window);
        Some((Rc::new(shaped), px(metrics.line_height)))
    }

    /// The chapter offset under a window position (nearest painted paragraph).
    fn hit_test(&mut self, position: Point<Pixels>) -> Option<(usize, usize)> {
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
        let inner = line.char_of_byte(byte);
        Some((painted.chapter, doc.line_start(painted.line) + inner))
    }

    // ----- movement ----------------------------------------------------------

    fn move_horizontal(&mut self, forward: bool, extend: bool, cx: &mut Context<Self>) {
        let mut sel = self.selection;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        if !extend && !sel.is_empty() {
            let range = sel.range();
            let to = if forward { range.end } else { range.start };
            sel = Selection::caret(sel.chapter, to);
        } else if forward {
            if sel.head < doc.max_cursor() {
                sel.head += 1;
            } else if !extend && sel.chapter + 1 < self.book.chapters.len() {
                sel = Selection::caret(sel.chapter + 1, 0);
            }
        } else if sel.head > 0 {
            sel.head -= 1;
        } else if !extend && sel.chapter > 0 {
            let prev = sel.chapter - 1;
            sel = Selection::caret(prev, self.book.chapters[prev].doc.max_cursor());
        }
        if !extend {
            sel.anchor = sel.head;
        }
        sel.affinity = Affinity::Downstream;
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    fn move_vertical(
        &mut self,
        down: bool,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut sel = self.selection;
        let chapter = sel.chapter;
        let (line_ix, inner) = self.book.chapters[chapter].doc.locate(sel.head);
        let Some((layout, line_height)) = self.line_layout(chapter, line_ix, window) else {
            return;
        };
        let rows = layout.row_count();
        let byte = self.book.chapters[chapter]
            .doc
            .line(line_ix)
            .byte_of_char(inner);
        let here = layout.point_for_byte(byte, sel.affinity, line_height);
        let goal_x = sel.goal_x.unwrap_or(here.x);
        let row = layout.row_of(byte, sel.affinity);
        let target = if down && row + 1 < rows {
            Some((chapter, line_ix, row + 1))
        } else if !down && row > 0 {
            Some((chapter, line_ix, row - 1))
        } else {
            // Into the neighbouring paragraph, possibly in the next chapter.
            let visible = self.book.chapters[chapter].doc.visible_lines();
            let neighbour = if down {
                if line_ix + 1 < visible {
                    Some((chapter, line_ix + 1))
                } else if chapter + 1 < self.book.chapters.len() && !extend {
                    Some((chapter + 1, 0))
                } else {
                    None
                }
            } else if line_ix > 0 {
                Some((chapter, line_ix - 1))
            } else if chapter > 0 && !extend {
                Some((
                    chapter - 1,
                    self.book.chapters[chapter - 1].doc.visible_lines() - 1,
                ))
            } else {
                None
            };
            neighbour.and_then(|(c, l)| {
                let (layout, _) = self.line_layout(c, l, window)?;
                let rows = layout.row_count();
                Some((c, l, if down { 0 } else { rows - 1 }))
            })
        };
        let (offset, affinity, target_chapter) = match target {
            Some((c, l, r)) => {
                let Some((layout, _)) = self.line_layout(c, l, window) else {
                    return;
                };
                let (byte, affinity) = layout.byte_in_row(r, goal_x);
                let doc = &mut self.book.chapters[c].doc;
                let inner = doc.line(l).char_of_byte(byte);
                (doc.line_start(l) + inner, affinity, c)
            }
            None => {
                let doc = &mut self.book.chapters[chapter].doc;
                let end = if down { doc.max_cursor() } else { 0 };
                (end, Affinity::Downstream, chapter)
            }
        };
        if target_chapter != sel.chapter {
            sel = Selection::caret(target_chapter, offset);
        } else {
            sel.head = offset;
            if !extend {
                sel.anchor = offset;
            }
        }
        sel.affinity = affinity;
        sel.goal_x = Some(goal_x);
        self.set_selection(sel, cx);
    }

    fn move_to_row_edge(
        &mut self,
        end: bool,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut sel = self.selection;
        let (line_ix, inner) = self.book.chapters[sel.chapter].doc.locate(sel.head);
        let Some((layout, _)) = self.line_layout(sel.chapter, line_ix, window) else {
            return;
        };
        let rows = &layout.rows;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        let byte = doc.line(line_ix).byte_of_char(inner);
        let row = rows[layout.row_of(byte, sel.affinity)].clone();
        let target = if end { row.end } else { row.start };
        let inner = doc.line(line_ix).char_of_byte(target);
        sel.head = doc.line_start(line_ix) + inner;
        if !extend {
            sel.anchor = sel.head;
        }
        sel.affinity = if end {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        sel.goal_x = None;
        self.set_selection(sel, cx);
    }

    fn set_selection(&mut self, selection: Selection, cx: &mut Context<Self>) {
        self.selection = selection;
        self.clamp_selection();
        self.reveal_cursor();
        self.reset_blink(cx);
        cx.notify();
    }

    // ----- actions -----------------------------------------------------------

    fn move_left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(false, false, cx);
    }
    fn move_right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(true, false, cx);
    }
    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(false, true, cx);
    }
    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_horizontal(true, true, cx);
    }
    fn move_up(&mut self, _: &MoveUp, window: &mut Window, cx: &mut Context<Self>) {
        self.move_vertical(false, false, window, cx);
    }
    fn move_down(&mut self, _: &MoveDown, window: &mut Window, cx: &mut Context<Self>) {
        self.move_vertical(true, false, window, cx);
    }
    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        self.move_vertical(false, true, window, cx);
    }
    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        self.move_vertical(true, true, window, cx);
    }
    fn move_to_line_start(
        &mut self,
        _: &MoveToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(false, false, window, cx);
    }
    fn move_to_line_end(&mut self, _: &MoveToLineEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to_row_edge(true, false, window, cx);
    }
    fn select_to_line_start(
        &mut self,
        _: &SelectToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(false, true, window, cx);
    }
    fn select_to_line_end(
        &mut self,
        _: &SelectToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_to_row_edge(true, true, window, cx);
    }
    fn move_to_chapter_start(
        &mut self,
        _: &MoveToChapterStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let sel = Selection::caret(self.selection.chapter, 0);
        self.set_selection(sel, cx);
    }
    fn move_to_chapter_end(
        &mut self,
        _: &MoveToChapterEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let chapter = self.selection.chapter;
        let end = self.book.chapters[chapter].doc.max_cursor();
        self.set_selection(Selection::caret(chapter, end), cx);
    }
    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let chapter = self.selection.chapter;
        let end = self.book.chapters[chapter].doc.max_cursor();
        let mut sel = Selection::caret(chapter, 0);
        sel.head = end;
        self.selection = sel;
        self.reset_blink(cx);
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            if !sel.is_empty() {
                let range = sel.range();
                let _ = doc.replace(range.clone(), "", ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, range.start);
                return;
            }
            if sel.head == 0 {
                return;
            }
            let (line, inner) = doc.locate(sel.head);
            if inner == 0 {
                doc.checkpoint();
                let _ = doc.join_backward(line, ORIGIN_USER);
            } else {
                let _ = doc.replace(sel.head - 1..sel.head, "", ORIGIN_USER);
            }
            *sel = Selection::caret(sel.chapter, sel.head - 1);
        });
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            if !sel.is_empty() {
                let range = sel.range();
                let _ = doc.replace(range.clone(), "", ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, range.start);
                return;
            }
            if sel.head >= doc.max_cursor() {
                return;
            }
            let (line, inner) = doc.locate(sel.head);
            if inner == doc.line(line).chars {
                doc.checkpoint();
                let _ = doc.join_backward(line + 1, ORIGIN_USER);
            } else {
                let _ = doc.replace(sel.head..sel.head + 1, "", ORIGIN_USER);
            }
        });
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        self.edit(window, cx, |doc, sel| {
            let range = sel.range();
            doc.checkpoint();
            if !range.is_empty() {
                let _ = doc.replace(range.clone(), "", ORIGIN_USER);
                doc.checkpoint();
            }
            let _ = doc.split(range.start, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, range.start + 1);
        });
    }

    fn set_kind(&mut self, kind: BlockKind, window: &mut Window, cx: &mut Context<Self>) {
        self.edit(window, cx, |doc, sel| {
            let (line, _) = doc.locate(sel.head);
            doc.checkpoint();
            let _ = doc.set_kind(line, kind, ORIGIN_USER);
        });
    }
    fn set_body(&mut self, _: &SetBody, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::Body, window, cx);
    }
    fn set_h1(&mut self, _: &SetH1, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H1, window, cx);
    }
    fn set_h2(&mut self, _: &SetH2, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H2, window, cx);
    }
    fn set_h3(&mut self, _: &SetH3, window: &mut Window, cx: &mut Context<Self>) {
        self.set_kind(BlockKind::H3, window, cx);
    }

    /// Undo across chapters: the most recent author step in any chapter.
    /// Ignored while composing (the marked text belongs to the input method).
    pub fn undo(&mut self, _: &Undo, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        while let Some(chapter) = self.undo_chapters.pop() {
            self.own_edit = true;
            let result = self.book.chapters[chapter].doc.undo();
            self.sync_chapter(chapter);
            self.own_edit = false;
            if let Some(cursor) = result {
                self.redo_chapters.push(chapter);
                if let Some(cursor) = cursor {
                    self.selection = Selection::caret(chapter, cursor);
                    self.clamp_selection();
                }
                self.reveal_cursor();
                self.reset_blink(cx);
                window.notify_text_input_changed(&self.focus);
                cx.notify();
                return;
            }
        }
    }

    pub fn redo(&mut self, _: &Redo, window: &mut Window, cx: &mut Context<Self>) {
        if self.composition.is_some() {
            return;
        }
        while let Some(chapter) = self.redo_chapters.pop() {
            self.own_edit = true;
            let result = self.book.chapters[chapter].doc.redo();
            self.sync_chapter(chapter);
            self.own_edit = false;
            if let Some(cursor) = result {
                self.undo_chapters.push(chapter);
                if let Some(cursor) = cursor {
                    self.selection = Selection::caret(chapter, cursor);
                    self.clamp_selection();
                }
                self.reveal_cursor();
                self.reset_blink(cx);
                window.notify_text_input_changed(&self.focus);
                cx.notify();
                return;
            }
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let sel = self.selection;
        if !sel.is_empty() {
            let text = self.book.chapters[sel.chapter].doc.slice(sel.range());
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        self.copy(&Copy, window, cx);
        if !self.selection.is_empty() {
            self.backspace(&Backspace, window, cx);
        }
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        self.edit(window, cx, |doc, sel| {
            let range = sel.range();
            doc.checkpoint();
            let _ = doc.replace(range.clone(), &text, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, range.start + text.chars().count());
        });
    }

    // ----- mouse -------------------------------------------------------------

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some((chapter, offset)) = self.hit_test(event.position) else {
            return;
        };
        let mut sel = if event.modifiers.shift && chapter == self.selection.chapter {
            let mut sel = self.selection;
            sel.head = offset;
            sel
        } else {
            Selection::caret(chapter, offset)
        };
        let doc = &mut self.book.chapters[chapter].doc;
        match event.click_count {
            2 => {
                let (start, end) = word_around(doc, offset);
                sel.anchor = start;
                sel.head = end;
            }
            n if n >= 3 => {
                let (line, _) = doc.locate(offset);
                sel.anchor = doc.line_start(line);
                sel.head = sel.anchor + doc.line(line).chars;
            }
            _ => {}
        }
        self.selecting = true;
        self.selection = sel;
        self.clamp_selection();
        self.reset_blink(cx);
        cx.notify();
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selecting || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let Some((chapter, offset)) = self.hit_test(event.position) {
            let head = if chapter == self.selection.chapter {
                offset
            } else if chapter > self.selection.chapter {
                self.book.chapters[self.selection.chapter].doc.max_cursor()
            } else {
                0
            };
            if head != self.selection.head {
                self.selection.head = head;
                cx.notify();
            }
        }
        // Drag past the edge: scroll so the selection can grow.
        let viewport = self.list.viewport_bounds();
        let delta = if event.position.y < viewport.top() {
            f64::from(f32::from(event.position.y - viewport.top()))
        } else if event.position.y > viewport.bottom() {
            f64::from(f32::from(event.position.y - viewport.bottom()))
        } else {
            0.
        };
        if delta != 0. {
            self.scroll_by_estimate(delta, cx);
        }
    }

    fn mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    // ----- IME coordinate space ---------------------------------------------

    fn input_chapter(&self) -> usize {
        self.composition
            .as_ref()
            .map_or(self.selection.chapter, |comp| comp.chapter)
    }

    /// `(anchor, marked length, replaced length)` in UTF-16.
    fn marked16(&mut self) -> Option<(usize, usize, usize)> {
        let comp = self.composition.as_ref()?;
        let (chapter, at, replaced) = (comp.chapter, comp.at, comp.replaced);
        let len16 = comp.text.encode_utf16().count();
        let doc = &mut self.book.chapters[chapter].doc;
        let at16 = doc.offset_to_utf16(at);
        let end16 = doc.offset_to_utf16(at + replaced);
        Some((at16, len16, end16 - at16))
    }

    fn virtual_len16(&mut self) -> usize {
        let marked = self.marked16();
        let chapter = self.input_chapter();
        let len = self.book.chapters[chapter].doc.len_utf16();
        match marked {
            Some((_, len16, replaced16)) => len - replaced16 + len16,
            None => len,
        }
    }

    fn doc_to_virtual16(&mut self, offset: usize) -> usize {
        let marked = self.marked16();
        let chapter = self.input_chapter();
        let at = self.composition.as_ref().map(|comp| comp.at);
        let offset16 = self.book.chapters[chapter].doc.offset_to_utf16(offset);
        match (marked, at) {
            (Some((at16, len16, replaced16)), Some(at)) if offset > at => {
                offset16.saturating_sub(replaced16).max(at16) + len16
            }
            _ => offset16,
        }
    }

    fn virtual16_to_doc(&mut self, v: usize) -> VirtualPos {
        let chapter = self.input_chapter();
        match self.marked16() {
            None => VirtualPos::Doc(self.book.chapters[chapter].doc.offset_from_utf16(v)),
            Some((at16, len16, replaced16)) => {
                let comp_at = self.composition.as_ref().map_or(0, |comp| comp.at);
                let replaced = self.composition.as_ref().map_or(0, |comp| comp.replaced);
                if v <= at16 {
                    VirtualPos::Doc(self.book.chapters[chapter].doc.offset_from_utf16(v))
                } else if v < at16 + len16 {
                    VirtualPos::Marked(v - at16)
                } else if v == at16 + len16 {
                    VirtualPos::Doc(comp_at + replaced)
                } else {
                    VirtualPos::Doc(
                        self.book.chapters[chapter]
                            .doc
                            .offset_from_utf16(v - len16 + replaced16),
                    )
                }
            }
        }
    }

    /// A virtual UTF-16 range as committed offsets; positions inside the marked
    /// text map to its edges.
    fn virtual_range_to_doc(&mut self, range: Range<usize>) -> Range<usize> {
        let at = self.composition.as_ref().map_or(0, |comp| comp.at);
        let end_of_marked = self
            .composition
            .as_ref()
            .map_or(0, |comp| comp.at + comp.replaced);
        let start = match self.virtual16_to_doc(range.start) {
            VirtualPos::Doc(offset) => offset,
            VirtualPos::Marked(_) => at,
        };
        let end = match self.virtual16_to_doc(range.end) {
            VirtualPos::Doc(offset) => offset,
            VirtualPos::Marked(_) => end_of_marked,
        };
        start.min(end)..start.max(end)
    }

    fn commit_text(
        &mut self,
        range: Range<usize>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_composition();
        self.edit(window, cx, |doc, sel| {
            let max = doc.len_chars();
            let range = range.start.min(max)..range.end.min(max);
            doc.checkpoint();
            let _ = doc.replace(range.clone(), text, ORIGIN_USER);
            *sel = Selection::caret(sel.chapter, range.start + text.chars().count());
        });
    }

    /// The line and display byte of a virtual UTF-16 position.
    fn display_position(&mut self, v: usize) -> (usize, usize) {
        let chapter = self.input_chapter();
        let pos = self.virtual16_to_doc(v);
        let comp = self.composition.clone();
        let doc = &mut self.book.chapters[chapter].doc;
        match (pos, comp) {
            (VirtualPos::Marked(k), Some(comp)) => {
                let (line, inner) = doc.locate(comp.at);
                let base = doc.line(line).byte_of_char(inner);
                (line, base + utf16_to_byte(&comp.text, k))
            }
            (VirtualPos::Doc(offset), comp) => {
                let (line, inner) = doc.locate(offset);
                let mut byte = doc.line(line).byte_of_char(inner);
                if let Some(comp) = comp {
                    let (comp_line, comp_inner) = doc.locate(comp.at);
                    if comp_line == line && inner >= comp_inner + comp.replaced && offset > comp.at
                    {
                        let replaced_bytes =
                            doc.line(line).byte_of_char(comp_inner + comp.replaced)
                                - doc.line(line).byte_of_char(comp_inner);
                        byte = byte - replaced_bytes + comp.text.len();
                    }
                }
                (line, byte)
            }
            (VirtualPos::Marked(_), None) => (0, 0),
        }
    }
}

fn doc_line_of(doc: &mut ProseDoc, offset: usize) -> usize {
    doc.locate(offset).0
}

fn utf16_to_byte(text: &str, offset16: usize) -> usize {
    let mut count = 0;
    for (byte, ch) in text.char_indices() {
        if count >= offset16 {
            return byte;
        }
        count += ch.len_utf16();
    }
    text.len()
}

fn utf16_slice(text: &str, range: Range<usize>) -> &str {
    &text[utf16_to_byte(text, range.start)..utf16_to_byte(text, range.end)]
}

/// A run of same-class characters around `offset` (a stand-in for ICU word
/// segmentation, which F4c adds).
fn word_around(doc: &mut ProseDoc, offset: usize) -> (usize, usize) {
    let (line_ix, inner) = doc.locate(offset);
    let start = doc.line_start(line_ix);
    let chars: Vec<char> = doc.line(line_ix).text.chars().collect();
    if chars.is_empty() {
        return (offset, offset);
    }
    let class = |c: char| -> u8 {
        if c.is_alphanumeric() && c.is_ascii() {
            0
        } else if crate::heights::advance_em(c) >= 1.0 && c.is_alphanumeric() {
            1
        } else if c.is_whitespace() {
            2
        } else {
            3
        }
    };
    let pivot = inner.min(chars.len() - 1);
    let target = class(chars[pivot]);
    let mut a = pivot;
    while a > 0 && class(chars[a - 1]) == target {
        a -= 1;
    }
    let mut b = pivot + 1;
    while b < chars.len() && class(chars[b]) == target {
        b += 1;
    }
    (start + a, start + b)
}

impl EntityInputHandler for ProseEditor {
    fn text_for_range(
        &mut self,
        range16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let len = self.virtual_len16();
        let range16 = range16.start.min(len)..range16.end.min(len);
        actual_range.replace(range16.clone());
        let chapter = self.input_chapter();
        let Some((at16, len16, replaced16)) = self.marked16() else {
            let doc = &mut self.book.chapters[chapter].doc;
            let range = doc.offset_from_utf16(range16.start)..doc.offset_from_utf16(range16.end);
            return Some(doc.slice(range));
        };
        let comp_text = self.composition.as_ref().map(|comp| comp.text.clone())?;
        let doc = &mut self.book.chapters[chapter].doc;
        let mut out = String::new();
        if range16.start < at16 {
            let end = range16.end.min(at16);
            let range = doc.offset_from_utf16(range16.start)..doc.offset_from_utf16(end);
            out.push_str(&doc.slice(range));
        }
        let (ms, me) = (
            range16.start.clamp(at16, at16 + len16) - at16,
            range16.end.clamp(at16, at16 + len16) - at16,
        );
        if ms < me {
            out.push_str(utf16_slice(&comp_text, ms..me));
        }
        if range16.end > at16 + len16 {
            let start = range16.start.max(at16 + len16) - len16 + replaced16;
            let end = range16.end - len16 + replaced16;
            let range = doc.offset_from_utf16(start)..doc.offset_from_utf16(end);
            out.push_str(&doc.slice(range));
        }
        Some(out)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        if let Some((at16, _, _)) = self.marked16() {
            let comp = self.composition.as_ref()?;
            let start = comp.text[..comp.selected.start].encode_utf16().count();
            let end = comp.text[..comp.selected.end].encode_utf16().count();
            return Some(UTF16Selection {
                range: at16 + start..at16 + end,
                reversed: false,
            });
        }
        let sel = self.selection;
        let doc = &mut self.book.chapters[sel.chapter].doc;
        let range = sel.range();
        Some(UTF16Selection {
            range: doc.offset_to_utf16(range.start)..doc.offset_to_utf16(range.end),
            reversed: sel.head < sel.anchor,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        let comp = self.composition.as_ref()?;
        // `&self` here: compute the anchor's UTF-16 offset by scanning.
        let doc = &self.book.chapters[comp.chapter].doc;
        let mut at16 = 0;
        let mut remaining = comp.at;
        for line in doc.lines() {
            if remaining <= line.chars {
                at16 += line
                    .text
                    .chars()
                    .take(remaining)
                    .map(char::len_utf16)
                    .sum::<usize>();
                break;
            }
            at16 += line.utf16 + 1;
            remaining -= line.chars + 1;
        }
        Some(at16..at16 + comp.text.encode_utf16().count())
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.log_ime(format_args!("unmark_text"));
        // The input method accepts the marked text as it stands.
        if let Some(comp) = self.composition.clone() {
            self.commit_text(comp.at..comp.at + comp.replaced, &comp.text, window, cx);
        }
    }

    fn replace_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.log_ime(format_args!("replace_text_in_range({range16:?}, {text:?})"));
        let explicit = range16.is_some();
        let range = match (&self.composition, range16) {
            (Some(comp), None) => comp.at..comp.at + comp.replaced,
            (Some(comp), Some(range16)) => {
                let (at, end) = (comp.at, comp.at + comp.replaced);
                let mapped = self.virtual_range_to_doc(range16);
                mapped.start.min(at)..mapped.end.max(end)
            }
            (None, Some(range16)) => self.virtual_range_to_doc(range16),
            (None, None) => self.selection.range(),
        };
        if self.composition.is_none() && !explicit && text.is_empty() && range.is_empty() {
            return;
        }
        if self.composition.is_some() {
            self.commit_text(range, text, window, cx);
        } else {
            // Plain typing: merge with neighbouring keystrokes into one undo step.
            self.edit(window, cx, |doc, sel| {
                let _ = doc.replace(range.clone(), text, ORIGIN_USER);
                *sel = Selection::caret(sel.chapter, range.start + text.chars().count());
            });
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.log_ime(format_args!(
            "replace_and_mark_text_in_range({range16:?}, {new_text:?}, {new_selected_range16:?})"
        ));
        if self.composition.is_none() {
            let mut base = match range16 {
                Some(range16) => self.virtual_range_to_doc(range16),
                None => self.selection.range(),
            };
            let chapter = self.selection.chapter;
            let doc = &mut self.book.chapters[chapter].doc;
            let (first, _) = doc.locate(base.start);
            let (last, _) = doc.locate(base.end);
            if first != last {
                // A selection across paragraphs is removed up front; the marked
                // text is then shown inside one paragraph.
                let range = base.clone();
                self.edit(window, cx, |doc, sel| {
                    doc.checkpoint();
                    let _ = doc.replace(range.clone(), "", ORIGIN_USER);
                    *sel = Selection::caret(sel.chapter, range.start);
                });
                base = base.start..base.start;
            }
            self.composition = Some(Composition {
                chapter,
                at: base.start,
                replaced: base.len(),
                text: String::new(),
                selected: 0..0,
            });
        } else if let Some(range16) = range16 {
            // The input method re-targets the marked range (rare).
            let mapped = self.virtual_range_to_doc(range16);
            if let Some(comp) = self.composition.as_mut() {
                let end = (comp.at + comp.replaced).max(mapped.end);
                comp.at = comp.at.min(mapped.start);
                comp.replaced = end - comp.at;
            }
        }
        if new_text.is_empty() {
            // All marked text deleted: back to the committed text, untouched.
            let at = self.composition.as_ref().map_or(0, |comp| comp.at);
            let chapter = self.input_chapter();
            self.cancel_composition();
            self.selection = Selection::caret(chapter, at);
        } else if let Some(comp) = self.composition.as_mut() {
            comp.text = new_text.to_owned();
            comp.selected = match new_selected_range16 {
                Some(range) => {
                    utf16_to_byte(new_text, range.start)..utf16_to_byte(new_text, range.end)
                }
                None => new_text.len()..new_text.len(),
            };
        }
        self.autoscroll = true;
        self.reset_blink(cx);
        cx.notify();
        self.present_now(window);
    }

    fn bounds_for_range(
        &mut self,
        range16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let result = self.bounds_for_range_inner(range16.clone(), window);
        self.log_ime(format_args!("bounds_for_range({range16:?}) -> {result:?}"));
        result
    }
    fn selection_bounds_for_range(
        &mut self,
        range16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        self.bounds_for_range(range16, element_bounds, window, cx)
            .into_iter()
            .collect()
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let (chapter, offset) = self.hit_test(point)?;
        (chapter == self.input_chapter()).then(|| self.doc_to_virtual16(offset))
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.virtual_len16())
    }

    fn set_selected_text_range(
        &mut self,
        range16: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_some() {
            return;
        }
        let range = self.virtual_range_to_doc(range16);
        let mut sel = Selection::caret(self.selection.chapter, range.start);
        sel.head = range.end;
        self.selection = sel;
        self.clamp_selection();
        cx.notify();
    }
}

impl ProseEditor {
    fn bounds_for_range_inner(
        &mut self,
        range16: Range<usize>,
        window: &mut Window,
    ) -> Option<Bounds<Pixels>> {
        let chapter = self.input_chapter();
        let (line_ix, byte) = self.display_position(range16.start);
        let (end_line, end_byte) = self.display_position(range16.end);
        let painted = self.frame.borrow().get(chapter, line_ix).cloned()?;
        // The paragraph may have changed since it was painted (this query often
        // comes right after a keystroke): shape the current display text at the
        // painted width so the candidate window lands on the new position.
        let element = self.paragraph(0, chapter, line_ix);
        let layout = if element.text == painted.text {
            painted.layout.clone()
        } else {
            Rc::new(shape(
                &element.text,
                element.font_size,
                &element.runs,
                painted.layout.wrap_width,
                window,
            ))
        };
        let start = layout.point_for_byte(byte, Affinity::Downstream, painted.line_height);
        let end_x = if end_line == line_ix {
            let end = layout.point_for_byte(end_byte, Affinity::Upstream, painted.line_height);
            if end.y == start.y { end.x } else { start.x }
        } else {
            start.x
        };
        Some(Bounds::new(
            painted.origin + start,
            size((end_x - start.x).max(px(1.)), painted.line_height),
        ))
    }
}

/// The caret, drawn over the editor. It owns the blink timer and notifies only
/// itself, so the paragraphs (a cached view) are replayed, not rebuilt.
pub struct CursorLayer {
    rect: Rc<Cell<Option<Bounds<Pixels>>>>,
    color: Hsla,
    visible: bool,
    epoch: u64,
    _task: Option<Task<()>>,
}

impl CursorLayer {
    fn restart(&mut self, cx: &mut Context<Self>) {
        self.visible = true;
        self.epoch += 1;
        let epoch = self.epoch;
        self._task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(BLINK_INTERVAL).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if this.epoch != epoch {
                            return false;
                        }
                        this.visible = !this.visible;
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
        }));
        cx.notify();
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        self.epoch += 1;
        self._task = None;
        self.visible = false;
        cx.notify();
    }
}

impl Render for CursorLayer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let (rect, color, visible) = (self.rect.clone(), self.color, self.visible);
        div().absolute().top_0().left_0().size_full().child(
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    if let (true, Some(caret)) = (visible, rect.get()) {
                        window.with_content_mask(Some(ContentMask { bounds }), |window| {
                            window.paint_quad(fill(caret, color));
                        });
                    }
                },
            )
            .size_full(),
        )
    }
}

impl Focusable for ProseEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ProseEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .on_action(cx.listener(Self::move_left))
            .on_action(cx.listener(Self::move_right))
            .on_action(cx.listener(Self::move_up))
            .on_action(cx.listener(Self::move_down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::move_to_line_start))
            .on_action(cx.listener(Self::move_to_line_end))
            .on_action(cx.listener(Self::select_to_line_start))
            .on_action(cx.listener(Self::select_to_line_end))
            .on_action(cx.listener(Self::move_to_chapter_start))
            .on_action(cx.listener(Self::move_to_chapter_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::set_body))
            .on_action(cx.listener(Self::set_h1))
            .on_action(cx.listener(Self::set_h2))
            .on_action(cx.listener(Self::set_h3))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::mouse_up))
            .child(
                list(
                    self.list.clone(),
                    cx.processor(|this, ix, window, cx| this.render_item(ix, window, cx)),
                )
                .size_full(),
            )
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

#[cfg(test)]
mod tests;
