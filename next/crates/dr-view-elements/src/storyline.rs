//! The storyline page (M13, the 0.1 client's `StorylineEditorView`): above
//! its text the folio (故事线 · its dash and name · how many chapters · how
//! many thousand words), the name beside the big dash in the storyline's
//! colour, the summary (说明), the colour, then the head of 「札记」 (the
//! text is the editor's); under the text 「字段」 and 「章节序列」.
//!
//! The 0.1 rules:
//!
//! - **Name**: Enter leaves, Esc puts the stored name back, leaving saves.
//!   Trimmed; an empty one becomes 「New Storyline」 and a taken one gets a
//!   「 2」 (F3 does both, as 0.1 did).
//! - **Summary**: Enter starts a new line, Esc puts it back, leaving saves.
//! - **Colour**: the swatch shows it; the 0.1 client opened the system's
//!   colour picker from it (GPUI has none yet).
//! - **章节序列** shows only when the storyline has chapters: the chapters on
//!   it in reading order, primary and secondary alike, filtered all /
//!   written (any words) / not started. A row: the chapter's seal in the
//!   storyline's colour (hollow without words), 「§01」 (its place in the
//!   filtered list), the title, two lines of its summary (「尚未填写一句话摘要」
//!   without), its words and 已写 / 未起, the thousands on the right, an arrow
//!   under the pointer. A click previews the chapter, a double click keeps
//!   it. The 0.1 page set no chapter's membership or primary storyline
//!   here, and neither does this one.
//! - 「章节模版」 is not here yet: F3 writes no body template.

use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of, seal_of};
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
use dr_workspace::{Workspace as Library, dto::ChapterInfo};
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, WeakEntity, Window, div, px,
};

use crate::data;
use crate::element::field_id;
use crate::fields::{Fields, Owner};
use crate::page;
use crate::swatch;
use crate::template::ChapterTemplate;

/// 「2.3」: thousands of words with one decimal (the 0.1 `kWords`).
pub fn thousands(words: u64) -> String {
    format!("{:.1}", words as f64 / 1000.0)
}

/// The chapters on storyline `id`, in reading order.
pub fn chapters_of<'a>(book: &'a Book, id: &str) -> Vec<&'a ChapterInfo> {
    book.chapters
        .iter()
        .filter(|c| c.storylines.iter().any(|s| s == id))
        .collect()
}

/// The storyline page's head.
pub struct StorylineHead {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    pub id: String,
    book: Rc<Book>,
    name: Entity<TextArea>,
    summary: Entity<TextArea>,
    shown_name: Option<String>,
    shown_summary: Option<String>,
    /// The colour being picked (dr-ui's swatch).
    picked: swatch::Picked,
    _subs: Vec<Subscription>,
}

