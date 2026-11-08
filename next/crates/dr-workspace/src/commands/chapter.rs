//! Chapters and acts (幕).

use dr_doc::book::Collection;
use dr_model::DocId;
use dr_model::book::EntityRef;
use dr_model::id::{ActId, NodeId, StorylineId};
use dr_model::kind::{EntityKind, NodeKind, NodeStatus};
use dr_model::order::{act_index_for_order, chapter_order_after, cmp_order};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::{ActInfo, ChapterInfo};
use crate::naming::unique_name;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ChapterList>()
        .add::<ChapterCreate>()
        .add::<ChapterUpdate>()
        .add::<ChapterMove>()
        .add::<ChapterSetPlace>()
        .add::<ChapterSpread>()
        .add::<ChapterArrange>()
        .add::<ChapterTrash>()
        .add::<ChapterRestore>()
        .add::<ChapterPurge>()
        .add::<ActList>()
        .add::<ActCreate>()
        .add::<ActUpdate>()
        .add::<ActDelete>();
}

pub(crate) const UNTITLED: &str = "Untitled";

/// Where a chapter goes in reading order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChapterPlace {
    /// Before every chapter.
    First,
    /// After every chapter.
    Last,
    /// Right after this chapter (before the next chapter or act boundary).
    After(String),
    /// Right before this chapter.
    Before(String),
    /// An exact book-order coordinate (undo uses it).
    Order(f64),
}

fn live_chapter(slot: &BookSlot, id: &str) -> Result<Node> {
    let nid: NodeId = pid("chapter", id)?;
    match nodes(slot).get(&nid) {
        Some(n) if n.is_chapter() => Ok(n.clone()),
        _ => Err(WsError::not_found("chapter", id)),
    }
}

/// The book order for `place`, leaving `moving` out of the neighbours.
pub(crate) fn order_for(
    slot: &BookSlot,
    place: &ChapterPlace,
    moving: Option<&NodeId>,
) -> Result<f64> {
    let chs: Vec<Node> = chapters(slot)
        .into_iter()
        .filter(|c| Some(&c.id) != moving)
        .collect();
    let orders: Vec<f64> = chs
        .iter()
        .filter_map(|c| c.effective_book_order())
        .collect();
    let starts: Vec<Option<f64>> = acts(slot).iter().map(|a| a.start_order).collect();
    let find = |id: &str| {
        chs.iter()
            .find(|c| c.id.as_str() == id)
            .ok_or_else(|| WsError::not_found("chapter", id))
    };
    Ok(match place {
        ChapterPlace::Last => chapter_order_after(&orders, &starts, None),
        ChapterPlace::First => {
            let first = orders.iter().copied().fold(f64::INFINITY, f64::min);
            if first.is_finite() {
                first - dr_model::order::CHAPTER_ORDER_STRIDE
            } else {
                dr_model::order::CHAPTER_ORDER_STRIDE
            }
        }
        ChapterPlace::After(id) => {
            let at = find(id)?.effective_book_order().unwrap_or(0.0);
            chapter_order_after(&orders, &starts, Some(at))
        }
        ChapterPlace::Before(id) => {
            let at = find(id)?.effective_book_order().unwrap_or(0.0);
            let prev = orders
                .iter()
                .copied()
                .filter(|o| *o < at)
                .fold(f64::NEG_INFINITY, f64::max);
            if prev.is_finite() {
                prev + (at - prev) / 2.0
            } else {
                at - dr_model::order::CHAPTER_ORDER_STRIDE
            }
        }
        ChapterPlace::Order(o) if o.is_finite() => *o,
        ChapterPlace::Order(_) => return Err(WsError::invalid("book order must be finite")),
    })
}

// ---- list -----------------------------------------------------------------

op! {
    ChapterList = "chapter.list", Read, Shared,
    "List chapters in reading order, with their act, storylines, words, creation and last change (trashed ones after, when asked).",
    fn(cx, input: ListIn) -> Vec<ChapterInfo> {
        let slot = cx.book(&input.book)?;
        let a = acts(&slot);
        let lib = cx.workspace().library();
        let facts = |n: &Node| prose_facts(lib, &DocId::Node(n.id.clone()).to_string());
        let mut out: Vec<ChapterInfo> = chapters(&slot).iter().enumerate().map(|(i, n)| {
            let act = n.effective_book_order()
                .and_then(|o| act_index_for_order(&a, o))
                .map(|i| a[i].id.to_string());
            ChapterInfo::of(n, Some(i as u32 + 1), act).with_prose(facts(n))
        }).collect();
        if input.trashed {
            let mut t: Vec<Node> = nodes(&slot).values().filter(|n| n.is_chapter() && n.is_trashed()).cloned().collect();
            t.sort_by(|a, b| cmp_order((a.book_order, &a.id), (b.book_order, &b.id)));
            out.extend(t.iter().map(|n| ChapterInfo::of(n, None, None).with_prose(facts(n))));
        }
        Ok(out)
    }
}

