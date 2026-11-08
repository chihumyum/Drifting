//! The category page (the 0.1 client's `CategoryEditorView`): above its
//! text the folio, the name beside the category's big folded-corner mark,
//! how many elements and its colour, then the head of 「札记」 (the text is
//! the editor's); under the text 「要素清单」, the category's elements with
//! a filter (all, filled in, empty).
//!
//! - **Name**: as an element's (Enter leaves, Esc puts it back, leaving
//!   saves; empty or unchanged writes nothing). A name another category
//!   has gets a 「 2」 (F3); the 0.1 client allowed two alike.
//! - **Colour**: the swatch shows it. The 0.1 client opened the system's
//!   colour picker from it; GPUI has none yet (m11-elements.md, 「待协调」).
//! - **要素清单** shows only when the category has elements. 「已填写」 is an
//!   element with a summary or any text (the 0.1 rule; the text's words come
//!   from the derived index). A row: the element's mark (hollow without
//!   text), 「E.」 and four characters of its id (the last four: see `row`), the name and two
//!   lines of the summary (「尚未填写概述」 without), a mark for the summary,
//!   an arrow under the pointer. A click previews the element, a double
//!   click keeps it.

use std::collections::HashMap;
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    components::{
        ColorSwatch, Segmented,
        cell::{RING_RIM, ring_tone},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec},
    input::{area::TextArea, field::FieldEvent},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Rgb, radius},
};
use dr_workspace::{Workspace as Library, dto::ElementInfo};
use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, ElementId, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, WeakEntity, Window, div, px,
};

use crate::data;
use crate::element::field_id;
use crate::page;
use crate::swatch;

/// The category page's head.
pub struct CategoryHead {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    pub id: String,
    book: Rc<Book>,
    name: Entity<TextArea>,
    shown_name: Option<String>,
    /// The colour being picked (dr-ui's swatch).
    picked: swatch::Picked,
    _subs: Vec<Subscription>,
}

