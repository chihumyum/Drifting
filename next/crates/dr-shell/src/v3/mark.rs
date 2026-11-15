//! The mark picker (`kernel-v5.md` §8 「条目自己的记号」): a card with the
//! seven sand marks, a small field for one character (emoji too) and, for an
//! entry, a row that hands its mark back to its template. Entries have no
//! colour of their own: a sand mark is drawn in the template's colour, so
//! the card offers no colours (作者 2026-11-15, 弱化颜色).
use crate::{
    book::v3::{SAND_MARKS, is_glyph_mark, mark},
    strings::t,
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::menu::{Menu, MenuItem, section_label, separator},
    input::{FieldEvent, TextField},
    sand::{Icon, KindMark, SandFrame},
};
use gpui::{prelude::*, *};
use std::rc::Rc;

/// What the author picked: a mark, or `None` (the template's mark again).
pub type OnPick = Rc<dyn Fn(Option<String>, &mut Window, &mut App)>;
/// The pointer went down outside the card.
pub type OnDismiss = Rc<dyn Fn(&mut Window, &mut App)>;

pub struct MarkPicker {
    /// Whose mark it is (an entry's or a template's id): it fixes a
    /// chapter seal's shape.
    owner: String,
    current: Option<String>,
    /// An entry's picker offers its template's mark back.
    template_row: bool,
    glyph: Entity<TextField>,
    on_pick: OnPick,
    on_dismiss: OnDismiss,
    _glyph: Subscription,
}

impl MarkPicker {
    /// `current` is the mark set now (`None`: none of its own). The picker
    /// calls `on_pick` once a mark is chosen and `on_dismiss` when the
    /// pointer goes down outside it.
    pub fn new(
        owner: impl Into<String>,
        current: Option<String>,
        template_row: bool,
        on_pick: impl Fn(Option<String>, &mut Window, &mut App) + 'static,
        on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> MarkPicker {
        let typed = current.clone().filter(|m| is_glyph_mark(m));
        let glyph = cx.new(|cx| {
            TextField::new("v3-mark-glyph", window, cx)
                .small()
                .with_text(typed.unwrap_or_default())
        });
        let sub = cx.subscribe_in(&glyph, window, |this, field, event, window, cx| {
            if let FieldEvent::Submitted(_) | FieldEvent::Blurred = event {
                let text = field.read(cx).text().trim().to_owned();
                if is_glyph_mark(&text) && this.current.as_deref() != Some(text.as_str()) {
                    this.pick(Some(text), window, cx);
                }
            }
        });
        MarkPicker {
            owner: owner.into(),
            current,
            template_row,
            glyph,
            on_pick: Rc::new(on_pick),
            on_dismiss: Rc::new(on_dismiss),
            _glyph: sub,
        }
    }

    /// The field that takes one character (for tests and the bridge).
    pub fn glyph_field(&self) -> &Entity<TextField> {
        &self.glyph
    }

    pub fn pick(&mut self, mark: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.current = mark.clone();
        (self.on_pick)(mark, window, cx);
        cx.notify();
    }
}

/// A sand mark's name, as the picker reads it out.
fn sand_label(name: &str) -> dr_i18n::Key {
    use keys::template_editor as k;
    match name {
        "book" => k::MARK_BOOK,
        "file-text" => k::MARK_SEAL,
        "lightbulb" => k::MARK_SPIRAL,
        "folder" => k::MARK_CORNER,
        "compass" => k::MARK_DASH,
        "git-branch" => k::MARK_WAVE,
        _ => k::MARK_SQUARE,
    }
}

impl Render for MarkPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let mut grid = div().flex().flex_row().flex_wrap().gap_1().px_3().py_1();
        for name in SAND_MARKS {
            let selected = self.current.as_deref() == Some(name);
            let kind = mark(Some(name), &self.owner);
            grid = grid.child(
                div()
                    .id(SharedString::from(format!("v3-mark-sand-{name}")))
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, sand_label(name)))
                    .aria_selected(selected)
                    .relative()
                    .size(px(28.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(SandFrame::new(
                        SharedString::from(format!("v3-mark-sand-frame-{name}")),
                        selected,
                    ))
                    .child(KindMark::new(
                        SharedString::from(format!("v3-mark-sand-mark-{name}")),
                        kind,
                    ))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.pick(Some(name.to_owned()), window, cx)
                    })),
            );
        }
        let mut menu = Menu::new("v3-mark-picker")
            .child(section_label(t(cx, keys::v3_shell::MARK_SAND), &theme))
            .child(grid)
            .child(separator(p))
            .child(section_label(t(cx, keys::v3_shell::MARK_GLYPH), &theme))
            .child(div().px_3().py_1().w(px(96.0)).child(self.glyph.clone()));
        if self.template_row {
            menu = menu.child(separator(p)).item(
                MenuItem::new(
                    "v3-mark-template",
                    Icon::Rotate,
                    t(cx, keys::v3_shell::MARK_FROM_TEMPLATE),
                )
                .disabled(self.current.is_none())
                .on_click(cx.listener(|this, _, window, cx| this.pick(None, window, cx))),
            );
        }
        let dismiss = self.on_dismiss.clone();
        div()
            .occlude()
            .on_mouse_down_out(move |_, window, cx| dismiss(window, cx))
            .child(menu)
    }
}
