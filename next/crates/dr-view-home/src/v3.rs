//! Versioned Project Home. Template actions create entries through F3; the
//! legacy chapter/idea/category routes are never used by this page.

use std::rc::Rc;

use dr_i18n::{keys, number::compact};
use dr_shell::{
    Services, Settings, Workspace,
    book::Book,
    nav::{Open, Target},
    t,
};
use dr_ui::{
    Theme,
    components::{Button, Dialog, PanelIconButton},
    fonts::Role,
    input::{
        TextArea,
        field::{FieldEvent, TextField},
    },
    sand::{Icon, KindMark, Readout},
    style::DrStyled,
    tokens::radius,
};
use dr_view_stats::{
    LiveWords,
    v3::{Loaded, Scope},
};
use dr_workspace::{
    Actor, RecordKey, Workspace as Library, WritePreconditions, WsError,
    commands::v3::entry::CreateIn, dto::FieldInfo,
};
use gpui::{
    AppContext as _, Context, ElementId, Entity, Focusable, IntoElement, ParentElement, Render,
    Styled, Subscription, Task, WeakEntity, Window, div, prelude::*, px,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateAction {
    pub level: String,
    pub level_title: String,
    pub id: String,
    pub name: String,
    pub template: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentPage {
    pub target: Target,
    pub title: String,
}

/// Device-local navigation preserves the selected entry module.
pub fn recent(lib: &Library, book: &Book) -> Result<Vec<RecentPage>, WsError> {
    let Some(v3) = book.v3() else {
        return Ok(Vec::new());
    };
    let result = lib.call(
        &Actor::User,
        "recent.list",
        serde_json::json!({"book":book.id,"limit":4}),
    )?;
    let rows = result["output"]
        .as_array()
        .ok_or_else(|| WsError::Internal("recent.list did not return an array".into()))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            if row["book"].as_str()? != book.id {
                return None;
            }
            let raw = &row["target"];
            let id = raw["id"].as_str()?;
            match raw["kind"].as_str()? {
                "entry" => Some(RecentPage {
                    target: Target::Entry {
                        id: id.parse().ok()?,
                        module: raw["module"].as_str().map(str::parse).transpose().ok()?,
                    },
                    title: v3.entry(id)?.title.clone(),
                }),
                "material" => Some(RecentPage {
                    target: Target::Material(id.parse().ok()?),
                    title: book
                        .material_items()
                        .iter()
                        .find(|m| m.id == id)?
                        .title
                        .clone(),
                }),
                _ => None,
            }
        })
        .collect())
}

/// Resident levels only. Memberships do not duplicate an action and a hidden
/// ancestor cannot leave its descendants' create buttons on Home.
pub fn actions(book: &Book) -> Vec<CreateAction> {
    let Some(v) = book.v3() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut todo: Vec<_> = v.roots.iter().rev().cloned().collect();
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = todo.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(entry) = v.entry(&id) else {
            continue;
        };
        let Some(level) = v.levels.get(&id) else {
            continue;
        };
        if let Some(template) = v.template_of(&id) {
            for verb in &template.verbs {
                if verb
                    .target_template
                    .as_ref()
                    .is_none_or(|id| v.template(id).is_some())
                {
                    out.push(CreateAction {
                        level: id.clone(),
                        level_title: entry.title.clone(),
                        id: verb.id.clone(),
                        name: verb.name.clone(),
                        template: verb.target_template.clone(),
                    });
                }
            }
        }
        todo.extend(level.children.iter().rev().cloned());
    }
    out
}

/// The button text of `action` among `all`: its name, followed by the
/// title of the level that declares it when another action has the same
/// name (a book with several manuscripts has a 「新建章节」 for each).
pub fn action_label(all: &[CreateAction], action: &CreateAction) -> String {
    if all.iter().filter(|a| a.name == action.name).count() > 1 {
        format!("{} · {}", action.name, action.level_title)
    } else {
        action.name.clone()
    }
}

