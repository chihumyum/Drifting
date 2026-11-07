//! The find bar over the page (⌘F / Ctrl+F; the 0.1 client's `findPanel`):
//! a glass bar at the paper's top right with the query, where the current
//! match stands (「3 / 12」), and previous, next and close.
//!
//! Finding itself is F4c's ([`gpui_prose::ProseEditor::set_find`] and the
//! steps): typing sets the query and selects the first match at or after
//! the caret; Enter and ⌘G go to the next, ⇧Enter and ⇧⌘G to the previous
//! (F3 and ⇧F3 on Windows); Esc closes the bar, drops the query and gives
//! the page the keyboard back. In a chapter it looks in that chapter; in
//! the whole book (M05) in every chapter. The current match is the
//! selection, so the editor scrolls to it; drawing every match is F4d's
//! highlight layer. ⌘E in the editor ("use the selection for find") fills
//! the bar.

use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::IconButton,
    fonts::Role,
    glass::{self, Kind, Mode, Spec, Tone},
    input::field::{FieldEvent, TextField},
    sand::Icon,
    style::DrStyled,
    tokens::glass as g,
};
use gpui::{
    AppContext as _, Context, Entity, EventEmitter, Focusable as _, InteractiveElement,
    IntoElement, KeyBinding, ParentElement, Render, Styled, Subscription, Window, div, px,
};
use gpui_prose::ProseEditor;
use gpui_prose::input::find::{FindEvent, FindOptions, FindScope, FindStatus};

use crate::strings::t;

/// The bar's key context.
pub const KEY_CONTEXT: &str = "DrFind";

gpui::actions!(
    find,
    [
        /// The next match.
        Next,
        /// The previous match.
        Previous,
    ]
);

/// The bar's own keys (bound through `keymap::add_bindings`): ⇧Enter for
/// the previous match, ⌘G / ⇧⌘G (F3 / ⇧F3 on Windows) while its field has
/// the keyboard.
pub fn key_bindings() -> Vec<KeyBinding> {
    let c = Some(KEY_CONTEXT);
    let mut keys = vec![KeyBinding::new("shift-enter", Previous, c)];
    if cfg!(target_os = "macos") {
        keys.push(KeyBinding::new("cmd-g", Next, c));
        keys.push(KeyBinding::new("cmd-shift-g", Previous, c));
    } else {
        keys.push(KeyBinding::new("f3", Next, c));
        keys.push(KeyBinding::new("shift-f3", Previous, c));
    }
    keys
}

/// What the bar tells the workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindBarEvent {
    /// Esc or the close button: the bar goes, the page gets the keyboard.
    Close,
}

pub struct FindBar {
    /// The editor it searches.
    pub prose: Entity<ProseEditor>,
    field: Entity<TextField>,
    scope: FindScope,
    status: FindStatus,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<FindBarEvent> for FindBar {}

impl FindBar {
    /// A bar searching `prose`; `book`: the whole book's editor (every
    /// chapter), else the chapter the caret is in.
    pub fn new(
        prose: Entity<ProseEditor>,
        book: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> FindBar {
        let placeholder = t(
            cx,
            if book {
                keys::find_panel::BOOK_PLACEHOLDER
            } else {
                keys::find_panel::CURRENT_PLACEHOLDER
            },
        );
        // An earlier query of this editor comes back into the field.
        let query = prose
            .read(cx)
            .find_query()
            .map(|(q, _)| q.to_owned())
            .unwrap_or_default();
        let field = cx.new(|cx| {
            TextField::new("find-field", window, cx)
                .placeholder(placeholder)
                .icon(Icon::Search)
                .small()
                .with_text(query)
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &field,
                window,
                |bar, _, event: &FieldEvent, window, cx| match event {
                    FieldEvent::Changed(text) => bar.search(text, window, cx),
                    FieldEvent::Submitted(_) => bar.step(true, window, cx),
                    FieldEvent::Cancelled => cx.emit(FindBarEvent::Close),
                    FieldEvent::Blurred => {}
                },
            ),
            cx.subscribe_in(&prose, window, |bar, _, event: &FindEvent, _, cx| {
                if let FindEvent::QueryChanged(query) = event {
                    let query = query.clone();
                    bar.field.update(cx, |f, cx| f.set_text(query, cx));
                    bar.refresh(cx);
                }
            }),
            cx.observe(&prose, |bar, _, cx| bar.refresh(cx)),
        ];
        let mut bar = FindBar {
            prose,
            field,
            scope: if book {
                FindScope::Book
            } else {
                FindScope::Chapter
            },
            status: FindStatus::default(),
            _subscriptions: subscriptions,
        };
        bar.refresh(cx);
        bar
    }

    /// The field takes the keyboard.
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.field.focus_handle(cx).focus(window, cx);
    }

    pub fn status(&self) -> FindStatus {
        self.status
    }

