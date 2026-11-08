//! The hover cards on the tracks (the 0.1 client's `EntityHoverCard` on the
//! timeline): a chapter's slab and a storyline lane's name. The card is the
//! shell's own page card (`dr_shell::workspace::page_hover_card`, the
//! chapter panel's: name, words, storylines, summary, then what its ⋯ menu
//! offers); the timeline adds its own rows as `extra`, which the shell puts
//! before the dangerous ones:
//!
//! - a chapter: 转移至未归属 (when it is on a storyline) and, on the
//!   narrative axis, 回到未放置;
//! - a lane: 在此故事线中新建章节 (just past the last chapter on the axis
//!   shown).
//!
//! What used to be their right-click menu is along the bottom of the card;
//! right-click itself is the system's.

use super::*;

use dr_shell::pages::{PageMenuItem, PageMenuSection};
use dr_shell::workspace::page_hover_card;

/// What a card is about.
#[derive(Clone)]
pub(super) enum CardOf {
    Chapter(String),
    Storyline(String),
}

type Run = Rc<dyn Fn(&mut Window, &mut App)>;

impl BottomTimeline {
    /// Holds the timeline's own card `key` open (`timeline-pin-card-<pin>`,
    /// `timeline-act-card-<act>`) whatever the pointer does; `None` lets it
    /// go (captures, where nothing hovers). The slabs' and lanes' cards are
    /// the shell's and follow the pointer only.
    pub fn hold_card(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        self.held_card = key;
        cx.notify();
    }

    /// The card `key` is held open.
    pub(super) fn held(
        &self,
        key: &str,
        card: dr_ui::components::HoverCard,
    ) -> dr_ui::components::HoverCard {
        if self.held_card.as_deref() == Some(key) {
            card.force_open(true)
        } else {
            card
        }
    }

    /// `el` with `of`'s card: the shell's page card with the timeline's rows.
    pub(super) fn with_card(
        &self,
        id: String,
        el: impl IntoElement,
        of: CardOf,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = match &of {
            CardOf::Chapter(id) => id.parse().ok().map(Target::Chapter),
            CardOf::Storyline(id) => id.parse().ok().map(Target::Storyline),
        };
        let (Some(ws), Some(target)) = (self.ws.upgrade(), target) else {
            return el.into_any_element();
        };
        // The timeline's own rows lead the card, above the page's (0.1's
        // order); F6's CardRows since its round nine.
        let rows = dr_shell::pages::CardRows {
            lead: self.card_rows(&of, cx),
            ..Default::default()
        };
        page_hover_card(id, el, &target, &ws, rows, cx)
    }

    /// The timeline's own rows on `of`'s card (tests read their ids).
    pub fn card_row_ids(&self, chapter_or_storyline: &str, cx: &mut Context<Self>) -> Vec<String> {
        let of = if self
            .book
            .chapters
            .iter()
            .any(|c| c.id == chapter_or_storyline)
        {
            CardOf::Chapter(chapter_or_storyline.to_owned())
        } else {
            CardOf::Storyline(chapter_or_storyline.to_owned())
        };
        self.card_rows(&of, cx)
            .into_iter()
            .flat_map(|s| s.items)
            .map(|i| i.id.to_string())
            .collect()
    }

    fn card_rows(&self, of: &CardOf, cx: &mut Context<Self>) -> Vec<PageMenuSection> {
        let entity = cx.entity();
        let row = |id: &str, icon: Icon, label: SharedString, run: Run| PageMenuItem {
            id: SharedString::from(id.to_owned()),
            icon: icon.into(),
            label,
            checked: false,
            danger: false,
            run,
        };
        let mut items = Vec::new();
        match of {
            CardOf::Chapter(id) => {
                let Some(c) = self.book.chapters.iter().find(|c| &c.id == id) else {
                    return Vec::new();
                };
                if !c.storylines.is_empty() {
                    let (entity, id) = (entity.clone(), id.clone());
                    items.push(row(
                        "timeline-unaffiliated",
                        Icon::ArrowOut,
                        t(cx, keys::bottom_timeline::menu::MOVE_TO_UNAFFILIATED),
                        Rc::new(move |_, cx| {
                            entity.update(cx, |t, cx| t.move_to_unaffiliated(&id, cx))
                        }),
                    ));
                }
                if self.axis == Axis::Narrative && c.narrative_order.is_some() {
                    let (entity, id) = (entity.clone(), id.clone());
                    items.push(row(
                        "timeline-unplace",
                        Icon::ArrowIn,
                        t(cx, keys::bottom_timeline::menu::DETACH_FROM_NARRATIVE),
                        Rc::new(move |_, cx| {
                            entity.update(cx, |t, cx| t.detach_from_narrative(&id, cx))
                        }),
                    ));
                }
            }
            CardOf::Storyline(id) => {
                let (entity, id) = (entity.clone(), id.clone());
                items.push(row(
                    "timeline-append",
                    Icon::Plus,
                    t(cx, keys::left_sidebar::groups::NEW_CHAPTER_IN_STORYLINE),
                    Rc::new(move |_, cx| entity.update(cx, |t, cx| t.append_chapter(&id, cx))),
                ));
            }
        }
        if items.is_empty() {
            Vec::new()
        } else {
            vec![PageMenuSection { title: None, items }]
        }
    }

    /// Takes chapter `id` off every storyline (转移至未归属), where it is on
    /// the axis shown.
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
