//! The multi-line input: a book's introduction, a chapter's synopsis, a
//! chapter title that wraps. It has no frame of its own and takes its face,
//! size, weight, line height and colour from the text around it, so on a
//! page it reads as the page's own words; only the caret, the selection and
//! the placeholder (ink 4) are its own. [`TextArea::framed`] gives it the
//! single-line field's slip instead (the 0.1 client's `ui-field--area`): a
//! resting line of glass, selected while the caret is in it, 8 × 12 px
//! inside, 16 px corners, the interface's body type, at least a few rows
//! high (a form's summary, 本书简介). It wraps to its width and grows a
//! row at a time; rows break by the editor's Chinese rules
//! (`prose-linebreak`: no 「。」 or closing quote starts a row, Latin words
//! stay whole, a mark that does not fit hangs past the edge).
//! [`TextArea::wrap_punctuation`] instead moves closing marks with the
//! preceding text to the next row, for a field whose sides are clipped.
//!
//! Enter starts a new paragraph, or with [`TextArea::submit_on_enter`] (a
//! title: one paragraph that wraps) submits instead, and newlines that are
//! pasted or come from the input method become spaces. ⌘↵ / Ctrl+Enter
//! submits either way, Esc cancels; what that means (save, put the old text
//! back, move on to the body) is the owner's.
//!
//! Composition follows the single-line field ([`super::field`]): the owner
//! hears [`FieldEvent::Changed`] only for committed text, keys belong to the
//! input method while it composes, and losing focus (or the window)
//! discards the marked text here and in the system input method.
//!
//! Positions are UTF-8 offsets into the text, as in [`LineComposer`]; at a
//! soft wrap one offset is both the end of a row and the start of the next,
//! and the caret remembers which it is on (`upstream`).

use std::{ops::Range, rc::Rc, time::Duration};

use gpui::{
    App, AvailableSpace, Bounds, ClipboardItem, Context, CursorStyle, ElementId,
    ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    GlobalElementId, InspectorElementId, InteractiveElement, IntoElement, KeyBinding, LayoutId,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, ParentElement, Pixels,
    Point, Render, SharedString, Style, Styled, Task, TextAlign, TextRun, TextStyle,
    UTF16Selection, UnderlineStyle, Window, actions, fill, point, prelude::FluentBuilder as _, px,
    relative, size,
};
use gpui_ime::{Change, LineComposer};
use unicode_segmentation::UnicodeSegmentation as _;

use super::{
    field::{
        Backspace, Cancel, Copy, Cut, Delete, End, FieldEvent, Home, Left, Paste, Right, SelectAll,
        SelectLeft, SelectRight, Submit,
    },
    ime::{self, Graphemes},
};
use crate::{
    fonts::Role,
    glass::{self, GlassState, Kind, Mode, Spec, Tone},
    style::DrStyled as _,
    text::{Paragraph, shape},
    theme::Theme,
    tokens::{color::Palette, radius},
};

actions!(
    dr_text_area,
    [Up, Down, SelectUp, SelectDown, TextStart, TextEnd, Newline]
);

pub const KEY_CONTEXT: &str = "DrTextArea";

/// The multi-line input's key bindings (part of [`super::bindings`]).
pub fn bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    let mac = cfg!(target_os = "macos");
    let k = |mac_key: &'static str, other: &'static str| if mac { mac_key } else { other };
    vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new(k("cmd-a", "ctrl-a"), SelectAll, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new(k("cmd-left", "home"), Home, c),
        KeyBinding::new(k("cmd-right", "end"), End, c),
        KeyBinding::new(k("cmd-up", "ctrl-home"), TextStart, c),
        KeyBinding::new(k("cmd-down", "ctrl-end"), TextEnd, c),
        KeyBinding::new(k("cmd-v", "ctrl-v"), Paste, c),
        KeyBinding::new(k("cmd-c", "ctrl-c"), Copy, c),
        KeyBinding::new(k("cmd-x", "ctrl-x"), Cut, c),
        KeyBinding::new("enter", Newline, c),
        KeyBinding::new("shift-enter", Newline, c),
        KeyBinding::new(k("cmd-enter", "ctrl-enter"), Submit, c),
        KeyBinding::new("escape", Cancel, c),
    ]
}

