//! Inline header fields (title, synopsis) and bottom 「项目模板」 block for
//! Project Home (`kernel-v5.md` §2 & §3, `v5-tracks.md` T2).

use std::collections::HashSet;
use std::rc::Rc;

use dr_i18n::keys;
use dr_shell::{book::Book, t};
use dr_ui::{
    Theme,
    components::{Button, Switch},
    fonts::Role,
    input::{AreaEvent, FieldEvent, TextArea, TextField},
    sand::{self, Icon},
    style::DrStyled as _,
    tokens::Palette,
};
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::v3::{
        project::{ProjectUpdate, ProjectUpdateIn},
        types::TemplateAgentConfig,
    },
};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, prelude::FluentBuilder as _, px,
};

use crate::v3::Home;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentField {
    Name,
    Description,
    Instructions,
}

pub(crate) struct InlineState {
    pub(crate) synced_book_id: String,
    synced_revision: String,
    pub(crate) pending_saves: usize,
    stale_revisions: HashSet<String>,
    pub(crate) stored_title: String,
    pub(crate) stored_synopsis: String,
    pub(crate) stored_has_book: bool,
    pub(crate) stored_word_target: i64,
    pub(crate) stored_daily_word_target: i64,
    pub(crate) stored_agent: Option<TemplateAgentConfig>,
    pub(crate) title: Entity<TextArea>,
    pub(crate) synopsis: Entity<TextArea>,
    pub(crate) word_target: Entity<TextField>,
    pub(crate) daily_word_target: Entity<TextField>,
    pub(crate) agent_name: Entity<TextField>,
    pub(crate) agent_description: Entity<TextField>,
    pub(crate) agent_instructions: Entity<TextArea>,
}

fn normalize_agent(
    name: String,
    description: String,
    instructions: String,
) -> Option<TemplateAgentConfig> {
    if name.is_empty() && description.is_empty() && instructions.is_empty() {
        None
    } else {
        Some(TemplateAgentConfig {
            name,
            description,
            instructions,
        })
    }
}

fn parse_word_target(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    trimmed
        .replace(',', "")
        .parse::<i64>()
        .ok()
        .filter(|&n| n >= 0)
}

fn read_book_summary(lib: Option<&Library>, book_id: &str) -> String {
    let Some(lib) = lib else {
        return String::new();
    };
    let Ok(parsed) = dr_model::id::BookId::parse(book_id) else {
        return String::new();
    };
    lib.read_book_v3(book_id, move |doc, _| {
        let bb = dr_doc::v3::BorrowedBookV3::new(doc, &parsed)
            .map_err(|e| WsError::Invalid(e.to_string()))?;
        Ok(bb.view().meta().summary)
    })
    .unwrap_or_default()
}

impl InlineState {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Home>) -> (Self, Vec<Subscription>) {
        let untitled = t(cx, keys::common::UNTITLED);
        let synopsis_placeholder = t(cx, keys::chapter_editor::SYNOPSIS_PLACEHOLDER);

        let title = cx.new(|cx| {
            TextArea::new("v3-home-title", window, cx)
                .submit_on_enter()
                .placeholder(untitled)
        });
        let synopsis = cx.new(|cx| {
            TextArea::new("v3-home-synopsis", window, cx).placeholder(synopsis_placeholder)
        });
        let word_target = cx.new(|cx| TextField::new("v3-home-word-target", window, cx).mono());
        let daily_word_target =
            cx.new(|cx| TextField::new("v3-home-daily-target", window, cx).mono());
        let agent_name = cx.new(|cx| TextField::new("v3-home-agent-name", window, cx));
        let agent_description =
            cx.new(|cx| TextField::new("v3-home-agent-description", window, cx));
        let agent_instructions =
            cx.new(|cx| TextArea::new("v3-home-agent-instructions", window, cx).framed(3.0));

