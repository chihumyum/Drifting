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
use dr_workspace::{Actor, Workspace};
use gpui::{AnyElement, IntoElement, ParentElement, SharedString, Styled, div};
use serde_json::{Value, json};

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

fn list(ws: &Workspace, name: &str, book: &str) -> Vec<Value> {
    ws.call(&Actor::User, name, json!({ "book": book }))
        .ok()
        .and_then(|v| v["output"].as_array().cloned())
        .unwrap_or_default()
}

fn find<'a>(items: &'a [Value], id: &str) -> Option<&'a Value> {
    items.iter().find(|v| v["id"].as_str() == Some(id))
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}

/// Groups digits by thousands (「12,345」).
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

/// `book.word_counts`: the derived index's words of each live chapter and
/// storyline.
fn word_counts(ws: &Workspace, book: &str) -> Value {
    ws.call(&Actor::User, "book.word_counts", json!({ "book": book }))
        .map(|v| v["output"].clone())
        .unwrap_or_default()
}

/// The words of row `id` of `rows`, `None` while it is still being counted.
fn words_of(rows: &Value, id: &str) -> Option<u64> {
    rows.as_array()?
        .iter()
        .find(|r| r["id"].as_str() == Some(id))
        .filter(|r| r["counted"].as_bool().unwrap_or(true))
        .and_then(|r| r["words"].as_u64())
}

/// The card of `target` in `book`, or `None` when it is in the trash, gone,
/// or of a kind without a card.
pub fn card_facts(ws: &Workspace, book: &str, target: &LinkTarget) -> Option<CardFacts> {
    let id = target.id.as_str();
    let base = |title: String, mark: sand::Kind| CardFacts {
        target: target.clone(),
        title,
        mark,
        color: None,
        count: None,
        tags: Vec::new(),
        aka: None,
        summary: String::new(),
        facts: Vec::new(),
    };
    match target.kind {
        EntityKind::Element => {
            let elements = list(ws, "element.list", book);
            let e = find(&elements, id).filter(|e| !e["trashed"].as_bool().unwrap_or(false))?;
            let categories = list(ws, "category.list", book);
            let category = e["category"].as_str().and_then(|c| find(&categories, c));
            let mut card = base(s(e, "name"), sand::Kind::Element);
            card.color = category.map(|c| s(c, "color"));
            card.tags
                .push(category.map_or("未分类".to_owned(), |c| s(c, "name")));
            if let Some(g) = e["group_name"].as_str().filter(|g| !g.is_empty()) {
                card.tags.push(g.to_owned());
            }
            let aliases: Vec<String> = e["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .collect();
            if !aliases.is_empty() {
                let shown = aliases
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" · ");
                let more = aliases.len().saturating_sub(3);
                card.aka = Some(if more > 0 {
                    format!("AKA {shown} +{more}")
                } else {
                    format!("AKA {shown}")
                });
            }
            card.summary = s(e, "summary");
            card.facts = e["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| (s(f, "key"), s(f, "value")))
                .filter(|(k, v)| !k.is_empty() || !v.is_empty())
                .collect();
            Some(card)
        }
        EntityKind::Node => {
            let chapters = list(ws, "chapter.list", book);
            if let Some(c) = find(&chapters, id) {
                if c["trashed"].as_bool().unwrap_or(false) {
                    return None;
                }
                let storylines = list(ws, "storyline.list", book);
                let name_of = |sid: &str| find(&storylines, sid).map(|l| s(l, "name"));
                let mut card = base(s(c, "title"), sand::Kind::Chapter(0));
                let words = words_of(&word_counts(ws, book)["chapters"], id);
                card.count = Some(match words {
                    Some(w) => format!("{} 字", grouped(w)),
                    None => "统计中…".to_owned(),
                });
                card.tags.push(
                    match s(c, "status").as_str() {
                        "finished" => "已完成",
                        "discarded" => "已弃用",
                        _ => "草稿",
                    }
                    .to_owned(),
                );
                let primary = c["primary_storyline"].as_str().map(str::to_owned);
                let all: Vec<String> = c["storylines"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                let first = primary.or_else(|| all.first().cloned());
                match first.as_deref().and_then(name_of) {
                    Some(n) => card.tags.push(n),
                    None => card.tags.push("未归属故事线".to_owned()),
                }
                for other in all.iter().filter(|o| Some(o.as_str()) != first.as_deref()) {
                    if let Some(n) = name_of(other) {
                        card.tags.push(n);
                    }
                }
                card.summary = s(c, "summary");
                return Some(card);
            }
            let ideas = list(ws, "idea.list", book);
            let i = find(&ideas, id).filter(|i| !i["trashed"].as_bool().unwrap_or(false))?;
            let mut card = base(
                s(i, "title"),
                sand::Kind::Drift {
                    loose: i["group"].is_null(),
                },
            );
            card.tags.push("构想".to_owned());
            card.summary = s(i, "summary");
            Some(card)
        }
        EntityKind::Storyline => {
            let storylines = list(ws, "storyline.list", book);
            let l = find(&storylines, id).filter(|l| !l["trashed"].as_bool().unwrap_or(false))?;
            let counts = word_counts(ws, book);
            let row = counts["storylines"]
                .as_array()
                .and_then(|a| a.iter().find(|r| r["id"].as_str() == Some(id)).cloned())
                .unwrap_or_default();
            let mut card = base(s(l, "name"), sand::Kind::Storyline);
            card.color = Some(s(l, "color"));
            card.count = Some(if row["counted"].as_bool().unwrap_or(false) {
                format!(
                    "{} 章 · {:.1}k 字",
                    row["chapters"].as_u64().unwrap_or(0),
                    row["words"].as_u64().unwrap_or(0) as f64 / 1000.
                )
            } else {
                "统计中…".to_owned()
            });
            card.summary = s(l, "summary");
            Some(card)
        }
        EntityKind::Category => {
            let categories = list(ws, "category.list", book);
            let c = find(&categories, id).filter(|c| !c["trashed"].as_bool().unwrap_or(false))?;
            let mut card = base(s(c, "name"), sand::Kind::Category);
            card.color = Some(s(c, "color"));
            card.count = Some(format!("{} 要素", c["elements"].as_u64().unwrap_or(0)));
            Some(card)
        }
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    #[test]
    fn thousands_are_grouped() {
        assert_eq!(super::grouped(0), "0");
        assert_eq!(super::grouped(999), "999");
        assert_eq!(super::grouped(12345), "12,345");
        assert_eq!(super::grouped(1234567), "1,234,567");
    }
}