/// What the multi-line input says besides [`FieldEvent`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AreaEvent {
    /// ↓ with the caret already at the very end: nothing below in the
    /// field, so the owner may move on (a chapter title hands the caret to
    /// the text).
    PastEnd,
}

pub struct TextArea {
    focus: FocusHandle,
    composer: LineComposer,
    placeholder: SharedString,
    disabled: bool,
    submit_on_enter: bool,
    overflow: prose_linebreak::Overflow,
    layout: Option<Rc<Layout>>,
    /// At a soft wrap, the caret is at the end of the upper row.
    upstream: bool,
    /// Where Up and Down aim, kept across a run of them.
    goal_x: Option<Pixels>,
    selecting: bool,
    caret_on: bool,
    blink: Option<Task<()>>,
    id: ElementId,
    /// In a slip at least this many rows high ([`TextArea::framed`]).
    frame: Option<f32>,
    glass: Option<Entity<GlassState>>,
}

impl EventEmitter<FieldEvent> for TextArea {}
impl EventEmitter<AreaEvent> for TextArea {}

impl Focusable for TextArea {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextArea {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut Context<Self>) -> TextArea {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _, cx| {
            this.start_blink(cx);
            cx.notify();
        })
        .detach();
        cx.on_blur(&focus, window, |this, window, cx| this.blurred(window, cx))
            .detach();
        cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() {
                this.drop_composition(window, cx);
            }
        })
        .detach();
        TextArea {
            focus,
            composer: LineComposer::default(),
            placeholder: SharedString::default(),
            disabled: false,
            submit_on_enter: false,
            overflow: prose_linebreak::Overflow::Hang,
            layout: None,
            upstream: false,
            goal_x: None,
            selecting: false,
            caret_on: true,
            blink: None,
            id: id.into(),
            frame: None,
            glass: None,
        }
    }

    /// In the single-line field's slip, at least `rows` rows high (the 0.1
    /// client: 3 in a dialog, 4 for 本书简介), in the interface's body
    /// type. A press on the slip's padding puts the caret in it too.
    pub fn framed(mut self, rows: f32) -> Self {
        self.frame = Some(rows);
        self
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// Move closing marks with their preceding text to the next row instead
    /// of hanging them beyond the width. A segment without a legal break
    /// stays together; glyphs are never squeezed. Used by plot-grid slips.
    pub fn wrap_punctuation(mut self) -> Self {
        self.overflow = prose_linebreak::Overflow::Wrap;
        self
    }

    /// One paragraph that wraps (a chapter title): Enter submits, and
    /// newlines that arrive become spaces.
    pub fn submit_on_enter(mut self) -> Self {
        self.submit_on_enter = true;
        self.composer.set_text(self.clean(self.composer.text()));
        self
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        let text = self.clean(&text.into());
        self.composer.set_text(text);
        self
    }

    /// The committed text (never the composition).
    pub fn text(&self) -> String {
        self.composer.committed()
    }

    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        let text = self.clean(&text.into());
        self.composer.set_text(text);
        self.upstream = false;
        self.goal_x = None;
        cx.notify();
    }

    pub fn is_composing(&self) -> bool {
        self.composer.is_composing()
    }

    /// Selects the whole text (a new chapter's title, so the author names
    /// it first).
    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.composer.select_all();
        self.upstream = false;
        cx.notify();
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    /// The composer, for tests.
    pub fn composer(&self) -> &LineComposer {
        &self.composer
    }

    /// How many rows the text took at its last layout (0 before the first).
    pub fn rows(&self) -> usize {
        self.layout.as_ref().map_or(0, |l| l.rows.len())
    }

    /// Newlines as this field takes them: `\r\n` and `\r` are `\n`, and a
    /// one-paragraph field turns them into spaces.
    fn clean(&self, text: &str) -> String {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if self.submit_on_enter {
            text.replace('\n', " ")
        } else {
            text
        }
    }

    fn report(&mut self, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        self.caret_on = true;
        self.upstream = false;
        self.goal_x = None;
        window.notify_text_input_changed(&self.focus);
        if change == Change::Committed {
            cx.emit(FieldEvent::Changed(self.composer.committed()));
        }
        cx.notify();
    }

    /// The caret or selection moved; `upstream` says which row a soft wrap
    /// puts it on, and Up / Down keep their aim.
    fn moved_to(
        &mut self,
        upstream: bool,
        keep_goal: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.caret_on = true;
        self.upstream = upstream;
        if !keep_goal {
            self.goal_x = None;
        }
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.moved_to(false, false, window, cx);
    }

    /// The shared blur rule (see [`super::ime`]).
    fn drop_composition(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.composer.is_composing() {
            return;
        }
        let change = self.composer.blur();
        ime::discard_marked_text(window, cx);
        self.report(change, window, cx);
    }

    fn blurred(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.drop_composition(window, cx);
        self.blink = None;
        self.selecting = false;
        if let Some(g) = &self.glass {
            g.update(cx, |s, _| s.set_selected(false));
        }
        cx.notify();
        cx.emit(FieldEvent::Blurred);
    }

    fn takes_input(&self, window: &Window) -> bool {
        !self.disabled && self.focus.is_focused(window)
    }

    fn start_blink(&mut self, cx: &mut Context<Self>) {
        self.caret_on = true;
        self.blink = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(530))
                    .await;
                let alive = this.update(cx, |this, cx| {
                    this.caret_on = !this.caret_on;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        }));
    }

    // ----- keys ------------------------------------------------------------------------

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        let change = self.composer.backspace(&Graphemes);
        self.report(change, window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        let change = self.composer.delete(&Graphemes);
        self.report(change, window, cx);
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.left(&Graphemes);
        self.moved(window, cx);
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.right(&Graphemes);
        self.moved(window, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_left(&Graphemes);
        self.moved(window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_right(&Graphemes);
        self.moved(window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_all();
        self.moved(window, cx);
    }

    /// Up or down a row, aiming where the caret was when the run of moves
    /// began; past the first row it goes to the start, past the last to
    /// the end.
    fn vertical(&mut self, down: bool, select: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.clone() else {
            return;
        };
        let len = self.composer.text().len();
        let at = layout.vertical(
            self.composer.cursor(),
            self.upstream,
            self.goal_x,
            down,
            len,
        );
        if select {
            self.composer.select_to(at.offset);
        } else {
            self.composer.move_to(at.offset);
        }
        self.goal_x = Some(at.goal);
        self.moved_to(at.upstream, true, window, cx);
    }

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, false, window, cx);
    }

    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        let at_end = self.composer.selection().is_empty()
            && self.composer.cursor() == self.composer.text().len();
        if at_end && !self.composer.is_composing() {
            cx.emit(AreaEvent::PastEnd);
            return;
        }
        self.vertical(true, false, window, cx);
    }

    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(false, true, window, cx);
    }

    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(true, true, window, cx);
    }

    /// The start of the caret's row.
    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        match self.layout.clone() {
            Some(l) => {
                let row = &l.rows[l.row_index(self.composer.cursor(), self.upstream)];
                self.composer.move_to(row.start);
            }
            None => self.composer.home(),
        }
        self.moved(window, cx);
    }

    /// The end of the caret's row (staying on it at a soft wrap).
    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        let upstream = match self.layout.clone() {
            Some(l) => {
                let ix = l.row_index(self.composer.cursor(), self.upstream);
                self.composer.move_to(l.rows[ix].end);
                !l.last_of_paragraph(ix)
            }
            None => {
                self.composer.end();
                false
            }
        };
        self.moved_to(upstream, false, window, cx);
    }

    fn text_start(&mut self, _: &TextStart, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.home();
        self.moved(window, cx);
    }

    fn text_end(&mut self, _: &TextEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.end();
        self.moved(window, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            // `LineComposer::insert` flattens newlines (it is one line's);
            // this field keeps them unless it is a title.
            let text = self.clean(&text);
            let change = self.composer.replace(None, &text);
            self.report(change, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.selected_text();
        if !text.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.selected_text().to_string();
        if !text.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            let change = self.composer.replace(None, "");
            self.report(change, window, cx);
        }
    }

    /// Enter: a new paragraph, or for a title the same as submitting.
    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        // While composing, Enter chooses the candidate; it is not ours.
        if self.composer.is_composing() {
            return;
        }
        if self.submit_on_enter {
            cx.emit(FieldEvent::Submitted(self.composer.committed()));
        } else {
            let change = self.composer.replace(None, "\n");
            self.report(change, window, cx);
        }
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if !self.composer.is_composing() {
            cx.emit(FieldEvent::Submitted(self.composer.committed()));
        }
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        if !self.composer.is_composing() {
            cx.emit(FieldEvent::Cancelled);
        }
    }

    // ----- the pointer -----------------------------------------------------------------

    /// The offset under a window position, and whether it is a row's end at
    /// a soft wrap.
    fn offset_at(&self, position: Point<Pixels>) -> Option<(usize, bool)> {
        let layout = self.layout.as_ref()?;
        if self.composer.text().is_empty() {
            return Some((0, false));
        }
        Some(layout.offset_at(position - layout.bounds.origin))
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.disabled {
            return;
        }
        window.focus(&self.focus, cx);
        self.selecting = true;
        let Some((at, upstream)) = self.offset_at(event.position) else {
            return;
        };
        if event.modifiers.shift {
            self.composer.select_to(at);
        } else if event.click_count >= 3 {
            let range = paragraph_at(self.composer.text(), at);
            self.composer.move_to(range.start);
            self.composer.select_to(range.end);
        } else if event.click_count == 2 {
            let range = word_at(self.composer.text(), at);
            self.composer.move_to(range.start);
            self.composer.select_to(range.end);
        } else {
            self.composer.move_to(at);
        }
        self.moved_to(upstream, false, window, cx);
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selecting
            && let Some((at, upstream)) = self.offset_at(event.position)
        {
            self.composer.select_to(at);
            self.moved_to(upstream, false, window, cx);
        }
    }

    /// The text to shape and its runs: the placeholder in ink 4 when empty,
    /// the composition underlined.
    fn shaping(&self, style: &TextStyle, p: &Palette) -> (SharedString, Vec<TextRun>, bool) {
        let text = self.composer.text();
        if text.is_empty() {
            let mut run = style.to_run(self.placeholder.len());
            run.color = p.ink(4).solid();
            return (self.placeholder.clone(), vec![run], true);
        }
        let run = style.to_run(text.len());
        let runs = match self.composer.marked() {
            Some(m) => [
                TextRun {
                    len: m.start,
                    ..run.clone()
                },
                TextRun {
                    len: m.end - m.start,
                    underline: Some(UnderlineStyle {
                        color: Some(p.ink(2).solid()),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: text.len() - m.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect(),
            None => vec![run],
        };
        (text.to_string().into(), runs, false)
    }
}

/// The word (by Unicode word bounds; every CJK ideograph is one) at `at`.
fn word_at(text: &str, at: usize) -> Range<usize> {
    text.split_word_bound_indices()
        .map(|(i, w)| i..i + w.len())
        .find(|r| r.contains(&at) || r.end == at && at == text.len())
        .unwrap_or(at..at)
}

/// The paragraph (between newlines) holding `at`.
fn paragraph_at(text: &str, at: usize) -> Range<usize> {
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    start..end
}

impl EntityInputHandler for TextArea {
    fn text_for_range(
        &mut self,
        range16: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let (text, range) = self.composer.text_for_utf16(range16);
        actual.replace(range);
        Some(text)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.composer.selected_utf16(),
            reversed: self.composer.reversed(),
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.composer.marked_utf16()
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.takes_input(window) {
            return;
        }
        let change = self.composer.unmark();
        self.report(change, window, cx);
    }

    fn replace_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.takes_input(window) {
            return;
        }
        let text = self.clean(text);
        let change = self.composer.replace(range16, &text);
        self.report(change, window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range16: Option<Range<usize>>,
        text: &str,
        selected16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.takes_input(window) {
            return;
        }
        let change = self.composer.replace_and_mark(range16, text, selected16);
        self.report(change, window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range16: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let range = self.composer.range_from_utf16(&range16);
        let origin = layout.bounds.origin;
        let start = layout.point_of(range.start, false);
        let end = layout.point_of(range.end, true);
        // The first row of the range: where the candidate window goes.
        let right = if end.y == start.y {
            end.x
        } else {
            layout.bounds.size.width
        };
        Some(Bounds::from_corners(
            origin + start,
            origin + point(right, start.y + layout.line_height),
        ))
    }

    fn character_index_for_point(
        &mut self,
        at: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let (offset, _) = self.offset_at(at)?;
        Some(self.composer.to_utf16(offset))
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.composer.utf16_len())
    }

    fn set_selected_text_range(
        &mut self,
        range16: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composer.set_selected_utf16(range16);
        self.moved(window, cx);
    }
}

impl Render for TextArea {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let focused = self.focus.is_focused(window);
        let el = match self.frame {
            None => gpui::div().id(self.id.clone()),
            Some(_) => {
                let mode = Mode {
                    disabled: self.disabled,
                    ..Mode::default()
                };
                let spec = Spec::new(Tone::Clear, radius::SHEET).filled(p.page);
                self.glass = Some(glass::use_state(
                    self.id.clone(),
                    Kind::Rest,
                    mode,
                    focused,
                    theme,
                    window,
                    cx,
                ));
                glass::glass_box(self.id.clone(), Kind::Rest, mode, focused, spec, window, cx)
            }
        };
        let area = AreaElement {
            area: cx.entity(),
            focused,
        };
        el.key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::text_start))
            .on_action(cx.listener(Self::text_end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::cancel))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .w_full()
            .map(|el| match self.frame {
                None => el
                    .when(self.disabled, |el| el.text_color(p.ink(4).solid()))
                    .child(area),
                Some(rows) => el
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(radius::SHEET))
                    .bg(if self.disabled {
                        p.page.alpha(0.45)
                    } else {
                        p.page.solid()
                    })
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(if self.disabled { p.ink(4) } else { p.ink(1) }.solid())
                    .child(
                        gpui::div()
                            .w_full()
                            .min_h(px(s.line_body * rows))
                            .child(area),
                    ),
            })
    }
}

