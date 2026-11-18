//! Inline header fields (title, synopsis) and the bottom 「项目模板」 block
//! of Project Home (`kernel-v5.md` §2 & §3, `v5-tracks.md` T2).
//!
//! Every field is stored the way an entry page's title is (`dr-view-page`'s
//! `entry_head.rs`): leaving it stores it, one `project.update` and one undo
//! step each, off the main thread through the shell's release gate
//! ([`settlement`]) and held to the value the field showed. A write that
//! fails keeps what was typed, with 「未能保存」 and 「重试」 under the field.
//! A value the book changes elsewhere shows up unless the author is editing
//! that field or a write of theirs to it is pending or refused. Before the
//! shell lets go of the library it blurs the fields, then drains them
//! ([`Drafts`]): a field being typed is stored first.

use std::rc::Rc;

use dr_i18n::{Locale, keys, number::grouped};
use dr_shell::{Settings, book::Book, t};
use dr_ui::{
    Theme,
    components::{Button, Switch},
    fonts::Role,
    input::{AreaEvent, FieldEvent, TextArea, TextField},
    sand::{self, Icon},
    style::DrStyled as _,
    tokens::Palette,
};
use dr_view_page::settlement::{self, Drafts, Drain};
use dr_workspace::{Actor, RecordKey, Workspace as Library, WritePreconditions, WsError};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use serde_json::{Value, json};

use crate::v3::Home;

/// A part of Project Home stored on its own: one `project.update`, one
/// undo step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Title,
    Synopsis,
    WordTarget,
    DailyTarget,
    /// The three 「写给 Agent」 fields, stored together.
    Agent,
    /// The 「成书」 switch.
    HasBook,
}

impl Field {
    pub const ALL: [Field; 6] = [
        Field::Title,
        Field::Synopsis,
        Field::WordTarget,
        Field::DailyTarget,
        Field::Agent,
        Field::HasBook,
    ];

