//! The Review tab: comments and TODOs of the book (docs/design-system/
//! components.md, Review 卡).
//!
//! - A row of three (全部 / 批注 / TODO) and a scope toggle (当前: only the
//!   current tab's entity) over the list; the list is grouped by where the
//!   items are, resolved ones folded under 「已解决（n）」 at the end.
//! - A card has no ground, only a still hairline of clear glass that drifts
//!   under the pointer; the comment or TODO colour stays on its type word.
//!   Pointing at a card turns its sand in the prose hot; resting the pointer
//!   on the sand in the prose lights the card (dr-editor's
//!   [`ReviewFocus`]).
//! - The arrow jumps to the text: the shell opens the entity (the
//!   [`crate::Opener`] it gave) and the editor shows the comment and draws
//!   its sand again.
//! - Double-click the body to edit it in place, on a slip of paper with
//!   F5's multi-line input (Enter a new line, ⌘↵ saves, Esc cancels).
//! - Resting on a card floats out its source card beside it (the 0.1
//!   client's `CommentSourceHoverCard`, right of the card or left when the
//!   right has no room): what it is on, with that thing's mark, and the
//!   passage it was written on (原文) on a slip of the page — the words
//!   selected then, or the paragraphs it spanned, read when the card opens,
//!   with 「已删除/改动」 under it when the prose there has changed since;
//!   the card's rows at the bottom: edit, resolve or reopen, turn into a
//!   TODO or a note, delete (no right-click menu).
//! - A TODO's round button completes it: a check stroke is drawn in it
//!   from left to right (0.38 s); undone, the stroke goes back. A note is
//!   resolved and reopened with a text button.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use dr_editor::decor::{Original, ReviewFocus};
use dr_i18n::{I18n, Locale, Platform, keys};
use dr_ui::Theme;
use dr_ui::anim::{self, Tween};
use dr_ui::components::{
    Button, CardAction, CardBody, EmptyState, HoverCard, ScopeToggle, Segmented,
};
use dr_ui::fonts::Role;
use dr_ui::glass::{self, Kind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled;
use dr_ui::tokens::{Easing, Story, motion, radius};
use dr_workspace::commands::EntityIn;
use dr_workspace::commands::comment::{
    CommentDelete, CommentList, CommentListIn, CommentUpdate, CommentUpdateIn,
};
use dr_workspace::commands::relation::{RelationList, RelationListIn};
use dr_workspace::dto::{CommentInfo, RelationInfo, Target};
use dr_workspace::{Actor, LinkGroup, NavTarget, Workspace};
use gpui::{
    AnyElement, AppContext, ClickEvent, Context, ElementId, Entity, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Subscription, Task, Window, div, prelude::FluentBuilder, px,
};

use crate::Opener;
use crate::model::{self, Filter, Group, Listing, Place};

/// The Review tab of one pane.
pub struct ReviewView {
    id: SharedString,
    lib: Option<Workspace>,
    pub(crate) book: String,
    target: Option<NavTarget>,
    i18n: I18n,
    items: Vec<CommentInfo>,
    /// Only the built-in generic associations, never custom relation types.
    associations: Vec<RelationInfo>,
    /// Titles and tabs of the items' targets (`kind:id`).
    places: HashMap<String, (String, Option<NavTarget>)>,
    filter: Filter,
    current_only: bool,
    resolved_open: bool,
    editing: Option<(String, Entity<TextArea>, Subscription)>,
    /// TODOs completed or undone here: their check strokes are drawn.
    checks: HashMap<String, Tween>,
    pending: Option<Task<()>>,
    loaded: bool,
    opener: Option<Opener>,
    /// The passages source cards show (原文), read when a card opens, and
    /// the ones being read.
    originals: HashMap<String, (Instant, Option<Original>)>,
    asking: HashSet<String>,
}

/// How long a source card trusts the passage it read (the prose may have
/// changed under it since).
const ORIGINAL_FRESH: Duration = Duration::from_secs(2);

/// Where a comment is, as a tab: a chapter, an idea, an element ….
fn nav_of(catalog: &dr_workspace::BookCatalog, target: &Target) -> Option<NavTarget> {
    if target.kind == "material" {
        let nav = NavTarget::Material(target.id.parse().ok()?);
        return catalog.exists(&nav).then_some(nav);
    }
    let groups: &[LinkGroup] = match target.kind.as_str() {
        "node" => &[LinkGroup::Chapters, LinkGroup::Drifts],
        "element" => &[LinkGroup::Elements],
        "storyline" => &[LinkGroup::Storylines],
        "category" => &[LinkGroup::Categories],
        _ => &[],
    };
    groups.iter().find_map(|g| catalog.by_id(*g, &target.id))
}

/// The comment target of a tab.
pub fn target_of(nav: &NavTarget) -> Option<Target> {
    let (kind, id) = nav
        .key()
        .split_once(':')
        .map(|(k, i)| (k.to_owned(), i.to_owned()))?;
    let kind = match kind.as_str() {
        "chapter" | "idea" => "node".to_owned(),
        _ => kind,
    };
    Some(Target { kind, id })
}

impl ReviewView {
    pub(crate) fn new(id: SharedString, lib: Option<Workspace>) -> ReviewView {
        ReviewView {
            id,
            lib,
            book: String::new(),
            target: None,
            i18n: I18n::new(Locale::default(), Platform::current()),
            items: Vec::new(),
            associations: Vec::new(),
            places: HashMap::new(),
            filter: Filter::All,
            current_only: false,
            resolved_open: false,
            editing: None,
            checks: HashMap::new(),
            pending: None,
            loaded: false,
            opener: None,
            originals: HashMap::new(),
            asking: HashSet::new(),
        }
    }

    /// How the arrows open an entity's tab.
    pub fn set_opener(&mut self, open: Opener) {
        self.opener = Some(open);
    }

    /// Shows `book`, following the page `target`.
    pub(crate) fn show(
        &mut self,
        book: &str,
        target: Option<NavTarget>,
        locale: Locale,
        platform: Platform,
        cx: &mut Context<Self>,
    ) {
        if self.i18n.locale() != locale {
            self.i18n = I18n::new(locale, platform);
        }
        if self.target != target {
            self.target = target;
            cx.notify();
        }
        if self.book != book {
            self.book = book.to_owned();
            self.items.clear();
            self.associations.clear();
            self.loaded = false;
            self.reload(cx);
        }
    }

    /// The comments changed: read them again shortly.
    pub(crate) fn schedule(&mut self, cx: &mut Context<Self>) {
        self.pending = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(60))
                .await;
            this.update(cx, |this, cx| this.reload(cx)).ok();
        }));
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.clone();
        if book.is_empty() {
            return;
        }
        let task = cx.background_executor().spawn(async move {
            let items = lib
                .run::<CommentList>(
                    &Actor::User,
                    CommentListIn {
                        book: book.clone(),
                        kind: None,
                        status: None,
                        target: None,
                    },
                )
                .map(|o| o.output)
                .unwrap_or_default();
            let associations = book
                .parse::<dr_model::id::BookId>()
                .ok()
                .and_then(|id| {
                    lib.run::<RelationList>(
                        &Actor::User,
                        RelationListIn {
                            book: book.clone(),
                            entity: None,
                            relation_type: Some(
                                dr_doc::book::generic_relation_type_id(&id).to_string(),
                            ),
                        },
                    )
                    .ok()
                    .map(|o| o.output)
                })
                .unwrap_or_default();
            let mut places = HashMap::new();
            if let Ok(catalog) = lib.catalog(&book) {
                for t in items.iter().filter_map(|i| i.target.as_ref()) {
                    let key = format!("{}:{}", t.kind, t.id);
                    places.entry(key).or_insert_with(|| {
                        let nav = nav_of(&catalog, t);
                        let title = nav
                            .as_ref()
                            .and_then(|n| catalog.title(n))
                            .unwrap_or_default();
                        (title, nav)
                    });
                }
            }
            (items, places, associations)
        });
        self.pending = Some(cx.spawn(async move |this, cx| {
            let (items, places, associations) = task.await;
            this.update(cx, |this, cx| {
                this.items = items;
                this.associations = associations;
                this.places = places;
                this.loaded = true;
                cx.notify();
            })
            .ok();
        }));
    }

    /// What is listed now.
    pub fn listing(&self) -> Listing {
        let scope = self
            .current_only
            .then(|| self.target.as_ref().and_then(target_of))
            .flatten();
        let related = scope
            .as_ref()
            .filter(|target| {
                matches!(
                    target.kind.as_str(),
                    "node" | "element" | "storyline" | "category"
                )
            })
            .map(|target| {
                self.associations
                    .iter()
                    .filter(|relation| relation.from.kind == "comment" && &relation.to == target)
                    .map(|relation| relation.from.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        model::arrange_with_related(&self.items, self.filter, scope.as_ref(), &related)
    }

    pub fn set_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        self.filter = filter;
        cx.notify();
    }

    pub fn set_current_only(&mut self, on: bool, cx: &mut Context<Self>) {
        self.current_only = on;
        cx.notify();
    }

    fn update_comment(&mut self, input: CommentUpdateIn, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        // Shown at once; the workspace's event reads the list again.
        if let Some(item) = self.items.iter_mut().find(|i| i.id == input.id) {
            if let Some(body) = &input.body {
                item.body = body.clone();
            }
            if let Some(status) = &input.status {
                item.status = status.clone();
            }
        }
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = lib.run::<CommentUpdate>(&Actor::User, input) {
                    log::warn!("review: comment.update: {e}");
                }
            })
            .detach();
        cx.notify();
    }

    fn update_in(&self, id: &str) -> CommentUpdateIn {
        CommentUpdateIn {
            book: self.book.clone(),
            id: id.to_owned(),
            body: None,
            status: None,
            priority: None,
            kind: None,
            agent_conversation: None,
        }
    }

    /// Completes or reopens a comment; a TODO's check stroke is drawn.
    pub fn set_done(&mut self, id: &str, done: bool, cx: &mut Context<Self>) {
        let now = anim::now();
        let check = self
            .checks
            .entry(id.to_owned())
            .or_insert_with(|| Tween::still(if done { 0.0 } else { 1.0 }));
        check.retarget(
            if done { 1.0 } else { 0.0 },
            now,
            motion::sand::DRAW,
            Easing::EASE_OUT,
        );
        let mut input = self.update_in(id);
        input.status = Some(if done { "resolved" } else { "open" }.into());
        self.update_comment(input, cx);
    }

    /// Starts editing a card's body in place.
    pub fn edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else {
            return;
        };
        let body = item.body.clone();
        let placeholder = self
            .i18n
            .t(keys::review_panel::COMMENT_PLACEHOLDER)
            .to_owned();
        let field_id = ElementId::Name(format!("{}-edit-{id}", self.id).into());
        let field = cx.new(|cx| {
            TextArea::new(field_id, window, cx)
                .placeholder(placeholder)
                .with_text(body)
        });
        let comment = id.to_owned();
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, _, e: &FieldEvent, _, cx| match e {
                FieldEvent::Submitted(text) => this.finish_edit(&comment, Some(text.clone()), cx),
                FieldEvent::Cancelled => this.finish_edit(&comment, None, cx),
                _ => {}
            },
        );
        let handle = gpui::Focusable::focus_handle(field.read(cx), cx);
        window.focus(&handle, cx);
        self.editing = Some((id.to_owned(), field, sub));
        cx.notify();
    }

    /// Ends editing: saves `text` (or cancels with `None`).
    pub fn finish_edit(&mut self, id: &str, text: Option<String>, cx: &mut Context<Self>) {
        if self.editing.as_ref().is_some_and(|(e, _, _)| e == id) {
            self.editing = None;
        }
        if let Some(text) = text {
            let mut input = self.update_in(id);
            input.body = Some(text);
            self.update_comment(input, cx);
        }
        cx.notify();
    }

    /// Turns a note into a TODO or back (`kind`: `todo` or `note`).
    pub fn set_kind(&mut self, id: &str, kind: &str, cx: &mut Context<Self>) {
        if let Some(item) = self.items.iter_mut().find(|i| i.id == id) {
            item.kind = kind.to_owned();
        }
        let mut input = self.update_in(id);
        input.kind = Some(kind.to_owned());
        self.update_comment(input, cx);
    }

    /// Deletes a comment (F3 records how to undo it).
    pub fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.items.retain(|i| i.id != id);
        let input = EntityIn {
            book: self.book.clone(),
            id: id.to_owned(),
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = lib.run::<CommentDelete>(&Actor::User, input) {
                    log::warn!("review: comment.delete: {e}");
                }
            })
            .detach();
        cx.notify();
    }

    /// What the source card of comment `id` says: where it is, and the
    /// passage it is anchored to.
    pub fn source_summary(&self, id: &str) -> Option<(SharedString, Option<SharedString>)> {
        let item = self.items.iter().find(|i| i.id == id)?;
        let source = self.source_of(item);
        Some((source.title, source.quote))
    }

    /// The passage comment `id` was written on, as last read (see
    /// [`Self::want_original`]).
    pub fn original_of(&self, id: &str) -> Option<&Original> {
        self.originals.get(id).and_then(|(_, o)| o.as_ref())
    }

    /// Reads comment `id`'s passage (its 原文 snapshot, and whether the
    /// prose has changed under it) unless a fresh one is at hand.
    pub fn want_original(&mut self, id: &str, cx: &mut Context<Self>) {
        let fresh = self
            .originals
            .get(id)
            .is_some_and(|(at, _)| at.elapsed() < ORIGINAL_FRESH);
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if fresh || !self.asking.insert(id.to_owned()) {
            return;
        }
        let (book, comment) = (self.book.clone(), id.to_owned());
        let task = cx
            .background_executor()
            .spawn(async move { dr_editor::decor::original(&lib, &book, &comment) });
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let found = task.await;
            this.update(cx, |this, cx| {
                this.asking.remove(&id);
                let found = found.unwrap_or_else(|e| {
                    log::warn!("review: the passage of {id}: {e}");
                    None
                });
                let changed = this.originals.get(&id).map(|(_, o)| o) != Some(&found);
                this.originals.insert(id, (Instant::now(), found));
                if changed {
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// What a card's source card shows: the thing it is on and the passage.
    fn source_of(&self, item: &CommentInfo) -> Source {
        let place = item
            .target
            .as_ref()
            .filter(|_| !item.unlocated)
            .and_then(|t| self.places.get(&format!("{}:{}", t.kind, t.id)));
        let Some((title, nav)) = place else {
            return Source {
                title: self
                    .i18n
                    .t(keys::review_panel::SOURCE_FLOATING)
                    .to_owned()
                    .into(),
                mark: None,
                quote: None,
            };
        };
        let key = nav.as_ref().map(NavTarget::key).unwrap_or_default();
        let (kind, id) = key.split_once(':').unwrap_or(("", ""));
        let mark = match kind {
            "chapter" => Some(sand::Kind::Chapter(seal_of(id))),
            "idea" => Some(sand::Kind::Drift { loose: false }),
            "element" => Some(sand::Kind::Element),
            "storyline" => Some(sand::Kind::Storyline),
            "category" => Some(sand::Kind::Category),
            "material" => Some(sand::Kind::Material),
            _ => None,
        };
        let quote = item.anchored.then(|| {
            item.quote
                .clone()
                .filter(|q| !q.is_empty())
                .unwrap_or_else(|| {
                    self.i18n
                        .t(keys::review_panel::SOURCE_TEXT_UNAVAILABLE)
                        .to_owned()
                })
                .into()
        });
        Source {
            title: title.clone().into(),
            mark,
            quote,
        }
    }

    /// Jumps to a comment's text: the shell opens its entity, the editor
    /// shows it and draws it again.
    pub fn jump(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else {
            return;
        };
        let nav = item
            .target
            .as_ref()
            .and_then(|t| self.places.get(&format!("{}:{}", t.kind, t.id)))
            .and_then(|(_, nav)| nav.clone());
        ReviewFocus::jump(id, cx);
        if let (Some(nav), Some(open)) = (nav, self.opener.clone()) {
            open(&nav.key(), window, cx);
        }
    }

    fn group_title(&self, group: &Group) -> SharedString {
        match &group.place {
            Place::On(t) => self
                .places
                .get(&format!("{}:{}", t.kind, t.id))
                .map(|(title, _)| title.clone())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| self.i18n.t(keys::review_panel::groups::DELETED).to_owned())
                .into(),
            Place::Gone => self.i18n.t(keys::review_panel::groups::DELETED).into(),
            Place::Floating => self.i18n.t(keys::review_panel::groups::FLOATING).into(),
        }
    }

    fn card(
        &self,
        item: &CommentInfo,
        resolved: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let todo = item.kind == "todo";
        let focus = ReviewFocus::get(cx);
        let lit = focus.prose.contains(&item.id) || focus.cards.contains(&item.id);
        let id = |part: &str| ElementId::Name(format!("{}-{part}-{}", self.id, item.id).into());
        let color = if todo {
            p.story(Story::S4).mix(p.ink(1), 0.16)
        } else {
            p.comment
        };
        let word: SharedString = if todo {
            self.i18n.t(keys::review_panel::filters::TODO).into()
        } else {
            self.i18n.t(keys::review_panel::filters::COMMENT).into()
        };
        let entity = cx.entity();
        let comment = item.id.clone();
        let mut head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(color.solid())
                    .child(word),
            )
            .child(div().flex_1());
        if item.target.is_some() && !item.unlocated {
            let (entity, comment) = (entity.clone(), comment.clone());
            head = head.child(
                div()
                    .id(id("jump"))
                    .cursor_pointer()
                    .child(sand::icon(Icon::ArrowForward, 13.0, p.muted().solid()))
                    .on_click(move |_: &ClickEvent, window, cx| {
                        entity.update(cx, |this, cx| this.jump(&comment, window, cx));
                    }),
            );
        }
        let done = item.status == "resolved";
        if todo {
            head = head.child(self.check(item, done, window, cx));
        } else {
            let (entity, comment) = (entity.clone(), comment.clone());
            let label = if done {
                keys::comment_rail::actions::REOPEN
            } else {
                keys::comment_rail::actions::RESOLVE
            };
            head = head.child(
                Button::new(id("resolve"), self.i18n.t(label).to_owned())
                    .text()
                    .small()
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |this, cx| this.set_done(&comment, !done, cx));
                    }),
            );
        }
        let mut body = div().flex().flex_col().gap(px(4.0)).child(head);
        if let Some(quote) = item.quote.as_ref().filter(|q| !q.is_empty()) {
            let short: String = quote.chars().take(60).collect();
            body = body.child(
                div()
                    .pl(px(8.0))
                    .font_role(Role::Prose)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.muted().solid())
                    .child(short),
            );
        }
        match &self.editing {
            Some((editing, field, _)) if *editing == item.id => {
                let (save, cancel) = (entity.clone(), entity.clone());
                let (c1, c2) = (comment.clone(), comment.clone());
                let f = field.clone();
                // A slip of paper to write on; the input takes its type.
                let slip = div()
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(px(radius::SM))
                    .bg(p.page.solid())
                    .border_1()
                    .border_color(p.hairline())
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(1).solid())
                    .child(field.clone());
                body = body.child(slip).child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            Button::new(id("cancel"), self.i18n.t(keys::common::CANCEL).to_owned())
                                .text()
                                .small()
                                .on_click(move |_, _, cx| {
                                    cancel.update(cx, |this, cx| this.finish_edit(&c1, None, cx));
                                }),
                        )
                        .child(
                            Button::new(id("save"), self.i18n.t(keys::common::SAVE).to_owned())
                                .primary()
                                .small()
                                .on_click(move |_, _, cx| {
                                    let text = f.read(cx).text();
                                    save.update(cx, |this, cx| {
                                        this.finish_edit(&c2, Some(text), cx)
                                    });
                                }),
                        ),
                );
            }
            _ => {
                let text: SharedString = if item.body.trim().is_empty() {
                    self.i18n.t(keys::comment_rail::card::EMPTY_COMMENT).into()
                } else {
                    item.body.clone().into()
                };
                let (entity, comment) = (entity.clone(), comment.clone());
                body = body.child(
                    div()
                        .id(id("body"))
                        .role(gpui::Role::Label)
                        .aria_label(text.clone())
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(text)
                        .on_click(move |e: &ClickEvent, window, cx| {
                            if e.click_count() >= 2 {
                                entity.update(cx, |this, cx| this.edit(&comment, window, cx));
                            }
                        }),
                );
            }
        }
        let pointed = comment.clone();
        let source = self.source_of(item);
        let labels = Labels {
            edit: self.i18n.t(keys::common::EDIT).to_owned().into(),
            status: self
                .i18n
                .t(if done {
                    keys::comment_rail::actions::REOPEN
                } else {
                    keys::comment_rail::actions::RESOLVE
                })
                .to_owned()
                .into(),
            convert: self
                .i18n
                .t(if todo {
                    keys::comment_rail::actions::TO_NOTE
                } else {
                    keys::comment_rail::actions::TO_TODO
                })
                .to_owned()
                .into(),
            delete: self.i18n.t(keys::common::DELETE).to_owned().into(),
            changed: self
                .i18n
                .t(keys::comment_rail::snapshot::CHANGED)
                .to_owned()
                .into(),
        };
        let card_id = format!("{}-src-{}", self.id, item.id);
        let (card_entity, card_comment) = (entity.clone(), comment.clone());
        let source_card = move |window: &mut Window, cx: &mut gpui::App| {
            // The passage is read when the card opens (and again once it is
            // a little old): the prose may have changed under it.
            let (view, id) = (card_entity.clone(), card_comment.clone());
            window.defer(cx, move |_, cx| {
                view.update(cx, |v, cx| v.want_original(&id, cx));
            });
            let original = card_entity.read(cx).original_of(&card_comment).cloned();
            source_card(
                &card_id,
                &source,
                original.as_ref(),
                &labels,
                card_entity.clone(),
                card_comment.clone(),
                todo,
                done,
            )
        };
        // The glass answers the pointer itself; the card around it tells
        // the prose which card the pointer is on.
        let card = div()
            .id(id("wrap"))
            .w_full()
            .on_hover(move |hovered, _, cx| {
                let ids = if *hovered {
                    vec![pointed.clone()]
                } else {
                    Vec::new()
                };
                ReviewFocus::point_cards(ids, cx);
            })
            .child(
                glass::glass_box(
                    id("card"),
                    Kind::Surface,
                    Mode::default(),
                    lit,
                    Spec::new(Tone::Clear, radius::MD),
                    window,
                    cx,
                )
                .w_full()
                .p(px(10.0))
                .when(resolved, |d| d.opacity(0.55))
                .child(body),
            );
        let editing = self.editing.as_ref().is_some_and(|(e, _, _)| *e == item.id);
        if editing {
            // No card over the slip being written on.
            return card.into_any_element();
        }
        HoverCard::new(id("source"), card, source_card)
            .beside()
            .into_any_element()
    }

    /// A TODO's round completion button with its check stroke.
    fn check(
        &self,
        item: &CommentInfo,
        done: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let now = anim::now();
        let drawn = match self.checks.get(&item.id) {
            Some(t) => {
                anim::keep_going(!t.settled(now), window);
                if theme.reduce_motion {
                    if done { 1.0 } else { 0.0 }
                } else {
                    t.value(now)
                }
            }
            None => {
                if done {
                    1.0
                } else {
                    0.0
                }
            }
        };
        let size = 20.0;
        let entity = cx.entity();
        let comment = item.id.clone();
        glass::glass_box(
            ElementId::Name(format!("{}-check-{}", self.id, item.id).into()),
            Kind::Rest,
            Mode::default(),
            done,
            Spec::new(Tone::Clear, size / 2.0),
            window,
            cx,
        )
        .size(px(size))
        .flex_none()
        .rounded_full()
        .cursor_pointer()
        .child(
            // The stroke drawn from left to right: the icon clipped.
            div()
                .absolute()
                .top(px(3.0))
                .left(px(3.0))
                .h(px(size - 6.0))
                .w(px((size - 6.0) * drawn))
                .overflow_hidden()
                .child(sand::icon(Icon::Check, size - 6.0, p.ink(1).solid())),
        )
        .on_click(move |_, _, cx| {
            entity.update(cx, |this, cx| this.set_done(&comment, !done, cx));
        })
        .into_any_element()
    }
}