// ----- layout ----------------------------------------------------------------------------

/// One row on screen: the part of a paragraph it shows (text offsets; the
/// end leaves out the newline) and where it sits.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Row {
    paragraph: usize,
    start: usize,
    end: usize,
    /// The row's start in its paragraph's unwrapped line.
    x0: Pixels,
    y: Pixels,
}

/// Where a vertical move lands.
struct Landing {
    offset: usize,
    upstream: bool,
    goal: Pixels,
}

/// The text as last laid out, in the element's own coordinates.
pub(crate) struct Layout {
    bounds: Bounds<Pixels>,
    line_height: Pixels,
    paragraphs: Vec<Paragraph>,
    rows: Vec<Row>,
    /// The rows show the placeholder.
    placeholder: bool,
}

impl Layout {
    fn new(
        bounds: Bounds<Pixels>,
        line_height: Pixels,
        paragraphs: Vec<Paragraph>,
        placeholder: bool,
    ) -> Layout {
        let mut rows = Vec::new();
        let mut y = px(0.0);
        for (ix, para) in paragraphs.iter().enumerate() {
            for (range, x0) in &para.breaks {
                rows.push(Row {
                    paragraph: ix,
                    start: para.start + range.start,
                    end: para.start + range.end,
                    x0: *x0,
                    y,
                });
                y += line_height;
            }
        }
        Layout {
            bounds,
            line_height,
            paragraphs,
            rows,
            placeholder,
        }
    }