// ---- create -----------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChapterCreateIn {
    pub book: String,
    /// A taken title gets a ` 2` suffix; empty becomes "Untitled".
    #[serde(default)]
    pub title: String,
    /// Default: after the last chapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<ChapterPlace>,
    #[serde(default)]
    pub summary: String,
    /// Put it on this storyline (and make it the primary one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storyline: Option<String>,
    /// Initial text; a newline starts a new paragraph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Its place on the narrative axis (story time), written with the
    /// chapter: a double click on the timeline's story time is one step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative_order: Option<f64>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChapterCreated {
    pub id: String,
    /// The final title (with a suffix if the asked one was taken).
    pub title: String,
    pub book_order: f64,
}

/// Write `text` into a fresh prose document (step 2 of the write order).
pub(crate) fn seed_prose(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    doc: &DocId,
    text: Option<&str>,
) -> Result<()> {
    cx.create_prose(book, doc)?;
    if let Some(t) = text.filter(|t| !t.is_empty()) {
        if t.contains('\u{FFFC}') {
            return Err(WsError::invalid("text may not contain U+FFFC"));
        }
        let names = if cx.workspace().auto_links() && crate::autolink::links_for(cx.actor()) {
            Some(crate::autolink::book_matcher(
                &*cx.book(book.as_str())?,
                doc,
            ))
        } else {
            None
        };
        let slot = cx.prose(doc)?;
        let t = t.replace("\r\n", "\n");
        cx.write_prose(&slot, move |txn| {
            let end = txn.view().len().saturating_sub(1);
            let caret = txn.insert_paragraphs(end, &t)?;
            // Automatic links on the names in the new text, same commit.
            if let Some(n) = &names {
                crate::autolink::link_written(txn, n, end..caret)?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

op! {
    ChapterCreate = "chapter.create", Write, Book,
    "Create a chapter (a taken title gets a numbered suffix; the final title is returned), optionally placed on story time too. Given a storyline and no text, it starts from that storyline's chapter template.",
    fn(cx, input: ChapterCreateIn) -> ChapterCreated {
        let slot = cx.book(&input.book)?;
        let storyline: Option<StorylineId> = match &input.storyline {
            Some(s) => {
                let id: StorylineId = pid("storyline", s)?;
                if !storylines(&slot).iter().any(|x| x.id == id && x.deleted_at.is_none()) {
                    return Err(WsError::not_found("storyline", s));
                }
                Some(id)
            }
            None => None,
        };
        if input.narrative_order.is_some_and(|o| !o.is_finite()) {
            return Err(WsError::invalid("narrative order must be finite"));
        }
        let title = unique_name(&input.title, UNTITLED, node_titles(&slot, None).iter().map(String::as_str));
        let order = order_for(&slot, input.place.as_ref().unwrap_or(&ChapterPlace::Last), None)?;
        let id = NodeId::new_v7();
        cx.summarize(format!("「{title}」"));
        // A new chapter without text starts from its main storyline's
        // chapter template.
        let template = match (&input.text, storyline.as_ref()) {
            (None, Some(s)) => {
                let legacy = storylines(&slot).iter().find(|x| &x.id == s).and_then(|x| x.chapter_template.clone());
                super::template::template_of(cx, &dr_model::id::TemplateOwner::Storyline(s.clone()), legacy.as_deref())?
            }
            _ => None,
        };
        match template {
            Some(t) => super::template::apply_template(cx, &slot.book, &DocId::Node(id.clone()), t)?,
            None => seed_prose(cx, &slot.book, &DocId::Node(id.clone()), input.text.as_deref())?,
        }
        crate::autolink::backfill_title(cx, &slot, &id, &title)?;
        let (i2, t2, s2, n2) = (id.clone(), title.clone(), input.summary.clone(), input.narrative_order);
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&i2)?;
            w.kind(&NodeKind::Chapter)?.title(&t2)?.summary(&s2)?.book_order(Some(order))?
                .status(&NodeStatus::Draft)?.x(0.0)?.y(0.0)?.created_at(Some(now()))?;
            if let Some(o) = n2 {
                w.narrative_order(Some(o))?;
            }
            if let Some(s) = &storyline {
                w.add_storyline(s)?.primary_storyline(Some(s))?;
            }
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "node", id.as_str(), Some(&title));
        cx.undo_with(Invocation::new("chapter.trash", EntityIn { book: input.book, id: id.to_string() }));
        Ok(ChapterCreated { id: id.to_string(), title, book_order: order })
    }
}

// ---- update -----------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ChapterUpdateIn {
    pub book: String,
    pub id: String,
    /// A taken title gets a ` 2` suffix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// `draft`, `finished` or `discarded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Exact place in reading order (`null` takes it out: it sorts after
    /// every chapter). `chapter.move` places it relative to others.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub book_order: Option<Option<f64>>,
    /// Place on the narrative axis (`null` takes it off).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub narrative_order: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_storylines: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_storylines: Vec<String>,
    /// The primary storyline (must be one of the chapter's; `null` clears).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub primary_storyline: Option<Option<String>>,
}

op! {
    ChapterUpdate = "chapter.update", Write, Book,
    "Change a chapter's title, summary, status, place in reading order, narrative position or storylines.",
    fn(cx, input: ChapterUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = live_chapter(&slot, &input.id)?;
        let title = input.title.as_ref().map(|t| unique_name(t, UNTITLED, node_titles(&slot, Some(&old.id)).iter().map(String::as_str)));
        let status = input.status.as_deref().map(NodeStatus::parse);
        if let Some(s) = &status && !s.fits(&NodeKind::Chapter) {
            return Err(WsError::invalid(format!("{:?} is not a chapter status", s.as_str())));
        }
        if let Some(Some(o)) = input.narrative_order && !o.is_finite() {
            return Err(WsError::invalid("narrative order must be finite"));
        }
        if let Some(Some(o)) = input.book_order && !o.is_finite() {
            return Err(WsError::invalid("book order must be finite"));
        }
        let live: Vec<StorylineId> = storylines(&slot).iter().filter(|s| s.deleted_at.is_none()).map(|s| s.id.clone()).collect();
        let add: Vec<StorylineId> = input.add_storylines.iter().map(|s| {
            let id: StorylineId = pid("storyline", s)?;
            if live.contains(&id) { Ok(id) } else { Err(WsError::not_found("storyline", s)) }
        }).collect::<Result<_>>()?;
        let remove: Vec<StorylineId> = input.remove_storylines.iter().map(|s| pid("storyline", s)).collect::<Result<_>>()?;
        let mut members = old.storylines.clone();
        members.extend(add.iter().cloned());
        for r in &remove { members.remove(r); }
        let primary: Option<Option<StorylineId>> = match &input.primary_storyline {
            Some(Some(p)) => {
                let id: StorylineId = pid("storyline", p)?;
                if !members.contains(&id) {
                    return Err(WsError::invalid("the primary storyline must be one of the chapter's storylines"));
                }
                Some(Some(id))
            }
            Some(None) => Some(None),
            // Taking the chapter off its primary storyline clears it.
            None if old.primary_storyline.as_ref().is_some_and(|p| remove.contains(p)) => Some(None),
            None => None,
        };
        if let Some(t) = title.as_ref().filter(|t| **t != old.title) {
            crate::autolink::backfill_title(cx, &slot, &old.id, t)?;
        }
        let id = old.id.clone();
        let (t2, s2, st2, bo, no, a2, r2, p2) = (title.clone(), input.summary.clone(), status.clone(), input.book_order, input.narrative_order, add.clone(), remove.clone(), primary.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&id)?;
            if let Some(t) = &t2 { w.title(t)?; }
            if let Some(s) = &s2 { w.summary(s)?; }
            if let Some(s) = &st2 { w.status(s)?; }
            if let Some(o) = bo { w.book_order(o)?; }
            if let Some(o) = no { w.narrative_order(o)?; }
            for s in &a2 { w.add_storyline(s)?; }
            for s in &r2 { w.remove_storyline(s)?; }
            if let Some(p) = &p2 { w.primary_storyline(p.as_ref())?; }
            Ok(())
        })?;
        let name = title.clone().unwrap_or_else(|| old.title.clone());
        cx.effect(if title.is_some() { EffectAction::Renamed } else { EffectAction::Updated }, "node", &input.id, Some(&name));
        cx.undo_with(Invocation::new("chapter.update", ChapterUpdateIn {
            book: input.book.clone(),
            id: input.id.clone(),
            title: title.as_ref().map(|_| old.title.clone()),
            summary: input.summary.as_ref().map(|_| old.summary.clone()),
            status: status.as_ref().map(|_| old.status.as_str().to_string()),
            book_order: input.book_order.map(|_| old.book_order),
            narrative_order: input.narrative_order.map(|_| old.narrative_order),
            add_storylines: remove.iter().filter(|s| old.storylines.contains(*s)).map(|s| s.to_string()).collect(),
            remove_storylines: add.iter().filter(|s| !old.storylines.contains(*s)).map(|s| s.to_string()).collect(),
            primary_storyline: primary.as_ref().map(|_| old.primary_storyline.as_ref().map(|s| s.to_string())),
        }));
        Ok(Named { id: input.id, name })
    }
}