/// A new entry is a partial operation. No read snapshot is ever written back.
/// Re-check a dialog's declaration before creating; changed actions keep the
/// title draft and report a conflict rather than silently choosing a new kind.
pub fn create(
    lib: &Library,
    book: &str,
    action: &CreateAction,
    title: &str,
) -> Result<String, WsError> {
    // An action is declared by a level and its template. Observe both before
    // re-checking it: the new entry is held to the declaration it was chosen
    // from, not to the rest of the book.
    let declared = lib.observe_records(
        &format!("book:{book}"),
        &[
            RecordKey::entry(&action.level),
            RecordKey::collection("templates"),
        ],
    )?;
    let current = Book::load(lib, book)?;
    if !actions(&current).iter().any(|a| a == action) {
        return Err(WsError::Conflict("home action changed".into()));
    }
    let result = lib.call_guarded(
        &Actor::User,
        "entry.create",
        serde_json::to_value(CreateIn {
            book: book.into(),
            title: title.into(),
            mark: None,
            parent: Some(action.level.clone()),
            host: None,
            template: action.template.clone(),
            level: None,
            bodies: Default::default(),
            auto_link: None,
        })
        .expect("serializable entry input"),
        WritePreconditions::from_records(declared),
    )?;
    result["output"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| WsError::Internal("entry.create did not return an id".into()))
}

pub struct Home {
    pub(crate) ws: WeakEntity<Workspace>,
    pub(crate) lib: Option<Library>,
    /// The book the page's numbers ([`Self::loaded`]) are read from.
    pub(crate) source: Option<Rc<Book>>,
    pub loaded: Option<Loaded>,
    recent: Vec<RecentPage>,
    facts: Vec<FieldInfo>,
    fact_key: Entity<TextField>,
    fact_value: Entity<TextField>,
    task: Option<Task<()>>,
    generation: u64,
    stale: bool,
    error: bool,
    pub(crate) inline: crate::project_template::InlineState,
    pub(crate) agent_cards: crate::agent_cards::HomeAgentCards,
    _events: Option<dr_workspace::Subscription>,
    _live: Vec<Subscription>,
}

impl Home {
    /// How many times Home has started reading the book's numbers (for tests).
    pub fn reads(&self) -> u64 {
        self.generation
    }

    /// Current `成书` (`project.book`) state synced or optimistically flipped on Home.
    pub fn has_book(&self) -> bool {
        self.inline.has_book
    }

    /// Whether the book shown is a template's working copy (编辑模板的工作区,
    /// DW's `Workspace::is_working_copy`): Home then draws no source row, no
    /// 「另存为项目模板」 and no word lines at the top.
    pub fn template_workspace(&self) -> bool {
        self.inline.template_copy
    }

    pub fn title_input(&self) -> &Entity<TextArea> {
        &self.inline.title
    }

    pub fn synopsis_input(&self) -> &Entity<TextArea> {
        &self.inline.synopsis
    }

    pub fn word_target_input(&self) -> &Entity<TextField> {
        &self.inline.word_target
    }

    pub fn daily_word_target_input(&self) -> &Entity<TextField> {
        &self.inline.daily_word_target
    }

    pub fn agent_name_input(&self) -> &Entity<TextField> {
        &self.inline.agent_name
    }

    pub fn agent_description_input(&self) -> &Entity<TextField> {
        &self.inline.agent_description
    }

    pub fn agent_instructions_input(&self) -> &Entity<TextArea> {
        &self.inline.agent_instructions
    }