    /// Whether row `ix` is its paragraph's last.
    fn last_of_paragraph(&self, ix: usize) -> bool {
        self.rows
            .get(ix + 1)
            .is_none_or(|next| next.paragraph != self.rows[ix].paragraph)
    }

    /// The row the caret at `offset` is on.
    fn row_index(&self, offset: usize, upstream: bool) -> usize {
        if self.placeholder {
            return 0;
        }
        let mut ix = self
            .rows
            .partition_point(|r| r.start <= offset)
            .saturating_sub(1);
        if upstream && ix > 0 && self.rows[ix].start == offset && !self.last_of_paragraph(ix - 1) {
            ix -= 1;
        }
        ix
    }

    fn x_of(&self, row: &Row, offset: usize) -> Pixels {
        let para = &self.paragraphs[row.paragraph];
        para.line.x_for_index(offset - para.start) - row.x0
    }

    /// Where the caret at `offset` stands, relative to the element.
    fn point_of(&self, offset: usize, upstream: bool) -> Point<Pixels> {
        let row = &self.rows[self.row_index(offset, upstream)];
        if self.placeholder {
            return point(px(0.0), row.y);
        }
        point(self.x_of(row, offset), row.y)
    }

    /// The offset nearest `local` on row `ix`, and whether it is the row's
    /// end at a soft wrap.
    fn offset_on(&self, ix: usize, x: Pixels) -> (usize, bool) {
        let row = &self.rows[ix];
        let para = &self.paragraphs[row.paragraph];
        let inner = para.line.closest_index_for_x(x.max(px(0.0)) + row.x0);
        let at = (para.start + inner).clamp(row.start, row.end);
        (at, at == row.end && !self.last_of_paragraph(ix))
    }