// ---- move -----------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChapterMoveIn {
    pub book: String,
    pub id: String,
    pub place: ChapterPlace,
}

op! {
    ChapterMove = "chapter.move", Write, Book,
    "Move a chapter in reading order (it lands before the next chapter or act boundary).",
    fn(cx, input: ChapterMoveIn) -> ChapterCreated {
        let slot = cx.book(&input.book)?;
        let old = live_chapter(&slot, &input.id)?;
        if let ChapterPlace::After(x) | ChapterPlace::Before(x) = &input.place && x == &input.id {
            return Err(WsError::invalid("a chapter cannot move relative to itself"));
        }
        let order = order_for(&slot, &input.place, Some(&old.id))?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.node(&id)?.book_order(Some(order))?; Ok(()) })?;
        cx.effect(EffectAction::Moved, "node", &input.id, Some(&old.title));
        let back = old.effective_book_order().map(ChapterPlace::Order).unwrap_or(ChapterPlace::Last);
        cx.undo_with(Invocation::new("chapter.move", ChapterMoveIn { book: input.book.clone(), id: input.id.clone(), place: back }));
        Ok(ChapterCreated { id: input.id, title: old.title, book_order: order })
    }
}

// ---- place, spread, arrange ---------------------------------------------------
//
// The timeline's writes (M14, and M21's story graph): a drop puts a chapter
// at an exact coordinate of the axis shown and, when it lands on another
// lane, on that storyline, in one write and one undo step (the old
// `persistChapterTimelineMove`); 打散 respaces every placed chapter of an
// axis, moving the act boundaries along on the book axis, in one write too
// (the old `spreadTimelineNodes` + `remapActBoundariesForSpread`).