    /// The part of element ids naming it (`v3-home-failed-<name>`).
    pub fn name(self) -> &'static str {
        match self {
            Field::Title => "title",
            Field::Synopsis => "synopsis",
            Field::WordTarget => "word-target",
            Field::DailyTarget => "daily-target",
            Field::Agent => "agent",
            Field::HasBook => "has-book",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Where a field's write stands.
#[derive(Clone, Copy, Debug, Default)]
struct Save {
    writing: bool,
    failed: bool,
    /// Stored; the book has not said so yet.
    awaiting: bool,
}

/// The stored values the fields show (what a write is held to), and where
/// each field's write stands.
pub(crate) struct InlineState {
    pub(crate) synced_book_id: String,
    synced_revision: String,
    /// The book is a template's working copy (编辑模板的工作区, DW's
    /// `Workspace::is_working_copy`).
    pub(crate) template_copy: bool,
    title_base: String,
    synopsis_base: String,
    /// Read off the main thread with the page's numbers: until they are
    /// in, the synopsis shows nothing of this book.
    synopsis_known: bool,
    /// The whole-book and daily targets as shown (`0`: off).
    pub(crate) targets_base: [i64; 2],
    /// What `project.book` stores for them (`None`: the default).
    targets_raw: [Option<i64>; 2],
    agent_base: [String; 3],
    book_base: bool,
    /// 「成书」 as the switch shows it: what the author chose last.
    pub(crate) has_book: bool,
    saves: [Save; 6],
    pub(crate) title: Entity<TextArea>,
    pub(crate) synopsis: Entity<TextArea>,
    pub(crate) word_target: Entity<TextField>,
    pub(crate) daily_word_target: Entity<TextField>,
    pub(crate) agent_name: Entity<TextField>,
    pub(crate) agent_description: Entity<TextField>,
    pub(crate) agent_instructions: Entity<TextArea>,
}

/// A target as the field shows it: grouped as the interface language
/// groups numbers (300,000).
fn target_text(n: i64, locale: Locale) -> String {
    grouped(n.max(0) as u64, locale)
}

/// What the author typed in a target field, as a count: empty is `0`
/// (no target); commas and the language's own grouping are allowed; anything
/// else (a negative number, letters) is not a count.
pub(crate) fn parse_target(raw: &str, locale: Locale) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    let group = grouped(1_000_000, locale)
        .chars()
        .find(|c| !c.is_ascii_digit());
    trimmed
        .chars()
        .filter(|c| *c != ',' && Some(*c) != group && !c.is_whitespace())
        .collect::<String>()
        .parse::<i64>()
        .ok()
        .filter(|&n| n >= 0)
}

/// The values a guard accepts for a text the field showed: an empty one
/// may also be stored as nothing.
fn shown_text(text: &str) -> Vec<Value> {
    if text.is_empty() {
        vec![json!(""), Value::Null]
    } else {
        vec![json!(text)]
    }
}

/// One write of one field: its `project.update` arguments, the values it
/// is held to and what it stores.
struct Edit {
    input: serde_json::Map<String, Value>,
    /// `(key, shown, edited)`: the stored value at `key` must be one of
    /// `shown` (or already `edited`).
    guards: Vec<(RecordKey, Vec<Value>, Value)>,
    sent: Sent,
}

/// What was sent, to settle the field when it is stored.
enum Sent {
    /// As typed, and as stored (trimmed).
    Title(String, String),
    Synopsis(String),
    Target(usize, String, i64),
    Agent([String; 3]),
    HasBook(bool),
}

/// The guard of one write: each value as the field showed it (`retry`: as
/// stored now, read just before the write), or already the edited one.
fn held(
    lib: &Library,
    book: &str,
    guards: Vec<(RecordKey, Vec<Value>, Value)>,
    retry: bool,
) -> Result<WritePreconditions, WsError> {
    let doc = format!("book:{book}");
    let now = if retry && !guards.is_empty() {
        let keys: Vec<RecordKey> = guards.iter().map(|(k, _, _)| k.clone()).collect();
        Some(lib.observe_records(&doc, &keys)?)
    } else {
        None
    };
    let mut pre = WritePreconditions {
        require_all: false,
        ..WritePreconditions::default()
    };
    for (i, (key, shown, edited)) in guards.into_iter().enumerate() {
        let mut any = match &now {
            Some(now) => vec![now[i].value.clone()],
            None => shown,
        };
        any.push(edited);
        pre = pre.with_value(doc.clone(), key, any);
    }
    Ok(pre)
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
        // Until a book is shown (none open: an empty 「全部项目」) every field
        // shows what its base says is stored, the targets their defaults, so
        // nothing reads as typed and unsaved and letting the library go (a
        // swap, quitting) has nothing to wait for (`Drafts::drain`).
        let default_pb = dr_model::v3::ProjectBook::default();
        let targets_base = [
            default_pb.word_target().unwrap_or(0),
            default_pb.daily_word_target().unwrap_or(0),
        ];
        let locale = Settings::locale(cx);
        let [word_shown, daily_shown] = targets_base.map(|n| target_text(n, locale));
        let word_target = cx.new(|cx| {
            let mut field = TextField::new("v3-home-word-target", window, cx).mono();
            field.set_text(word_shown, cx);
            field
        });
        let daily_word_target = cx.new(|cx| {
            let mut field = TextField::new("v3-home-daily-target", window, cx).mono();
            field.set_text(daily_shown, cx);
            field
        });
        let agent_name = cx.new(|cx| TextField::new("v3-home-agent-name", window, cx));
        let agent_description =
            cx.new(|cx| TextField::new("v3-home-agent-description", window, cx));
        let agent_instructions =
            cx.new(|cx| TextArea::new("v3-home-agent-instructions", window, cx).framed(3.0));

        let subs = vec![
            cx.subscribe_in(&title, window, Home::on_title_event),
            // ↓ at the end of the title goes on to the synopsis.
            cx.subscribe_in(&title, window, |home, _, _: &AreaEvent, window, cx| {
                home.inline.synopsis.focus_handle(cx).focus(window, cx);
            }),
            cx.subscribe_in(&synopsis, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::Synopsis, 0, ev, w, cx)
            }),
            cx.subscribe_in(&word_target, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::WordTarget, 0, ev, w, cx)
            }),
            cx.subscribe_in(&daily_word_target, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::DailyTarget, 0, ev, w, cx)
            }),
            cx.subscribe_in(&agent_name, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::Agent, 0, ev, w, cx)
            }),
            cx.subscribe_in(&agent_description, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::Agent, 1, ev, w, cx)
            }),
            cx.subscribe_in(&agent_instructions, window, |h, _, ev, w, cx| {
                h.on_field_event(Field::Agent, 2, ev, w, cx)
            }),
        ];

        let state = Self {
            synced_book_id: String::new(),
            synced_revision: String::new(),
            template_copy: false,
            title_base: String::new(),
            synopsis_base: String::new(),
            synopsis_known: false,
            targets_base,
            targets_raw: [None, None],
            agent_base: Default::default(),
            book_base: true,
            has_book: true,
            saves: Default::default(),
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

    fn target_field(&self, k: usize) -> &Entity<TextField> {
        if k == 0 {
            &self.word_target
        } else {
            &self.daily_word_target
        }
    }

    fn agent_texts(&self, cx: &gpui::App) -> [String; 3] {
        [
            self.agent_name.read(cx).text(),
            self.agent_description.read(cx).text(),
            self.agent_instructions.read(cx).text(),
        ]
    }

    fn set_agent_texts(&self, texts: &[String; 3], cx: &mut Context<Home>) {
        let [name, description, instructions] = texts.clone();
        if self.agent_name.read(cx).text() != name {
            self.agent_name.update(cx, |f, cx| f.set_text(name, cx));
        }
        if self.agent_description.read(cx).text() != description {
            self.agent_description
                .update(cx, |f, cx| f.set_text(description, cx));
        }
        if self.agent_instructions.read(cx).text() != instructions {
            self.agent_instructions
                .update(cx, |f, cx| f.set_text(instructions, cx));
        }
    }

    /// Whether a write of `field` is pending, failed or not yet seen in the
    /// book: what the book says meanwhile does not replace what it shows.
    /// The book saying `same` (what the field stored) ends the wait.
    fn takes(&mut self, field: Field, same: bool, dirty: bool) -> bool {
        let save = &mut self.saves[field.index()];
        if save.awaiting && same {
            save.awaiting = false;
        }
        !(save.writing || save.failed || save.awaiting || dirty)
    }
}

