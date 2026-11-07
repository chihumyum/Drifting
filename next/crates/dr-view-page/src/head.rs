//! A chapter page's head: the act's title page (whole book only), the folio
//! line, the title and synopsis fields, the rule.

use dr_editor::page::{self, PageInfo};
use dr_i18n::keys;
use dr_shell::pages::PageHost;
use dr_shell::strings::{t, tf};
use dr_shell::workspace::editors::{PAGE_GUTTER, editor_settings};
use dr_ui::{
    Theme,
    fonts::Role,
    input::{AreaEvent, FieldEvent, TextArea},
    sand::{self, KindMark, Readout},
    style::DrStyled,
    tokens::page as tk,
};
use gpui::{
    AnyElement, AppContext as _, Context, Div, ElementId, Entity, Focusable as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{NewTitles, focus_body};

/// The text's column on the paper: the page gutter on both sides, then at
/// most the paper's text width, centred (the editor's own title row and
/// paragraphs use the same).
pub(crate) fn column(cx: &gpui::App) -> (Div, Div) {
    let width = editor_settings(cx).page_width;
    (
        div().w_full().px(px(PAGE_GUTTER)).flex().justify_center(),
        div().w_full().max_w(px(width)).flex().flex_col(),
    )
}

pub struct PageHead {
    host: PageHost,
    page: PageInfo,
    title: Entity<TextArea>,
    synopsis: Entity<TextArea>,
    /// What the workspace last said the title and synopsis are.
    stored_title: String,
    stored_synopsis: String,
    _subscriptions: Vec<Subscription>,
}

impl PageHead {
    pub fn new(
        host: PageHost,
        page: &PageInfo,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let id = |what: &str| ElementId::Name(format!("page-{what}-{}", page.doc).into());
        let title = cx.new(|cx| {
            TextArea::new(id("title"), window, cx)
                .submit_on_enter()
                .placeholder(t(cx, keys::chapter_editor::UNTITLED_CHAPTER))
                .with_text(page.title.clone())
        });
        let synopsis = cx.new(|cx| {
            TextArea::new(id("synopsis"), window, cx)
                .placeholder(t(cx, keys::chapter_editor::SYNOPSIS_PLACEHOLDER))
                .with_text(page.synopsis.clone())
        });
        let subscriptions = vec![
            cx.subscribe_in(&title, window, Self::on_title),
            cx.subscribe_in(&title, window, |head, _, _: &AreaEvent, window, cx| {
                head.hand_over(window, cx)
            }),
            cx.subscribe_in(&synopsis, window, Self::on_synopsis),
        ];
        // A chapter ⁂ just made: its title takes the caret, selected, once
        // this frame is drawn.
        if NewTitles::take(&page.doc, cx) {
            let field = title.clone();
            window.defer(cx, move |window, cx| {
                window.focus(&field.focus_handle(cx), cx);
                field.update(cx, |f, cx| f.select_all_text(cx));
            });
        }
        PageHead {
            host,
            page: page.clone(),
            title,
            synopsis,
            stored_title: page.title.clone(),
            stored_synopsis: page.synopsis.clone(),
            _subscriptions: subscriptions,
        }
    }

    /// The title field (tests, and hosts that focus it).
    pub fn title(&self) -> &Entity<TextArea> {
        &self.title
    }

    pub fn synopsis(&self) -> &Entity<TextArea> {
        &self.synopsis
    }

    /// The editor's latest facts: a field shows a new stored value unless
    /// the author is typing in it.
    pub fn set_page(&mut self, page: &PageInfo, window: &mut Window, cx: &mut Context<Self>) {
        if page.title != self.stored_title {
            self.stored_title = page.title.clone();
            if !self.title.focus_handle(cx).is_focused(window) {
                let text = page.title.clone();
                self.title.update(cx, |f, cx| f.set_text(text, cx));
            }
        }
        if page.synopsis != self.stored_synopsis {
            self.stored_synopsis = page.synopsis.clone();
            if !self.synopsis.focus_handle(cx).is_focused(window) {
                let text = page.synopsis.clone();
                self.synopsis.update(cx, |f, cx| f.set_text(text, cx));
            }
        }
        self.page = page.clone();
    }

    fn hand_over(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        focus_body(&self.host, &self.page.doc, window, cx);
    }

    fn on_title(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // Enter: on to the text (leaving the field stores the title).
            FieldEvent::Submitted(_) => self.hand_over(window, cx),
            FieldEvent::Cancelled => {
                let stored = self.stored_title.clone();
                self.title.update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_title(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    fn on_synopsis(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => window.blur(cx),
            FieldEvent::Cancelled => {
                let stored = self.stored_synopsis.clone();
                self.synopsis.update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_synopsis(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    /// `page::rename` off the main thread. An empty title is not stored:
    /// the field shows the stored one again; a taken one comes back with
    /// F3's suffix.
    fn store_title(&mut self, cx: &mut Context<Self>) {
        let text = self.title.read(cx).text();
        let (lib, book, doc) = (
            self.host.library.clone(),
            self.host.book.clone(),
            self.page.doc.clone(),
        );
        let typed = text.clone();
        let task = cx.background_spawn(async move { page::rename(&lib, &book, &doc, &typed) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |head, cx| {
                let untouched = head.title.read(cx).text() == text;
                match result {
                    Ok(Some(stored)) => {
                        head.stored_title = stored.clone();
                        if untouched && stored != text {
                            head.title.update(cx, |f, cx| f.set_text(stored, cx));
                        }
                    }
                    Ok(None) if untouched && text.trim() != head.stored_title => {
                        let stored = head.stored_title.clone();
                        head.title.update(cx, |f, cx| f.set_text(stored, cx));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        log::warn!("{}: the title was not stored: {error}", head.page.doc)
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn store_synopsis(&mut self, cx: &mut Context<Self>) {
        let text = self.synopsis.read(cx).text();
        let (lib, book, doc) = (
            self.host.library.clone(),
            self.host.book.clone(),
            self.page.doc.clone(),
        );
        let task = cx.background_spawn(async move { page::set_synopsis(&lib, &book, &doc, &text) });
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                this.update(cx, |head, _| {
                    log::warn!("{}: the synopsis was not stored: {error}", head.page.doc)
                })
                .ok();
            }
        })
        .detach();
    }
}

/// `n` with its thousands grouped (the 0.1 client's `toLocaleString` for
/// the languages it ships).
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

impl Render for PageHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let body = editor_settings(cx).font_size;
        let page = &self.page;
        // The folio line: 「第 N 章」, the storyline's dash and name, the words.
        let number: SharedString = match page.number {
            Some(n) => tf(cx, keys::node_editor::folio::CHAPTER_NUMBER, &[("n", &n)]),
            None => t(cx, keys::node_editor::folio::CHAPTER),
        };
        let words = tf(
            cx,
            keys::node_editor::meta::WORDS,
            &[("count", &grouped(page.words))],
        );
        let storyline: Option<AnyElement> = page.storyline.as_ref().map(|s| {
            let mark = KindMark::new(
                ElementId::Name(format!("page-folio-mark-{}", page.doc).into()),
                sand::Kind::Storyline,
            );
            let mark = match dr_shell::book::color_of(&s.color) {
                Some(c) => mark.color(c),
                None => mark,
            };
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(tk::FOLIO_MARK_GAP))
                .text_color(p.ink(3).solid())
                .child(mark)
                .child(s.name.clone())
                .into_any_element()
        });
        let dot = || div().mr(px(8.0)).text_color(p.ink(5).solid()).child("·");
        let folio = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(tk::FOLIO_GAP))
            .gap_y(px(tk::FOLIO_ROW_GAP))
            .pb(px(tk::FOLIO_PAD))
            .mb(px(tk::FOLIO_MARGIN))
            .border_b_1()
            .border_dashed()
            .border_color(p.rule.solid())
            .font_role(Role::Index)
            .type_px(tk::FOLIO_SIZE, tk::FOLIO_LINE)
            .text_color(p.ink(4).solid())
            .child(number)
            .when_some(storyline, |el, s| {
                el.child(div().flex().flex_row().items_center().child(dot()).child(s))
            })
            .child(div().flex().flex_row().child(dot()).child(words));
        let synopsis_size = body - tk::SYNOPSIS_LESS;
        let (outer, inner) = column(cx);
        let text = inner
            .pt(px(tk::TOP))
            .child(folio)
            .child(
                div()
                    .mb(px(tk::TITLE_GAP))
                    .font_role(Role::Prose)
                    .type_px(tk::TITLE_SIZE, tk::TITLE_SIZE * tk::TITLE_LINE)
                    .text_color(p.ink(1).solid())
                    .child(self.title.clone()),
            )
            .child(
                div()
                    .mb(px(tk::SYNOPSIS_GAP))
                    .font_role(Role::Prose)
                    .type_px(synopsis_size, synopsis_size * tk::SYNOPSIS_LINE)
                    .text_color(p.ink(3).solid())
                    .child(self.synopsis.clone()),
            )
            .child(div().mb(px(tk::RULE_GAP)).h(px(1.0)).bg(p.rule.solid()));
        // The act this chapter opens (the whole book): its name over one dry
        // stroke, with room above and below.
        let act = page.act_opening.clone().map(|name| {
            div()
                .w_full()
                .pt(px(tk::ACT_TOP))
                .pb(px(tk::ACT_BOTTOM))
                .flex()
                .flex_col()
                .items_center()
                .child(
                    div()
                        .font_role(Role::Prose)
                        .type_px(tk::ACT_NAME_SIZE, tk::ACT_NAME_SIZE * tk::ACT_NAME_LINE)
                        .text_color(p.ink(1).solid())
                        .child(name),
                )
                .child(
                    div().mt(px(tk::ACT_GAP)).w(px(tk::ACT_STROKE)).child(
                        Readout::new(
                            ElementId::Name(format!("page-act-{}", page.doc).into()),
                            1.0,
                        )
                        .bare()
                        .color(p.ink(3)),
                    ),
                )
        });
        div()
            .w_full()
            .flex()
            .flex_col()
            .children(act)
            .child(outer.child(text))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn counts_are_grouped_by_thousands() {
        assert_eq!(super::grouped(0), "0");
        assert_eq!(super::grouped(999), "999");
        assert_eq!(super::grouped(1000), "1,000");
        assert_eq!(super::grouped(1234567), "1,234,567");
    }
}