/// The axis a chapter's coordinate is on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrderAxis {
    /// Reading order (`book_order`).
    #[default]
    Book,
    /// Story time (`narrative_order`).
    Narrative,
}

impl OrderAxis {
    fn of(self, n: &Node) -> Option<f64> {
        match self {
            OrderAxis::Book => n.effective_book_order(),
            OrderAxis::Narrative => n.narrative_order.filter(|o| o.is_finite()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChapterPlaceIn {
    pub book: String,
    pub id: String,
    #[serde(default)]
    pub axis: OrderAxis,
    /// The exact coordinate on that axis (a drop's, not snapped).
    pub order: f64,
    /// Absent: storylines stay. `null`: off every storyline. An id: that
    /// storyline becomes the primary one and the old primary is dropped;
    /// the other storylines stay.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub storyline: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChapterPlaced {
    pub id: String,
    pub axis: OrderAxis,
    pub order: f64,
    /// The chapter's storylines afterwards, sorted.
    pub storylines: Vec<String>,
    pub primary_storyline: Option<String>,
}

/// The storylines a chapter ends up on when dropped on `target`'s lane
/// (`resolveChapterTimelineMembership`): the members and the primary one.
fn lane_membership(
    old: &Node,
    target: &Option<Option<StorylineId>>,
) -> (std::collections::BTreeSet<StorylineId>, Option<StorylineId>) {
    let members: std::collections::BTreeSet<StorylineId> = old.storylines.iter().cloned().collect();
    let primary = old.effective_primary_storyline().cloned();
    match target {
        None => (members, primary),
        Some(None) => (Default::default(), None),
        Some(Some(to)) => {
            let mut m: std::collections::BTreeSet<StorylineId> = members
                .into_iter()
                .filter(|s| Some(s) != primary.as_ref())
                .collect();
            m.insert(to.clone());
            (m, Some(to.clone()))
        }
    }
}

op! {
    ChapterSetPlace = "chapter.place", Write, Book,
    "Put a chapter at an exact place on the reading-order or story-time axis and, optionally, on another storyline (as the primary one) or on none, in one step.",
    fn(cx, input: ChapterPlaceIn) -> ChapterPlaced {
        let slot = cx.book(&input.book)?;
        let old = live_chapter(&slot, &input.id)?;
        if !input.order.is_finite() {
            return Err(WsError::invalid("the order must be finite"));
        }
        let target: Option<Option<StorylineId>> = match &input.storyline {
            Some(Some(s)) => {
                let id: StorylineId = pid("storyline", s)?;
                if !storylines(&slot).iter().any(|l| l.id == id && l.deleted_at.is_none()) {
                    return Err(WsError::not_found("storyline", s));
                }
                Some(Some(id))
            }
            Some(None) => Some(None),
            None => None,
        };
        let (members, primary) = lane_membership(&old, &target);
        let before: std::collections::BTreeSet<StorylineId> = old.storylines.iter().cloned().collect();
        let old_primary = old.effective_primary_storyline().cloned();
        let add: Vec<StorylineId> = members.difference(&before).cloned().collect();
        let remove: Vec<StorylineId> = before.difference(&members).cloned().collect();
        let set_primary = primary != old_primary || (primary.is_none() && old.primary_storyline.is_some() && target.is_some());
        let moved = input.axis.of(&old) != Some(input.order);
        let out = ChapterPlaced {
            id: input.id.clone(),
            axis: input.axis,
            order: input.order,
            storylines: members.iter().map(|s| s.to_string()).collect(),
            primary_storyline: primary.as_ref().map(|s| s.to_string()),
        };
        if !moved && add.is_empty() && remove.is_empty() && !set_primary {
            cx.undo_nothing();
            return Ok(out);
        }
        let (id, axis, order, a2, r2, p2) = (old.id.clone(), input.axis, input.order, add.clone(), remove.clone(), primary.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&id)?;
            if moved {
                match axis {
                    OrderAxis::Book => w.book_order(Some(order))?,
                    OrderAxis::Narrative => w.narrative_order(Some(order))?,
                };
            }
            for s in &a2 { w.add_storyline(s)?; }
            for s in &r2 { w.remove_storyline(s)?; }
            if set_primary { w.primary_storyline(p2.as_ref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Moved, "node", &input.id, Some(&old.title));
        cx.undo_with(Invocation::new("chapter.update", ChapterUpdateIn {
            book: input.book.clone(),
            id: input.id.clone(),
            book_order: (moved && axis == OrderAxis::Book).then_some(old.book_order),
            narrative_order: (moved && axis == OrderAxis::Narrative).then_some(old.narrative_order),
            add_storylines: remove.iter().map(|s| s.to_string()).collect(),
            remove_storylines: add.iter().map(|s| s.to_string()).collect(),
            primary_storyline: set_primary.then(|| old_primary.as_ref().map(|s| s.to_string())),
            ..ChapterUpdateIn::default()
        }));
        Ok(out)
    }
}

/// A chapter's coordinate on one axis.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChapterAt {
    pub id: String,
    pub order: f64,
}

/// An act boundary's place in reading order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ActAt {
    pub id: String,
    pub start_order: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChapterArrangeIn {
    pub book: String,
    #[serde(default)]
    pub axis: OrderAxis,
    /// Exact coordinates for these chapters.
    #[serde(default)]
    pub chapters: Vec<ChapterAt>,
    /// Act boundaries to move with them (reading order only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acts: Vec<ActAt>,
}

/// What an arrangement or a spread changed: the new coordinates.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Arranged {
    pub chapters: Vec<ChapterAt>,
    pub acts: Vec<ActAt>,
}

/// Writes `plan` in one book write and declares its exact inverse.
fn arrange(
    cx: &Cx<'_>,
    slot: &BookSlot,
    book: &str,
    axis: OrderAxis,
    plan: Arranged,
) -> Result<Arranged> {
    if axis == OrderAxis::Narrative && !plan.acts.is_empty() {
        return Err(WsError::invalid("acts are on the reading-order axis"));
    }
    let all = nodes(slot);
    let all_acts = acts(slot);
    let mut ch: Vec<(Node, f64)> = Vec::new();
    for c in &plan.chapters {
        let nid: NodeId = pid("chapter", &c.id)?;
        let n = all
            .get(&nid)
            .filter(|n| n.is_chapter())
            .ok_or_else(|| WsError::not_found("chapter", &c.id))?;
        if !c.order.is_finite() {
            return Err(WsError::invalid("the order must be finite"));
        }
        if ch.iter().any(|(m, _)| m.id == n.id) {
            return Err(WsError::invalid(format!(
                "chapter {} is listed twice",
                c.id
            )));
        }
        let now = match axis {
            OrderAxis::Book => n.book_order,
            OrderAxis::Narrative => n.narrative_order,
        };
        if now != Some(c.order) {
            ch.push((n.clone(), c.order));
        }
    }
    let mut ac: Vec<(dr_model::book::Act, f64)> = Vec::new();
    for a in &plan.acts {
        let old = all_acts
            .iter()
            .find(|x| x.id.as_str() == a.id)
            .ok_or_else(|| WsError::not_found("act", &a.id))?;
        if !a.start_order.is_finite() {
            return Err(WsError::invalid("act start must be finite"));
        }
        if ac.iter().any(|(m, _)| m.id == old.id) {
            return Err(WsError::invalid(format!("act {} is listed twice", a.id)));
        }
        if old.start_order != Some(a.start_order) {
            ac.push((old.clone(), a.start_order));
        }
    }
    let done = Arranged {
        chapters: ch
            .iter()
            .map(|(n, o)| ChapterAt {
                id: n.id.to_string(),
                order: *o,
            })
            .collect(),
        acts: ac
            .iter()
            .map(|(a, o)| ActAt {
                id: a.id.to_string(),
                start_order: *o,
            })
            .collect(),
    };
    if ch.is_empty() && ac.is_empty() {
        cx.undo_nothing();
        return Ok(done);
    }
    let writes: Vec<(NodeId, f64)> = ch.iter().map(|(n, o)| (n.id.clone(), *o)).collect();
    let act_writes: Vec<(ActId, f64)> = ac.iter().map(|(a, o)| (a.id.clone(), *o)).collect();
    cx.write_book(slot, move |txn| {
        for (id, o) in &writes {
            let w = txn.node(id)?;
            match axis {
                OrderAxis::Book => w.book_order(Some(*o))?,
                OrderAxis::Narrative => w.narrative_order(Some(*o))?,
            };
        }
        for (id, o) in &act_writes {
            txn.act(id)?.start_order(Some(*o))?;
        }
        Ok(())
    })?;
    for (n, _) in &ch {
        cx.effect(EffectAction::Moved, "node", n.id.as_str(), Some(&n.title));
    }
    for (a, _) in &ac {
        cx.effect(EffectAction::Updated, "act", a.id.as_str(), Some(&a.name));
    }
    // Only coordinates that were there come back exactly; one that was
    // missing is not taken off again (a live chapter always has a reading
    // place, and a spread only touches placed chapters).
    let back_ch: Vec<ChapterAt> = ch
        .iter()
        .filter_map(|(n, _)| {
            let was = match axis {
                OrderAxis::Book => n.book_order,
                OrderAxis::Narrative => n.narrative_order,
            };
            was.filter(|o| o.is_finite()).map(|o| ChapterAt {
                id: n.id.to_string(),
                order: o,
            })
        })
        .collect();
    let back_acts: Vec<ActAt> = ac
        .iter()
        .filter_map(|(a, _)| {
            a.start_order.filter(|o| o.is_finite()).map(|o| ActAt {
                id: a.id.to_string(),
                start_order: o,
            })
        })
        .collect();
    cx.undo_with(Invocation::new(
        "chapter.arrange",
        ChapterArrangeIn {
            book: book.to_string(),
            axis,
            chapters: back_ch,
            acts: back_acts,
        },
    ));
    Ok(done)
}

op! {
    ChapterArrange = "chapter.arrange", Write, Book,
    "Set exact coordinates of several chapters on one axis, and move act boundaries with them, in one step (undo of a spread uses it).",
    fn(cx, input: ChapterArrangeIn) -> Arranged {
        let slot = cx.book(&input.book)?;
        arrange(cx, &slot, &input.book, input.axis, Arranged { chapters: input.chapters, acts: input.acts })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ChapterSpreadIn {
    pub book: String,
    #[serde(default)]
    pub axis: OrderAxis,
}

/// The 打散 plan: every live chapter placed on `axis`, kept in order and
/// set one stride apart from `min(first, 1)`; on the reading-order axis
/// each act boundary lands halfway between the chapters it fell between
/// (half a stride before the first, or after the last).
fn spread_plan(slot: &BookSlot, axis: OrderAxis) -> Arranged {
    let mut placed: Vec<(Node, f64)> = chapters(slot)
        .into_iter()
        .filter_map(|n| axis.of(&n).map(|o| (n, o)))
        .collect();
    placed.sort_by(|a, b| cmp_order((Some(a.1), &a.0.id), (Some(b.1), &b.0.id)));
    if placed.len() < 2 {
        return Arranged::default();
    }
    let stride = dr_model::order::CHAPTER_ORDER_STRIDE;
    let start = placed[0].1.min(1.0);
    let moved: Vec<(f64, f64)> = placed
        .iter()
        .enumerate()
        .map(|(i, (_, o))| (*o, start + i as f64 * stride))
        .collect();
    let chapters = placed
        .iter()
        .zip(&moved)
        .map(|((n, _), (_, new))| ChapterAt {
            id: n.id.to_string(),
            order: *new,
        })
        .collect();
    let mut out_acts = Vec::new();
    if axis == OrderAxis::Book {
        for a in acts(slot).iter() {
            let Some(s) = a.start_order.filter(|o| o.is_finite()) else {
                continue;
            };
            let before = moved.iter().rev().find(|(o, _)| *o < s);
            let after = moved.iter().find(|(o, _)| *o >= s);
            let next = match (before, after) {
                (Some(b), Some(a)) => (b.1 + a.1) / 2.0,
                (None, Some(a)) => a.1 - stride / 2.0,
                (Some(b), None) => b.1 + stride / 2.0,
                (None, None) => continue,
            };
            out_acts.push(ActAt {
                id: a.id.to_string(),
                start_order: next,
            });
        }
    }
    Arranged {
        chapters,
        acts: out_acts,
    }
}

op! {
    ChapterSpread = "chapter.spread", Write, Book,
    "Spread out (打散) the chapters on one axis: same order, evenly spaced, act boundaries moved along, in one step.",
    fn(cx, input: ChapterSpreadIn) -> Arranged {
        let slot = cx.book(&input.book)?;
        let plan = spread_plan(&slot, input.axis);
        arrange(cx, &slot, &input.book, input.axis, plan)
    }
}

// ---- trash, restore, purge ------------------------------------------------------

/// Trash or restore a node (chapter or idea). On restore a title that is
/// now taken gets a suffix.
pub(crate) fn set_node_trashed(
    cx: &Cx<'_>,
    input: &EntityIn,
    kind: NodeKind,
    trash: bool,
) -> Result<Named> {
    let slot = cx.book(&input.book)?;
    let nid: NodeId = pid("node", &input.id)?;
    let n = nodes(&slot)
        .get(&nid)
        .filter(|n| n.kind == kind)
        .cloned()
        .ok_or_else(|| {
            WsError::not_found(
                if kind == NodeKind::Chapter {
                    "chapter"
                } else {
                    "idea"
                },
                &input.id,
            )
        })?;
    let target = EntityRef::new(EntityKind::Node, input.id.clone());
    let title = if trash || !n.is_trashed() {
        n.title.clone()
    } else {
        unique_name(
            &n.title,
            UNTITLED,
            node_titles(&slot, Some(&nid)).iter().map(String::as_str),
        )
    };
    if trash == n.is_trashed() {
        cx.undo_nothing();
        return Ok(Named {
            id: input.id.clone(),
            name: title,
        });
    }
    if trash {
        trash_effects(cx, &slot, &target, true);
    }
    let (id, t2, renamed) = (nid.clone(), title.clone(), title != n.title);
    let at = trash.then(now);
    cx.write_book(&slot, move |txn| {
        let w = txn.node(&id)?;
        w.deleted_at(at)?;
        if renamed {
            w.title(&t2)?;
        }
        Ok(())
    })?;
    if !trash {
        trash_effects(cx, &slot, &target, false);
    }
    cx.effect(
        if trash {
            EffectAction::Trashed
        } else {
            EffectAction::Restored
        },
        "node",
        &input.id,
        Some(&title),
    );
    let (name, back) = match (kind == NodeKind::Chapter, trash) {
        (true, true) => ("chapter.restore", input.clone()),
        (true, false) => ("chapter.trash", input.clone()),
        (false, true) => ("idea.restore", input.clone()),
        (false, false) => ("idea.trash", input.clone()),
    };
    cx.undo_with(Invocation::new(name, back));
    Ok(Named {
        id: input.id.clone(),
        name: title,
    })
}

op! {
    ChapterTrash = "chapter.trash", Write, Book,
    "Move a chapter to the trash. Never refused: its relations are hidden and comments on it shown as unlocated until it is restored; the result lists them.",
    fn(cx, input: EntityIn) -> Named { set_node_trashed(cx, &input, NodeKind::Chapter, true) }
}

op! {
    ChapterRestore = "chapter.restore", Write, Book,
    "Bring a chapter back from the trash (its relations and comments come back with it).",
    fn(cx, input: EntityIn) -> Named { set_node_trashed(cx, &input, NodeKind::Chapter, false) }
}

/// Purge a node (chapter or idea) in one commit: its relations go, comments
/// on it become floating, plot grid goes; for an idea, time pins bound to it
/// take its title as their label and lose the binding, acts lose it. The
/// prose document stays (orphaned) so the purge can be undone.
pub(crate) fn purge_node(cx: &Cx<'_>, input: &EntityIn, kind: NodeKind) -> Result<Done> {
    let slot = cx.book(&input.book)?;
    let nid: NodeId = pid("node", &input.id)?;
    let n = nodes(&slot)
        .get(&nid)
        .filter(|n| n.kind == kind)
        .cloned()
        .ok_or_else(|| {
            WsError::not_found(
                if kind == NodeKind::Chapter {
                    "chapter"
                } else {
                    "idea"
                },
                &input.id,
            )
        })?;
    let target = EntityRef::new(EntityKind::Node, input.id.clone());
    let (rels, cmts) = purge_fallout(&slot, &target);
    let pins: Vec<_> = time_pins(&slot)
        .iter()
        .filter(|p| p.drift.as_ref() == Some(&nid))
        .cloned()
        .collect();
    let bound_acts: Vec<_> = acts(&slot)
        .iter()
        .filter(|a| a.drift.as_ref() == Some(&nid))
        .map(|a| a.id.clone())
        .collect();
    let mut touched: Vec<(String, String)> = vec![("nodes".into(), input.id.clone())];
    touched.extend(
        rels.iter()
            .map(|r| ("relations".to_string(), r.to_string())),
    );
    touched.extend(cmts.iter().map(|c| ("comments".to_string(), c.to_string())));
    touched.extend(
        pins.iter()
            .map(|p| ("time_pins".to_string(), p.id.to_string())),
    );
    touched.extend(
        bound_acts
            .iter()
            .map(|a| ("acts".to_string(), a.to_string())),
    );
    let has_grid = slot.reader.view().plot_grid(&nid).is_some();
    if has_grid {
        touched.push(("plot_grids".into(), input.id.clone()));
    }
    let faults = cx.faults();
    let (r2, c2, title) = (rels.clone(), cmts.clone(), n.title.clone());
    let pin_ids: Vec<_> = pins.iter().map(|p| p.id.clone()).collect();
    let acts2 = bound_acts.clone();
    let id = nid.clone();
    let (_, before) = cx.write_book(&slot, move |txn| {
        apply_fallout(txn, &r2, &c2)?;
        // A fault here leaves relations gone and the node still there: a
        // state every reader accepts (and the retry finishes).
        faults.check("in_book")?;
        for p in &pin_ids {
            txn.time_pin(p)?.label(&title)?.drift(None)?;
        }
        for a in &acts2 {
            txn.act(a)?.drift(None)?;
        }
        if has_grid {
            txn.purge(Collection::PlotGrids, id.as_str())?;
        }
        txn.purge(Collection::Nodes, id.as_str())?;
        Ok(())
    })?;
    report_fallout(cx, &rels, &cmts);
    for p in &pins {
        cx.effect(
            EffectAction::Detached,
            "time_pin",
            p.id.as_str(),
            Some(&n.title),
        );
    }
    for a in &bound_acts {
        cx.effect(EffectAction::Detached, "act", a.as_str(), None);
    }
    cx.effect(EffectAction::Purged, "node", &input.id, Some(&n.title));
    cx.undo_with(super::history::restore_invocation(
        &input.book,
        &before,
        touched,
    ));
    Ok(Done {
        id: input.id.clone(),
    })
}

op! {
    ChapterPurge = "chapter.purge", Write, Book,
    "Delete a chapter for good: its relations go and comments on it become floating, in one commit. Undo restores it from history.",
    fn(cx, input: EntityIn) -> Done { purge_node(cx, &input, NodeKind::Chapter) }
}

// ---- acts -----------------------------------------------------------------

op! {
    ActList = "act.list", Read, Shared,
    "List acts in reading order, each with its chapters.",
    fn(cx, input: BookIn) -> Vec<ActInfo> {
        let slot = cx.book(&input.book)?;
        let a = acts(&slot);
        let chs = chapters(&slot);
        let pairs: Vec<(f64, NodeId)> = chs.iter().filter_map(|c| Some((c.effective_book_order()?, c.id.clone()))).collect();
        let (segments, _) = dr_model::order::act_segments(&a, &pairs);
        Ok(a.iter().zip(segments).map(|(act, seg)| ActInfo {
            id: act.id.to_string(),
            name: act.name.clone(),
            color: act.color.clone(),
            start_order: act.start_order,
            drift: act.drift.as_ref().map(|d| d.to_string()),
            chapters: seg.into_iter().map(|i| pairs[i].1.to_string()).collect(),
        }).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ActCreateIn {
    pub book: String,
    pub name: String,
    /// The act starts at this chapter; omitted: a book-head act (before
    /// every chapter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_chapter: Option<String>,
    /// An exact boundary (undo uses it); wins over `start_chapter`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_order: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Keep this id (undo uses it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

fn act_start(slot: &BookSlot, chapter: Option<&str>, exact: Option<f64>) -> Result<Option<f64>> {
    if let Some(o) = exact {
        return if o.is_finite() {
            Ok(Some(o))
        } else {
            Err(WsError::invalid("act start must be finite"))
        };
    }
    match chapter {
        Some(c) => {
            let ch = live_chapter(slot, c)?;
            if ch.is_trashed() {
                return Err(WsError::not_found("chapter", c));
            }
            Ok(ch.effective_book_order())
        }
        None => Ok(None),
    }
}

op! {
    ActCreate = "act.create", Write, Book,
    "Create an act starting at a chapter (or at the head of the book).",
    fn(cx, input: ActCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        name_ok(&input.name)?;
        let start = act_start(&slot, input.start_chapter.as_deref(), input.start_order)?;
        if start.is_none() && acts(&slot).iter().any(|a| a.start_order.is_none()) {
            return Err(WsError::invalid("the book already has a head act"));
        }
        let id: ActId = match &input.id { Some(i) => pid("act", i)?, None => ActId::new_v7() };
        let (i2, n2, c2) = (id.clone(), input.name.trim().to_string(), input.color.clone());
        cx.write_book(&slot, move |txn| {
            txn.act(&i2)?.name(&n2)?.start_order(start)?.color(c2.as_deref())?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "act", id.as_str(), Some(input.name.trim()));
        cx.undo_with(Invocation::new("act.delete", EntityIn { book: input.book, id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: input.name.trim().to_string() })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ActUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub color: Option<Option<String>>,
    /// Move the boundary to this chapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_chapter: Option<String>,
    /// Move the boundary exactly (`null`: the book head).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub start_order: Option<Option<f64>>,
    /// Bind an idea as the act's notes (`null` unbinds).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub drift: Option<Option<String>>,
}

op! {
    ActUpdate = "act.update", Write, Book,
    "Rename an act, recolour it, move its boundary or bind an idea to it.",
    fn(cx, input: ActUpdateIn) -> Named {
        let slot = cx.book(&input.book)?;
        let old = acts(&slot).iter().find(|a| a.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("act", &input.id))?;
        if let Some(n) = &input.name { name_ok(n)?; }
        let start: Option<Option<f64>> = match (&input.start_chapter, input.start_order) {
            (_, Some(o)) => Some(act_start(&slot, None, o)?),
            (Some(c), None) => Some(act_start(&slot, Some(c), None)?),
            (None, None) => None,
        };
        let drift: Option<Option<NodeId>> = match &input.drift {
            Some(Some(d)) => {
                let id: NodeId = pid("idea", d)?;
                if !nodes(&slot).get(&id).is_some_and(|n| n.is_drift() && !n.is_trashed()) {
                    return Err(WsError::not_found("idea", d));
                }
                Some(Some(id))
            }
            Some(None) => Some(None),
            None => None,
        };
        let i = old.id.clone();
        let (n2, c2, s2, d2) = (input.name.clone(), input.color.clone(), start, drift.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.act(&i)?;
            if let Some(n) = &n2 { w.name(n.trim())?; }
            if let Some(c) = &c2 { w.color(c.as_deref())?; }
            if let Some(s) = s2 { w.start_order(s)?; }
            if let Some(d) = &d2 { w.drift(d.as_ref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "act", &input.id, Some(input.name.as_deref().unwrap_or(&old.name)));
        cx.undo_with(Invocation::new("act.update", ActUpdateIn {
            book: input.book.clone(), id: input.id.clone(),
            name: input.name.as_ref().map(|_| old.name.clone()),
            color: input.color.as_ref().map(|_| old.color.clone()),
            start_chapter: None,
            start_order: start.map(|_| old.start_order),
            drift: drift.as_ref().map(|_| old.drift.as_ref().map(|d| d.to_string())),
        }));
        Ok(Named { id: input.id, name: input.name.unwrap_or(old.name) })
    }
}

op! {
    ActDelete = "act.delete", Write, Book,
    "Delete an act boundary (its chapters join the act before).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = acts(&slot).iter().find(|a| a.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("act", &input.id))?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.purge(Collection::Acts, id.as_str())?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "act", &input.id, Some(&old.name));
        cx.undo_with(Invocation::new("act.create", ActCreateIn {
            book: input.book.clone(), name: old.name.clone(), start_chapter: None,
            start_order: old.start_order, color: old.color.clone(), id: Some(input.id.clone()),
        }));
        Ok(Done { id: input.id })
    }
}
