//! An entry page's head (`kernel-v5.md` §8 「条目自己的记号」, §16
//! 「条目页」): the entry's mark, a button that opens the mark picker, and
//! its title, a field that renames it, on one line; the name of its
//! template under them. It is the one place an entry is renamed on its page,
//! whatever its modules (a chapter's body draws no title of its own here).
//!
//! The title is stored when the field is left (Enter leaves it for the
//! entry's first body, if it has one); Esc puts
//! the stored title back; an empty title is not stored. A title being typed
//! is stored before the app quits or the library is swapped, held to the
//! title the head showed: one set elsewhere meanwhile is not overwritten,
//! the typed one stays in the field with 「重试」 (the page-head drafts'
//! rules, `head/drafts.rs`). A chapter just made with ⁂ 「新建下一章」 opens
//! with its title taking the caret, selected.
use std::{collections::HashMap, rc::Rc};

use dr_i18n::keys;
use dr_shell::{
    book::Book,
    strings::{t, tf},
    v3::{EntryHost, Rendered, mark::MarkPicker},
};
use dr_ui::{
    Theme,
    components::overlay::{self, Layer, Place},
    fonts::Role,
    input::{FieldEvent, TextArea},
    sand::KindMark,
    style::DrStyled,
};
use dr_workspace::{Actor, RecordKey, WritePreconditions, WsError};
use gpui::{prelude::*, *};
use serde_json::json;

use crate::{
    NewTitles,
    settlement::{self, Drafts, Drain},
};

pub fn register(cx: &mut App) {
    dr_shell::v3::add_entry_head(cx, |host, window, cx| {
        let view = cx.new(|cx| EntryHead::new(host, window, cx));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            let _ = weak.update(cx, |head, cx| head.refresh(book, cx));
        })
    });
}

/// The heads drawn now, by entry: a body asks whether its entry's title has
/// the caret before it takes it.
#[derive(Default)]
struct Heads(HashMap<String, WeakEntity<EntryHead>>);
impl Global for Heads {}

/// Whether the head of `entry`'s page has the caret in its title.
pub fn title_focused(entry: &str, window: &Window, cx: &App) -> bool {
    cx.try_global::<Heads>()
        .and_then(|heads| heads.0.get(entry))
        .and_then(WeakEntity::upgrade)
        .is_some_and(|head| head.read(cx).title.focus_handle(cx).is_focused(window))
}

/// The head of `entry`'s page drawn last, while it lives (tests).
pub fn head_of(entry: &str, cx: &App) -> Option<Entity<EntryHead>> {
    cx.try_global::<Heads>()?.0.get(entry)?.upgrade()
}

/// The title as typed, against the title the head showed (`base`).
struct Draft {
    text: String,
    base: String,
    writing: bool,
    failed: bool,
    /// Stored; the book has not said so yet.
    awaiting: bool,
}

impl Draft {
    fn new(value: &str) -> Self {
        Self {
            text: value.into(),
            base: value.into(),
            writing: false,
            failed: false,
            awaiting: false,
        }
    }
    fn dirty(&self) -> bool {
        self.text != self.base
    }
    /// The book says the title is `value`: shown unless the author is
    /// typing or a write of theirs is pending or refused.
    fn refresh(&mut self, value: &str) -> bool {
        if self.awaiting && value == self.base {
            self.awaiting = false;
        }
        if self.writing || self.failed || self.dirty() || self.awaiting {
            return false;
        }
        self.text = value.into();
        self.base = value.into();
        true
    }
}

pub struct EntryHead {
    host: EntryHost,
    title: Entity<TextArea>,
    draft: Draft,
    picker: Option<Entity<MarkPicker>>,
    _subscriptions: Vec<Subscription>,
}