fn area_dirty(area: &Entity<TextArea>, base: &str, cx: &gpui::App) -> bool {
    let area = area.read(cx);
    area.is_composing() || area.text() != base
}

fn field_dirty(field: &Entity<TextField>, base: &str, cx: &gpui::App) -> bool {
    let field = field.read(cx);
    field.is_composing() || field.text() != base
}

fn agent_of(book: &Book) -> [String; 3] {
    book.v3()
        .and_then(|v| v.project.agent.clone())
        .map(|a| [a.name, a.description, a.instructions])
        .unwrap_or_default()
}

impl Home {
    /// Brings the fields to the book as the shell read it: another book
    /// shows anew; a new revision of the same book replaces what a field
    /// shows unless the author is editing it or a write to it is pending
    /// or refused (the synopsis comes with the page's numbers,
    /// [`Self::sync_synopsis`]).
    pub(crate) fn sync_book(&mut self, book: &Rc<Book>, cx: &mut Context<Self>) {
        let Some(v3) = book.v3() else {
            return;
        };
        let same_book = self.inline.synced_book_id == book.id;
        if same_book && self.inline.synced_revision == v3.revision {
            return;
        }
        let locale = Settings::locale(cx);
        let stored_book = v3.project.book.clone();
        let stored_agent = agent_of(book);
        if !same_book {
            let template_copy = self
                .lib
                .as_ref()
                .is_some_and(|lib| lib.is_working_copy(&book.id).unwrap_or(false));
            let i = &mut self.inline;
            i.synced_book_id = book.id.clone();
            i.template_copy = template_copy;
            i.saves = Default::default();
            i.title_base = book.name.clone();
            let name = book.name.clone();
            i.title.update(cx, |f, cx| f.set_text(name, cx));
            i.synopsis_base = String::new();
            i.synopsis_known = false;
            i.synopsis.update(cx, |f, cx| f.set_text("", cx));
            let (shown, raw) = stored_book
                .as_ref()
                .map(|pb| {
                    (
                        [
                            pb.word_target.unwrap_or(0),
                            pb.daily_word_target.unwrap_or(0),
                        ],
                        [pb.word_target_set, pb.daily_word_target_set],
                    )
                })
                .unwrap_or_else(|| {
                    let pb = dr_model::v3::ProjectBook::default();
                    (
                        [
                            pb.word_target().unwrap_or(0),
                            pb.daily_word_target().unwrap_or(0),
                        ],
                        [None, None],
                    )
                });
            i.targets_base = shown;
            i.targets_raw = raw;
            for k in 0..2 {
                let text = target_text(i.targets_base[k], locale);
                i.target_field(k).update(cx, |f, cx| f.set_text(text, cx));
            }
            i.agent_base = stored_agent.clone();
            i.set_agent_texts(&stored_agent, cx);
            i.book_base = stored_book.is_some();
            i.has_book = i.book_base;
        } else {
            let i = &mut self.inline;
            // Title.
            let dirty = area_dirty(&i.title, &i.title_base, cx);
            if i.takes(Field::Title, book.name == i.title_base, dirty) {
                i.title_base = book.name.clone();
                if i.title.read(cx).text() != book.name {
                    let name = book.name.clone();
                    i.title.update(cx, |f, cx| f.set_text(name, cx));
                }
            }
            // The two targets: only while the book is on (they are not
            // read while it is off; turning it on brings them back).
            if let Some(pb) = &stored_book {
                let stored = [
                    pb.word_target.unwrap_or(0),
                    pb.daily_word_target.unwrap_or(0),
                ];
                let raw = [pb.word_target_set, pb.daily_word_target_set];
                for (k, field) in [Field::WordTarget, Field::DailyTarget]
                    .into_iter()
                    .enumerate()
                {
                    let shown = target_text(i.targets_base[k], locale);
                    let dirty = field_dirty(i.target_field(k), &shown, cx);
                    let same = stored[k] == i.targets_base[k];
                    if same {
                        i.targets_raw[k] = raw[k];
                    }
                    if i.takes(field, same, dirty) {
                        i.targets_base[k] = stored[k];
                        i.targets_raw[k] = raw[k];
                        let text = target_text(stored[k], locale);
                        if i.target_field(k).read(cx).text() != text {
                            i.target_field(k).update(cx, |f, cx| f.set_text(text, cx));
                        }
                    }
                }
            }
            // 写给 Agent.
            let typed = i.agent_texts(cx);
            let composing = i.agent_name.read(cx).is_composing()
                || i.agent_description.read(cx).is_composing()
                || i.agent_instructions.read(cx).is_composing();
            let dirty = composing || typed != i.agent_base;
            if i.takes(Field::Agent, stored_agent == i.agent_base, dirty) {
                i.agent_base = stored_agent.clone();
                i.set_agent_texts(&stored_agent, cx);
            }
            // 成书.
            let stored_on = stored_book.is_some();
            let dirty = i.has_book != i.book_base;
            if i.takes(Field::HasBook, stored_on == i.book_base, dirty) {
                i.book_base = stored_on;
                i.has_book = stored_on;
            }
        }
        self.inline.synced_revision = v3.revision.clone();
        self.sync_synopsis(cx);
    }