    fn offset_at(&self, local: Point<Pixels>) -> (usize, bool) {
        let ix = (local.y / self.line_height).floor().max(0.0) as usize;
        self.offset_on(ix.min(self.rows.len() - 1), local.x)
    }

    fn vertical(
        &self,
        offset: usize,
        upstream: bool,
        goal: Option<Pixels>,
        down: bool,
        len: usize,
    ) -> Landing {
        let ix = self.row_index(offset, upstream);
        let goal = goal.unwrap_or_else(|| self.point_of(offset, upstream).x);
        let target = if down {
            Some(ix + 1).filter(|&t| t < self.rows.len())
        } else {
            ix.checked_sub(1)
        };
        match target {
            Some(t) if !self.placeholder => {
                let (offset, upstream) = self.offset_on(t, goal);
                Landing {
                    offset,
                    upstream,
                    goal,
                }
            }
            _ => Landing {
                offset: if down { len } else { 0 },
                upstream: false,
                goal,
            },
        }
    }

    /// The selection's wash, a rectangle per row it covers; a newline it
    /// takes in is a third of the font size wide.
    fn selection(&self, range: Range<usize>, newline: Pixels) -> Vec<Bounds<Pixels>> {
        if range.is_empty() || self.placeholder {
            return Vec::new();
        }
        let last = self.rows.len() - 1;
        self.rows
            .iter()
            .enumerate()
            .filter_map(|(ix, row)| {
                let a = range.start.max(row.start);
                let b = range.end.min(row.end);
                let takes_break = ix < last
                    && self.last_of_paragraph(ix)
                    && range.start <= row.end
                    && range.end > row.end;
                if a > b || (a == b && !takes_break) {
                    return None;
                }
                let x0 = self.x_of(row, a);
                let x1 = self.x_of(row, b) + if takes_break { newline } else { px(0.0) };
                Some(Bounds::from_corners(
                    point(x0, row.y),
                    point(x1, row.y + self.line_height),
                ))
            })
            .collect()
    }
}