impl EntryHead {
    pub fn new(host: EntryHost, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let stored = host
            .page
            .book
            .v3()
            .and_then(|v| v.entry(&host.entry))
            .map(|e| e.title.clone())
            .unwrap_or_default();
        let placeholder = placeholder(&host.page.book, &host.entry, cx);
        let title = cx.new(|cx| {
            TextArea::new(
                SharedString::from(format!("v3-entry-title-{}", host.entry)),
                window,
                cx,
            )
            .submit_on_enter()
            .placeholder(placeholder)
            .with_text(stored.clone())
        });
        let subscriptions = vec![
            cx.subscribe_in(&title, window, Self::on_title),
            // The title's comment underline lights with the Review cards.
            cx.observe_global::<dr_shell::ReviewFocus>(|_, cx| cx.notify()),
        ];
        let me = cx.entity().downgrade();
        cx.default_global::<Heads>()
            .0
            .insert(host.entry.clone(), me);
        settlement::register(&host.page.library, window.window_handle(), cx);
        // A chapter just made: its title takes the caret, selected, once
        // the page is drawn (its body has seen it is pending by then).
        let entry = host.entry.clone();
        let field = title.clone();
        window.defer(cx, move |window, cx| {
            if NewTitles::take_entry(&entry, cx) {
                window.focus(&field.focus_handle(cx), cx);
                field.update(cx, |f, cx| f.select_all_text(cx));
            }
        });
        EntryHead {
            host,
            title,
            draft: Draft::new(&stored),
            picker: None,
            _subscriptions: subscriptions,
        }
    }

    /// The title field (tests, and hosts that focus it).
    pub fn title(&self) -> &Entity<TextArea> {
        &self.title
    }