    /// The synopsis from the page's numbers (read off the main thread
    /// with them), when they are this book's.
    pub(crate) fn sync_synopsis(&mut self, cx: &mut Context<Self>) {
        let ours = self
            .source
            .as_ref()
            .is_some_and(|s| s.id == self.inline.synced_book_id);
        let Some(summary) = self
            .loaded
            .as_ref()
            .filter(|_| ours)
            .map(|l| l.summary.clone())
        else {
            return;
        };
        let i = &mut self.inline;
        if !i.synopsis_known {
            i.synopsis_known = true;
        }
        let dirty = area_dirty(&i.synopsis, &i.synopsis_base, cx);
        if i.takes(Field::Synopsis, summary == i.synopsis_base, dirty) {
            i.synopsis_base = summary.clone();
            if i.synopsis.read(cx).text() != summary {
                i.synopsis.update(cx, |f, cx| f.set_text(summary, cx));
            }
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

    fn leave_field(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.ws.upgrade() {
            let focus = ws.read(cx).focus_handle().clone();
            window.focus(&focus, cx);
        } else {
            window.blur(cx);
        }
    }

    pub(crate) fn on_title_event(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !settlement::accepts(cx) {
            return;
        }
        match event {
            // Enter stores the name and goes on to the synopsis, as an
            // entry's title goes on to its text.
            FieldEvent::Submitted(_) => {
                self.save(Field::Title, false, cx);
                let synopsis = self.inline.synopsis.focus_handle(cx);
                window.focus(&synopsis, cx);
            }
            FieldEvent::Blurred => self.save(Field::Title, false, cx),
            FieldEvent::Cancelled => {
                if self.revert(Field::Title, 0, cx) {
                    self.leave_field(window, cx);
                }
            }
            FieldEvent::Changed(_) => {}
        }
        cx.notify();
    }

    fn on_field_event(
        &mut self,
        field: Field,
        part: usize,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !settlement::accepts(cx) {
            return;
        }
        match event {
            FieldEvent::Submitted(_) => {
                self.save(field, false, cx);
                self.leave_field(window, cx);
            }
            FieldEvent::Blurred => self.save(field, false, cx),
            FieldEvent::Cancelled => {
                if self.revert(field, part, cx) {
                    self.leave_field(window, cx);
                }
            }
            FieldEvent::Changed(_) => {}
        }
        cx.notify();
    }

    /// Esc: the field (`part` of 写给 Agent) shows what is stored again.
    /// A write already on its way, or one refused, stays for retry: Esc
    /// cannot take it back.
    fn revert(&mut self, field: Field, part: usize, cx: &mut Context<Self>) -> bool {
        let save = self.inline.saves[field.index()];
        if save.writing || save.failed {
            return false;
        }
        let locale = Settings::locale(cx);
        let i = &self.inline;
        match field {
            Field::Title => {
                let base = i.title_base.clone();
                i.title.update(cx, |f, cx| f.set_text(base, cx));
            }
            Field::Synopsis => {
                let base = i.synopsis_base.clone();
                i.synopsis.update(cx, |f, cx| f.set_text(base, cx));
            }
            Field::WordTarget | Field::DailyTarget => {
                let k = usize::from(field == Field::DailyTarget);
                let text = target_text(i.targets_base[k], locale);
                i.target_field(k).update(cx, |f, cx| f.set_text(text, cx));
            }
            Field::Agent => {
                let base = i.agent_base[part].clone();
                match part {
                    0 => i.agent_name.update(cx, |f, cx| f.set_text(base, cx)),
                    1 => i.agent_description.update(cx, |f, cx| f.set_text(base, cx)),
                    _ => i
                        .agent_instructions
                        .update(cx, |f, cx| f.set_text(base, cx)),
                }
            }
            Field::HasBook => {}
        }
        true
    }

    /// Whether `field` shows something other than what is stored.
    fn dirty(&self, field: Field, cx: &gpui::App) -> bool {
        let i = &self.inline;
        match field {
            Field::Title => i.title.read(cx).text() != i.title_base,
            Field::Synopsis => i.synopsis.read(cx).text() != i.synopsis_base,
            Field::WordTarget | Field::DailyTarget => {
                let k = usize::from(field == Field::DailyTarget);
                i.has_book
                    && i.target_field(k).read(cx).text()
                        != target_text(i.targets_base[k], Settings::locale(cx))
            }
            Field::Agent => i.agent_texts(cx) != i.agent_base,
            Field::HasBook => i.has_book != i.book_base,
        }
    }

    /// What storing `field` would write, or `None` when it shows what is
    /// stored: an empty name, or a target that is no count, is not stored
    /// (the field shows the stored value again).
    fn prepare(&mut self, field: Field, cx: &mut Context<Self>) -> Option<Edit> {
        let locale = Settings::locale(cx);
        let i = &mut self.inline;
        let mut input = serde_json::Map::new();
        match field {
            Field::Title => {
                let typed = i.title.read(cx).text();
                let value = typed.trim().to_owned();
                if value.is_empty() || value == i.title_base {
                    if typed != i.title_base {
                        let base = i.title_base.clone();
                        i.title.update(cx, |f, cx| f.set_text(base, cx));
                    }
                    return None;
                }
                input.insert("name".into(), json!(value));
                Some(Edit {
                    input,
                    guards: vec![(
                        RecordKey::record("meta", "name"),
                        shown_text(&i.title_base),
                        json!(value),
                    )],
                    sent: Sent::Title(typed, value),
                })
            }
            Field::Synopsis => {
                let typed = i.synopsis.read(cx).text();
                if typed == i.synopsis_base {
                    return None;
                }
                input.insert("summary".into(), json!(typed));
                Some(Edit {
                    input,
                    guards: vec![(
                        RecordKey::record("meta", "summary"),
                        shown_text(&i.synopsis_base),
                        json!(typed),
                    )],
                    sent: Sent::Synopsis(typed),
                })
            }
            Field::WordTarget | Field::DailyTarget => {
                if !i.has_book {
                    return None;
                }
                let k = usize::from(field == Field::DailyTarget);
                let typed = i.target_field(k).read(cx).text();
                let Some(n) = parse_target(&typed, locale).filter(|n| *n != i.targets_base[k])
                else {
                    let shown = target_text(i.targets_base[k], locale);
                    if typed != shown {
                        i.target_field(k).update(cx, |f, cx| f.set_text(shown, cx));
                    }
                    return None;
                };
                let key = if k == 0 {
                    "word_target"
                } else {
                    "daily_word_target"
                };
                input.insert(key.into(), json!(n));
                Some(Edit {
                    input,
                    guards: vec![(
                        RecordKey::record("project", "book").at([key]),
                        vec![json!(i.targets_raw[k])],
                        json!(n),
                    )],
                    sent: Sent::Target(k, typed, n),
                })
            }
            Field::Agent => {
                let typed = i.agent_texts(cx);
                if typed == i.agent_base {
                    return None;
                }
                // All three cleared: the project has no guidance for the
                // Agent (no question asked).
                let clear = typed.iter().all(String::is_empty);
                let [name, description, instructions] = typed.clone();
                input.insert(
                    "agent".into(),
                    if clear {
                        Value::Null
                    } else {
                        json!({"name": name, "description": description, "instructions": instructions})
                    },
                );
                let guards = ["name", "description", "instructions"]
                    .into_iter()
                    .enumerate()
                    .map(|(k, key)| {
                        (
                            RecordKey::record("project", "agent").at([key]),
                            shown_text(&i.agent_base[k]),
                            if clear { Value::Null } else { json!(typed[k]) },
                        )
                    })
                    .collect();
                Some(Edit {
                    input,
                    guards,
                    sent: Sent::Agent(typed),
                })
            }
            Field::HasBook => {
                if i.has_book == i.book_base {
                    return None;
                }
                input.insert("has_book".into(), json!(i.has_book));
                // A switch says what it is set to: setting it again is the
                // same, so the write is held to nothing.
                Some(Edit {
                    input,
                    guards: Vec::new(),
                    sent: Sent::HasBook(i.has_book),
                })
            }
        }
    }

    /// Stores `field` (`retry`: 「重试」 after a refusal, held to what is
    /// stored now). Nothing while the release gate is closed, while a
    /// write of it is on its way, or after a refusal until 「重试」.
    pub fn save(&mut self, field: Field, retry: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let save = self.inline.saves[field.index()];
        if save.writing || (save.failed && !retry) {
            return;
        }
        let (Some(lib), Some(book)) = (self.lib.clone(), self.active_book_id(cx)) else {
            return;
        };
        let Some(edit) = self.prepare(field, cx) else {
            self.inline.saves[field.index()].failed = false;
            cx.notify();
            return;
        };
        {
            let save = &mut self.inline.saves[field.index()];
            save.writing = true;
            save.failed = false;
        }
        let mut input = edit.input;
        input.insert("book".into(), json!(book));
        let guards = edit.guards;
        let worker = lib.clone();
        let held_book = book.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            let guard = held(&worker, &held_book, guards, retry)?;
            worker.call_guarded(&Actor::User, "project.update", Value::Object(input), guard)?;
            Ok::<_, WsError>(())
        });
        let sent = edit.sent;
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |h, cx| {
                    // Another book is shown now: its fields start afresh.
                    if h.inline.synced_book_id != book {
                        return;
                    }
                    h.inline.saves[field.index()].writing = false;
                    match result {
                        Ok(()) => {
                            h.inline.saves[field.index()].awaiting = true;
                            h.settle(sent, cx);
                            // Typed on while it was stored: that is stored too.
                            if h.dirty(field, cx) {
                                h.save(field, false, cx);
                            }
                        }
                        Err(error) => {
                            log::warn!("Project Home did not store its {}: {error}", field.name());
                            h.inline.saves[field.index()].failed = true;
                        }
                    }
                    cx.notify();
                })
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
        cx.notify();
    }

    /// A write is stored: it is what the field shows from now on.
    fn settle(&mut self, sent: Sent, cx: &mut Context<Self>) {
        let locale = Settings::locale(cx);
        let i = &mut self.inline;
        match sent {
            Sent::Title(typed, stored) => {
                if i.title.read(cx).text() == typed && typed != stored {
                    let value = stored.clone();
                    i.title.update(cx, |f, cx| f.set_text(value, cx));
                }
                i.title_base = stored;
            }
            Sent::Synopsis(text) => i.synopsis_base = text,
            Sent::Target(k, typed, n) => {
                i.targets_base[k] = n;
                i.targets_raw[k] = Some(n);
                let text = target_text(n, locale);
                if i.target_field(k).read(cx).text() == typed && typed != text {
                    i.target_field(k).update(cx, |f, cx| f.set_text(text, cx));
                }
            }
            Sent::Agent(texts) => i.agent_base = texts,
            Sent::HasBook(on) => i.book_base = on,
        }
    }

    /// Whether a write of one of the fields is on its way.
    pub fn is_saving(&self) -> bool {
        self.inline.saves.iter().any(|s| s.writing)
    }

    /// Whether storing `field` was refused (what was typed stays, with
    /// 「重试」).
    pub fn failed(&self, field: Field) -> bool {
        self.inline.saves[field.index()].failed
    }

    /// Stores the inline project title (tests; leaving the field does it).
    pub fn store_title(&mut self, cx: &mut Context<Self>) {
        self.save(Field::Title, false, cx);
    }

    /// Stores the inline synopsis (tests; leaving the field does it).
    pub fn store_synopsis(&mut self, cx: &mut Context<Self>) {
        self.save(Field::Synopsis, false, cx);
    }

    /// Stores the whole-book target (tests; leaving the field does it).
    pub fn store_word_target(&mut self, cx: &mut Context<Self>) {
        self.save(Field::WordTarget, false, cx);
    }

    /// Stores the daily target (tests; leaving the field does it).
    pub fn store_daily_word_target(&mut self, cx: &mut Context<Self>) {
        self.save(Field::DailyTarget, false, cx);
    }

    /// Stores 写给 Agent (tests; leaving one of its fields does it).
    pub fn store_agent(&mut self, cx: &mut Context<Self>) {
        self.save(Field::Agent, false, cx);
    }

    /// Turns 「成书」 on or off: one `project.update`. Its two targets stay
    /// in the book while it is off and come back when it is turned on.
    pub fn set_has_book(&mut self, on: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) || self.inline.has_book == on {
            return;
        }
        self.inline.has_book = on;
        // A new choice: a refused one does not wait for 「重试」.
        self.inline.saves[Field::HasBook.index()].failed = false;
        self.save(Field::HasBook, false, cx);
        cx.notify();
    }

    /// Rendered summary text for the `来源` row of the active book, if the book
    /// carries `project.source` (used by both Project Home rendering and tests).
    pub fn template_source_text(&self, cx: &gpui::App) -> Option<String> {
        let book = self.ws.upgrade().map(|ws| ws.read(cx).book.clone())?;
        format_source_parts(&book, cx).map(|(_, _, summary)| summary)
    }

    /// 「未能保存」 and 「重试」 under `field`, when its write was refused (as
    /// under an entry's title).
    pub(crate) fn failed_line(
        &self,
        field: Field,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.failed(field) {
            return None;
        }
        let theme = Theme::of(window, cx);
        let home = cx.weak_entity();
        let id = SharedString::from(format!("v3-home-failed-{}", field.name()));
        let selector = id.clone();
        let retry_id = SharedString::from(format!("v3-home-retry-{}", field.name()));
        let retry = retry_id.clone();
        Some(
            div()
                .id(id)
                .debug_selector(move || selector.to_string())
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .font_role(Role::Ui)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(theme.palette.danger.solid())
                .child(t(cx, keys::k4_pages::SAVE_FAILED))
                .child(
                    div().debug_selector(move || retry.to_string()).child(
                        Button::new(retry_id, t(cx, keys::markdown_share::RETRY))
                            .small()
                            .text()
                            .on_click(move |_, _, cx| {
                                home.update(cx, |h, cx| h.save(field, true, cx)).ok();
                            }),
                    ),
                )
                .into_any_element(),
        )
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
        // Not in a template's working copy (it is what a template is
        // edited in, not a project to save as one).
        let save_button = (crate::has_save_project_template(cx)
            && self.lib.is_some()
            && !self.inline.template_copy)
            .then(|| {
                let click_home = weak_home.clone();
                let click_book = book.id.clone();
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
                                (r.ws.clone(), r.lib.as_ref().map(Library::downgrade))
                            }) else {
                                return;
                            };
                            crate::open_save_project_template(
                                crate::SaveProjectTemplateHost {
                                    workspace,
                                    library,
                                    book_id: click_book.clone(),
                                },
                                window,
                                cx,
                            );
                        }),
                    )
            });

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

        if let Some((from_text, author, aria_summary)) = format_source_parts(book, cx)
            && !self.inline.template_copy
        {
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

        let in_book_label = t(cx, keys::project_home::project_template::BOOK);
        let switch_home = weak_home;
        let has_book_value = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .id("v3-home-has-book-toggle")
                    .debug_selector(|| "v3-home-has-book-toggle".into())
                    .role(gpui::Role::CheckBox)
                    .aria_label(in_book_label.clone())
                    .aria_toggled(if has_book {
                        gpui::Toggled::True
                    } else {
                        gpui::Toggled::False
                    })
                    .child(Switch::new("v3-home-has-book", has_book).on_change(
                        move |on, _, cx| {
                            switch_home.update(cx, |h, cx| h.set_has_book(on, cx)).ok();
                        },
                    )),
            )
            .children(self.failed_line(Field::HasBook, window, cx));
        block = block.child(hrow(
            in_book_label,
            has_book_value.into_any_element(),
            false,
            p,
        ));

        if has_book {
            let words_unit = t(cx, keys::common::WORDS);
            for (field, input, id, label) in [
                (
                    Field::WordTarget,
                    self.inline.word_target.clone(),
                    "v3-home-word-target-input",
                    t(cx, keys::project_home::settings::PROJECT_TARGET),
                ),
                (
                    Field::DailyTarget,
                    self.inline.daily_word_target.clone(),
                    "v3-home-daily-target-input",
                    t(cx, keys::project_home::settings::DAILY_GOAL),
                ),
            ] {
                let value = div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .id(id)
                                    .debug_selector(move || id.into())
                                    .role(gpui::Role::TextInput)
                                    .aria_label(label.clone())
                                    .w(px(110.0))
                                    .child(input),
                            )
                            .child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(13.0, 18.0)
                                    .text_color(p.ink(4).solid())
                                    .child(words_unit.clone()),
                            ),
                    )
                    .children(self.failed_line(field, window, cx));
                block = block.child(hrow(label, value.into_any_element(), false, p));
            }
        }

        if let Some(structure) = crate::structure_thumbnail::render(self, window, cx) {
            block = block.child(hrow(t(cx, keys::v5_fill::STRUCTURE), structure, true, p));
        }

        let agent_name_label = t(cx, keys::template_editor::NAME);
        let agent_desc_label = t(cx, keys::template_editor::DESCRIPTION);
        let agent_inst_label = t(cx, keys::template_editor::INSTRUCTIONS);
        let sub_w = agent_label_width(&[&agent_name_label, &agent_desc_label, &agent_inst_label]);

        let agent_rows = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .w_full()
            .child(agent_subrow(
                agent_name_label.clone(),
                sub_w,
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
                sub_w,
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
                sub_w,
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
            ))
            .children(self.failed_line(Field::Agent, window, cx));

        block = block.child(hrow(
            t(cx, keys::template_editor::FOR_AGENT),
            agent_rows.into_any_element(),
            true,
            p,
        ));

        block.into_any_element()
    }
}

