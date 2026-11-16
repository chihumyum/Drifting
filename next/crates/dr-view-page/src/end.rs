//! A page's end: the empty page's hint and the room under the text.
//!
//! Nothing else is drawn here. The mark that used to close a chapter (the
//! brush's three stones) and the actions it unfolded are gone
//! (`docs/rust-rewrite/kernel-v5.md` §15, item 34): the writing status is a
//! field of the entry, set in its fields module.

use dr_editor::page::{EMPTY_HINTS, PageInfo};
use dr_i18n::keys;
use dr_shell::{Settings, keymap, t};
use dr_ui::{Theme, fonts::Role, style::DrStyled, tokens::page as tk};
use gpui::{
    App, Context, Div, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

pub struct PageEnd {
    page: PageInfo,
}

impl PageEnd {
    pub fn new(page: &PageInfo) -> Self {
        PageEnd { page: page.clone() }
    }

    pub fn set_page(&mut self, page: &PageInfo) {
        self.page = page.clone();
    }

    /// The facts it shows.
    pub fn page(&self) -> &PageInfo {
        &self.page
    }

    /// Whether it draws the empty page's hint.
    pub fn shows_hint(&self) -> bool {
        self.page.empty
    }
}

/// The keys bound now to the shortcut registered as `id`, as they read.
fn shortcut(id: &str, cx: &App) -> SharedString {
    let Some(shortcut) = keymap::find(id) else {
        return SharedString::default();
    };
    let overrides = Settings::read(cx).key_bindings();
    shortcut
        .effective(&overrides)
        .first()
        .map(|keys| keymap::display(keys, cx.platform_info().os).into())
        .unwrap_or_default()
}

/// An empty page's hint, faint under where the first line goes: the
/// Markdown for the three heading levels, then search and the timeline.
fn hints(window: &Window, cx: &App) -> Div {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let rows: Vec<(SharedString, SharedString)> = EMPTY_HINTS
        .iter()
        .enumerate()
        .map(|(i, (_, md))| {
            let label = t(
                cx,
                [keys::k4_pages::H1, keys::k4_pages::H2, keys::k4_pages::H3][i],
            );
            (label, SharedString::from(*md))
        })
        .chain([
            (
                t(cx, keys::guide::hints::SEARCH),
                shortcut("globalSearch", cx),
            ),
            (
                t(cx, keys::guide::hints::TIMELINE),
                shortcut("toggleBottomTimeline", cx),
            ),
        ])
        .collect();
    let column = || div().flex().flex_col().gap(px(tk::HINTS_ROW_GAP));
    div()
        .pt(px(tk::HINTS_TOP))
        .flex()
        .flex_row()
        .gap(px(tk::HINTS_COLUMN_GAP))
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.muted().solid())
        .child(column().children(rows.iter().map(|(label, _)| div().child(label.clone()))))
        .child(
            column()
                .items_end()
                .font_role(Role::Index)
                .children(rows.into_iter().map(|(_, keys)| div().child(keys))),
        )
}

impl Render for PageEnd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selector = format!("page-end-{}", self.page.doc);
        div()
            .debug_selector(move || selector)
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .pb(px(tk::BOTTOM))
            .when(self.page.empty, |el| el.child(hints(window, cx)))
    }
}