    /// Whether the mark picker is open.
    pub fn picking(&self) -> bool {
        self.picker.is_some()
    }

    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        self.host.page.book = book;
        let now = self
            .host
            .page
            .book
            .v3()
            .and_then(|v| v.entry(&self.host.entry))
            .map(|e| e.title.clone());
        if let Some(now) = now
            && self.draft.refresh(&now)
            && self.title.read(cx).text() != now
        {
            self.title.update(cx, |f, cx| f.set_text(now, cx));
        }
        cx.notify();
    }

    /// Whether storing the typed title was refused (it stays in the field,
    /// with 「重试」).
    pub fn failed(&self) -> bool {
        self.draft.failed
    }

    fn on_title(
        &mut self,
        _: &Entity<TextArea>,
        event: &FieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !settlement::accepts(cx) {
            if matches!(event, FieldEvent::Changed(_)) {
                let text = self.draft.text.clone();
                self.title.update(cx, |f, cx| f.set_text(text, cx));
            }
            return;
        }
        match event {
            FieldEvent::Changed(value) => self.draft.text = value.clone(),
            FieldEvent::Submitted(_) => {
                self.save(false, cx);
                // Enter hands the caret to the text, when there is one.
                let body = self
                    .host
                    .entry_page
                    .upgrade()
                    .and_then(|page| page.read(cx).body_focus());
                match body {
                    Some(body) => window.focus(&body, cx),
                    None => window.blur(cx),
                }
            }
            FieldEvent::Blurred => self.save(false, cx),
            FieldEvent::Cancelled => {
                // A write already accepted, or one refused, stays for retry:
                // Esc cannot take it back.
                if self.draft.writing || self.draft.failed {
                    return;
                }
                let base = self.draft.base.clone();
                self.draft.text = base.clone();
                self.title.update(cx, |f, cx| f.set_text(base, cx));
                window.blur(cx);
            }
        }
        cx.notify();
    }

    /// Stores what is typed in the title (tests; leaving the field does it).
    pub fn store_title(&mut self, cx: &mut Context<Self>) {
        self.draft.text = self.title.read(cx).text();
        self.save(false, cx);
    }

    /// `entry.update`'s `title` off the main thread, held to the title the
    /// head showed (`retry`: to the one stored now). An empty title is not
    /// stored: the field shows the stored one again.
    fn save(&mut self, retry: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let draft = &mut self.draft;
        if draft.writing || (!draft.dirty() && !draft.failed) || (draft.failed && !retry) {
            return;
        }
        let value = draft.text.trim().to_owned();
        if value.is_empty() {
            draft.text = draft.base.clone();
            draft.failed = false;
            let base = draft.base.clone();
            self.title.update(cx, |f, cx| f.set_text(base, cx));
            return;
        }
        let (sent, base) = (draft.text.clone(), draft.base.clone());
        draft.writing = true;
        draft.failed = false;
        let lib = self.host.page.library.clone();
        let worker = lib.clone();
        let book = self.host.page.book_id.clone();
        let entry = self.host.entry.clone();
        let stored = value.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            let guard = settlement::held_to(
                &worker,
                &book,
                RecordKey::entry(&entry).at(["title"]),
                json!(base),
                json!(stored),
                retry,
            )?;
            worker.call_guarded(
                &Actor::User,
                "entry.update",
                json!({ "book": book, "id": entry, "title": stored }),
                guard,
            )?;
            Ok::<_, WsError>(stored)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |head, cx| {
                    let draft = &mut head.draft;
                    draft.writing = false;
                    let mut again = false;
                    match result {
                        Ok(saved) => {
                            let untouched = draft.text == sent;
                            draft.base = saved.clone();
                            draft.awaiting = true;
                            if untouched {
                                draft.text = saved.clone();
                                head.title.update(cx, |f, cx| f.set_text(saved, cx));
                            }
                            again = head.draft.dirty();
                        }
                        Err(e) => {
                            log::warn!("the entry's title was not stored: {e}");
                            draft.failed = true;
                        }
                    }
                    if again {
                        head.save(false, cx);
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

    /// Sets the entry's own mark (`None`: its template's again), held to
    /// the entry as the page showed it.
    pub fn set_mark(&mut self, mark: Option<String>, cx: &mut Context<Self>) {
        let Some(v) = self.host.page.book.v3() else {
            return;
        };
        if v.entry(&self.host.entry).is_none() || !settlement::accepts(cx) {
            return;
        }
        let changes = json!({
            "book": self.host.page.book_id, "id": self.host.entry, "mark": mark,
        });
        let guard = WritePreconditions {
            require_all: false,
            ..v.guard_for(&changes)
        };
        let lib = self.host.page.library.clone();
        let job = cx.background_spawn(async move {
            lib.call_guarded(&Actor::User, "entry.update", changes, guard)
        });
        let workspace = self.host.page.workspace.clone();
        let book = self.host.page.book_id.clone();
        cx.spawn(async move |this, cx| {
            if let Err(error) = job.await {
                log::warn!("the entry's mark was not stored: {error}");
                this.update(cx, |_, cx| {
                    let text = t(cx, keys::common::SAVE_FAILED);
                    workspace
                        .update(cx, |ws, cx| {
                            if ws.book_id == book {
                                ws.toast(text, cx);
                            }
                        })
                        .ok();
                })
                .ok();
            }
        })
        .detach();
    }

    /// Opens the mark picker under the mark.
    pub fn open_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = self
            .host
            .page
            .book
            .v3()
            .and_then(|v| v.entry(&self.host.entry))
            .and_then(|e| e.mark.clone());
        let weak = cx.entity().downgrade();
        let dismiss = cx.entity().downgrade();
        let picker = cx.new(|cx| {
            MarkPicker::new(
                self.host.entry.clone(),
                current,
                true,
                move |mark, _, cx| {
                    let _ = weak.update(cx, |head, cx| {
                        head.set_mark(mark, cx);
                        head.picker = None;
                        cx.notify();
                    });
                },
                move |_, cx| {
                    let _ = dismiss.update(cx, |head, cx| {
                        head.picker = None;
                        cx.notify();
                    });
                },
                window,
                cx,
            )
        });
        self.picker = Some(picker);
        cx.notify();
    }
}

impl Drafts for EntryHead {
    fn drain(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Drain {
        self.save(false, cx);
        if self.draft.writing {
            return Drain::Pending;
        }
        if self.draft.failed || self.draft.dirty() {
            return Drain::Failed(t(cx, keys::k4_pages::SAVE_FAILED).to_string());
        }
        Drain::Ready
    }
}

fn placeholder(book: &Book, entry: &str, cx: &App) -> SharedString {
    match book.v3().and_then(|v| v.template_of(entry)) {
        Some(t) => tf(cx, keys::v3_shell::UNTITLED_NAMED, &[("name", &t.name)]),
        None => t(cx, keys::v3_shell::UNTITLED_ENTRY),
    }
}

impl Render for EntryHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let book = self.host.page.book.clone();
        let id = self.host.entry.clone();
        let (mark, color) = dr_shell::v3::entry_target(&id)
            .map(|t| book.mark(&t))
            .unwrap_or((dr_ui::sand::Kind::Element, None));
        let template = book
            .v3()
            .and_then(|v| v.template_of(&id))
            .map(|t| t.name.clone());
        let bounds = overlay::use_bounds(
            SharedString::from(format!("v3-entry-mark-bounds-{id}")),
            window,
            cx,
        );
        let picker = self.picker.clone().map(|picker| {
            let place = match *bounds.read(cx) {
                Some(rect) => Place::below(rect, 6.0),
                None => Place::Point(window.mouse_position()),
            };
            overlay::float(place, Layer::Popover, picker)
        });
        let size = theme.scale.heading;
        // Comments on the title (T6): a sand underline under it, and where it
        // is, for the composer opened from a menu or a hover card.
        let title_ul = dr_shell::comment_underline(
            SharedString::from(format!("v3-entry-title-ul-{id}")),
            book.v3()
                .map(|v| v.entry_title_comments(&id))
                .unwrap_or_default(),
            self.host.page.workspace.clone(),
            cx,
        );
        let probe_entry = id.clone();
        let title_probe = canvas(
            move |bounds, _, cx| {
                dr_shell::record_entry_title_bounds(probe_entry.clone(), bounds, cx)
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        div()
            .id(SharedString::from(format!("v3-entry-head-{id}")))
            .flex()
            .flex_col()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap_2()
                    .child(
                        div()
                            .id("v3-entry-mark")
                            .role(gpui::Role::Button)
                            .aria_label(t(cx, keys::v3_shell::MARK))
                            .flex_none()
                            .mt(px((size + 12.0 - 21.0).max(0.0) / 2.0))
                            .cursor_pointer()
                            .child(overlay::probe(bounds))
                            .child(
                                KindMark::new(
                                    SharedString::from(format!("v3-entry-mark-{id}")),
                                    mark,
                                )
                                .scale(1.5)
                                .when_some(color, |m, c| m.color(c)),
                            )
                            .on_click(cx.listener(|head, _, window, cx| {
                                if head.picker.is_some() {
                                    head.picker = None;
                                    cx.notify();
                                } else {
                                    head.open_picker(window, cx);
                                }
                            })),
                    )
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_w_0()
                            .font_role(Role::Structure)
                            .type_px(size, size + 12.0)
                            .text_color(theme.palette.ink(1).solid())
                            .child(title_probe)
                            .child(self.title.clone())
                            .children(title_ul),
                    ),
            )
            .children(template.map(|name| {
                div()
                    .id("v3-entry-template-name")
                    .role(gpui::Role::Label)
                    .aria_label(name.clone())
                    .pl(px(29.0))
                    .font_role(Role::Ui)
                    .type_px(theme.scale.caption, theme.scale.line_caption)
                    .text_color(theme.palette.muted().solid())
                    .child(name)
            }))
            .when(self.draft.failed, |el| {
                el.child(
                    div()
                        .pl(px(29.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .font_role(Role::Ui)
                        .type_px(theme.scale.caption, theme.scale.line_caption)
                        .text_color(theme.palette.danger.solid())
                        .child(t(cx, keys::k4_pages::SAVE_FAILED))
                        .child(
                            dr_ui::components::Button::new(
                                "retry-entry-title",
                                t(cx, keys::markdown_share::RETRY),
                            )
                            .small()
                            .text()
                            .on_click(cx.listener(|head, _, _, cx| head.save(true, cx))),
                        ),
                )
            })
            .children(picker)
    }
}