impl StorylineHead {
    pub fn new(
        id: String,
        ws: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> StorylineHead {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let untitled = t(cx, keys::storyline_editor::UNTITLED);
        let name = cx.new(|cx| {
            TextArea::new(field_id("storyline-name", &id), window, cx)
                .submit_on_enter()
                .placeholder(untitled)
        });
        let hint = t(cx, keys::storyline_editor::SUMMARY_PLACEHOLDER);
        let summary = cx.new(|cx| {
            TextArea::new(field_id("storyline-summary", &id), window, cx).placeholder(hint)
        });
        let on_name = cx.subscribe_in(&name, window, |head, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => head.leave(window, cx),
            FieldEvent::Cancelled => {
                let stored = head.stored().0;
                field.update(cx, |f, cx| f.set_text(stored, cx));
                head.leave(window, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                head.save_name(text, cx);
            }
            FieldEvent::Changed(_) => {}
        });
        let on_summary = cx.subscribe_in(&summary, window, |head, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => head.leave(window, cx),
            FieldEvent::Cancelled => {
                let stored = head.stored().1;
                field.update(cx, |f, cx| f.set_text(stored, cx));
                head.leave(window, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                head.save_summary(text, cx);
            }
            FieldEvent::Changed(_) => {}
        });
        cx.spawn(async move |this, cx| this.update(cx, |head, cx| head.follow(cx)).ok())
            .detach();
        StorylineHead {
            ws,
            lib,
            id,
            book: Rc::default(),
            name,
            summary,
            shown_name: None,
            shown_summary: None,
            picked: swatch::Picked::default(),
            _subs: vec![on_name, on_summary],
        }
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

    /// The name and summary fields (tests).
    pub fn fields(&self) -> (Entity<TextArea>, Entity<TextArea>) {
        (self.name.clone(), self.summary.clone())
    }

    /// The stored name and summary.
    fn stored(&self) -> (String, String) {
        data::storyline(&self.book, &self.id)
            .map(|l| (l.name.clone(), l.summary.clone()))
            .unwrap_or_default()
    }

    fn leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.ws.upgrade() {
            ws.read(cx).focus_handle().clone().focus(window, cx);
        }
    }

    fn write(&self, edit: dr_workspace::commands::storyline::StorylineUpdateIn, cx: &mut App) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = data::update_storyline(&lib, edit) {
                    log::warn!("the storyline could not be saved: {error}");
                }
            })
            .detach();
    }

    /// Saves the name unless it is unchanged (an empty one is F3's 「New
    /// Storyline」, as in 0.1).
    fn save_name(&mut self, text: String, cx: &mut Context<Self>) {
        let name = text.trim().to_owned();
        if name == self.stored().0 {
            return;
        }
        let mut edit = data::storyline_edit(&self.book.id, &self.id);
        edit.name = Some(name);
        self.write(edit, cx);
    }

    fn save_summary(&mut self, text: String, cx: &mut Context<Self>) {
        if text == self.stored().1 {
            return;
        }
        let mut edit = data::storyline_edit(&self.book.id, &self.id);
        edit.summary = Some(text);
        self.write(edit, cx);
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
        let stored = data::storyline(&self.book, &self.id).map(|l| l.color.clone());
        let Some(color) = self.picked.settled(stored.as_deref()) else {
            return;
        };
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let mut edit = data::storyline_edit(&self.book.id, &self.id);
        edit.color = Some(color);
        cx.spawn(async move |this, cx| {
            let out = cx
                .background_executor()
                .spawn(async move { data::update_storyline(&lib, edit) })
                .await;
            if let Err(error) = out {
                log::warn!("the storyline's colour could not be saved: {error}");
                this.update(cx, |head, cx| {
                    head.picked.forget();
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }
}

impl Render for StorylineHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(line) = data::storyline(&self.book, &self.id).cloned() else {
            return div().into_any_element();
        };
        if self.shown_name.as_ref() != Some(&line.name)
            && !self.name.focus_handle(cx).is_focused(window)
        {
            self.shown_name = Some(line.name.clone());
            let name = line.name.clone();
            self.name.update(cx, |f, cx| f.set_text(name, cx));
        }
        if self.shown_summary.as_ref() != Some(&line.summary)
            && !self.summary.focus_handle(cx).is_focused(window)
        {
            self.shown_summary = Some(line.summary.clone());
            let text = line.summary.clone();
            self.summary.update(cx, |f, cx| f.set_text(text, cx));
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let look = page::look(cx);
        let color = self.picked.shown(Some(&line.color), color_of(&line.color));
        let chapters = chapters_of(&self.book, &self.id);
        let words: u64 = chapters.iter().map(|c| c.words).sum();
        let folio = page::folio(
            vec![
                div()
                    .child(t(cx, keys::storyline_editor::FOLIO))
                    .into_any_element(),
                page::folio_mark(
                    "storyline-folio-mark",
                    sand::Kind::Storyline,
                    color,
                    line.name.clone().into(),
                    window,
                    cx,
                ),
                div()
                    .child(tf(
                        cx,
                        keys::storyline_editor::meta::CHAPTERS,
                        &[("count", &chapters.len())],
                    ))
                    .into_any_element(),
                div()
                    .child(tf(
                        cx,
                        keys::storyline_editor::meta::K_WORDS,
                        &[("count", &thousands(words))],
                    ))
                    .into_any_element(),
            ],
            window,
            cx,
        );
        let mark = KindMark::new("storyline-hero-mark", sand::Kind::Storyline)
            .scale(30.0 / 14.0)
            .color(color.unwrap_or(p.accent));
        let name_row = div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(14.0))
            .child(div().mt(px(10.0)).child(mark))
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
        let summary_size = look.font_size - 4.0;
        let entity = cx.entity();
        let swatch = div()
            .self_start()
            .debug_selector(|| "storyline-color".into())
            .child(
                ColorSwatch::new("storyline-color", color.unwrap_or(p.accent))
                    .label(t(cx, keys::common::CUSTOM_COLOR))
                    .on_pick(move |color, _, cx| {
                        entity.update(cx, |head, cx| head.pick_color(color, cx))
                    }),
            );
        let facts = div()
            .mt(px(14.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14.0))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(9.5, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::storyline_editor::labels::COLOR)),
            )
            .child(swatch);
        let overview = div()
            .pb(px(22.0))
            .mb(px(24.0))
            .border_b_1()
            .border_color(p.rule.solid())
            .flex()
            .flex_col()
            .child(name_row)
            .child(
                div()
                    .mt(px(10.0))
                    .font_role(Role::Prose)
                    .type_px(summary_size, summary_size * 1.55)
                    .text_color(p.ink(3).solid())
                    .child(self.summary.clone()),
            )
            .child(facts);
        let content = div()
            .flex()
            .flex_col()
            .child(folio)
            .child(overview)
            .child(page::section(
                t(cx, keys::storyline_editor::sections::SCRATCH),
                None,
                true,
                window,
                cx,
            ));
        page::column(look, content).pt(px(56.0)).into_any_element()
    }
}

