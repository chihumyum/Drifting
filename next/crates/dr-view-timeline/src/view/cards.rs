//! The hover cards on the tracks (the 0.1 client's `EntityHoverCard` on the
//! timeline): a chapter's slab and a storyline lane's name. What used to be
//! their right-click menu is along the bottom of the card; right-click
//! itself is the system's.
//!
//! - A chapter's card: its title and seal, its words, its storylines (the
//!   main one first), its synopsis; then the timeline's own rows —
//!   转移至未归属 (when it is on a storyline) and, on the narrative axis,
//!   回到未放置 — then the rows the shell lists for a chapter (its ⋯ menu's,
//!   `page_actions`).
//! - A lane's card, beside the name: the storyline's chapters and words
//!   and its summary; 在此故事线中新建章节 (just past the last chapter on
//!   the axis shown), then the shell's rows for a storyline.
//!
//! The card is dr-ui's `HoverCard`; the shell's own chapter-panel card is
//! not yet open to modules (m14-timeline.md, 「待协调」), so this one is
//! built the same way from the same rows.

use super::*;

use dr_shell::pages::PageMenuHost;
use dr_shell::workspace::page_actions::page_actions;
use dr_ui::components::{CardAction, CardBody, HoverCard};

/// What a card is about.
#[derive(Clone)]
pub(super) enum CardOf {
    Chapter(String),
    Storyline(String),
}

/// `n` grouped by thousands (`toLocaleString`).
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

impl BottomTimeline {
    fn host(&self) -> PageMenuHost {
        PageMenuHost {
            workspace: self.ws.clone(),
            library: self.lib.clone(),
            book_id: self.book.id.clone(),
            book: self.book.clone(),
        }
    }

    /// Holds the card `key` open (`timeline-clip-card-<chapter>`,
    /// `timeline-rail-card-<storyline>`, `timeline-pin-card-<pin>`,
    /// `timeline-act-card-<act>`) whatever the pointer does; `None` lets it
    /// go (captures, where nothing hovers).
    pub fn hold_card(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        self.held_card = key;
        cx.notify();
    }

    /// The card `key` is held open.
    pub(super) fn held(&self, key: &str, card: HoverCard) -> HoverCard {
        if self.held_card.as_deref() == Some(key) {
            card.force_open(true)
        } else {
            card
        }
    }

    /// `el` with `of`'s hover card (beside it for a lane's name).
    pub(super) fn with_card(
        &self,
        id: String,
        el: impl IntoElement,
        of: CardOf,
        beside: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let card = HoverCard::new(ElementId::Name(id.clone().into()), el, move |window, cx| {
            card(&entity, &of, window, cx)
        });
        let card = self.held(&id, card);
        if beside {
            card.beside().into_any_element()
        } else {
            card.into_any_element()
        }
    }

    /// Takes chapter `id` off every storyline (转移至未归属).
    pub fn move_to_unaffiliated(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(order) = self
            .book
            .chapters
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| self.axis.order(c))
        else {
            return;
        };
        self.move_chapter(
            id,
            DropAt {
                lane: LaneId::Unaffiliated,
                order,
            },
            cx,
        );
    }

    /// Takes chapter `id` off the narrative axis (回到未放置).
    pub fn detach_from_narrative(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (book, id) = (self.book.id.clone(), id.to_owned());
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = lib.run::<ChapterUpdate>(
                    &Actor::User,
                    ChapterUpdateIn {
                        book,
                        id,
                        narrative_order: Some(None),
                        ..ChapterUpdateIn::default()
                    },
                ) {
                    log::warn!("timeline: taking a chapter off the narrative axis failed: {e}");
                }
            })
            .detach();
    }

    /// A new chapter on `storyline`, just past the last chapter on the axis
    /// shown (the lane card's 在此故事线中新建章节).
    pub fn append_chapter(&mut self, storyline: &str, cx: &mut Context<Self>) {
        let layout = self.layout();
        let last = self
            .book
            .chapters
            .iter()
            .filter_map(|c| self.axis.order(c))
            .fold(f64::NEG_INFINITY, f64::max);
        let order = if last.is_finite() {
            last + model::CHAPTER_STRIDE
        } else {
            layout.scale.min_order
        };
        self.create_at(&LaneId::Storyline(storyline.to_owned()), order, cx);
    }
}