    fn options(&self) -> FindOptions {
        FindOptions {
            scope: self.scope,
            ..FindOptions::default()
        }
    }

    /// The query changed: the first match at or after the caret.
    pub fn search(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        let options = self.options();
        self.prose.update(cx, |p, cx| {
            if query.is_empty() {
                p.clear_find(cx);
            } else {
                p.set_find(query, options, window, cx);
            }
        });
        self.refresh(cx);
    }

    /// The next (`forward`) or previous match.
    pub fn step(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.prose.update(cx, |p, cx| {
            if forward {
                p.find_next(window, cx);
            } else {
                p.find_previous(window, cx);
            }
        });
        self.refresh(cx);
    }

    /// Drops the query (the bar is closing).
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.prose.update(cx, |p, cx| p.clear_find(cx));
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let status = self.prose.read(cx).find_status();
        if status != self.status {
            self.status = status;
            cx.notify();
        }
    }
}

impl Render for FindBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let status = match (self.status.current, self.status.total) {
            (_, 0) if self.prose.read(cx).find_query().is_none() => String::new(),
            (Some(i), n) => format!("{} / {n}", i + 1),
            (None, n) => format!("{n}"),
        };
        let entity = cx.entity();
        let (prev, next, close) = (entity.clone(), entity.clone(), entity);
        glass::glass_box(
            "find-bar",
            Kind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0)
                .origin(glass::SAMPLE_ORIGINS[0])
                .rim(12.0)
                .filled(p.page),
            window,
            cx,
        )
        .key_context(KEY_CONTEXT)
        .on_action(cx.listener(|bar, _: &Previous, window, cx| bar.step(false, window, cx)))
        .on_action(cx.listener(|bar, _: &Next, window, cx| bar.step(true, window, cx)))
        .occlude()
        .w(px(340.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .p(px(g::TRAY_PADDING))
        .rounded_full()
        .bg(p.page.solid())
        .child(div().flex_1().min_w_0().child(self.field.clone()))
        .child(
            div()
                .px(px(6.0))
                .min_w(px(44.0))
                .flex()
                .justify_end()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(status),
        )
        .child(
            IconButton::new("find-previous", Icon::ChevronUp)
                .in_tray()
                .label(t(cx, keys::find_panel::PREVIOUS_TITLE))
                .on_click(move |_, window, cx| {
                    prev.update(cx, |bar, cx| bar.step(false, window, cx))
                }),
        )
        .child(
            IconButton::new("find-next", Icon::ChevronDown)
                .in_tray()
                .label(t(cx, keys::find_panel::NEXT_TITLE))
                .on_click(move |_, window, cx| {
                    next.update(cx, |bar, cx| bar.step(true, window, cx))
                }),
        )
        .child(
            IconButton::new("find-close", Icon::Close)
                .in_tray()
                .label(t(cx, keys::find_panel::CLOSE_TITLE))
                .on_click(move |_, _, cx| close.update(cx, |_, cx| cx.emit(FindBarEvent::Close))),
        )
    }
}

impl super::Workspace {
    /// ⌘F: the find bar over the focused page (its field takes the
    /// keyboard; open already, it takes it again).
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(bar) = self.find.clone() {
            bar.update(cx, |bar, cx| bar.focus(window, cx));
            return;
        }
        let Some(target) = self.nav.active_tab().map(|t| t.focused().target.clone()) else {
            return;
        };
        let Some(view) = self.page_view(&target).cloned() else {
            return;
        };
        let book = matches!(view, super::editors::PageView::Book(_));
        let prose = view.prose(cx);
        let bar = cx.new(|cx| FindBar::new(prose, book, window, cx));
        cx.subscribe_in(
            &bar,
            window,
            |ws, _, event: &FindBarEvent, window, cx| match event {
                FindBarEvent::Close => ws.close_find(window, cx),
            },
        )
        .detach();
        bar.update(cx, |bar, cx| bar.focus(window, cx));
        self.find = Some(bar);
        cx.notify();
    }

    /// Closes the find bar: its query goes, the page gets the keyboard.
    pub fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = self.find.take() else {
            return;
        };
        let prose = bar.read(cx).prose.clone();
        bar.update(cx, |bar, cx| bar.clear(cx));
        window.focus(&prose.focus_handle(cx), cx);
        cx.notify();
    }

    /// The bar searches the page that was in front when it opened; another
    /// page in front closes it.
    pub(super) fn keep_find_on_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = &self.find else {
            return;
        };
        let searched = bar.read(cx).prose.entity_id();
        let front = self
            .nav
            .active_tab()
            .map(|t| t.focused().target.clone())
            .and_then(|t| self.page_view(&t).map(|v| v.prose(cx).entity_id()));
        if front != Some(searched) {
            self.close_find(window, cx);
        }
    }
}