/// The filter over 章节序列.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChapterFilter {
    #[default]
    All,
    Written,
    NotStarted,
}

/// Under the storyline's text: 「字段」, then 「章节序列」.
pub struct StorylineEnd {
    ws: WeakEntity<Workspace>,
    pub id: String,
    book: Rc<Book>,
    pub fields: Entity<Fields>,
    /// 章节模版, made on the first frame the book is there.
    pub template: Option<Entity<ChapterTemplate>>,
    pub filter: ChapterFilter,
    _ws: Option<Subscription>,
}

impl StorylineEnd {
    pub fn new(id: String, ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> StorylineEnd {
        let fields = {
            let (id, ws) = (id.clone(), ws.clone());
            cx.new(|cx| Fields::new(Owner::Storyline(id), false, ws, cx))
        };
        cx.spawn(async move |this, cx| this.update(cx, |end, cx| end.follow(cx)).ok())
            .detach();
        StorylineEnd {
            ws,
            id,
            book: Rc::default(),
            fields,
            template: None,
            filter: ChapterFilter::default(),
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

    /// The chapters 章节序列 lists with the filter, in reading order.
    pub fn listed(&self) -> Vec<ChapterInfo> {
        chapters_of(&self.book, &self.id)
            .into_iter()
            .filter(|c| match self.filter {
                ChapterFilter::All => true,
                ChapterFilter::Written => c.words > 0,
                ChapterFilter::NotStarted => c.words == 0,
            })
            .cloned()
            .collect()
    }

    pub fn set_filter(&mut self, filter: ChapterFilter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    fn open(&self, id: &str, how: Open, cx: &mut App) {
        let Some(target) = id.parse().ok().map(Target::Chapter) else {
            return;
        };
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }
}

impl Render for StorylineEnd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let look = page::look(cx);
        let Some(line) = data::storyline(&self.book, &self.id).cloned() else {
            return div().into_any_element();
        };
        let fields = self.fields.clone();
        let template = self
            .template
            .get_or_insert_with(|| {
                let (book, id) = (self.book.id.clone(), self.id.clone());
                let exists = line.has_chapter_template;
                cx.new(|cx| ChapterTemplate::new(book, id, exists, window, cx))
            })
            .clone();
        template.update(cx, |t, cx| t.follow(line.has_chapter_template, window, cx));
        // 章节模版: what a new chapter on this storyline starts with.
        let template = div()
            .flex()
            .flex_col()
            .child(page::column(
                look,
                page::section(
                    t(cx, keys::storyline_editor::sections::NODE_TEMPLATE),
                    Some(page::meta(
                        t(cx, keys::storyline_editor::meta::NODE_TEMPLATE),
                        window,
                        cx,
                    )),
                    false,
                    window,
                    cx,
                ),
            ))
            .child(template);
        let chapters = chapters_of(&self.book, &self.id);
        if chapters.is_empty() {
            // The 0.1 page shows the sequence only when there is a chapter.
            return div()
                .pb(px(80.0))
                .child(fields)
                .child(template)
                .into_any_element();
        }
        let color = color_of(&line.color);
        let total = chapters.len();
        let written = chapters.iter().filter(|c| c.words > 0).count();
        let words: u64 = chapters.iter().map(|c| c.words).sum();
        let head = page::section(
            t(cx, keys::storyline_editor::sections::CHAPTERS),
            Some(page::meta(
                tf(
                    cx,
                    keys::storyline_editor::meta::CHAPTERS_WORDS,
                    &[("chapters", &total), ("words", &thousands(words))],
                ),
                window,
                cx,
            )),
            false,
            window,
            cx,
        );
        let entity = cx.entity();
        let filters = Segmented::new(
            "storyline-filter",
            [
                format!("{} {total}", t(cx, keys::storyline_editor::filters::ALL)),
                format!(
                    "{} {written}",
                    t(cx, keys::storyline_editor::filters::WRITTEN)
                ),
                format!(
                    "{} {}",
                    t(cx, keys::storyline_editor::filters::UNWRITTEN),
                    total - written
                ),
            ],
            match self.filter {
                ChapterFilter::All => 0,
                ChapterFilter::Written => 1,
                ChapterFilter::NotStarted => 2,
            },
        )
        .on_change({
            let entity = entity.clone();
            move |i, _, cx| {
                let filter = match i {
                    1 => ChapterFilter::Written,
                    2 => ChapterFilter::NotStarted,
                    _ => ChapterFilter::All,
                };
                entity.update(cx, |end, cx| end.set_filter(filter, cx));
            }
        });
        let listed = self.listed();
        let mut list = div().flex().flex_col().gap(px(2.0));
        if listed.is_empty() {
            list = list.child(page::empty_line(
                t(cx, keys::storyline_editor::empty::NO_FILTERED_CHAPTERS),
                look,
                window,
                cx,
            ));
        }
        for (ix, chapter) in listed.iter().enumerate() {
            list = list.child(row(&entity, ix, chapter, color, window, cx));
        }
        div()
            .flex()
            .flex_col()
            .child(fields)
            .child(template)
            .child(
                page::column(
                    look,
                    div()
                        .flex()
                        .flex_col()
                        .child(head)
                        .child(div().mt(px(8.0)).mb(px(4.0)).pb(px(4.0)).child(filters))
                        .child(list),
                )
                .pb(px(80.0)),
            )
            .into_any_element()
    }
}

/// One chapter of 章节序列 (`.mgr-row`).
fn row(
    entity: &Entity<StorylineEnd>,
    ix: usize,
    chapter: &ChapterInfo,
    color: Option<Rgb>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let locale = dr_shell::Settings::locale(cx);
    let id: SharedString = format!("storyline-row-{}", chapter.id).into();
    let title: SharedString = if chapter.title.trim().is_empty() {
        t(cx, keys::common::UNTITLED)
    } else {
        chapter.title.clone().into()
    };
    let summary = chapter.summary.trim().to_owned();
    let open = {
        let entity = entity.clone();
        let chapter = chapter.id.clone();
        move |e: &ClickEvent, _: &mut Window, cx: &mut App| {
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            let chapter = chapter.clone();
            entity.update(cx, |end, cx| end.open(&chapter, how, cx));
        }
    };
    let mark = KindMark::new(
        ElementId::Name(format!("{id}-mark").into()),
        sand::Kind::Chapter(seal_of(&chapter.id)),
    )
    .hollow(chapter.words == 0);
    let state = if chapter.words > 0 {
        t(cx, keys::storyline_editor::filters::WRITTEN)
    } else {
        t(cx, keys::storyline_editor::filters::UNWRITTEN)
    };
    let meta = div()
        .flex()
        .flex_row()
        .items_baseline()
        .gap(px(14.0))
        .font_role(Role::Index)
        .type_px(9.5, 14.0)
        .text_color(p.ink(4).solid())
        .child(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .child(
                    div()
                        .font_role(Role::Ui)
                        .italic()
                        .weight(weight::MEDIUM)
                        .type_px(11.5, 14.0)
                        .text_color(p.ink(2).solid())
                        .child(dr_i18n::number::grouped(chapter.words, locale)),
                )
                .child(t(cx, keys::common::WORDS)),
        )
        .child(state);
    let wc: AnyElement = if chapter.words == 0 {
        div()
            .font_role(Role::Ui)
            .type_px(19.0, 19.0)
            .text_color(p.ink(1).solid())
            .child("—")
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_row()
            .items_baseline()
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(19.0, 19.0)
                    .text_color(p.ink(1).solid())
                    .child(thousands(chapter.words)),
            )
            .child(
                div()
                    .ml(px(2.0))
                    .font_role(Role::Index)
                    .type_px(10.0, 12.0)
                    .text_color(p.ink(4).solid())
                    .child("k"),
            )
            .into_any_element()
    };
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
    .aria_label(title.clone())
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
            .child(format!("§{:02}", ix + 1)),
    )
    .child(
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(5.0))
            .child(
                div()
                    .truncate()
                    .font_role(Role::Prose)
                    .type_px(17.0, 17.0 * 1.2)
                    .text_color(p.ink(1).solid())
                    .child(title),
            )
            .child(if summary.is_empty() {
                div()
                    .font_role(Role::Index)
                    .type_px(10.0, 14.0)
                    .text_color(p.ink(5).solid())
                    .child(t(cx, keys::storyline_editor::empty::NO_CHAPTER_SUMMARY))
            } else {
                div()
                    .max_w(px(560.0))
                    .font_role(Role::Prose)
                    .italic()
                    .type_px(13.5, 13.5 * 1.55)
                    .text_color(p.ink(3).solid())
                    .line_clamp(2)
                    .child(dr_ui::text::wrapped(summary))
            })
            .child(meta),
    )
    .child(
        div()
            .flex_none()
            .pt(px(4.0))
            .flex()
            .flex_col()
            .items_end()
            .gap(px(2.0))
            .child(wc)
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(9.0, 12.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::common::WORDS)),
            ),
    )
    .child(
        div()
            .id(ElementId::Name(format!("{id}-open").into()))
            .size(px(16.0))
            .flex_none()
            .invisible()
            .group_hover(id.clone(), |st| st.visible())
            .aria_label(t(cx, keys::storyline_editor::actions::OPEN_CHAPTER))
            .child(sand::icon(Icon::ArrowForward, 14.0, p.ink(3).solid())),
    )
    .into_any_element()
}
