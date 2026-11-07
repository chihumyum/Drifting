//! The single-line input (components.md, 「单行输入框」): titles, search,
//! settings. A paper-coloured slip with a resting line of glass; the pointer
//! bleeds it and sets it drifting; while it holds the caret it is the
//! selected glass, still. A search field puts the brush's search icon before
//! the words and a count in index type at the end.
//!
//! Input goes through GPUI's `EntityInputHandler`; the rules for
//! composition live in [`super::compose`]. The owner hears
//! [`FieldEvent::Changed`] only for committed text, never mid-composition,
//! and Enter while composing belongs to the input method.
//!
//! The text element follows the structure of GPUI's `examples/input.rs`
//! (Apache-2.0).

use std::{ops::Range, time::Duration};

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, InspectorElementId,
    InteractiveElement, IntoElement, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, ParentElement, Pixels, Point, Render, ShapedLine,
    SharedString, Style, Styled, Task, TextRun, UTF16Selection, UnderlineStyle, Window, actions,
    div, fill, point, prelude::FluentBuilder as _, px, relative, size,
};

use crate::{
    fonts::Role,
    glass::{self, GlassState, Kind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::DrStyled,
    theme::Theme,
    tokens::radius,
};

use super::compose::{Change, Composer};

actions!(
    dr_text_field,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Copy,
        Cut,
        Submit,
        Cancel
    ]
);

pub const KEY_CONTEXT: &str = "DrTextField";

/// The field's key bindings; [`crate::init`] registers them.
pub fn bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    // The platform's command key: ⌘ on macOS, Ctrl elsewhere.
    let mac = cfg!(target_os = "macos");
    let k = |mac_key: &'static str, other: &'static str| if mac { mac_key } else { other };
    vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new(k("cmd-a", "ctrl-a"), SelectAll, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new(k("cmd-left", "ctrl-left"), Home, c),
        KeyBinding::new(k("cmd-right", "ctrl-right"), End, c),
        KeyBinding::new(k("cmd-v", "ctrl-v"), Paste, c),
        KeyBinding::new(k("cmd-c", "ctrl-c"), Copy, c),
        KeyBinding::new(k("cmd-x", "ctrl-x"), Cut, c),
        KeyBinding::new("enter", Submit, c),
        KeyBinding::new("escape", Cancel, c),
    ]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldEvent {
    /// The committed text changed.
    Changed(String),
    Submitted(String),
    Cancelled,
    Blurred,
}

pub struct TextField {
    focus: FocusHandle,
    composer: Composer,
    placeholder: SharedString,
    icon: Option<Icon>,
    meta: Option<SharedString>,
    disabled: bool,
    small: bool,
    mono: bool,
    trailing: Option<crate::components::Build>,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    scroll_x: f32,
    selecting: bool,
    caret_on: bool,
    blink: Option<Task<()>>,
    glass: Option<Entity<GlassState>>,
    id: ElementId,
}

