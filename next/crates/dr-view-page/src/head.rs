//! A chapter's or an idea's page head: the act's title page (whole book
//! only), the folio line, the title and synopsis fields, the rule.

use dr_editor::page::{self, ActPage, PageInfo, PageKind};
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
    AnyElement, AppContext as _, Context, Div, ElementId, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
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
    /// The current idea group breadcrumb, from the shell's book snapshot.
    group_path: Option<String>,
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
        let untitled = if page.kind == PageKind::Idea {
            keys::chapter_editor::UNTITLED_DRIFT
        } else {
            keys::chapter_editor::UNTITLED_CHAPTER
        };
        let title = cx.new(|cx| {
            TextArea::new(id("title"), window, cx)
                .submit_on_enter()
                .placeholder(t(cx, untitled))
                .with_text(page.title.clone())
        });
        let synopsis = cx.new(|cx| {
            TextArea::new(id("synopsis"), window, cx)
                .placeholder(t(cx, keys::chapter_editor::SYNOPSIS_PLACEHOLDER))
                .with_text(page.synopsis.clone())
        });
        let mut subscriptions = vec![
            cx.subscribe_in(&title, window, Self::on_title),
            cx.subscribe_in(&title, window, |head, _, _: &AreaEvent, window, cx| {
                head.hand_over(window, cx)
            }),
            cx.subscribe_in(&synopsis, window, Self::on_synopsis),
        ];
        if let Some(workspace) = host.workspace.upgrade() {
            subscriptions.push(cx.observe(&workspace, |head, _, cx| {
                if head.refresh_group_path(cx) {
                    cx.notify();
                }
            }));
        }
        let group_path = read_group_path(&host, page, cx);
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
            group_path,
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

    /// The idea's groups, top down, as shown in its folio line.
    pub fn group_path(&self) -> Option<&str> {
        self.group_path.as_deref()
    }

    fn refresh_group_path(&mut self, cx: &gpui::App) -> bool {
        let path = read_group_path(&self.host, &self.page, cx);
        if self.group_path == path {
            return false;
        }
        self.group_path = path;
        true
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
        if self.refresh_group_path(cx) {
            cx.notify();
        }
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

/// Like NodeEditorView's `driftGroupChain`: follow parents, stop at a
/// missing group or a cycle, and show the surviving chain from the top.
fn read_group_path(host: &PageHost, page: &PageInfo, cx: &gpui::App) -> Option<String> {
    if page.kind != PageKind::Idea {
        return None;
    }
    let workspace = host.workspace.upgrade()?;
    let book = &workspace.read(cx).book;
    let id = page.doc.strip_prefix("node:")?;
    let idea = book.ideas.iter().find(|idea| idea.id == id)?;
    let mut current = idea.group.as_deref();
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        let Some(group) = book.idea_groups.iter().find(|group| group.id == id) else {
            break;
        };
        chain.push(group.name.as_str());
        current = group.parent.as_deref();
    }
    if chain.is_empty() {
        None
    } else {
        chain.reverse();
        Some(chain.join(" - "))
    }
}

/// An act's ordinal as the 0.1 client writes it in 「第{n}幕」: Chinese
/// numerals for Chinese (1–99, then digits), Roman numerals otherwise.
pub fn act_numeral(n: usize, chinese: bool) -> String {
    if chinese {
        chinese_numeral(n)
    } else {
        roman(n)
    }
}

fn chinese_numeral(n: usize) -> String {
    const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    match n {
        1..=9 => DIGITS[n].to_owned(),
        10..=99 => {
            let (tens, ones) = (n / 10, n % 10);
            format!(
                "{}十{}",
                if tens == 1 { "" } else { DIGITS[tens] },
                if ones == 0 { "" } else { DIGITS[ones] }
            )
        }
        _ => n.to_string(),
    }
}

fn roman(n: usize) -> String {
    if n == 0 {
        return n.to_string();
    }
    const MAP: [(usize, &str); 13] = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut out = String::new();
    let mut rest = n;
    for (v, s) in MAP {
        while rest >= v {
            out.push_str(s);
            rest -= v;
        }
    }
    out
}