        let subs = vec![
            cx.subscribe_in(&title, window, Home::on_title_event),
            cx.subscribe_in(&title, window, |home, _, _: &AreaEvent, window, cx| {
                home.inline.synopsis.focus_handle(cx).focus(window, cx);
            }),
            cx.subscribe_in(&synopsis, window, Home::on_synopsis_event),
            cx.subscribe_in(&word_target, window, Home::on_word_target_event),
            cx.subscribe_in(&daily_word_target, window, Home::on_daily_target_event),
            cx.subscribe_in(&agent_name, window, |h, _, ev, w, cx| {
                h.on_agent_event(AgentField::Name, ev, w, cx);
            }),
            cx.subscribe_in(&agent_description, window, |h, _, ev, w, cx| {
                h.on_agent_event(AgentField::Description, ev, w, cx);
            }),
            cx.subscribe_in(&agent_instructions, window, |h, _, ev, w, cx| {
                h.on_agent_event(AgentField::Instructions, ev, w, cx);
            }),
        ];

        let default_pb = dr_model::v3::ProjectBook::default();
        let state = Self {
            synced_book_id: String::new(),
            synced_revision: String::new(),
            pending_saves: 0,
            stale_revisions: HashSet::new(),
            stored_title: String::new(),
            stored_synopsis: String::new(),
            stored_has_book: true,
            stored_word_target: default_pb.word_target().unwrap_or(0),
            stored_daily_word_target: default_pb.daily_word_target().unwrap_or(0),
            stored_agent: None,
            title,
            synopsis,
            word_target,
            daily_word_target,
            agent_name,
            agent_description,
            agent_instructions,
        };
        (state, subs)
    }

    pub(crate) fn synced_revision(&self) -> &str {
        &self.synced_revision
    }
}

impl Home {
    pub(crate) fn sync_book(
        &mut self,
        book: &Rc<Book>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(v3) = book.v3() else {
            return;
        };
        let same_book = self.inline.synced_book_id == book.id;
        if same_book {
            if self.inline.synced_revision == v3.revision
                || self.inline.pending_saves > 0
                || self.inline.stale_revisions.contains(&v3.revision)
            {
                return;
            }
            self.inline.stale_revisions.clear();
        } else {
            self.inline.stale_revisions.clear();
        }

        let new_title = book.name.clone();
        let new_synopsis = read_book_summary(self.lib.as_ref(), &book.id);
        let new_has_book = v3.project.book.is_some();
        let (new_wt, new_dwt) = if let Some(pb) = &v3.project.book {
            crate::remember_book_targets(
                &book.id,
                pb.word_target_set,
                pb.daily_word_target_set,
                cx,
            );
            (
                pb.word_target.unwrap_or(0),
                pb.daily_word_target.unwrap_or(0),
            )
        } else if let Some((wt_set, dwt_set)) = crate::remembered_book_targets(&book.id, cx) {
            let pb = dr_model::v3::ProjectBook {
                word_target_set: wt_set,
                daily_word_target_set: dwt_set,
            };
            (
                pb.word_target().unwrap_or(0),
                pb.daily_word_target().unwrap_or(0),
            )
        } else {
            let pb = dr_model::v3::ProjectBook::default();
            (
                pb.word_target().unwrap_or(0),
                pb.daily_word_target().unwrap_or(0),
            )
        };
        let new_agent = v3
            .project
            .agent
            .clone()
            .and_then(|a| normalize_agent(a.name, a.description, a.instructions));

        let force = !same_book;
        self.inline.synced_book_id = book.id.clone();
        self.inline.synced_revision = v3.revision.clone();
        self.inline.stored_has_book = new_has_book;

        sync_text_area(
            &self.inline.title,
            &mut self.inline.stored_title,
            new_title,
            force,
            window,
            cx,
        );
        sync_text_area(
            &self.inline.synopsis,
            &mut self.inline.stored_synopsis,
            new_synopsis,
            force,
            window,
            cx,
        );

        let old_wt_str = self.inline.stored_word_target.to_string();
        let new_wt_str = new_wt.to_string();
        if sync_line_field(
            &self.inline.word_target,
            &old_wt_str,
            &new_wt_str,
            force,
            window,
            cx,
        ) {
            self.inline.stored_word_target = new_wt;
        }

        let old_dwt_str = self.inline.stored_daily_word_target.to_string();
        let new_dwt_str = new_dwt.to_string();
        if sync_line_field(
            &self.inline.daily_word_target,
            &old_dwt_str,
            &new_dwt_str,
            force,
            window,
            cx,
        ) {
            self.inline.stored_daily_word_target = new_dwt;
        }

        let old_an = self
            .inline
            .stored_agent
            .as_ref()
            .map(|a| a.name.as_str())
            .unwrap_or("");
        let old_ad = self
            .inline
            .stored_agent
            .as_ref()
            .map(|a| a.description.as_str())
            .unwrap_or("");
        let old_ai = self
            .inline
            .stored_agent
            .as_ref()
            .map(|a| a.instructions.as_str())
            .unwrap_or("");
        let new_an = new_agent.as_ref().map(|a| a.name.as_str()).unwrap_or("");
        let new_ad = new_agent
            .as_ref()
            .map(|a| a.description.as_str())
            .unwrap_or("");
        let new_ai = new_agent
            .as_ref()
            .map(|a| a.instructions.as_str())
            .unwrap_or("");

        let ok_an = sync_line_field(&self.inline.agent_name, old_an, new_an, force, window, cx);
        let ok_ad = sync_line_field(
            &self.inline.agent_description,
            old_ad,
            new_ad,
            force,
            window,
            cx,
        );
        let ok_ai = sync_area_value(
            &self.inline.agent_instructions,
            old_ai,
            new_ai,
            force,
            window,
            cx,
        );
        if force || (ok_an && ok_ad && ok_ai) {
            self.inline.stored_agent = new_agent;
        }

        if crate::take_pending_title_focus(&book.id, cx) {
            let field = self.inline.title.clone();
            window.defer(cx, move |window, cx| {
                window.focus(&field.focus_handle(cx), cx);
                field.update(cx, |f, cx| f.select_all_text(cx));
            });
        }
    }