impl Render for ReviewView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let listing = self.listing();
        let entity = cx.entity();
        let options = [
            self.i18n.t(keys::review_panel::filters::ALL).to_owned(),
            self.i18n.t(keys::review_panel::filters::COMMENT).to_owned(),
            self.i18n.t(keys::review_panel::filters::TODO).to_owned(),
        ];
        let filters = {
            let entity = entity.clone();
            Segmented::new(
                ElementId::Name(format!("{}-filter", self.id).into()),
                options,
                self.filter.index(),
            )
            .on_change(move |ix, _, cx| {
                entity.update(cx, |this, cx| this.set_filter(Filter::ALL[ix], cx));
            })
        };
        let scope = {
            let entity = entity.clone();
            ScopeToggle::new(
                ElementId::Name(format!("{}-scope", self.id).into()),
                self.i18n.t(keys::review_panel::scopes::CURRENT).to_owned(),
                self.current_only,
            )
            .disabled(self.target.as_ref().and_then(target_of).is_none())
            .on_change(move |on, _, cx| {
                entity.update(cx, |this, cx| this.set_current_only(on, cx));
            })
        };
        let toolbar = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .px(px(12.0))
            .py(px(8.0))
            .child(filters)
            .child(scope);
        let mut list = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .px(px(12.0))
            .pb(px(16.0));
        if self.loaded && listing.open.is_empty() && listing.resolved_count == 0 {
            list = list.child(EmptyState::new(
                ElementId::Name(format!("{}-empty", self.id).into()),
                self.i18n.t(keys::review_panel::EMPTY).to_owned(),
            ));
        }
        let header = |title: SharedString| {
            div()
                .pt(px(4.0))
                .font_role(Role::Structure)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .child(title)
        };
        for group in &listing.open {
            // One target needs no header (the current entity alone).
            if !(self.current_only && listing.open.len() == 1) {
                list = list.child(header(self.group_title(group)));
            }
            for item in &group.items {
                list = list.child(self.card(item, false, window, cx));
            }
        }
        if listing.resolved_count > 0 {
            let open = self.resolved_open;
            let toggle = entity.clone();
            list = list.child(
                div()
                    .id(ElementId::Name(format!("{}-resolved", self.id).into()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .pt(px(6.0))
                    .cursor_pointer()
                    .child(sand::icon(
                        if open {
                            Icon::ChevronDown
                        } else {
                            Icon::ChevronRight
                        },
                        11.0,
                        p.muted().solid(),
                    ))
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .weight(FontWeight::NORMAL)
                            .child(self.i18n.fmt(
                                keys::review_panel::RESOLVED,
                                &[("count", &listing.resolved_count)],
                            )),
                    )
                    .on_click(move |_, _, cx| {
                        toggle.update(cx, |this, cx| {
                            this.resolved_open = !this.resolved_open;
                            cx.notify();
                        });
                    }),
            );
            if open {
                for group in &listing.resolved {
                    list = list.child(header(self.group_title(group)));
                    for item in &group.items {
                        list = list.child(self.card(item, true, window, cx));
                    }
                }
            }
        }
        div().size_full().flex().flex_col().child(toolbar).child(
            div()
                .id(ElementId::Name(format!("{}-list", self.id).into()))
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(list),
        )
    }
}