/// Words in thousands with one decimal, rounded half up as the 0.1
/// client's `toFixed(1)`: 「12.3」 for 12 345, 「0.0」 for none.
pub fn thousands(words: u64) -> String {
    let tenths = (words + 50) / 100;
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// An act's title page above the chapter that opens it: 「第一幕」, the
/// name, one dry stroke, 「N 章 · x.xk 字」, with room above and below.
fn act_page(doc: &str, act: &ActPage, window: &Window, cx: &gpui::App) -> Div {
    let p = Theme::of(window, cx).palette;
    let chinese = matches!(
        dr_shell::strings::Strings::get(cx).locale(),
        dr_i18n::Locale::ZhCn | dr_i18n::Locale::ZhTw
    );
    let ordinal = tf(
        cx,
        keys::all_chapters::ACT_ORDINAL,
        &[("n", &act_numeral(act.ordinal, chinese))],
    );
    let chapters = tf(
        cx,
        keys::storyline_editor::meta::CHAPTERS,
        &[("count", &act.chapters)],
    );
    let words = tf(
        cx,
        keys::storyline_editor::meta::K_WORDS,
        &[("count", &thousands(act.words))],
    );
    div()
        .w_full()
        .pt(px(tk::ACT_TOP))
        .pb(px(tk::ACT_BOTTOM))
        .flex()
        .flex_col()
        .items_center()
        .child(
            div()
                .font_role(Role::Structure)
                .type_px(tk::ACT_ORDINAL_SIZE, tk::ACT_ORDINAL_SIZE)
                .text_color(p.ink(4).solid())
                .child(ordinal),
        )
        .child(
            div()
                .mt(px(tk::ACT_ORDINAL_GAP))
                .font_role(Role::Prose)
                .type_px(tk::ACT_NAME_SIZE, tk::ACT_NAME_SIZE * tk::ACT_NAME_LINE)
                .text_color(p.ink(1).solid())
                .child(act.name.clone()),
        )
        .child(
            div().mt(px(tk::ACT_GAP)).w(px(tk::ACT_STROKE)).child(
                Readout::new(ElementId::Name(format!("page-act-{doc}").into()), 1.0)
                    .bare()
                    .color(p.ink(3)),
            ),
        )
        .child(
            div()
                .mt(px(tk::ACT_GAP))
                .flex()
                .flex_row()
                .font_role(Role::Index)
                .type_px(tk::ACT_META_SIZE, tk::ACT_META_LINE)
                .text_color(p.ink(4).solid())
                .child(chapters)
                .child(div().mx(px(8.0)).text_color(p.ink(5).solid()).child("·"))
                .child(words),
        )
}

impl Render for PageHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let body = editor_settings(cx).font_size;
        let page = &self.page;
        // The folio line: 「第 N 章」, the storyline's dash and name, the words.
        let number: SharedString = match (page.kind, page.number) {
            (PageKind::Idea, _) => t(cx, keys::node_editor::folio::DRIFT),
            (_, Some(n)) => tf(cx, keys::node_editor::folio::CHAPTER_NUMBER, &[("n", &n)]),
            (_, None) => t(cx, keys::node_editor::folio::CHAPTER),
        };
        let words = tf(
            cx,
            keys::node_editor::meta::WORDS,
            &[(
                "count",
                &dr_i18n::number::grouped(page.words, dr_shell::strings::Strings::get(cx).locale()),
            )],
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
            .when_some(self.group_path.as_ref(), |el, path| {
                el.child(
                    div().flex().flex_row().items_center().child(dot()).child(
                        div()
                            .id(ElementId::Name(
                                format!("page-folio-group-path-{}", page.doc).into(),
                            ))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(tk::FOLIO_MARK_GAP))
                            .text_color(p.ink(3).solid())
                            .role(gpui::Role::Label)
                            .aria_label(path.clone())
                            .child(KindMark::new(
                                ElementId::Name(format!("page-folio-group-{}", page.doc).into()),
                                sand::Kind::DriftGroup,
                            ))
                            .child(path.clone()),
                    ),
                )
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
        // The act this chapter opens (the whole book).
        let act = page
            .act_page
            .as_ref()
            .map(|act| act_page(&page.doc, act, window, cx));
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
    fn acts_are_numbered_as_the_old_client_did() {
        use super::act_numeral;
        let zh: Vec<String> = [1, 9, 10, 11, 20, 21, 99, 100]
            .iter()
            .map(|&n| act_numeral(n, true))
            .collect();
        assert_eq!(
            zh,
            ["一", "九", "十", "十一", "二十", "二十一", "九十九", "100"]
        );
        let en: Vec<String> = [1, 4, 9, 14, 40, 1999]
            .iter()
            .map(|&n| act_numeral(n, false))
            .collect();
        assert_eq!(en, ["I", "IV", "IX", "XIV", "XL", "MCMXCIX"]);
    }

    #[test]
    fn act_words_are_in_thousands_with_one_decimal() {
        use super::thousands;
        assert_eq!(thousands(0), "0.0");
        assert_eq!(thousands(49), "0.0");
        assert_eq!(thousands(50), "0.1");
        assert_eq!(thousands(1250), "1.3");
        assert_eq!(thousands(12_345), "12.3");
    }
}