impl CategoryHead {
    pub fn new(
        id: String,
        ws: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> CategoryHead {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let untitled = t(cx, keys::category_editor::UNTITLED);
        let name = cx.new(|cx| {
            TextArea::new(field_id("category-name", &id), window, cx)
                .submit_on_enter()
                .placeholder(untitled)
        });
        let sub = cx.subscribe_in(&name, window, |head, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => head.leave(window, cx),
            FieldEvent::Cancelled => {
                let stored = head.stored_name();
                field.update(cx, |f, cx| f.set_text(stored, cx));
                head.leave(window, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                head.save_name(text, cx);
            }
            FieldEvent::Changed(_) => {}
        });
        cx.spawn(async move |this, cx| this.update(cx, |head, cx| head.follow(cx)).ok())
            .detach();
        CategoryHead {
            ws,
            lib,
            id,
            book: Rc::default(),
            name,
            shown_name: None,
            picked: swatch::Picked::default(),
            _subs: vec![sub],
        }
    }

    /// A colour from the picker: shown at once, written once the picker has
    /// been still for [`swatch::SETTLE`].
    pub fn pick_color(&mut self, color: Rgb, cx: &mut Context<Self>) {
        let timer = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(swatch::SETTLE).await;
            this.update(cx, |head, cx| head.save_color(cx)).ok();
        });
        self.picked.pick(color, timer);
        cx.notify();
    }

    fn save_color(&mut self, cx: &mut Context<Self>) {
        let stored = data::category(&self.book, &self.id).map(|c| c.color.clone());
        let Some(color) = self.picked.settled(stored.as_deref()) else {
            return;
        };
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let mut edit = data::category_edit(&self.book.id, &self.id);
        edit.color = Some(color);
        cx.spawn(async move |this, cx| {
            let out = cx
                .background_executor()
                .spawn(async move { data::update_category(&lib, edit) })
                .await;
            if let Err(error) = out {
                log::warn!("the category's colour could not be saved: {error}");
                this.update(cx, |head, cx| {
                    head.picked.forget();
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        self._subs.push(cx.observe(&ws, |head, ws, cx| {
            let book = ws.read(cx).book.clone();
            if !Rc::ptr_eq(&book, &head.book) {
                head.book = book;
                cx.notify();
            }
        }));
        cx.notify();
    }

    /// The name field (tests).
    pub fn name_field(&self) -> Entity<TextArea> {
        self.name.clone()
    }

    fn stored_name(&self) -> String {
        data::category(&self.book, &self.id)
            .map(|c| c.name.clone())
            .unwrap_or_default()
    }

    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.ws.upgrade() {
            ws.read(cx).focus_handle().clone().focus(window, cx);
        }
    }

    fn save_name(&mut self, text: String, cx: &mut Context<Self>) {
        let name = text.trim().to_owned();
        if name.is_empty() || name == self.stored_name() {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let mut edit = data::category_edit(&self.book.id, &self.id);
        edit.name = Some(name);
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = data::update_category(&lib, edit) {
                    log::warn!("the category could not be renamed: {error}");
                }
            })
            .detach();
    }
}

impl Render for CategoryHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(category) = data::category(&self.book, &self.id).cloned() else {
            return div().into_any_element();
        };
        if self.shown_name.as_ref() != Some(&category.name)
            && !self.name.focus_handle(cx).is_focused(window)
        {
            self.shown_name = Some(category.name.clone());
            let name = category.name.clone();
            self.name.update(cx, |f, cx| f.set_text(name, cx));
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let look = page::look(cx);
        let color = self
            .picked
            .shown(Some(&category.color), color_of(&category.color));
        let count = category.elements as usize;
        let folio = page::folio(
            vec![
                div()
                    .child(t(cx, keys::category_editor::FOLIO))
                    .into_any_element(),
                page::folio_mark(
                    "category-folio-mark",
                    sand::Kind::Category,
                    color,
                    category.name.clone().into(),
                    window,
                    cx,
                ),
                div()
                    .child(tf(
                        cx,
                        keys::category_editor::meta::ELEMENTS,
                        &[("count", &count)],
                    ))
                    .into_any_element(),
            ],
            window,
            cx,
        );
        let mark = KindMark::new("category-hero-mark", sand::Kind::Category).scale(30.0 / 14.0);
        let name_row = div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(14.0))
            .child(div().mt(px(10.0)).child(match color {
                Some(c) => mark.color(c),
                None => mark,
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_role(Role::Prose)
                    .type_px(38.0, 38.0 * 1.3)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(self.name.clone()),
            );
        let fact_key = |text: SharedString| {
            div()
                .font_role(Role::Index)
                .type_px(9.5, 18.0)
                .text_color(p.ink(4).solid())
                .child(text)
        };
        let entity = cx.entity();
        let swatch = div()
            .self_start()
            .debug_selector(|| "category-color".into())
            .child(
                ColorSwatch::new("category-color", color.unwrap_or(p.accent))
                    .label(t(cx, keys::common::CUSTOM_COLOR))
                    .on_pick(move |color, _, cx| {
                        entity.update(cx, |head, cx| head.pick_color(color, cx))
                    }),
            );
        let facts = div()
            .mt(px(14.0))
            .flex()
            .flex_row()
            .gap(px(14.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(fact_key(t(
                        cx,
                        keys::category_editor::labels::ELEMENT_COUNT,
                    )))
                    .child(
                        div()
                            .h(px(dr_ui::components::color::SWATCH))
                            .flex()
                            .items_center()
                            .child(fact_key(t(cx, keys::storyline_editor::labels::COLOR))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .h(px(18.0))
                            .font_role(Role::Prose)
                            .italic()
                            .type_px(13.0, 18.0)
                            .text_color(p.ink(2).solid())
                            .child(tf(
                                cx,
                                keys::category_editor::meta::ITEMS,
                                &[("count", &count)],
                            )),
                    )
                    .child(swatch),
            );
        let overview = div()
            .pb(px(22.0))
            .mb(px(24.0))
            .border_b_1()
            .border_color(p.rule.solid())
            .flex()
            .flex_col()
            .child(name_row)
            .child(facts);
        let content = div()
            .flex()
            .flex_col()
            .child(folio)
            .child(overview)
            .child(page::section(
                t(cx, keys::category_editor::sections::SCRATCH),
                None,
                true,
                window,
                cx,
            ));
        page::column(look, content).pt(px(56.0)).into_any_element()
    }
}

/// The filter over 要素清单.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    All,
    Used,
    Unused,
}

/// 要素清单 under the category's text.
pub struct CategoryEnd {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    pub id: String,
    book: Rc<Book>,
    pub filter: Filter,
    /// Words in each element's text (the derived index), read off the main
    /// thread for the book last drawn.
    words: HashMap<String, u64>,
    words_for: Option<Rc<Book>>,
    task: Option<Task<()>>,
    _ws: Option<Subscription>,
}

impl CategoryEnd {
    pub fn new(id: String, ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> CategoryEnd {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        cx.spawn(async move |this, cx| this.update(cx, |end, cx| end.follow(cx)).ok())
            .detach();
        CategoryEnd {
            ws,
            lib,
            id,
            book: Rc::default(),
            filter: Filter::All,
            words: HashMap::new(),
            words_for: None,
            task: None,
            _ws: None,
        }
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        self._ws = Some(cx.observe(&ws, |end, ws, cx| {
            let book = ws.read(cx).book.clone();
            if !Rc::ptr_eq(&book, &end.book) {
                end.book = book;
                cx.notify();
            }
        }));
        cx.notify();
    }

    /// The elements of the category, and of those whether each is filled in
    /// (a summary or any text).
    pub fn elements(&self) -> Vec<(ElementInfo, bool)> {
        data::elements_of(&self.book, &self.id)
            .into_iter()
            .map(|e| {
                let used =
                    !e.summary.trim().is_empty() || self.words.get(&e.id).copied().unwrap_or(0) > 0;
                (e.clone(), used)
            })
            .collect()
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    /// Whether the words have been read for the book drawn.
    pub fn words_read(&self) -> bool {
        self.words_for
            .as_ref()
            .is_some_and(|b| Rc::ptr_eq(b, &self.book))
    }

    fn read_words(&mut self, cx: &mut Context<Self>) {
        if self.task.is_some() || self.words_read() || self.book.is_empty() {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.clone();
        let ids: Vec<String> = data::elements_of(&book, &self.id)
            .into_iter()
            .map(|e| e.id.clone())
            .collect();
        self.task = Some(cx.spawn(async move |this, cx| {
            let words = cx
                .background_executor()
                .spawn(async move {
                    let store = lib.library();
                    ids.into_iter()
                        .map(|id| {
                            let words = store
                                .doc_stats(&format!("element:{id}"))
                                .ok()
                                .flatten()
                                .map_or(0, |s| s.words);
                            (id, words)
                        })
                        .collect::<HashMap<_, _>>()
                })
                .await;
            this.update(cx, |end, cx| {
                end.task = None;
                end.words = words;
                end.words_for = Some(book);
                cx.notify();
            })
            .ok();
        }));
    }

    fn open(&self, id: &str, how: Open, cx: &mut gpui::App) {
        let Some(target) = id.parse().ok().map(Target::Element) else {
            return;
        };
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }
}

impl Render for CategoryEnd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.read_words(cx);
        let look = page::look(cx);
        let Some(category) = data::category(&self.book, &self.id).cloned() else {
            return div().into_any_element();
        };
        let elements = self.elements();
        if elements.is_empty() {
            // The 0.1 page shows the list only when there is something in it.
            return div().pb(px(80.0)).into_any_element();
        }
        let color = color_of(&category.color);
        let used = elements.iter().filter(|(_, u)| *u).count();
        let total = elements.len();
        let head = page::section(
            t(cx, keys::category_editor::sections::ELEMENTS),
            Some(page::meta(
                tf(cx, keys::category_editor::meta::ITEMS, &[("count", &total)]),
                window,
                cx,
            )),
            false,
            window,
            cx,
        );
        let entity = cx.entity();
        let filters = Segmented::new(
            "category-filter",
            [
                format!("{} {total}", t(cx, keys::storyline_editor::filters::ALL)),
                format!("{} {used}", t(cx, keys::category_editor::filters::USED)),
                format!(
                    "{} {}",
                    t(cx, keys::category_editor::filters::UNUSED),
                    total - used
                ),
            ],
            match self.filter {
                Filter::All => 0,
                Filter::Used => 1,
                Filter::Unused => 2,
            },
        )
        .on_change({
            let entity = entity.clone();
            move |i, _, cx| {
                let filter = match i {
                    1 => Filter::Used,
                    2 => Filter::Unused,
                    _ => Filter::All,
                };
                entity.update(cx, |end, cx| end.set_filter(filter, cx));
            }
        });
        let shown: Vec<&(ElementInfo, bool)> = elements
            .iter()
            .filter(|(_, u)| match self.filter {
                Filter::All => true,
                Filter::Used => *u,
                Filter::Unused => !*u,
            })
            .collect();
        let mut list = div().flex().flex_col().gap(px(2.0));
        if shown.is_empty() {
            list = list.child(page::empty_line(
                t(cx, keys::category_editor::empty::NO_FILTERED_ELEMENTS),
                look,
                window,
                cx,
            ));
        }
        for (element, _) in shown {
            let has_text = self.words.get(&element.id).copied().unwrap_or(0) > 0;
            list = list.child(row(&entity, element, has_text, color, window, cx));
        }
        page::column(
            look,
            div()
                .flex()
                .flex_col()
                .child(head)
                .child(div().pb(px(4.0)).child(filters))
                .child(list),
        )
        .pb(px(80.0))
        .into_any_element()
    }
}

/// One element in 要素清单 (`.mgr-row`).
fn row(
    entity: &Entity<CategoryEnd>,
    element: &ElementInfo,
    has_text: bool,
    color: Option<Rgb>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let id: SharedString = format!("category-row-{}", element.id).into();
    let name: SharedString = if element.name.trim().is_empty() {
        t(cx, keys::element_editor::UNTITLED)
    } else {
        element.name.clone().into()
    };
    // The 0.1 row took the id's first four characters; ids are UUID v7 now,
    // whose first characters are the time and alike across a book, so the
    // last four (random) tell the rows apart.
    let tail: String = element
        .id
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let number = format!("E.{}", tail.to_uppercase());
    let summary = element.summary.trim().to_owned();
    let open = {
        let entity = entity.clone();
        let id = element.id.clone();
        move |e: &ClickEvent, _: &mut Window, cx: &mut gpui::App| {
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            let id = id.clone();
            entity.update(cx, |end, cx| end.open(&id, how, cx));
        }
    };
    let mark = KindMark::new(
        ElementId::Name(format!("{id}-mark").into()),
        sand::Kind::Element,
    )
    .hollow(!has_text);
    glass::glass_box(
        ElementId::Name(id.clone()),
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(ring_tone(color, p.glass_clear), radius::SM).rim(RING_RIM),
        window,
        cx,
    )
    .group(id.clone())
    .pl(px(10.0))
    .pr(px(8.0))
    .py(px(10.0))
    .flex()
    .flex_row()
    .items_start()
    .gap(px(10.0))
    .cursor_pointer()
    .role(gpui::Role::Button)
    .aria_label(name.clone())
    .on_click(open)
    .child(
        div()
            .w(px(14.0))
            .flex_none()
            .mt(px(5.0))
            .child(match color {
                Some(c) => mark.color(c),
                None => mark,
            }),
    )
    .child(
        div()
            .w(px(44.0))
            .flex_none()
            .pt(px(7.0))
            .font_role(Role::Index)
            .type_px(10.5, 14.0)
            .text_color(p.ink(4).solid())
            .child(number),
    )
    .child(
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(17.0, 17.0 * 1.2)
                    .text_color(p.ink(1).solid())
                    .child(name),
            )
            .child(if summary.is_empty() {
                div()
                    .font_role(Role::Index)
                    .type_px(10.0, 14.0)
                    .text_color(p.ink(5).solid())
                    .child(t(cx, keys::category_editor::empty::NO_SUMMARY))
            } else {
                div()
                    .max_w(px(560.0))
                    .font_role(Role::Prose)
                    .italic()
                    .type_px(13.5, 13.5 * 1.55)
                    .text_color(p.ink(3).solid())
                    .line_clamp(2)
                    .child(dr_ui::text::wrapped(summary.clone()))
            }),
    )
    .child(
        div()
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(19.0, 22.0)
                    .text_color(p.ink(3).solid())
                    .child(if summary.is_empty() { "—" } else { "·" }),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(9.0, 12.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::category_editor::labels::SUMMARY)),
            ),
    )
    .child(
        div()
            .id(ElementId::Name(format!("{id}-open").into()))
            .size(px(16.0))
            .flex_none()
            .invisible()
            .group_hover(id.clone(), |st| st.visible())
            .aria_label(t(cx, keys::category_editor::actions::OPEN_ELEMENT))
            .child(sand::icon(Icon::ArrowOut, 12.0, p.ink(3).solid())),
    )
    .into_any_element()
}