    fn active_book_id(&self, cx: &gpui::App) -> Option<String> {
        if !self.inline.synced_book_id.is_empty() {
            return Some(self.inline.synced_book_id.clone());
        }
        self.ws
            .upgrade()
            .map(|ws| ws.read(cx).book_id.clone())
            .filter(|id| !id.is_empty())
    }

    fn run_project_update(
        &mut self,
        update: ProjectUpdateIn,
        on_err: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else {
            on_err(self, cx);
            return;
        };
        let book_id = update.book.clone();
        self.inline.pending_saves += 1;
        cx.spawn(async move |this, cx| {
            let outcome = cx
                .background_executor()
                .spawn(async move {
                    let pre_rev = lib
                        .read_book_v3(&book_id, |_, version| Ok(version))
                        .unwrap_or_default();
                    lib.run::<ProjectUpdate>(&Actor::User, update)?;
                    let post_rev = lib
                        .read_book_v3(&book_id, |_, version| Ok(version))
                        .unwrap_or_default();
                    Ok::<_, WsError>((pre_rev, post_rev))
                })
                .await;
            this.update(cx, |h, cx| {
                h.inline.pending_saves = h.inline.pending_saves.saturating_sub(1);
                match outcome {
                    Ok((pre_rev, post_rev)) => {
                        if !pre_rev.is_empty() && pre_rev != post_rev {
                            h.inline.stale_revisions.insert(pre_rev);
                        }
                    }
                    Err(error) => {
                        log::warn!("project.update on Project Home failed: {error}");
                        on_err(h, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn on_title_event(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => {
                self.store_title(cx);
                window.blur(cx);
            }
            FieldEvent::Cancelled => {
                let stored = self.inline.stored_title.clone();
                self.inline.title.update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_title(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    pub(crate) fn on_synopsis_event(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => {
                self.store_synopsis(cx);
                window.blur(cx);
            }
            FieldEvent::Cancelled => {
                let stored = self.inline.stored_synopsis.clone();
                self.inline
                    .synopsis
                    .update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_synopsis(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    pub(crate) fn on_word_target_event(
        &mut self,
        _: &Entity<TextField>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => {
                self.store_word_target(cx);
                window.blur(cx);
            }
            FieldEvent::Cancelled => {
                let stored = self.inline.stored_word_target.to_string();
                self.inline
                    .word_target
                    .update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_word_target(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    pub(crate) fn on_daily_target_event(
        &mut self,
        _: &Entity<TextField>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => {
                self.store_daily_word_target(cx);
                window.blur(cx);
            }
            FieldEvent::Cancelled => {
                let stored = self.inline.stored_daily_word_target.to_string();
                self.inline
                    .daily_word_target
                    .update(cx, |f, cx| f.set_text(stored, cx));
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_daily_word_target(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    fn on_agent_event(
        &mut self,
        which: AgentField,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            FieldEvent::Submitted(_) => {
                self.store_agent(cx);
                window.blur(cx);
            }
            FieldEvent::Cancelled => {
                let cfg = self.inline.stored_agent.as_ref();
                match which {
                    AgentField::Name => {
                        let s = cfg.map(|a| a.name.clone()).unwrap_or_default();
                        self.inline.agent_name.update(cx, |f, cx| f.set_text(s, cx));
                    }
                    AgentField::Description => {
                        let s = cfg.map(|a| a.description.clone()).unwrap_or_default();
                        self.inline
                            .agent_description
                            .update(cx, |f, cx| f.set_text(s, cx));
                    }
                    AgentField::Instructions => {
                        let s = cfg.map(|a| a.instructions.clone()).unwrap_or_default();
                        self.inline
                            .agent_instructions
                            .update(cx, |f, cx| f.set_text(s, cx));
                    }
                }
                window.blur(cx);
            }
            FieldEvent::Blurred => self.store_agent(cx),
            FieldEvent::Changed(_) => {}
        }
    }

    /// Saves the inline project title (`name`) if non-empty and changed. An
    /// empty title reverts the field to the stored title without writing.
    pub fn store_title(&mut self, cx: &mut Context<Self>) {
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        let raw = self.inline.title.read(cx).text();
        let trimmed = raw.trim().to_owned();
        if trimmed.is_empty() {
            let stored = self.inline.stored_title.clone();
            self.inline.title.update(cx, |f, cx| f.set_text(stored, cx));
            return;
        }
        if raw != trimmed {
            let clean = trimmed.clone();
            self.inline.title.update(cx, |f, cx| f.set_text(clean, cx));
        }
        if trimmed == self.inline.stored_title {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_title, trimmed.clone());
        let sent = trimmed.clone();
        let expected_book = book.clone();
        self.run_project_update(
            ProjectUpdateIn {
                book,
                name: Some(trimmed),
                ..Default::default()
            },
            move |h, cx| {
                if h.inline.synced_book_id == expected_book && h.inline.stored_title == sent {
                    h.inline.stored_title = prev.clone();
                    h.inline.title.update(cx, |f, cx| f.set_text(prev, cx));
                }
            },
            cx,
        );
    }

    /// Saves the inline project synopsis (`summary`) if changed.
    pub fn store_synopsis(&mut self, cx: &mut Context<Self>) {
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        let text = self.inline.synopsis.read(cx).text();
        if text == self.inline.stored_synopsis {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_synopsis, text.clone());
        let sent = text.clone();
        let expected_book = book.clone();
        self.run_project_update(
            ProjectUpdateIn {
                book,
                summary: Some(text),
                ..Default::default()
            },
            move |h, cx| {
                if h.inline.synced_book_id == expected_book && h.inline.stored_synopsis == sent {
                    h.inline.stored_synopsis = prev.clone();
                    h.inline.synopsis.update(cx, |f, cx| f.set_text(prev, cx));
                }
            },
            cx,
        );
    }

    /// Flips `成书` (`project.book`) in one `project.update`. Turning it back
    /// on restores the remembered word targets in the same write.
    pub fn set_has_book(&mut self, on: bool, cx: &mut Context<Self>) {
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        if on == self.inline.stored_has_book {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_has_book, on);
        let update = if on {
            if let Some((wt_set, dwt_set)) = crate::remembered_book_targets(&book, cx) {
                let pb = dr_model::v3::ProjectBook {
                    word_target_set: wt_set,
                    daily_word_target_set: dwt_set,
                };
                let wt = pb.word_target().unwrap_or(0);
                let dwt = pb.daily_word_target().unwrap_or(0);
                self.inline.stored_word_target = wt;
                self.inline.stored_daily_word_target = dwt;
                self.inline
                    .word_target
                    .update(cx, |f, cx| f.set_text(wt.to_string(), cx));
                self.inline
                    .daily_word_target
                    .update(cx, |f, cx| f.set_text(dwt.to_string(), cx));
                ProjectUpdateIn {
                    book: book.clone(),
                    has_book: Some(true),
                    word_target: Some(wt_set),
                    daily_word_target: Some(dwt_set),
                    ..Default::default()
                }
            } else {
                ProjectUpdateIn {
                    book: book.clone(),
                    has_book: Some(true),
                    ..Default::default()
                }
            }
        } else {
            ProjectUpdateIn {
                book: book.clone(),
                has_book: Some(false),
                ..Default::default()
            }
        };
        let expected_book = book;
        self.run_project_update(
            update,
            move |h, _| {
                if h.inline.synced_book_id == expected_book && h.inline.stored_has_book == on {
                    h.inline.stored_has_book = prev;
                }
            },
            cx,
        );
        cx.notify();
    }

    /// Saves the whole-book word target (`word_target`) if valid and changed;
    /// invalid input reverts to the stored value without writing.
    pub fn store_word_target(&mut self, cx: &mut Context<Self>) {
        if !self.inline.stored_has_book {
            return;
        }
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        let raw = self.inline.word_target.read(cx).text();
        let Some(next) = parse_word_target(&raw) else {
            let stored = self.inline.stored_word_target.to_string();
            self.inline
                .word_target
                .update(cx, |f, cx| f.set_text(stored, cx));
            return;
        };
        let clean = next.to_string();
        if raw != clean {
            self.inline
                .word_target
                .update(cx, |f, cx| f.set_text(clean, cx));
        }
        if next == self.inline.stored_word_target {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_word_target, next);
        let prev_remembered = crate::remembered_book_targets(&book, cx);
        let cur_dwt_set = prev_remembered.and_then(|(_, dwt)| dwt);
        crate::remember_book_targets(&book, Some(next), cur_dwt_set, cx);
        let expected_book = book.clone();
        self.run_project_update(
            ProjectUpdateIn {
                book,
                word_target: Some(Some(next)),
                ..Default::default()
            },
            move |h, cx| {
                if h.inline.synced_book_id == expected_book && h.inline.stored_word_target == next {
                    h.inline.stored_word_target = prev;
                    h.inline
                        .word_target
                        .update(cx, |f, cx| f.set_text(prev.to_string(), cx));
                    if let Some((wt_set, dwt_set)) = prev_remembered {
                        crate::remember_book_targets(&expected_book, wt_set, dwt_set, cx);
                    }
                }
            },
            cx,
        );
        cx.notify();
    }

    /// Saves the daily word target (`daily_word_target`) if valid and changed;
    /// invalid input reverts to the stored value without writing.
    pub fn store_daily_word_target(&mut self, cx: &mut Context<Self>) {
        if !self.inline.stored_has_book {
            return;
        }
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        let raw = self.inline.daily_word_target.read(cx).text();
        let Some(next) = parse_word_target(&raw) else {
            let stored = self.inline.stored_daily_word_target.to_string();
            self.inline
                .daily_word_target
                .update(cx, |f, cx| f.set_text(stored, cx));
            return;
        };
        let clean = next.to_string();
        if raw != clean {
            self.inline
                .daily_word_target
                .update(cx, |f, cx| f.set_text(clean, cx));
        }
        if next == self.inline.stored_daily_word_target {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_daily_word_target, next);
        let prev_remembered = crate::remembered_book_targets(&book, cx);
        let cur_wt_set = prev_remembered.and_then(|(wt, _)| wt);
        crate::remember_book_targets(&book, cur_wt_set, Some(next), cx);
        let expected_book = book.clone();
        self.run_project_update(
            ProjectUpdateIn {
                book,
                daily_word_target: Some(Some(next)),
                ..Default::default()
            },
            move |h, cx| {
                if h.inline.synced_book_id == expected_book
                    && h.inline.stored_daily_word_target == next
                {
                    h.inline.stored_daily_word_target = prev;
                    h.inline
                        .daily_word_target
                        .update(cx, |f, cx| f.set_text(prev.to_string(), cx));
                    if let Some((wt_set, dwt_set)) = prev_remembered {
                        crate::remember_book_targets(&expected_book, wt_set, dwt_set, cx);
                    }
                }
            },
            cx,
        );
        cx.notify();
    }

    /// Saves the project-level `写给 Agent` guidance if any of its three fields
    /// changed since the last saved/synced value.
    pub fn store_agent(&mut self, cx: &mut Context<Self>) {
        let Some(book) = self.active_book_id(cx) else {
            return;
        };
        let name = self.inline.agent_name.read(cx).text();
        let description = self.inline.agent_description.read(cx).text();
        let instructions = self.inline.agent_instructions.read(cx).text();
        let next = normalize_agent(name, description, instructions);
        if next == self.inline.stored_agent {
            return;
        }
        let prev = std::mem::replace(&mut self.inline.stored_agent, next.clone());
        let sent = next.clone();
        let expected_book = book.clone();
        self.run_project_update(
            ProjectUpdateIn {
                book,
                agent: Some(next),
                ..Default::default()
            },
            move |h, cx| {
                if h.inline.synced_book_id == expected_book && h.inline.stored_agent == sent {
                    let an = prev.as_ref().map(|a| a.name.clone()).unwrap_or_default();
                    let ad = prev
                        .as_ref()
                        .map(|a| a.description.clone())
                        .unwrap_or_default();
                    let ai = prev
                        .as_ref()
                        .map(|a| a.instructions.clone())
                        .unwrap_or_default();
                    h.inline.stored_agent = prev;
                    h.inline.agent_name.update(cx, |f, cx| f.set_text(an, cx));
                    h.inline
                        .agent_description
                        .update(cx, |f, cx| f.set_text(ad, cx));
                    h.inline
                        .agent_instructions
                        .update(cx, |f, cx| f.set_text(ai, cx));
                }
            },
            cx,
        );
    }

    /// Rendered summary text for the `来源` row of the active book, if the book
    /// carries `project.source` (used by both Project Home rendering and tests).
    pub fn template_source_text(&self, cx: &gpui::App) -> Option<String> {
        let book = self.ws.upgrade().map(|ws| ws.read(cx).book.clone())?;
        format_source_parts(&book, cx).map(|(_, _, summary)| summary)
    }

    pub(crate) fn render_project_template_block(
        &self,
        book: &Rc<Book>,
        has_book: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let weak_home = cx.weak_entity();

        let save_button = if crate::has_save_project_template(cx) && self.lib.is_some() {
            let click_home = weak_home.clone();
            let click_book = book.clone();
            Some(
                div()
                    .debug_selector(|| "v3-home-save-project-template".into())
                    .child(
                        Button::new(
                            "v3-home-save-project-template",
                            t(cx, keys::project_home::project_template::SAVE_AS),
                        )
                        .small()
                        .icon(Icon::MovableType)
                        .on_click(move |_, window, cx| {
                            let Some(h) = click_home.upgrade() else {
                                return;
                            };
                            let (workspace, Some(library)) = ({
                                let r = h.read(cx);
                                (r.ws.clone(), r.lib.clone())
                            }) else {
                                return;
                            };
                            crate::open_save_project_template(
                                crate::SaveProjectTemplateHost {
                                    workspace,
                                    library,
                                    book_id: click_book.id.clone(),
                                    book: click_book.clone(),
                                },
                                window,
                                cx,
                            );
                        }),
                    ),
            )
        } else {
            None
        };

        let header = div()
            .flex()
            .items_center()
            .gap(px(10.0))
            .pb(px(8.0))
            .border_b_1()
            .border_color(p.subtle_hairline())
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(17.0, 24.0)
                    .text_color(p.ink(1).solid())
                    .child(t(cx, keys::project_home::project_template::TITLE)),
            )
            .child(div().flex_1())
            .children(save_button);

        let mut block = div()
            .id("v3-home-project-template")
            .debug_selector(|| "v3-home-project-template".into())
            .mt(px(18.0))
            .flex()
            .flex_col()
            .child(header);

        if let Some((from_text, author, aria_summary)) = format_source_parts(book, cx) {
            let source_value = div()
                .id("v3-home-template-source")
                .debug_selector(|| "v3-home-template-source".into())
                .role(gpui::Role::Label)
                .aria_label(aria_summary)
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(8.0))
                .font_role(Role::Index)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(sand::icon(Icon::MovableType, 14.0, p.ink(3).solid()))
                .child(div().text_color(p.ink(2).solid()).child(from_text))
                .when_some(author, |d, author| {
                    d.child(sand::icon(Icon::NameSeal, 14.0, p.ink(3).solid()))
                        .child(
                            div()
                                .id("v3-home-template-source-author")
                                .debug_selector(|| "v3-home-template-source-author".into())
                                .child(author),
                        )
                });
            block = block.child(hrow(
                t(cx, keys::project_home::project_template::SOURCE),
                source_value.into_any_element(),
                false,
                p,
            ));
        }

        let in_book_label = t(cx, keys::v3_tabs::BOOK);
        let switch_home = weak_home;
        let has_book_value = div()
            .id("v3-home-has-book-toggle")
            .debug_selector(|| "v3-home-has-book-toggle".into())
            .role(gpui::Role::CheckBox)
            .aria_label(in_book_label.clone())
            .aria_toggled(if has_book {
                gpui::Toggled::True
            } else {
                gpui::Toggled::False
            })
            .child(
                Switch::new("v3-home-has-book", has_book).on_change(move |on, _, cx| {
                    switch_home.update(cx, |h, cx| h.set_has_book(on, cx)).ok();
                }),
            );
        block = block.child(hrow(
            in_book_label,
            has_book_value.into_any_element(),
            false,
            p,
        ));

        if has_book {
            let project_target_label = t(cx, keys::project_home::settings::PROJECT_TARGET);
            let daily_goal_label = t(cx, keys::project_home::settings::DAILY_GOAL);
            let words_unit = t(cx, keys::common::WORDS);

            let wt_value = div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .id("v3-home-word-target-input")
                        .debug_selector(|| "v3-home-word-target-input".into())
                        .role(gpui::Role::TextInput)
                        .aria_label(project_target_label.clone())
                        .w(px(110.0))
                        .child(self.inline.word_target.clone()),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(4).solid())
                        .child(words_unit.clone()),
                );
            block = block.child(hrow(
                project_target_label,
                wt_value.into_any_element(),
                false,
                p,
            ));

            let dwt_value = div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .id("v3-home-daily-target-input")
                        .debug_selector(|| "v3-home-daily-target-input".into())
                        .role(gpui::Role::TextInput)
                        .aria_label(daily_goal_label.clone())
                        .w(px(110.0))
                        .child(self.inline.daily_word_target.clone()),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(4).solid())
                        .child(words_unit),
                );
            block = block.child(hrow(
                daily_goal_label,
                dwt_value.into_any_element(),
                false,
                p,
            ));
        }

        let agent_name_label = t(cx, keys::template_editor::NAME);
        let agent_desc_label = t(cx, keys::template_editor::DESCRIPTION);
        let agent_inst_label = t(cx, keys::template_editor::INSTRUCTIONS);

        let agent_rows = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .w_full()
            .child(agent_subrow(
                agent_name_label.clone(),
                div()
                    .id("v3-home-agent-name-input")
                    .debug_selector(|| "v3-home-agent-name-input".into())
                    .role(gpui::Role::TextInput)
                    .aria_label(agent_name_label)
                    .flex_1()
                    .min_w_0()
                    .child(self.inline.agent_name.clone())
                    .into_any_element(),
                false,
                p,
            ))
            .child(agent_subrow(
                agent_desc_label.clone(),
                div()
                    .id("v3-home-agent-description-input")
                    .debug_selector(|| "v3-home-agent-description-input".into())
                    .role(gpui::Role::TextInput)
                    .aria_label(agent_desc_label)
                    .flex_1()
                    .min_w_0()
                    .child(self.inline.agent_description.clone())
                    .into_any_element(),
                false,
                p,
            ))
            .child(agent_subrow(
                agent_inst_label.clone(),
                div()
                    .id("v3-home-agent-instructions-input")
                    .debug_selector(|| "v3-home-agent-instructions-input".into())
                    .role(gpui::Role::TextInput)
                    .aria_label(agent_inst_label)
                    .flex_1()
                    .min_w_0()
                    .child(self.inline.agent_instructions.clone())
                    .into_any_element(),
                true,
                p,
            ));

        block = block.child(hrow(
            t(cx, keys::template_editor::FOR_AGENT),
            agent_rows.into_any_element(),
            true,
            p,
        ));

        block.into_any_element()
    }
}

fn format_source_parts(
    book: &Book,
    cx: &gpui::App,
) -> Option<(SharedString, Option<String>, String)> {
    let src = book.v3().and_then(|v| v.project.source.as_ref())?;
    let name = src
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let from_text = dr_shell::strings::tf(
        cx,
        keys::project_home::project_template::FROM_TEMPLATE,
        &[("name", &name)],
    );
    let author = src
        .credit
        .as_ref()
        .map(|c| c.author.trim())
        .filter(|a| !a.is_empty())
        .map(str::to_owned);
    let summary = match &author {
        Some(a) => format!("{from_text} {a}"),
        None => from_text.to_string(),
    };
    Some((from_text, author, summary))
}

fn hrow(label: SharedString, value: AnyElement, top: bool, p: &Palette) -> gpui::Div {
    div()
        .flex()
        .when(top, |d| d.items_start())
        .when(!top, |d| d.items_center())
        .gap(px(12.0))
        .min_h(px(40.0))
        .py(px(6.0))
        .border_b_1()
        .border_color(p.subtle_hairline())
        .child(
            div()
                .w(px(120.0))
                .flex_none()
                .when(top, |d| d.pt(px(5.0)))
                .font_role(Role::Index)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(div().flex_1().min_w_0().child(value))
}

fn agent_subrow(label: SharedString, input: AnyElement, top: bool, p: &Palette) -> gpui::Div {
    div()
        .flex()
        .when(top, |d| d.items_start())
        .when(!top, |d| d.items_center())
        .gap(px(12.0))
        .w_full()
        .child(
            div()
                .w(px(72.0))
                .flex_none()
                .when(top, |d| d.pt(px(5.0)))
                .font_role(Role::Index)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(input)
}

fn sync_text_area(
    area: &Entity<TextArea>,
    stored: &mut String,
    next: String,
    force: bool,
    window: &Window,
    cx: &mut Context<Home>,
) {
    let cur = area.read(cx);
    let composing = cur.is_composing();
    let focused = cur.focus_handle(cx).is_focused(window);
    let text = cur.text();
    let dirty = text != *stored;
    if force || (!composing && (!focused || !dirty)) {
        *stored = next.clone();
        if text != next {
            area.update(cx, |f, cx| f.set_text(next, cx));
        }
    }
}

fn sync_area_value(
    area: &Entity<TextArea>,
    old_stored: &str,
    next: &str,
    force: bool,
    window: &Window,
    cx: &mut Context<Home>,
) -> bool {
    let cur = area.read(cx);
    let composing = cur.is_composing();
    let focused = cur.focus_handle(cx).is_focused(window);
    let text = cur.text();
    let dirty = text != old_stored;
    if force || (!composing && (!focused || !dirty)) {
        if text != next {
            let s = next.to_owned();
            area.update(cx, |f, cx| f.set_text(s, cx));
        }
        true
    } else {
        false
    }
}

fn sync_line_field(
    field: &Entity<TextField>,
    old_stored: &str,
    next: &str,
    force: bool,
    window: &Window,
    cx: &mut Context<Home>,
) -> bool {
    let cur = field.read(cx);
    let composing = cur.is_composing();
    let focused = cur.focus_handle(cx).is_focused(window);
    let text = cur.text();
    let dirty = text != old_stored;
    if force || (!composing && (!focused || !dirty)) {
        if text != next {
            let s = next.to_owned();
            field.update(cx, |f, cx| f.set_text(s, cx));
        }
        true
    } else {
        false
    }
}
