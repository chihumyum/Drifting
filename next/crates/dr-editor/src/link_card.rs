//! An entity link's hover card (M12): what the linked thing is, at a
//! glance, when the pointer rests on its name in the prose.
//!
//! The 0.1 client's card (`features/entities/hover/EntityHoverCard.tsx`,
//! `entity-hover-card-model.ts`), on dr-ui's one hover card (`CardBody`):
//!
//! - an element: its mark in its category's colour, its name; the
//!   category (or 「未分类」), its group, `AKA` and up to three aliases
//!   (`+N` for the rest); its synopsis; its facts as key and value;
//! - a chapter: its title and words; its status, its primary storyline (or
//!   「未归属故事线」) and the others; its synopsis;
//! - an idea (构想): its title, its group; its synopsis;
//! - a storyline: its name, 「N 章 · x.xk 字」, its synopsis;
//! - a category: its name, 「N 要素」.
//!
//! A target in the trash or gone has no card (and a click on its link does
//! nothing). Timing and placement are the assist's ([`crate::assist`]).

use dr_model::kind::EntityKind;
use dr_text::autolink::LinkTarget;
use dr_ui::components::hover_card::CardBody;
use dr_ui::sand;
use dr_ui::tokens::Rgb;
use dr_workspace::Workspace;
use gpui::{AnyElement, IntoElement, ParentElement, SharedString, Styled, div};

/// What a link's card shows.
#[derive(Clone, Debug, PartialEq)]
pub struct CardFacts {
    pub target: LinkTarget,
    pub title: String,
    pub mark: sand::Kind,
    /// The mark's colour (`#rrggbb`), for an element's category or a
    /// storyline.
    pub color: Option<String>,
    /// Beside the title: 「1,234 字」 for a chapter.
    pub count: Option<String>,
    /// The tags line, in order.
    pub tags: Vec<String>,
    /// 「AKA a · b · c +N」 for an element with aliases.
    pub aka: Option<String>,
    pub summary: String,
    /// An element's facts, key and value.
    pub facts: Vec<(String, String)>,
}

/// The card of `target` in `book`, or `None` when it is in the trash, gone,
/// or of a kind without a card.
pub fn card_facts(ws: &Workspace, book: &str, target: &LinkTarget) -> Option<CardFacts> {
    card_facts_v3(ws, book, target)
}

/// `#rrggbb` as dr-ui's colour.
fn rgb(hex: &str) -> Option<Rgb> {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).ok()?;
    (hex.trim_start_matches('#').len() == 6).then(|| Rgb::hex(v))
}

/// The card, as dr-ui draws hover cards.
pub fn card_element(facts: &CardFacts) -> AnyElement {
    let id = SharedString::from(format!("dr-editor-link-card-{}", facts.target.id));
    let mut body = CardBody::new(id, facts.title.clone())
        .mark(facts.mark, facts.color.as_deref().and_then(rgb));
    if let Some(count) = &facts.count {
        body = body.count(count.clone());
    }
    let mut tags = facts.tags.join(" · ");
    if let Some(aka) = &facts.aka {
        if !tags.is_empty() {
            tags.push('　');
        }
        tags.push_str(aka);
    }
    if !tags.is_empty() {
        body = body.meta(div().child(tags));
    }
    if !facts.summary.is_empty() {
        body = body.summary(facts.summary.clone());
    }
    if !facts.facts.is_empty() {
        let rows = facts
            .facts
            .iter()
            .map(|(k, v)| {
                div()
                    .flex()
                    .gap_2()
                    .child(div().flex_none().child(k.clone()))
                    .child(div().child(v.clone()))
                    .into_any_element()
            })
            .collect();
        body = body.section(rows);
    }
    body.into_any_element()
}

fn card_facts_v3(ws: &Workspace, book: &str, target: &LinkTarget) -> Option<CardFacts> {
    let target = target.clone();
    crate::v3::read(ws, book, move |v| {
        let mut card = CardFacts {
            target: target.clone(),
            title: String::new(),
            mark: sand::Kind::Category,
            color: None,
            count: None,
            tags: Vec::new(),
            aka: None,
            summary: String::new(),
            facts: Vec::new(),
        };
        match target.kind {
            EntityKind::Entry => {
                let e = v
                    .entries()
                    .into_iter()
                    .find(|e| e.id.as_str() == target.id && !e.is_trashed())?;
                let templates = v.templates_map();
                let t = e.effective_template(&templates)?;
                card.title = e.title.clone();
                card.color = t.color.clone();
                card.tags.push(t.name.clone());
                let aliases = e.aliases(&templates);
                if !aliases.is_empty() {
                    card.aka = Some(aliases.into_iter().collect::<Vec<_>>().join(" · "));
                }
                for m in &t.modules {
                    if let Some(key) = &m.config.summary_field {
                        card.summary = e
                            .fields
                            .get(&m.id)
                            .and_then(|f| f.get(key))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_owned();
                    }
                    if let Some(rows) = e.kv.get(&m.id) {
                        card.facts
                            .extend(rows.iter().map(|r| (r.key.clone(), r.value.clone())));
                    }
                }
            }
            EntityKind::Material => {
                let m = v
                    .materials()
                    .into_iter()
                    .find(|m| m.id.as_str() == target.id)?;
                card.title = m.title;
                card.summary = m.description;
            }
            _ => return None,
        }
        Some(card)
    })
    .ok()
    .flatten()
}