impl Drafts for Home {
    /// Before the shell lets go of the library (the fields are blurred by
    /// then): what is typed is stored, and the shell waits for it.
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        for field in Field::ALL {
            self.save(field, false, cx);
        }
        if self.inline.saves.iter().any(|s| s.writing) {
            return Drain::Pending;
        }
        if self.inline.saves.iter().any(|s| s.failed)
            || Field::ALL.into_iter().any(|f| self.dirty(f, cx))
        {
            return Drain::Failed(t(cx, keys::k4_pages::SAVE_FAILED).to_string());
        }
        Drain::Ready
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

/// The 写给 Agent labels' column: 72px, or as wide as the widest label in
/// the index face (14px; a Latin letter is half an em). 「Description」 and
/// 「Instructions」 were broken inside the word in 72px.
fn agent_label_width(labels: &[&SharedString]) -> f32 {
    labels
        .iter()
        .map(|l| {
            l.chars()
                .map(|c| if c.is_ascii() { 7.0 } else { 14.0 })
                .sum::<f32>()
                + 2.0
        })
        .fold(72.0, f32::max)
}

fn agent_subrow(
    label: SharedString,
    label_w: f32,
    input: AnyElement,
    top: bool,
    p: &Palette,
) -> gpui::Div {
    div()
        .flex()
        .when(top, |d| d.items_start())
        .when(!top, |d| d.items_center())
        .gap(px(12.0))
        .w_full()
        .child(
            div()
                .w(px(label_w))
                .flex_none()
                .when(top, |d| d.pt(px(5.0)))
                .font_role(Role::Index)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .child(label),
        )
        .child(input)
}

#[cfg(test)]
mod label_tests {
    use super::agent_label_width;
    use gpui::SharedString;

    #[test]
    fn the_agent_labels_fit_their_column_in_every_language() {
        let zh: Vec<SharedString> = ["名字", "说明", "注意事项"].map(Into::into).into();
        assert_eq!(agent_label_width(&zh.iter().collect::<Vec<_>>()), 72.0);
        let en: Vec<SharedString> = ["Name", "Description", "Instructions"]
            .map(Into::into)
            .into();
        assert!(agent_label_width(&en.iter().collect::<Vec<_>>()) >= 12.0 * 7.0);
    }
}