/// The time a check stroke takes, for tests.
pub const CHECK_DRAW: Duration = motion::sand::DRAW;

/// What a source card shows.
#[derive(Clone)]
struct Source {
    title: SharedString,
    mark: Option<sand::Kind>,
    /// The anchored passage (or the words saying it was not kept).
    quote: Option<SharedString>,
}

/// The source card's row labels, in the tab's language.
#[derive(Clone)]
struct Labels {
    edit: SharedString,
    status: SharedString,
    convert: SharedString,
    delete: SharedString,
    /// Under the passage when the prose under it has changed.
    changed: SharedString,
}

/// The card beside a Review card: its source, the passage it was written
/// on (on a slip of the page; the words then, or the paragraphs it spanned,
/// with a word when the prose has changed since), then its rows.
#[allow(clippy::too_many_arguments)]
fn source_card(
    id: &str,
    source: &Source,
    original: Option<&Original>,
    labels: &Labels,
    view: Entity<ReviewView>,
    comment: String,
    todo: bool,
    done: bool,
) -> AnyElement {
    let rid = |part: &str| ElementId::Name(format!("{id}-{part}").into());
    let mut body = CardBody::new(rid("body"), source.title.clone());
    if let Some(mark) = source.mark {
        body = body.mark(mark, None);
    }
    match (original, &source.quote) {
        (Some(original), _) => {
            let note = (original.changed == Some(true)).then(|| labels.changed.clone());
            body = body.quote(original.text.clone(), note);
        }
        (None, Some(quote)) => body = body.quote(quote.clone(), None),
        _ => {}
    }
    let (v1, c1) = (view.clone(), comment.clone());
    let (v2, c2) = (view.clone(), comment.clone());
    let (v3, c3) = (view.clone(), comment.clone());
    let (v4, c4) = (view, comment);
    body.section(vec![
        CardAction::new(rid("edit"), Icon::Edit, labels.edit.clone())
            .on_click(move |_, window, cx| v1.update(cx, |v, cx| v.edit(&c1, window, cx)))
            .into_any_element(),
    ])
    .section(vec![
        CardAction::new(
            rid("status"),
            if done { Icon::Rotate } else { Icon::Check },
            labels.status.clone(),
        )
        .on_click(move |_, _, cx| v2.update(cx, |v, cx| v.set_done(&c2, !done, cx)))
        .into_any_element(),
        CardAction::new(
            rid("convert"),
            if todo {
                Icon::Comment
            } else {
                Icon::ChecklistPlus
            },
            labels.convert.clone(),
        )
        .on_click(move |_, _, cx| {
            v3.update(cx, |v, cx| {
                v.set_kind(&c3, if todo { "note" } else { "todo" }, cx)
            })
        })
        .into_any_element(),
    ])
    .section(vec![
        CardAction::new(rid("delete"), Icon::Trash, labels.delete.clone())
            .danger()
            .on_click(move |_, _, cx| v4.update(cx, |v, cx| v.delete(&c4, cx)))
            .into_any_element(),
    ])
    .into_any_element()
}

/// The seal a chapter presses (the 0.1 client's `sealOf`: a 31-hash of the
/// id over UTF-16 units, modulo 6; the same as the shell's).
fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
}