fn card(
    entity: &Entity<BottomTimeline>,
    of: &CardOf,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let (book, axis, host, ws) = {
        let t = entity.read(cx);
        (t.book.clone(), t.axis, t.host(), t.ws.upgrade())
    };
    let (key, target, mut body, timeline_rows) = match of {
        CardOf::Chapter(id) => {
            let key = format!("timeline-clip-card-{id}");
            let Some(c) = book.chapters.iter().find(|c| &c.id == id) else {
                return div().into_any_element();
            };
            let live: std::collections::HashMap<&str, usize> = book
                .storylines
                .iter()
                .enumerate()
                .map(|(i, s)| (s.id.as_str(), i))
                .collect();
            let main = model::main_storyline(c, &live);
            let color = main
                .and_then(|m| book.storylines.iter().find(|s| s.id == m))
                .and_then(|s| color_of(&s.color));
            let mut body = CardBody::new(
                ElementId::Name(format!("{key}-body").into()),
                untitled(&c.title, cx),
            )
            .mark(sand::Kind::Chapter(seal_of(&c.id)), color)
            .count(tf(
                cx,
                keys::node_editor::meta::WORDS,
                &[("count", &grouped(c.words))],
            ));
            let mut on: Vec<&dr_workspace::dto::StorylineInfo> = c
                .storylines
                .iter()
                .filter_map(|s| book.storylines.iter().find(|x| &x.id == s))
                .collect();
            on.sort_by_key(|s| Some(s.id.as_str()) != main);
            let line = if on.is_empty() {
                div()
                    .text_color(p.muted().solid())
                    .child(t(cx, keys::node_editor::empty::NO_STORYLINE))
            } else {
                div().flex().flex_row().flex_wrap().gap(px(8.0)).children(
                    on.into_iter().enumerate().map(|(i, s)| {
                        let ink = if i == 0 { p.ink(2) } else { p.muted() };
                        let mark = KindMark::new(
                            ElementId::Name(format!("{key}-sl-{}", s.id).into()),
                            sand::Kind::Storyline,
                        )
                        .scale(0.7);
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .text_color(ink.solid())
                            .child(match color_of(&s.color) {
                                Some(c) => mark.color(c),
                                None => mark,
                            })
                            .child(s.name.clone())
                    }),
                )
            };
            body = body.meta(line);
            if !c.summary.trim().is_empty() {
                body = body.summary(c.summary.clone());
            }
            let mut rows = Vec::new();
            if !c.storylines.is_empty() {
                let id = c.id.clone();
                rows.push(
                    CardAction::new(
                        ElementId::Name(format!("{key}-unaffiliated").into()),
                        Icon::ArrowOut,
                        t(cx, keys::bottom_timeline::menu::MOVE_TO_UNAFFILIATED),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |t, cx| t.move_to_unaffiliated(&id, cx))
                    })
                    .into_any_element(),
                );
            }
            if axis == Axis::Narrative && c.narrative_order.is_some() {
                let id = c.id.clone();
                rows.push(
                    CardAction::new(
                        ElementId::Name(format!("{key}-unplace").into()),
                        Icon::ArrowIn,
                        t(cx, keys::bottom_timeline::menu::DETACH_FROM_NARRATIVE),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |t, cx| t.detach_from_narrative(&id, cx))
                    })
                    .into_any_element(),
                );
            }
            let target = c.id.parse().ok().map(Target::Chapter);
            (key, target, body, rows)
        }
        CardOf::Storyline(id) => {
            let key = format!("timeline-lane-card-{id}");
            let Some(s) = book.storylines.iter().find(|s| &s.id == id) else {
                return div().into_any_element();
            };
            let chapters: Vec<_> = book.chapters_of(&s.id).collect();
            let words: u64 = chapters.iter().map(|c| c.words).sum();
            let name: SharedString = if s.name.trim().is_empty() {
                t(cx, keys::top_timeline::untitled::STORYLINE)
            } else {
                s.name.clone().into()
            };
            let mut body = CardBody::new(ElementId::Name(format!("{key}-body").into()), name)
                .mark(sand::Kind::Storyline, color_of(&s.color))
                .count(format!(
                    "{} · {}",
                    tf(
                        cx,
                        keys::storyline_editor::meta::CHAPTERS,
                        &[("count", &chapters.len())]
                    ),
                    tf(
                        cx,
                        keys::storyline_editor::meta::K_WORDS,
                        &[("count", &format!("{:.1}", words as f64 / 1000.0))]
                    ),
                ));
            if !s.summary.trim().is_empty() {
                body = body.summary(s.summary.clone());
            }
            let sid = s.id.clone();
            let rows = vec![
                CardAction::new(
                    ElementId::Name(format!("{key}-append").into()),
                    Icon::Plus,
                    t(cx, keys::left_sidebar::groups::NEW_CHAPTER_IN_STORYLINE),
                )
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |t, cx| t.append_chapter(&sid, cx))
                })
                .into_any_element(),
            ];
            let target = s.id.parse().ok().map(Target::Storyline);
            (key, target, body, rows)
        }
    };
    if !timeline_rows.is_empty() {
        body = body.section(timeline_rows);
    }
    if let (Some(ws), Some(target)) = (ws, target) {
        for section in page_actions(&ws, &host, &target, cx) {
            let rows = section
                .items
                .into_iter()
                .map(|item| {
                    let run = item.run.clone();
                    let mut action = CardAction::new(
                        ElementId::Name(format!("{key}-{}", item.id).into()),
                        item.icon,
                        item.label,
                    )
                    .current(item.checked)
                    .on_click(move |_, window, cx| run(window, cx));
                    if item.danger {
                        action = action.danger();
                    }
                    action.into_any_element()
                })
                .collect();
            body = body.section(rows);
        }
    }
    body.into_any_element()
}