    pub fn new(ws: WeakEntity<Workspace>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        let (inline, mut live) = crate::project_template::InlineState::new(window, cx);
        // Its fields are stored as an entry page's title is: through the
        // shell's release gate.
        if let Some(lib) = &lib {
            dr_view_page::settlement::register(lib, window.window_handle(), cx);
        }
        live.push(cx.observe_global::<crate::PendingTitleFocus>(|_, cx| cx.notify()));
        live.push(cx.observe_global::<dr_view_stats::WritingDaysChanged>(|_, cx| cx.notify()));
        live.push(cx.observe_global::<LiveWords>(|_, cx| cx.notify()));
        cx.defer_in(window, |h, window, cx| {
            if let Some(ws) = h.ws.upgrade() {
                let book = ws.read(cx).book.clone();
                h.sync_book(&book, cx);
                h._live.push(cx.observe_in(&ws, window, |h, ws, _, cx| {
                    let book = ws.read(cx).book.clone();
                    let changed = h.source.as_ref().is_none_or(|s| !Rc::ptr_eq(s, &book))
                        || book
                            .v3()
                            .is_some_and(|v| h.inline.synced_revision() != v.revision);
                    if changed {
                        h.sync_book(&book, cx);
                        cx.notify();
                    }
                }));
            }
        });
        let fact_key_ph = t(cx, keys::shell_ui::FACT_KEY_PLACEHOLDER);
        let fact_val_ph = t(cx, keys::shell_ui::FACT_VALUE_PLACEHOLDER);
        let fact_key = cx.new(|cx| {
            TextField::new("v3-home-fact-key", window, cx)
                .placeholder(fact_key_ph)
                .small()
        });
        let fact_value = cx.new(|cx| {
            TextField::new("v3-home-fact-value", window, cx)
                .placeholder(fact_val_ph)
                .small()
        });
        live.push(cx.subscribe_in(&fact_value, window, |h, _, ev, _, cx| {
            if matches!(ev, FieldEvent::Submitted(_)) {
                h.add_fact(cx);
            }
        }));
        let mut this = Self {
            ws,
            lib,
            source: None,
            loaded: None,
            recent: Vec::new(),
            facts: Vec::new(),
            fact_key,
            fact_value,
            task: None,
            generation: 0,
            stale: false,
            error: false,
            inline,
            agent_cards: Default::default(),
            _events: None,
            _live: live,
        };
        if let Some(lib) = &this.lib {
            let (tx, mut rx) = futures::channel::mpsc::unbounded();
            this._events = Some(lib.subscribe(move |event| {
                let book = match event {
                    dr_workspace::WsEvent::Prose(p) => p.book.as_ref().map(ToString::to_string),
                    // The words of a document that has text (not the book
                    // document's own, always empty, index row).
                    dr_workspace::WsEvent::Local(c) if dr_workspace::is_text_index(c) => {
                        Some(String::new())
                    }
                    dr_workspace::WsEvent::Local(c) if c.table == "recent" => Some(c.key.clone()),
                    // Another device's words for today. A writing day is no
                    // change to the book document (the shell does not read
                    // the book again for it); it comes here.
                    dr_workspace::WsEvent::Stats(s) => Some(s.book.to_string()),
                    _ => None,
                };
                if let Some(book) = book {
                    let _ = tx.unbounded_send(book);
                }
            }));
            cx.spawn(async move |this, cx| {
                use futures::StreamExt as _;
                while let Some(book) = rx.next().await {
                    if this
                        .update(cx, |h, cx| {
                            if h.source
                                .as_ref()
                                .is_some_and(|b| book.is_empty() || b.id == book)
                            {
                                h.stale = true;
                                cx.notify();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        this
    }

    fn reload(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        // While the shell lets go of the library no new read takes it up
        // (the page is let go of next).
        if dr_shell::release::is_releasing(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.source.as_ref().is_none_or(|old| old.id != book.id) {
            self.loaded = None;
            self.recent.clear();
            self.facts.clear();
            dr_view_stats::track_book(&book.id, cx);
        }
        self.source = Some(book.clone());
        self.stale = false;
        self.error = false;
        self.generation += 1;
        let generation = self.generation;
        let id = book.id.clone();
        let today = dr_model::Day::parse(&crate::today(cx).to_string()).expect("valid local day");
        self.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(60))
                .await;
            let loaded = cx
                .background_executor()
                .spawn(async move {
                    let data = dr_view_stats::v3::load_at(&lib, &id, Scope::Book, &today)?;
                    let book = Book::load(&lib, &id)?;
                    let facts: Vec<FieldInfo> = lib
                        .call(&Actor::User, "fact.list", serde_json::json!({"book": &id}))
                        .ok()
                        .and_then(|v| v["output"].as_array().cloned())
                        .map(|arr| {
                            arr.into_iter()
                                .filter_map(|item| {
                                    Some(FieldInfo {
                                        id: item["id"].as_str()?.to_owned(),
                                        key: item["key"].as_str()?.to_owned(),
                                        value: item["value"].as_str().unwrap_or("").to_owned(),
                                        pos: item["pos"].as_str().map(str::to_owned),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Ok::<_, WsError>((data, recent(&lib, &book)?, facts))
                })
                .await;
            this.update(cx, |h, cx| {
                if generation != h.generation {
                    return;
                }
                h.task = None;
                match loaded {
                    Ok((loaded, recent, facts)) => {
                        h.loaded = Some(loaded);
                        h.recent = recent;
                        h.facts = facts;
                        h.sync_synopsis(cx);
                    }
                    Err(error) => {
                        log::warn!("v3 home read failed: {error}");
                        h.loaded = None;
                        h.error = true;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn add_fact(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let Some(book) = self.source.as_ref().map(|b| b.id.clone()) else {
            return;
        };
        let key = self.fact_key.read(cx).text().trim().to_owned();
        let value = self.fact_value.read(cx).text().trim().to_owned();
        if key.is_empty() {
            return;
        }
        self.fact_key.update(cx, |f, cx| f.set_text("", cx));
        self.fact_value.update(cx, |f, cx| f.set_text("", cx));
        cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    lib.call(
                        &Actor::User,
                        "fact.put",
                        serde_json::json!({ "book": book, "key": key, "value": value }),
                    )
                })
                .await;
            if let Err(err) = res {
                log::warn!("fact.put failed: {err}");
            } else {
                let _ = this.update(cx, |h, cx| {
                    h.stale = true;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn remove_fact(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let Some(book) = self.source.as_ref().map(|b| b.id.clone()) else {
            return;
        };
        self.facts.retain(|f| f.id != id);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move {
                    lib.call(
                        &Actor::User,
                        "fact.remove",
                        serde_json::json!({ "book": book, "id": id }),
                    )
                })
                .await;
            if let Err(err) = res {
                log::warn!("fact.remove failed: {err}");
                let _ = this.update(cx, |h, cx| {
                    h.stale = true;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn ask_create(
        &mut self,
        action: CreateAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<CreateDialog>> {
        let lib = self.lib.clone()?;
        let ws = self.ws.upgrade()?;
        let book = ws.read(cx).book_id.clone();
        let weak = self.ws.clone();
        let dialog = cx.new(|cx| CreateDialog::new(lib, weak, book, action, window, cx));
        dr_shell::dialogs::show_in(window.window_handle(), cx, dialog.clone().into());
        Some(dialog)
    }
}

impl Render for Home {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let book = self
            .ws
            .upgrade()
            .map(|ws| ws.read(cx).book.clone())
            .unwrap_or_default();
        self.sync_book(&book, cx);
        // PT3's new project: its title takes the caret, selected, on the
        // first frame Home shows it (also when it shows it already).
        if !book.id.is_empty()
            && self.inline.synced_book_id == book.id
            && crate::take_pending_title_focus(&book.id, cx)
        {
            let field = self.inline.title.clone();
            window.defer(cx, move |window, cx| {
                window.focus(&field.focus_handle(cx), cx);
                field.update(cx, |f, cx| f.select_all_text(cx));
            });
        }
        if book.v3().is_some()
            && (self.source.as_ref().is_none_or(|s| !Rc::ptr_eq(s, &book))
                || (self.stale && self.task.is_none()))
        {
            self.reload(book.clone(), cx);
        }
        let p = Theme::of(window, cx).palette;
        let locale = Settings::locale(cx);
        let synced_this_book = !book.id.is_empty() && self.inline.synced_book_id == book.id;
        let has_book = if synced_this_book {
            self.inline.has_book
        } else {
            self.loaded
                .as_ref()
                .map(|d| d.has_book)
                .or_else(|| book.v3().map(|v| v.project.book.is_some()))
                .unwrap_or(true)
        };
        let effective_word_target = if synced_this_book {
            (self.inline.targets_base[0] > 0).then_some(self.inline.targets_base[0])
        } else {
            self.loaded
                .as_ref()
                .and_then(|s| s.word_target)
                .filter(|n| *n > 0)
        };
        let effective_daily_target = if synced_this_book {
            (self.inline.targets_base[1] > 0).then_some(self.inline.targets_base[1])
        } else {
            self.loaded
                .as_ref()
                .and_then(|s| s.daily_word_target)
                .filter(|n| *n > 0)
        };
        let book_words_count = self
            .loaded
            .as_ref()
            .and_then(|s| s.book_words(LiveWords::read(cx)))
            .map(|m| m.words);
        let words = book_words_count
            .map(|total| {
                if let Some(target) = effective_word_target {
                    return dr_shell::strings::tf(
                        cx,
                        keys::project_home::WORDS_OF_TARGET,
                        &[
                            ("words", &compact(total, locale)),
                            ("target", &compact(target as u64, locale)),
                        ],
                    );
                }
                dr_shell::strings::tf(
                    cx,
                    keys::project_home::WORDS,
                    &[("words", &compact(total, locale))],
                )
            })
            .unwrap_or_else(|| t(cx, keys::common::COUNTING));
        let book_progress = book_words_count
            .zip(effective_word_target)
            .filter(|&(_, target)| target > 0)
            .map(|(total, target)| (total as f32 / target as f32).clamp(0.0, 1.0));
        // The title field is named for the project; without a name, as the
        // placeholder it shows (an entry's title shows only that).
        let title_label: gpui::SharedString = match book.name.trim() {
            "" => t(cx, keys::common::UNTITLED),
            name => name.to_owned().into(),
        };
        let synopsis_placeholder = t(cx, keys::chapter_editor::SYNOPSIS_PLACEHOLDER);
        // A template's working copy has no word lines at the top.
        let word_lines = has_book && !self.inline.template_copy;
        let title_failed = self.failed_line(crate::Field::Title, window, cx);
        let synopsis_failed = self.failed_line(crate::Field::Synopsis, window, cx);
        let mut column = div()
            .w_full()
            .pt(px(64.0))
            .px(px(48.0))
            .pb(px(128.0))
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::project_home::KICKER)),
            )
            .child(
                div()
                    .id("v3-home-title-input")
                    .debug_selector(|| "v3-home-title-input".into())
                    .role(gpui::Role::TextInput)
                    .aria_label(title_label)
                    .font_role(Role::Prose)
                    .type_px(34.0, 44.0)
                    .text_color(p.ink(1).solid())
                    .child(self.inline.title.clone()),
            )
            .children(title_failed)
            .child(
                div()
                    .id("v3-home-synopsis-input")
                    .debug_selector(|| "v3-home-synopsis-input".into())
                    .role(gpui::Role::TextInput)
                    .aria_label(synopsis_placeholder)
                    .max_w(px(640.0))
                    .font_role(Role::Ui)
                    .type_px(16.0, 26.0)
                    .text_color(p.ink(2).solid())
                    .child(self.inline.synopsis.clone()),
            )
            .children(synopsis_failed);
        if !self.error && word_lines {
            let mut word_card = div().flex().flex_col().gap(px(6.0)).max_w(px(460.0)).child(
                div()
                    .id("v3-home-words")
                    .debug_selector(|| "v3-home-words".into())
                    .role(gpui::Role::Label)
                    .aria_label(words.clone())
                    .font_role(Role::Index)
                    .type_px(14.0, 20.0)
                    .text_color(p.ink(2).solid())
                    .child(words),
            );
            if let Some(value) = book_progress {
                word_card =
                    word_card.child(Readout::new("v3-home-words-bar", value).color(p.ink(2)));
            }
            column = column.child(word_card);
        }
        if self.error {
            let home = cx.weak_entity();
            column = column.child(
                Button::new("v3-home-retry", t(cx, keys::manuscript_export::RETRY)).on_click(
                    move |_, _, cx| {
                        home.update(cx, |h, cx| {
                            h.stale = true;
                            cx.notify();
                        })
                        .ok();
                    },
                ),
            );
        }
        if let Some(loaded) = &self.loaded {
            if word_lines {
                let today = dr_view_stats::model::today_words(
                    &loaded.days,
                    dr_view_stats::today_live(&book.id, cx),
                );
                let streak = if today > 0 {
                    loaded.days.streak_before + 1
                } else {
                    0
                };
                let today_progress = effective_daily_target
                    .filter(|&g| g > 0)
                    .map(|g| (today.max(0) as f32 / g as f32).clamp(0.0, 1.0));
                let today_text = if let Some(goal) = effective_daily_target {
                    dr_shell::strings::tf(
                        cx,
                        keys::project_home::TODAY,
                        &[
                            (
                                "today",
                                &dr_i18n::number::grouped(today.max(0) as u64, locale),
                            ),
                            ("goal", &dr_i18n::number::grouped(goal as u64, locale)),
                            ("streak", &streak),
                        ],
                    )
                } else {
                    dr_shell::strings::tf(
                        cx,
                        keys::project_home::TODAY_NO_GOAL,
                        &[
                            (
                                "today",
                                &dr_i18n::number::grouped(today.max(0) as u64, locale),
                            ),
                            ("streak", &streak),
                        ],
                    )
                };
                let mut today_block = div().flex().flex_col().gap(px(6.0)).max_w(px(460.0)).child(
                    div()
                        .id("v3-home-today")
                        .debug_selector(|| "v3-home-today".into())
                        .role(gpui::Role::Label)
                        .aria_label(today_text.clone())
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(3).solid())
                        .child(today_text),
                );
                if let Some(value) = today_progress {
                    today_block =
                        today_block.child(Readout::new("v3-home-today-bar", value).color(p.accent));
                }
                column = column.child(today_block);
            }
            let mut pages = self.recent.clone();
            if pages.is_empty() {
                let first = loaded
                    .documents
                    .iter()
                    .filter_map(|d| Some((d, book.v3()?.entry(d.entry.as_deref()?)?)))
                    .max_by_key(|(_, entry)| entry.updated_at.or(entry.created_at));
                if let Some((doc, entry)) = first {
                    pages.push(RecentPage {
                        target: Target::Entry {
                            id: entry.id.parse().expect("validated entry id"),
                            module: doc
                                .module
                                .as_deref()
                                .map(str::parse)
                                .transpose()
                                .expect("validated module id"),
                        },
                        title: entry.title.clone(),
                    });
                } else if let Some(entry) = book.v3().and_then(|v| {
                    v.entries
                        .iter()
                        .filter(|e| {
                            v.is_content(&e.id) && {
                                let mut cur = e.parent.as_deref();
                                let mut seen = std::collections::BTreeSet::new();
                                loop {
                                    let Some(pid) = cur else { break true };
                                    if !seen.insert(pid) {
                                        break false;
                                    }
                                    let Some(p) = v.entry(pid) else { break false };
                                    cur = p.parent.as_deref();
                                }
                            }
                        })
                        .max_by_key(|e| e.updated_at.or(e.created_at))
                }) {
                    pages.push(RecentPage {
                        target: Target::Entry {
                            id: entry.id.parse().expect("validated entry id"),
                            module: None,
                        },
                        title: entry.title.clone(),
                    });
                }
            }
            if !pages.is_empty() {
                let whole_btn = (has_book)
                    .then(|| book.v3()?.roots.first().cloned())
                    .flatten()
                    .and_then(|root| root.parse::<dr_model::id::EntryId>().ok())
                    .map(|root_id| {
                        let ws = self.ws.clone();
                        let expected_book = book.id.clone();
                        Button::new(
                            "v3-home-open-whole-book",
                            t(cx, keys::shell_ui::OPEN_WHOLE_BOOK),
                        )
                        .text()
                        .small()
                        .icon(Icon::OpenBook)
                        .on_click(move |_, _, cx| {
                            ws.update(cx, |ws, cx| {
                                if ws.book_id == expected_book {
                                    ws.open(Target::Book(root_id.clone()), Open::KEEP, cx);
                                }
                            })
                            .ok();
                        })
                    });
                let mut continue_card = div().flex().flex_col().items_start().gap(px(4.0)).child(
                    div()
                        .w_full()
                        .pb(px(4.0))
                        .border_b(px(0.5))
                        .border_color(p.subtle_hairline())
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .font_role(Role::Structure)
                                .type_px(14.0, 20.0)
                                .text_color(p.ink(2).solid())
                                .child(t(cx, keys::project_home::continue_::TITLE)),
                        )
                        .children(whole_btn),
                );
                for (i, page) in pages.into_iter().enumerate() {
                    let ws = self.ws.clone();
                    let expected_book = book.id.clone();
                    let (mark, color) = book.mark(&page.target);
                    let mut km = KindMark::new(
                        ElementId::Name(format!("v3-home-continue-mark-{i}").into()),
                        mark,
                    );
                    if let Some(c) = color {
                        km = km.color(c);
                    }
                    let row_selector = format!("v3-home-continue-{i}-row");
                    let btn_selector = format!("v3-home-continue-{i}");
                    continue_card = continue_card.child(
                        div()
                            .id(ElementId::Name(format!("v3-home-continue-{i}").into()))
                            .debug_selector(move || row_selector)
                            .max_w_full()
                            .min_w_0()
                            .py(px(4.0))
                            .pr(px(8.0))
                            .rounded(px(radius::SM))
                            .cursor_pointer()
                            .hover(|st| st.bg(p.desk.alpha(0.55)))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .on_click(move |_, _, cx| {
                                ws.update(cx, |ws, cx| {
                                    if ws.book_id == expected_book {
                                        ws.open(page.target.clone(), Open::KEEP, cx);
                                    }
                                })
                                .ok();
                            })
                            .child(km)
                            .child(
                                div()
                                    .debug_selector(move || btn_selector)
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .font_role(Role::Ui)
                                    .type_px(14.0, 20.0)
                                    .text_color(p.ink(1).solid())
                                    .child(page.title),
                            ),
                    );
                }
                column = column.child(continue_card);
            }
        }
        // HC: the Agent's suggestion cards, below 继续写 (`agent_cards.rs`).
        if let Some(cards) = self.agent_cards(window, cx) {
            column = column.child(cards);
        }
        let mut creations = div()
            .id("v3-home-create-row")
            .debug_selector(|| "v3-home-create-row".into())
            .flex()
            .flex_wrap()
            .gap(px(12.0));
        let all = actions(&book);
        for action in all.clone() {
            let home = cx.weak_entity();
            creations = creations.child(
                Button::new(
                    ElementId::Name(
                        format!("v3-home-create-{}-{}", action.level, action.id).into(),
                    ),
                    action_label(&all, &action),
                )
                .on_click(move |_, window, cx| {
                    home.update(cx, |h, cx| {
                        h.ask_create(action.clone(), window, cx);
                    })
                    .ok();
                }),
            );
        }
        // The workspace tour's 新建 step rings the row (M24).
        column = column
            .child(dr_shell::pages::anchor(
                dr_shell::pages::anchors::HOME_CREATE,
                creations,
                cx,
            ))
            .child(
                div()
                    .font_role(Role::Structure)
                    .child(t(cx, keys::project_home::book::TITLE)),
            );
        if let Some(v3) = book.v3() {
            let mut overview = div().flex().flex_row().flex_wrap().gap(px(10.0));
            for id in &v3.roots {
                let Some(entry) = v3.entry(id) else {
                    continue;
                };
                let target = Target::Entry {
                    id: id.parse().expect("validated entry id"),
                    module: None,
                };
                let ws = self.ws.clone();
                let (mark, color) = book.mark(&target);
                let mut km =
                    KindMark::new(ElementId::Name(format!("v3-home-mark-{id}").into()), mark);
                if let Some(c) = color {
                    km = km.color(c);
                }
                let child_count = v3
                    .levels
                    .get(id)
                    .map_or(0, |l| l.children.len() + l.members.len());
                overview = overview.child(
                    div()
                        .min_w(px(180.0))
                        .rounded(px(radius::MD))
                        .bg(p.desk.alpha(0.35))
                        .border(px(0.5))
                        .border_color(p.subtle_hairline())
                        .px(px(12.0))
                        .py(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(km)
                        .child(
                            Button::new(
                                ElementId::Name(format!("v3-home-entry-{id}").into()),
                                entry.title.clone(),
                            )
                            .text()
                            .on_click(move |_, _, cx| {
                                ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx))
                                    .ok();
                            }),
                        )
                        .when(child_count > 0, |el| {
                            el.child(
                                div()
                                    .ml_auto()
                                    .font_role(Role::Index)
                                    .type_px(12.0, 16.0)
                                    .text_color(p.muted().solid())
                                    .child(child_count.to_string()),
                            )
                        }),
                );
            }
            column = column.child(overview);
        }
        // Project Facts (`项目设定`, backed by `fact.list` / `fact.put` / `fact.remove`).
        if !self.inline.template_copy && !book.id.is_empty() {
            let mut facts_card = div()
                .id("v3-home-facts")
                .rounded(px(radius::MD))
                .bg(p.desk.alpha(0.35))
                .border(px(0.5))
                .border_color(p.subtle_hairline())
                .p(px(14.0))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .font_role(Role::Structure)
                        .type_px(14.0, 20.0)
                        .text_color(p.ink(2).solid())
                        .child(t(cx, keys::shell_ui::PROJECT_FACTS)),
                );
            for fact in self.facts.clone() {
                let fid = fact.id.clone();
                facts_card = facts_card.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .gap(px(10.0))
                        .py(px(2.0))
                        .child(
                            div()
                                .w(px(120.0))
                                .flex_none()
                                .font_role(Role::Index)
                                .type_px(13.0, 18.0)
                                .text_color(p.ink(3).solid())
                                .truncate()
                                .child(fact.key),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .font_role(Role::Ui)
                                .type_px(14.0, 20.0)
                                .text_color(p.ink(1).solid())
                                .child(fact.value),
                        )
                        .child(
                            PanelIconButton::new(
                                ElementId::Name(format!("v3-home-fact-del-{}", fact.id).into()),
                                Icon::Close,
                            )
                            .label(t(cx, keys::common::DELETE))
                            .on_click(
                                cx.listener(move |h, _, _, cx| h.remove_fact(fid.clone(), cx)),
                            ),
                        ),
                );
            }
            facts_card = facts_card.child(
                div()
                    .pt(px(4.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(132.0)).flex_none().child(self.fact_key.clone()))
                    .child(div().flex_1().min_w_0().child(self.fact_value.clone()))
                    .child(
                        Button::new("v3-home-fact-add", t(cx, keys::shell_ui::ADD_FACT))
                            .small()
                            .on_click(cx.listener(|h, _, _, cx| h.add_fact(cx))),
                    ),
            );
            column = column.child(facts_card);
        }
        column = column.child(self.render_project_template_block(&book, has_book, window, cx));
        div()
            .id("project-home-v3")
            .size_full()
            .overflow_y_scroll()
            .child(column)
    }
}

pub struct CreateDialog {
    lib: Library,
    ws: WeakEntity<Workspace>,
    book: String,
    pub action: CreateAction,
    pub title: Entity<TextField>,
    pub error: Option<String>,
    pub busy: bool,
    _field: Subscription,
}

impl CreateDialog {
    fn new(
        lib: Library,
        ws: WeakEntity<Workspace>,
        book: String,
        action: CreateAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let placeholder = t(cx, keys::k4_book::UNTITLED_ENTRY);
        let title =
            cx.new(|cx| TextField::new("v3-home-new-title", window, cx).placeholder(placeholder));
        title.focus_handle(cx).focus(window, cx);
        let sub = cx.subscribe_in(&title, window, |d, _, event, window, cx| match event {
            FieldEvent::Submitted(_) => d.submit(window, cx),
            FieldEvent::Cancelled => d.close(cx),
            FieldEvent::Changed(_) => cx.notify(),
            _ => {}
        });
        Self {
            lib,
            ws,
            book,
            action,
            title,
            error: None,
            busy: false,
            _field: sub,
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.title.read(cx).text().trim().to_owned();
        if self.busy || title.is_empty() {
            return;
        }
        self.busy = true;
        self.error = None;
        self.title.update(cx, |f, cx| f.set_disabled(true, cx));
        let (lib, book, action) = (self.lib.clone(), self.book.clone(), self.action.clone());
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { create(&lib, &book, &action, &title) })
                .await;
            this.update_in(cx, |d, _, cx| {
                d.busy = false;
                d.title.update(cx, |f, cx| f.set_disabled(false, cx));
                match result {
                    Ok(id) => {
                        d.ws.update(cx, |ws, cx| {
                            if ws.book_id == d.book {
                                ws.open(
                                    Target::Entry {
                                        id: id.parse().expect("validated entry id"),
                                        module: None,
                                    },
                                    Open::KEEP,
                                    cx,
                                );
                            }
                        })
                        .ok();
                        d.close(cx);
                    }
                    Err(error) => {
                        d.error = Some(error.to_string());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Render for CreateDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let cancel = me.clone();
        let close = me.clone();
        let error = self.error.as_ref().map(|_| {
            div()
                .text_color(Theme::of(window, cx).palette.danger.solid())
                .child(t(cx, keys::common::SAVE_FAILED))
        });
        Dialog::new("v3-home-create-dialog", self.action.name.clone())
            .eyebrow(self.action.level_title.clone())
            .body(self.title.clone())
            .body(div().children(error))
            .action(
                Button::new("v3-home-create-cancel", t(cx, keys::common::CANCEL))
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| cancel.update(cx, |d, cx| d.close(cx))),
            )
            .action(
                Button::new("v3-home-create-submit", self.action.name.clone())
                    .primary()
                    .busy(self.busy)
                    .disabled(self.busy || self.title.read(cx).text().trim().is_empty())
                    .on_click(move |_, window, cx| me.update(cx, |d, cx| d.submit(window, cx))),
            )
            .on_close(move |_, cx| close.update(cx, |d, cx| d.close(cx)))
            .on_mist(|_, _| {})
    }
}
