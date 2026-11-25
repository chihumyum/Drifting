//! The Stats visual vocabulary over v3 scopes (M07 + M20 + Fill dashboard).
use std::rc::Rc;

use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::{
    Theme,
    components::{Button, tooltip::tooltip},
    fonts::Role,
    sand::Icon,
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::Workspace;
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{
    LiveWords,
    sections::Ui,
    v3::{self, Loaded, RefEntry, Scope},
};

pub type Open = Rc<dyn Fn(Scope, &mut Window, &mut App)>;
pub type OpenHistory = Rc<dyn Fn(String, String, &mut Window, &mut App)>;

pub struct View {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    scope: Scope,
    i18n: I18n,
    open: Option<Open>,
    open_history: Option<OpenHistory>,
    fill_width: Option<f32>,
    loaded: Option<Loaded>,
    mine: Option<i64>,
    task: Option<Task<()>>,
    revision: u64,
}

impl View {
    pub fn new(id: SharedString, lib: Option<Workspace>) -> Self {
        Self {
            id,
            lib,
            book: String::new(),
            scope: Scope::Book,
            i18n: I18n::new(Locale::En, Platform::Mac),
            open: None,
            open_history: None,
            fill_width: None,
            loaded: None,
            mine: None,
            task: None,
            revision: 0,
        }
    }
    pub fn loaded(&self) -> Option<&Loaded> {
        self.loaded.as_ref()
    }
    /// How many times the tab asked for its numbers (for tests).
    pub fn reads(&self) -> u64 {
        self.revision
    }
    pub(crate) fn set_mine(&mut self, mine: Option<i64>, cx: &mut Context<Self>) {
        if self.mine != mine {
            self.mine = mine;
            cx.notify();
        }
    }
    pub(crate) fn set_open_history(&mut self, open_history: Option<OpenHistory>) {
        self.open_history = open_history;
    }
    pub(crate) fn set_fill_width(&mut self, width: Option<f32>, cx: &mut Context<Self>) {
        if self.fill_width != width {
            self.fill_width = width;
            cx.notify();
        }
    }
    pub fn show(
        &mut self,
        book: &str,
        scope: Scope,
        locale: Locale,
        platform: Platform,
        open: Option<Open>,
        cx: &mut Context<Self>,
    ) {
        self.i18n = I18n::new(locale, platform);
        self.open = open;
        if self.book != book || self.scope != scope {
            self.book = book.into();
            self.scope = scope;
            self.loaded = None;
            self.mine = None;
            self.reload(cx);
        }
    }
    pub(crate) fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        self.revision += 1;
        let revision = self.revision;
        let (book, scope) = (self.book.clone(), self.scope.clone());
        self.task = Some(cx.spawn(async move |this, cx| {
            // Coalesce a burst of prose/index/book events; a newer request
            // cancels this task and cannot receive this request's result.
            cx.background_executor()
                .timer(std::time::Duration::from_millis(300))
                .await;
            let result = cx
                .background_executor()
                .spawn(async move { v3::load(&lib, &book, scope) })
                .await;
            this.update(cx, |v, cx| {
                if v.revision != revision {
                    return;
                }
                v.task = None;
                match result {
                    Ok(data) => v.loaded = Some(data),
                    Err(error) => {
                        v.loaded = None;
                        log::warn!("v3 stats: {error}");
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn format_unix_date(secs: i64) -> String {
        // Howard Hinnant civil-from-days conversion (UTC date YYYY-MM-DD).
        let z = secs.div_euclid(86_400) + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        let y = (yoe as i64) + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };
        format!("{year:04}-{m:02}-{d:02}")
    }

    fn format_bytes(bytes: i64) -> String {
        let b = bytes.max(0) as f64;
        if b < 1024.0 {
            format!("{bytes} B")
        } else if b < 1024.0 * 1024.0 {
            format!("{:.1} KB", b / 1024.0)
        } else {
            format!("{:.2} MB", b / (1024.0 * 1024.0))
        }
    }

    fn status_label(&self, raw: &str) -> SharedString {
        use keys::editor_top_bar::status as st;
        match raw {
            "draft" => self.i18n.t(st::DRAFT).into(),
            "finished" => self.i18n.t(st::FINISHED).into(),
            "discarded" => self.i18n.t(st::DISCARDED).into(),
            "drifting" => self.i18n.t(st::DRIFTING).into(),
            "resting" => self.i18n.t(st::RESTING).into(),
            other => other.to_owned().into(),
        }
    }

    fn ref_list(
        &self,
        ui: &Ui<'_>,
        prefix: &str,
        title: SharedString,
        items: &[RefEntry],
    ) -> AnyElement {
        let p = ui.theme.palette;
        let mut sec = ui.section(Some(title));
        if items.is_empty() {
            sec = sec.child(ui.small(ui.t(keys::v5_stats::UNREFERENCED_NOTE)));
            return sec.into_any_element();
        }
        for (i, item) in items.iter().enumerate() {
            let open = self.open.clone();
            let eid = item.entry_id.clone();
            let row_label = if item.title.trim().is_empty() {
                ui.t(keys::k4_book::UNTITLED_ENTRY)
            } else {
                item.title.clone().into()
            };
            let count_str = ui.n(i64::from(item.count));
            let row = div()
                .id(ui.id(&format!("{prefix}-{i}-{}", item.entry_id)))
                .rounded(px(radius::SM))
                .px(px(4.0))
                .py(px(2.0))
                .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                .when_some(open, move |el, open| {
                    el.cursor_pointer().on_click(move |_, window, cx| {
                        open(
                            Scope::Entry {
                                id: eid.clone(),
                                module: None,
                            },
                            window,
                            cx,
                        )
                    })
                })
                .child(ui.row(row_label, count_str));
            sec = sec.child(row);
        }
        sec.into_any_element()
    }

    fn render_material(&self, ui: &Ui<'_>, data: &Loaded) -> Vec<AnyElement> {
        use keys::right_sidebar::stats;
        let p = ui.theme.palette;
        let Some(mat) = &data.material else {
            return Vec::new();
        };
        let mut sections: Vec<AnyElement> = Vec::new();
        let kind_label = match mat.kind.as_str() {
            "image" => ui.t(keys::v5_files::KIND_IMAGE),
            "pdf" => ui.t(keys::v5_files::KIND_PDF),
            other => other.to_owned().into(),
        };
        let mut coords = ui
            .section(Some(ui.t(stats::MATERIAL_COORDINATES)))
            .child(ui.row(ui.t(stats::NAME), data.title.clone()))
            .child(ui.row(ui.t(stats::FILE_TYPE), kind_label));
        if let Some(ts) = mat.created_at {
            coords = coords.child(ui.row(ui.t(stats::CREATED), Self::format_unix_date(ts)));
        }
        coords = coords.child(ui.row(ui.t(stats::OPEN_COMMENTS), ui.n(mat.open_comments as i64)));
        sections.push(coords.into_any_element());

        let mut file_sec = ui
            .section(Some(ui.t(stats::MATERIAL_FILE)))
            .child(ui.row(ui.t(stats::FILE_TYPE), mat.mime.clone()))
            .child(ui.row(ui.t(stats::FILE_SIZE), Self::format_bytes(mat.size_bytes)));
        if let (Some(w), Some(h)) = (mat.width, mat.height) {
            file_sec = file_sec.child(ui.row(ui.t(stats::DIMENSIONS), format!("{w} × {h} px")));
        }
        sections.push(file_sec.into_any_element());

        let mut embeds = ui.section(Some(ui.t(stats::EMBEDDED_MATERIALS)));
        if mat.usages.is_empty() {
            embeds = embeds.child(ui.small(ui.t(keys::v5_stats::UNREFERENCED_NOTE)));
        } else {
            for (idx, (eid, etitle)) in mat.usages.iter().enumerate() {
                let open = self.open.clone();
                let eid_click = eid.clone();
                let label: SharedString = if etitle.trim().is_empty() {
                    ui.t(keys::k4_book::UNTITLED_ENTRY)
                } else {
                    etitle.clone().into()
                };
                embeds = embeds.child(
                    div()
                        .id(ui.id(&format!("mat-use-{idx}-{eid}")))
                        .rounded(px(radius::SM))
                        .px(px(4.0))
                        .py(px(2.0))
                        .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                        .when_some(open, move |el, open| {
                            el.cursor_pointer().on_click(move |_, window, cx| {
                                open(
                                    Scope::Entry {
                                        id: eid_click.clone(),
                                        module: None,
                                    },
                                    window,
                                    cx,
                                )
                            })
                        })
                        .child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(ui.theme.scale.secondary, ui.theme.scale.line_body)
                                .text_color(p.ink(1).solid())
                                .child(label),
                        ),
                );
            }
        }
        sections.push(embeds.into_any_element());
        sections
    }

    fn render_book_charts(&self, ui: &Ui<'_>, data: &Loaded) -> Vec<AnyElement> {
        use keys::right_sidebar::stats;
        let p = ui.theme.palette;
        let mut sections: Vec<AnyElement> = Vec::new();

        // 1. Completion distribution stacked bar
        let comp = &data.completion;
        let active_total = comp.finished + comp.draft + comp.other;
        if active_total > 0 || comp.discarded > 0 {
            let denom = (active_total + comp.discarded).max(1) as f32;
            let mut bar = div()
                .w_full()
                .h(px(6.0))
                .rounded(px(3.0))
                .overflow_hidden()
                .bg(p.hairline())
                .flex()
                .flex_row();
            if comp.finished > 0 {
                bar = bar.child(
                    div()
                        .h_full()
                        .w(gpui::relative(comp.finished as f32 / denom))
                        .bg(p.accent.solid()),
                );
            }
            if comp.draft + comp.other > 0 {
                bar = bar.child(
                    div()
                        .h_full()
                        .w(gpui::relative((comp.draft + comp.other) as f32 / denom))
                        .bg(p.ink(3).alpha(0.45)),
                );
            }
            if comp.discarded > 0 {
                bar = bar.child(
                    div()
                        .h_full()
                        .w(gpui::relative(comp.discarded as f32 / denom))
                        .bg(p.ink(4).alpha(0.35)),
                );
            }
            let finished_label = ui.fmt(
                stats::STATUS_COUNT,
                &[
                    ("status", &self.status_label("finished")),
                    ("count", &comp.finished),
                ],
            );
            let draft_label = ui.fmt(
                stats::STATUS_COUNT,
                &[
                    ("status", &self.status_label("draft")),
                    ("count", &(comp.draft + comp.other)),
                ],
            );
            let mut summary_line = format!("{finished_label} · {draft_label}");
            if comp.discarded > 0 {
                summary_line.push(' ');
                summary_line
                    .push_str(&ui.fmt(stats::DISCARDED_PAREN, &[("count", &comp.discarded)]));
            }
            sections.push(
                ui.section(Some(ui.t(stats::COMPLETION)))
                    .child(bar)
                    .child(ui.small(summary_line))
                    .into_any_element(),
            );
        }

        // 2. Group / Act word rhythm
        if !data.group_rhythm.is_empty() {
            let total_group_words: u64 = data.group_rhythm.iter().map(|g| g.words).sum();
            let mut sec = ui.section(Some(ui.t(keys::v5_stats::GROUP_RHYTHM)));
            for (idx, g) in data.group_rhythm.iter().enumerate() {
                let frac = if total_group_words > 0 {
                    g.words as f32 / total_group_words as f32
                } else {
                    0.0
                };
                let pct = (frac * 100.0).round() as u32;
                let gname = if g.title.trim().is_empty() {
                    ui.t(keys::k4_book::UNTITLED_ENTRY).to_string()
                } else {
                    g.title.clone()
                };
                let open = self.open.clone();
                let gid = g.id.clone();
                sec = sec.child(
                    div()
                        .id(ui.id(&format!("group-{idx}-{}", g.id)))
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .when_some(open, move |el, open| {
                            el.cursor_pointer().on_click(move |_, window, cx| {
                                open(
                                    Scope::Entry {
                                        id: gid.clone(),
                                        module: None,
                                    },
                                    window,
                                    cx,
                                )
                            })
                        })
                        .child(ui.row(gname, format!("{} · {pct}%", ui.words(g.words))))
                        .child(ui.stroke(&format!("grp-bar-{idx}"), frac, None)),
                );
            }
            sections.push(sec.into_any_element());
        }

        // 3. Chapter-length rhythm bar chart + longest / shortest
        if !data.chapters.is_empty() {
            let max_words = data
                .chapters
                .iter()
                .map(|c| c.words)
                .max()
                .unwrap_or(1)
                .max(1);
            let mut bars = div()
                .w_full()
                .h(px(56.0))
                .flex()
                .flex_row()
                .items_end()
                .gap(px(2.0));
            for (i, ch) in data.chapters.iter().enumerate() {
                let ratio = (ch.words as f32 / max_words as f32).clamp(0.06, 1.0);
                let bar_color = match ch.status.as_deref() {
                    Some("finished") => p.accent.alpha(0.82),
                    Some("discarded") => p.ink(4).alpha(0.30),
                    _ => p.ink(2).alpha(0.55),
                };
                let ch_title = if ch.title.trim().is_empty() {
                    ui.t(keys::k4_book::UNTITLED_ENTRY).to_string()
                } else {
                    ch.title.clone()
                };
                let tip_text: SharedString = format!("{ch_title} · {}", ui.words(ch.words)).into();
                let open = self.open.clone();
                let eid = ch.entry_id.clone();
                bars = bars.child(
                    div()
                        .id(ui.id(&format!("ch-bar-{i}-{}", ch.entry_id)))
                        .flex_1()
                        .min_w(px(3.0))
                        .h(px(56.0 * ratio))
                        .rounded_t(px(2.0))
                        .bg(bar_color)
                        .tooltip(tooltip(tip_text))
                        .when_some(open, move |el, open| {
                            el.cursor_pointer().on_click(move |_, window, cx| {
                                open(
                                    Scope::Entry {
                                        id: eid.clone(),
                                        module: None,
                                    },
                                    window,
                                    cx,
                                )
                            })
                        }),
                );
            }
            let mut sec = ui
                .section(Some(ui.t(stats::CHAPTER_LENGTH_RHYTHM)))
                .child(bars);
            if let Some(longest) = data.chapters.iter().max_by_key(|c| c.words) {
                let tname = if longest.title.trim().is_empty() {
                    ui.t(keys::k4_book::UNTITLED_ENTRY).to_string()
                } else {
                    longest.title.clone()
                };
                sec = sec.child(ui.small(ui.fmt(
                    stats::LONGEST_WITH_WORDS,
                    &[("title", &tname), ("words", &ui.n(longest.words as i64))],
                )));
            }
            if data.chapters.len() > 1
                && let Some(shortest) = data
                    .chapters
                    .iter()
                    .filter(|c| c.words > 0)
                    .min_by_key(|c| c.words)
            {
                let tname = if shortest.title.trim().is_empty() {
                    ui.t(keys::k4_book::UNTITLED_ENTRY).to_string()
                } else {
                    shortest.title.clone()
                };
                sec = sec.child(ui.small(ui.fmt(
                    stats::SHORTEST_WITH_WORDS,
                    &[("title", &tname), ("words", &ui.n(shortest.words as i64))],
                )));
            }
            sections.push(sec.into_any_element());
        }

        sections
    }

    fn render_entry_extras(&self, ui: &Ui<'_>, data: &Loaded) -> Vec<AnyElement> {
        use keys::right_sidebar::stats;
        let p = ui.theme.palette;
        let mut sections: Vec<AnyElement> = Vec::new();

        if let Some(coords) = &data.coordinates {
            let mut sec = ui.section(Some(ui.t(keys::v5_stats::ENTRY_COORDINATES)));
            if let Some(tpl) = &coords.template_name {
                sec = sec.child(ui.row(ui.t(stats::NAME), tpl.clone()));
            }
            if let Some(parent) = &coords.parent_title {
                sec = sec.child(ui.row(ui.t(stats::STORYLINE), parent.clone()));
            }
            if let Some(st) = &coords.status {
                sec = sec.child(ui.row(ui.t(stats::COMPLETION), self.status_label(st)));
            }
            if let Some(pos) = coords.book_position {
                sec = sec.child(ui.row(ui.t(stats::BOOK_OVERVIEW), format!("#{pos}")));
            }
            if let Some(ts) = coords.updated_at {
                sec = sec.child(ui.row(ui.t(stats::UPDATED), Self::format_unix_date(ts)));
            }
            sections.push(sec.into_any_element());
        }

        if let Some(sub) = &data.subtree {
            let mut sec = ui
                .section(Some(ui.t(keys::v5_stats::CHILDREN_AGGREGATE)))
                .child(ui.row(
                    ui.t(keys::k4_book::ENTRY_TOTAL),
                    ui.n(sub.child_count as i64),
                ))
                .child(ui.row(ui.t(keys::k4_book::ENTRY_WORDS), ui.words(sub.total_words)))
                .child(ui.row(
                    ui.t(stats::REFERENCES),
                    format!("{} / {}", sub.appeared_count, sub.child_count),
                ));
            if !sub.unappeared.is_empty() {
                sec = sec.child(ui.small(ui.t(stats::UNAPPEARED_ELEMENTS)));
                for (idx, (uid, utitle)) in sub.unappeared.iter().take(8).enumerate() {
                    let open = self.open.clone();
                    let click_id = uid.clone();
                    let label: SharedString = if utitle.trim().is_empty() {
                        ui.t(keys::k4_book::UNTITLED_ENTRY)
                    } else {
                        utitle.clone().into()
                    };
                    sec = sec.child(
                        div()
                            .id(ui.id(&format!("unapp-{idx}-{uid}")))
                            .rounded(px(radius::SM))
                            .px(px(4.0))
                            .py(px(1.5))
                            .hover(move |st| st.bg(p.ink(1).alpha(0.05)))
                            .when_some(open, move |el, open| {
                                el.cursor_pointer().on_click(move |_, window, cx| {
                                    open(
                                        Scope::Entry {
                                            id: click_id.clone(),
                                            module: None,
                                        },
                                        window,
                                        cx,
                                    )
                                })
                            })
                            .child(
                                div()
                                    .font_role(Role::Ui)
                                    .type_px(ui.theme.scale.caption, ui.theme.scale.line_caption)
                                    .text_color(p.ink(2).solid())
                                    .child(label),
                            ),
                    );
                }
            }
            sections.push(sec.into_any_element());
        }

        // Outbound links (this entry's referenced elements)
        sections.push(self.ref_list(
            ui,
            "out",
            if data.has_book {
                ui.t(stats::THIS_CHAPTER_ELEMENTS)
            } else {
                ui.t(keys::v5_stats::OUTBOUND_LINKS)
            },
            &data.outbound_links,
        ));

        // Inbound backlinks
        sections.push(self.ref_list(
            ui,
            "in",
            ui.t(keys::v5_stats::INBOUND_LINKS),
            &data.inbound_links,
        ));

        // Snapshot history entry button
        if let (Some((doc_id, doc_title)), Some(open_history)) =
            (data.history_doc.clone(), self.open_history.clone())
        {
            sections.push(
                div()
                    .pt(px(4.0))
                    .child(
                        Button::new(ui.id("history-btn"), ui.t(stats::SNAPSHOT_BUTTON))
                            .icon(Icon::Rotate)
                            .small()
                            .on_click(move |_, window, cx| {
                                open_history(doc_id.clone(), doc_title.clone(), window, cx)
                            }),
                    )
                    .into_any_element(),
            );
        }

        sections
    }

    fn render_recent(&self, ui: &Ui<'_>, data: &Loaded) -> AnyElement {
        use keys::right_sidebar::stats;
        let today = crate::model::today_words(&data.days, self.mine);
        let week = data.days.week - data.days.today + today;
        let streak = if today > 0 {
            data.days.streak_before + 1
        } else {
            0
        };
        let mut recent = ui
            .section(Some(ui.t(stats::RECENT)))
            .child(ui.row(
                ui.t(keys::dashboard::today::WEEK),
                ui.words(week.max(0) as u64),
            ))
            .child(ui.row(
                ui.t(keys::dashboard::today::STREAK),
                format!("{streak} {}", ui.t(keys::project_picker::heat::DAYS_UNIT)),
            ));
        let max_day = data
            .days
            .days
            .iter()
            .enumerate()
            .map(|(i, d)| {
                if i + 1 == data.days.days.len() {
                    today.max(0) as u64
                } else {
                    d.words.max(0) as u64
                }
            })
            .max()
            .unwrap_or(1)
            .max(1);
        for (i, day) in data.days.days.iter().enumerate().rev() {
            let last = i + 1 == data.days.days.len();
            let label = if last {
                ui.t(keys::project_picker::heat::TODAY).to_string()
            } else {
                day.day.clone()
            };
            let w = if last { today } else { day.words }.max(0) as u64;
            let frac = (w as f32 / max_day as f32).clamp(0.0, 1.0);
            recent = recent.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(ui.row(label, ui.words(w)))
                    .child(ui.stroke(&format!("day-{i}"), frac, None)),
            );
        }
        recent.into_any_element()
    }
}

impl Render for View {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use keys::right_sidebar::stats;
        let theme = Theme::of(window, cx);
        let ui = Ui {
            theme,
            i18n: &self.i18n,
            id: self.id.clone(),
        };
        let live = LiveWords::read(cx);
        let data = self.loaded.as_ref();
        let wide_dashboard = self.fill_width.is_some_and(|w| w >= 620.0);

        // Material scope: show real file & usage statistics (never "素材字数: 0 字").
        if let Some(data) = data
            && matches!(data.scope, Scope::Material(_))
        {
            return div()
                .id(ElementId::Name(self.id.clone()))
                .size_full()
                .overflow_y_scroll()
                .px(px(16.0))
                .pt(px(10.0))
                .pb(px(24.0))
                .flex()
                .flex_col()
                .gap(px(20.0))
                .children(self.render_material(&ui, data));
        }

        // Bookless project (`has_book == false`): show useful Project Overview + Entry/Link stats.
        if let Some(data) = data
            && !data.has_book
        {
            let mut body = div()
                .id(ElementId::Name(self.id.clone()))
                .size_full()
                .overflow_y_scroll()
                .px(px(16.0))
                .pt(px(10.0))
                .pb(px(24.0))
                .flex()
                .flex_col()
                .gap(px(20.0))
                .child(
                    ui.section(Some(ui.t(keys::v5_stats::PROJECT_OVERVIEW)))
                        .child(ui.row(
                            ui.t(keys::k4_book::ENTRY_TOTAL),
                            ui.n(data.total_entries as i64),
                        ))
                        .child(ui.row(
                            ui.t(keys::v5_stats::TEMPLATES_TOTAL),
                            ui.n(data.template_count as i64),
                        )),
                );
            if matches!(data.scope, Scope::Entry { .. }) {
                body = body.children(self.render_entry_extras(&ui, data));
            } else if !data.inbound_links.is_empty() {
                body = body.child(self.ref_list(
                    &ui,
                    "top-refs",
                    ui.t(stats::REFERENCES),
                    &data.inbound_links,
                ));
            }
            return body;
        }

        let words = |n: Option<u64>| {
            n.map_or_else(
                || ui.t(keys::workspace_word_tally::COUNTING),
                |n| ui.words(n),
            )
        };
        let label = match (live.selection, &self.scope) {
            (Some(_), _) => keys::workspace_word_tally::SELECTION,
            (_, Scope::Book) => keys::workspace_word_tally::BOOK,
            (_, Scope::Entry { .. }) => keys::k4_book::ENTRY_WORDS,
            (_, Scope::Material(_)) => keys::k4_book::MATERIAL_WORDS,
        };
        let mut first = ui.section(None).child(ui.small(ui.t(label))).child(
            div()
                .font_role(Role::Ui)
                .type_px(theme.scale.heading, theme.scale.heading * 1.3)
                .text_color(theme.palette.ink(1).solid())
                .child(words(
                    live.selection
                        .or_else(|| data.and_then(|d| d.words(live)).map(|n| n.words)),
                )),
        );
        if self.scope != Scope::Book || live.selection.is_some() {
            first = first.child(ui.row(
                ui.t(keys::workspace_word_tally::BOOK),
                words(data.and_then(|d| d.book_words(live)).map(|n| n.words)),
            ));
        }
        let mut progress = ui.section(Some(ui.t(stats::WRITING_PROGRESS)));
        if let Some(data) = data {
            let today = crate::model::today_words(&data.days, self.mine);
            first = first.child(ui.row(
                ui.t(keys::project_picker::heat::TODAY),
                ui.words(today.max(0) as u64),
            ));
            if let Some(f) =
                crate::model::progress(today.max(0) as u64, data.days.daily_word_target)
            {
                first = first.child(ui.stroke("today", f, None));
            }
            progress =
                progress.child(ui.row(ui.t(keys::k4_book::ENTRY_TOTAL), data.entries.to_string()));
            if let Some(bw) = data.book_words(live) {
                if data.entries > 0 {
                    progress = progress.child(ui.row(
                        ui.t(stats::AVERAGE_PER_CHAPTER),
                        ui.words(bw.words / data.entries as u64),
                    ));
                }
                if let Some(target) = data.word_target.filter(|&t| t > 0) {
                    progress = progress.child(ui.row(
                        ui.t(stats::WRITTEN_TARGET),
                        format!("{} / {}", ui.n(bw.words as i64), ui.n(target)),
                    ));
                }
                if let Some(f) = crate::model::progress(bw.words, data.word_target) {
                    progress = progress.child(ui.stroke("book", f, None));
                }
            }
        }

        let mut left_col: Vec<AnyElement> = vec![first.into_any_element()];
        let mut right_col: Vec<AnyElement> = Vec::new();

        if let Some(data) = data {
            if let Some(shape) = data.shape {
                left_col.push(
                    ui.section(Some(ui.t(stats::WORD_RHYTHM)))
                        .child(ui.row(
                            ui.t(stats::PARAGRAPH_SENTENCE),
                            ui.fmt(
                                stats::PARAGRAPH_SENTENCE_VALUE,
                                &[
                                    ("paragraphs", &shape.paragraphs),
                                    ("sentences", &shape.sentences),
                                ],
                            ),
                        ))
                        .child(ui.row(
                            ui.t(stats::DIALOGUE_RATIO),
                            format!("{}%", (shape.dialogue * 100.0).round()),
                        ))
                        .child(ui.stroke("dialogue", shape.dialogue, None))
                        .into_any_element(),
                );
            }

            if matches!(data.scope, Scope::Book) {
                right_col.extend(self.render_book_charts(&ui, data));
            } else if matches!(data.scope, Scope::Entry { .. }) {
                right_col.extend(self.render_entry_extras(&ui, data));
            }

            let mut modules = ui.section(None);
            for doc in &data.documents {
                let name = if doc.retained {
                    ui.t(keys::k4_book::RETAINED_CONTENT).to_string()
                } else {
                    doc.name.clone()
                };
                let name = if matches!(data.scope, Scope::Book) {
                    format!(
                        "{} · {}",
                        doc.entry_title.as_deref().unwrap_or_default(),
                        name
                    )
                } else {
                    name
                };
                let mut row = div()
                    .id(ElementId::Name(format!("{}-{}", self.id, doc.id).into()))
                    .child(
                        ui.row(
                            name,
                            words(
                                live.docs
                                    .get(&doc.id)
                                    .copied()
                                    .or(doc.metrics)
                                    .map(|n| n.words),
                            ),
                        ),
                    );
                if let (Some(open), Some(entry)) = (self.open.clone(), doc.entry.clone()) {
                    let module = doc.module.clone();
                    row = row.cursor_pointer().on_click(move |_, window, cx| {
                        open(
                            Scope::Entry {
                                id: entry.clone(),
                                module: module.clone(),
                            },
                            window,
                            cx,
                        )
                    });
                }
                modules = modules.child(row);
            }
            if !data.documents.is_empty() {
                left_col.push(modules.into_any_element());
            }
        }
        left_col.push(progress.into_any_element());
        if let Some(data) = data {
            right_col.push(self.render_recent(&ui, data));
            if matches!(data.scope, Scope::Book) && !data.inbound_links.is_empty() {
                right_col.push(self.ref_list(
                    &ui,
                    "book-refs",
                    ui.t(stats::REFERENCES),
                    &data.inbound_links,
                ));
            }
        }

        let container = div()
            .id(ElementId::Name(self.id.clone()))
            .size_full()
            .overflow_y_scroll()
            .px(px(16.0))
            .pt(px(10.0))
            .pb(px(24.0));

        if wide_dashboard {
            container.child(
                div()
                    .w_full()
                    .max_w(px(960.0))
                    .mx_auto()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(28.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(22.0))
                            .children(left_col),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(22.0))
                            .children(right_col),
                    ),
            )
        } else {
            container
                .flex()
                .flex_col()
                .gap(px(22.0))
                .children(left_col)
                .children(right_col)
        }
    }
}

/// Wires the host callback that opens M09 snapshot history from the Stats tab.
pub fn set_open_history(id: &str, open_history: Option<OpenHistory>, cx: &mut App) {
    if let Some(v) = view(id, cx) {
        v.update(cx, |v, _| v.set_open_history(open_history));
    }
}

/// Switches the Stats tab into multi-column dashboard layout when filled.
pub fn set_fill_width(id: &str, width: Option<f32>, cx: &mut App) {
    if let Some(v) = view(id, cx) {
        v.update(cx, |v, cx| v.set_fill_width(width, cx));
    }
}

/// Version-specific host API; the caller passes the actual entry/module
/// before any legacy nav_target conversion and maps Open directly to Target.
pub fn panel(
    id: &str,
    book: &str,
    scope: Scope,
    locale: Locale,
    platform: Platform,
    open: Option<Open>,
    cx: &mut App,
) -> gpui::AnyElement {
    let key: SharedString = id.to_owned().into();
    let Some(hub) = cx.try_global::<crate::Hub>() else {
        return gpui::Empty.into_any_element();
    };
    let lib = hub.lib.clone();
    let existing = hub.v3_views.get(&key).cloned();
    let mine = hub.recorder.as_ref().and_then(|r| r.today(book));
    if existing.as_ref().is_none_or(|v| v.read(cx).book != book)
        && let Some(r) = hub.recorder.as_ref()
    {
        r.track(book);
    }
    let view = existing.unwrap_or_else(|| {
        let v = cx.new(|_| View::new(key.clone(), lib));
        let weak = v.downgrade();
        cx.observe_global::<LiveWords>(move |cx| {
            if let Some(v) = weak.upgrade() {
                v.update(cx, |_, cx| cx.notify());
            }
        })
        .detach();
        cx.global_mut::<crate::Hub>()
            .v3_views
            .insert(key, v.clone());
        v
    });
    view.update(cx, |v, cx| {
        v.show(book, scope, locale, platform, open, cx);
        v.set_mine(mine, cx);
    });
    view.into_any_element()
}

pub fn view(id: &str, cx: &App) -> Option<Entity<View>> {
    cx.try_global::<crate::Hub>()
        .and_then(|h| h.v3_views.get(&SharedString::from(id.to_owned())).cloned())
}