/// Shapes and paints the paragraphs, the selection, the composition
/// underline and the caret, and registers the area as the window's input
/// handler. Its height is the rows' at the width it is given.
struct AreaElement {
    area: Entity<TextArea>,
    focused: bool,
}

struct AreaPrepaint {
    layout: Rc<Layout>,
    selection: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
}

impl IntoElement for AreaElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// The font size and the row height of the text style in force.
fn metrics(window: &Window) -> (Pixels, Pixels) {
    let style = window.text_style();
    let font_size = style.font_size.to_pixels(window.rem_size());
    (font_size, window.pixel_snap(window.line_height()))
}

impl gpui::Element for AreaElement {
    type RequestLayoutState = ();
    type PrepaintState = AreaPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let p = Theme::of(window, cx).palette;
        let (text, runs, _) = self.area.read(cx).shaping(&window.text_style(), p);
        let overflow = self.area.read(cx).overflow;
        let (font_size, line_height) = metrics(window);
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let wrap = known.width.or(match available.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let paragraphs = shape(&text, &runs, font_size, wrap, overflow, window);
            let rows: usize = paragraphs.iter().map(|p| p.breaks.len()).sum();
            let width = wrap.unwrap_or_else(|| {
                paragraphs
                    .iter()
                    .map(|p| p.line.width())
                    .fold(px(0.0), |a, b| a.max(b))
            });
            size(width, line_height * rows.max(1) as f32)
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> AreaPrepaint {
        let p = Theme::of(window, cx).palette;
        let area = self.area.read(cx);
        let (text, runs, placeholder) = area.shaping(&window.text_style(), p);
        let (font_size, line_height) = metrics(window);
        let paragraphs = shape(
            &text,
            &runs,
            font_size,
            Some(bounds.size.width),
            area.overflow,
            window,
        );
        let layout = Rc::new(Layout::new(bounds, line_height, paragraphs, placeholder));
        let composer = &area.composer;
        let selection = composer.selection();
        let wash = p.accent.alpha(if self.focused { 0.22 } else { 0.12 });
        let selection = layout
            .selection(selection.clone(), font_size / 3.0)
            .into_iter()
            .map(|b| fill(b + bounds.origin, wash))
            .collect();
        let caret =
            (composer.selection().is_empty() && self.focused && area.caret_on && !area.disabled)
                .then(|| {
                    let at = layout.point_of(composer.cursor(), area.upstream);
                    fill(
                        Bounds::new(bounds.origin + at, size(px(1.5), line_height)),
                        p.accent.solid(),
                    )
                });
        let stored = layout.clone();
        self.area.update(cx, |a, _| a.layout = Some(stored));
        AreaPrepaint {
            layout,
            selection,
            caret,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut AreaPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.area.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.area.clone()),
            cx,
        );
        for quad in prepaint.selection.drain(..) {
            window.paint_quad(quad);
        }
        // Each row is its stretch of the paragraph's shaped line.
        let layout = prepaint.layout.clone();
        for (ix, para) in layout.paragraphs.iter().enumerate() {
            let mut cursor = para.line.cursor();
            for row in layout.rows.iter().filter(|r| r.paragraph == ix) {
                let piece = cursor.take_until(row.end - para.start);
                let _ = piece.paint(
                    point(bounds.origin.x, bounds.origin.y + row.y),
                    layout.line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
        }
        if focus.is_focused(window)
            && let Some(caret) = prepaint.caret.take()
        {
            window.paint_quad(caret);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_or_a_paragraph_under_the_pointer() {
        let text = "雾港 the lighthouse\n第二段";
        assert_eq!(&text[word_at(text, 0)], "雾");
        assert_eq!(&text["雾港 ".len()..][..3], "the");
        assert_eq!(&text[word_at(text, "雾港 t".len())], "the");
        assert_eq!(&text[paragraph_at(text, 3)], "雾港 the lighthouse");
        assert_eq!(&text[paragraph_at(text, text.len())], "第二段");
        assert_eq!(word_at("", 0), 0..0);
    }
}