impl EventEmitter<FieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextField {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut Context<Self>) -> TextField {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _, cx| {
            this.start_blink(cx);
            if let Some(g) = &this.glass {
                g.update(cx, |s, _| s.set_selected(true));
            }
            cx.notify();
        })
        .detach();
        cx.on_blur(&focus, window, |this, window, cx| this.blurred(window, cx))
            .detach();
        // Switching to another app is losing focus too: nothing half-composed
        // may stay behind.
        cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() && this.composer.is_composing() {
                let change = this.composer.blur();
                this.report(change, window, cx);
            }
        })
        .detach();
        TextField {
            focus,
            composer: Composer::default(),
            placeholder: SharedString::default(),
            icon: None,
            meta: None,
            disabled: false,
            small: false,
            mono: false,
            trailing: None,
            last_layout: None,
            last_bounds: None,
            scroll_x: 0.0,
            selecting: false,
            caret_on: true,
            blink: None,
            glass: None,
            id: id.into(),
        }
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// A search field: the brush's search icon before the words.
    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn small(mut self) -> Self {
        self.small = true;
        self
    }

    /// Read one character at a time (keys, paths, numbers): the index face.
    pub fn mono(mut self) -> Self {
        self.mono = true;
        self
    }

    /// Small controls at the field's end, after its meta (a number field's
    /// two steps); built on every render.
    pub fn set_trailing(
        &mut self,
        trailing: Option<crate::components::Build>,
        cx: &mut Context<Self>,
    ) {
        self.trailing = trailing;
        cx.notify();
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.composer.set_text(text);
        self
    }

    /// A count or reading at the end of the field, in index type.
    pub fn set_meta(&mut self, meta: Option<SharedString>, cx: &mut Context<Self>) {
        self.meta = meta;
        cx.notify();
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    /// The committed text (never the composition).
    pub fn text(&self) -> String {
        self.composer.committed()
    }

    pub fn is_composing(&self) -> bool {
        self.composer.is_composing()
    }

    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.composer.set_text(text);
        self.scroll_x = 0.0;
        cx.notify();
    }

    /// The composer, for tests and for the editor's shared rules.
    pub fn composer(&self) -> &Composer {
        &self.composer
    }

    fn report(&mut self, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        self.caret_on = true;
        window.notify_text_input_changed(&self.focus);
        if change == Change::Committed {
            cx.emit(FieldEvent::Changed(self.composer.committed()));
        }
        cx.notify();
    }

    fn moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.caret_on = true;
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }

    fn blurred(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let change = self.composer.blur();
        self.blink = None;
        self.selecting = false;
        if let Some(g) = &self.glass {
            g.update(cx, |s, _| s.set_selected(false));
        }
        self.report(change, window, cx);
        cx.emit(FieldEvent::Blurred);
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

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        let change = self.composer.backspace();
        self.report(change, window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        let change = self.composer.delete();
        self.report(change, window, cx);
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.left();
        self.moved(window, cx);
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.right();
        self.moved(window, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_left();
        self.moved(window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_right();
        self.moved(window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.select_all();
        self.moved(window, cx);
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.home();
        self.moved(window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.end();
        self.moved(window, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let change = self.composer.insert(&text);
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

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        // While composing, Enter chooses the candidate; it is not ours.
        if !self.composer.is_composing() {
            cx.emit(FieldEvent::Submitted(self.composer.committed()));
        }
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        if !self.composer.is_composing() {
            cx.emit(FieldEvent::Cancelled);
        }
    }

    fn index_for_x(&self, x: Pixels) -> usize {
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        if self.composer.text().is_empty() {
            return 0;
        }
        line.closest_index_for_x(x - bounds.left() + px(self.scroll_x))
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
        let at = self.index_for_x(event.position.x);
        if event.modifiers.shift {
            self.composer.select_to(at);
        } else if event.click_count >= 2 {
            self.composer.select_all();
        } else {
            self.composer.move_to(at);
        }
        self.moved(window, cx);
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
        if self.selecting {
            let at = self.index_for_x(event.position.x);
            self.composer.select_to(at);
            self.moved(window, cx);
        }
    }
}

impl EntityInputHandler for TextField {
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
        if self.disabled {
            return;
        }
        let text = text.replace(['\r', '\n'], " ");
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
        if self.disabled {
            return;
        }
        let change = self.composer.replace_and_mark(range16, text, selected16);
        self.report(change, window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.last_layout.as_ref()?;
        let range = self.composer.range_from_utf16(&range16);
        let shift = px(self.scroll_x);
        Some(Bounds::from_corners(
            point(
                bounds.left() + layout.x_for_index(range.start) - shift,
                bounds.top(),
            ),
            point(
                bounds.left() + layout.x_for_index(range.end) - shift,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        at: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let local = self.last_bounds?.localize(&at)?;
        let layout = self.last_layout.as_ref()?;
        let index = layout.closest_index_for_x(local.x + px(self.scroll_x));
        Some(self.composer.to_utf16(index))
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

impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let focused = self.focus.is_focused(window);
        let height = s.control_height - if self.small { 6.0 } else { 0.0 };
        let el = glass::glass_box(
            self.id.clone(),
            Kind::Rest,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            focused,
            Spec::new(Tone::Clear, radius::SM).filled(p.page),
            window,
            cx,
        );
        self.glass = Some(glass::use_state(
            self.id.clone(),
            Kind::Rest,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            focused,
            theme,
            window,
            cx,
        ));
        el.key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::cancel))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .h(px(height))
            .w_full()
            .map(|el| {
                // A number field: 8px before the digits, 4px after its steps.
                if self.trailing.is_some() {
                    el.pl(px(8.0)).pr(px(4.0)).gap(px(4.0))
                } else {
                    el.px(px(10.0)).gap(px(8.0))
                }
            })
            .flex()
            .flex_row()
            .items_center()
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .font_role(if self.mono { Role::Index } else { Role::Ui })
            .type_px(s.body, s.line_body)
            .text_color(if self.disabled { p.ink(4) } else { p.ink(1) }.solid())
            .when_some(self.icon, |el, icon| {
                el.child(sand::icon(icon, 14.0, p.ink(3).solid()))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(s.line_body))
                    .overflow_hidden()
                    .child(LineElement {
                        field: cx.entity(),
                        focused,
                    }),
            )
            .when_some(self.meta.clone(), |el, meta| {
                el.child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(3).solid())
                        .child(meta),
                )
            })
            .when_some(self.trailing.clone(), |el, build| {
                el.child(build(window, cx))
            })
    }
}

/// Shapes and paints the line, its selection, composition underline and
/// caret, and registers the field as the window's input handler.
struct LineElement {
    field: Entity<TextField>,
    focused: bool,
}

struct LinePrepaint {
    line: ShapedLine,
    selection: Option<PaintQuad>,
    caret: Option<PaintQuad>,
}

impl IntoElement for LineElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for LineElement {
    type RequestLayoutState = ();
    type PrepaintState = LinePrepaint;

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
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> LinePrepaint {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let field = self.field.read(cx);
        let composer = &field.composer;
        let style = window.text_style();
        let (text, color): (SharedString, _) = if composer.text().is_empty() {
            (field.placeholder.clone(), p.ink(4).solid())
        } else {
            (composer.text().to_string().into(), style.color)
        };
        let run = TextRun {
            len: text.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match composer.marked() {
            Some(m) if !composer.text().is_empty() => [
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
            _ => vec![run],
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(text, font_size, &runs, None);
        // Keep the caret in view.
        let cursor = composer.cursor();
        let cursor_x = f32::from(line.x_for_index(cursor));
        let width = f32::from(bounds.size.width);
        let mut scroll = field.scroll_x;
        if cursor_x - scroll > width - 2.0 {
            scroll = cursor_x - width + 2.0;
        }
        if cursor_x - scroll < 0.0 {
            scroll = cursor_x;
        }
        scroll = scroll.max(0.0);
        let shift = px(scroll);
        let selection = composer.selection();
        let (selection_quad, caret) = if selection.is_empty() {
            let caret = (self.focused && field.caret_on && !field.disabled).then(|| {
                fill(
                    Bounds::new(
                        point(bounds.left() + px(cursor_x) - shift, bounds.top()),
                        size(px(1.5), bounds.bottom() - bounds.top()),
                    ),
                    p.accent.solid(),
                )
            });
            (None, caret)
        } else {
            (
                Some(fill(
                    Bounds::from_corners(
                        point(
                            bounds.left() + line.x_for_index(selection.start) - shift,
                            bounds.top(),
                        ),
                        point(
                            bounds.left() + line.x_for_index(selection.end) - shift,
                            bounds.bottom(),
                        ),
                    ),
                    p.accent.alpha(if self.focused { 0.22 } else { 0.12 }),
                )),
                None,
            )
        };
        if (scroll - field.scroll_x).abs() > 0.01 {
            self.field.update(cx, |f, _| f.scroll_x = scroll);
        }
        LinePrepaint {
            line,
            selection: selection_quad,
            caret,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut LinePrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.field.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.field.clone()),
            cx,
        );
        if let Some(selection) = prepaint.selection.take() {
            window.paint_quad(selection);
        }
        let scroll = self.field.read(cx).scroll_x;
        let origin = point(bounds.origin.x - px(scroll), bounds.origin.y);
        let _ = prepaint.line.paint(
            origin,
            window.line_height(),
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        );
        if focus.is_focused(window)
            && let Some(caret) = prepaint.caret.take()
        {
            window.paint_quad(caret);
        }
        let line = prepaint.line.clone();
        self.field.update(cx, |f, _| {
            f.last_layout = Some(line);
            f.last_bounds = Some(bounds);
        });
    }
}
