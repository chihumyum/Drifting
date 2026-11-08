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
fn order_for(slot: &BookSlot, place: &ChapterPlace, moving: Option<&NodeId>) -> Result<f64> {
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
            Some(crate::autolink::matcher(
                &cx.book(book.as_str())?.reader.view(),
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
    "Create a chapter (a taken title gets a numbered suffix; the final title is returned). Given a storyline and no text, it starts from that storyline's chapter template.",
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
        let (i2, t2, s2) = (id.clone(), title.clone(), input.summary.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&i2)?;
            w.kind(&NodeKind::Chapter)?.title(&t2)?.summary(&s2)?.book_order(Some(order))?
                .status(&NodeStatus::Draft)?.x(0.0)?.y(0.0)?.created_at(Some(now()))?;
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
    "Change a chapter's title, summary, status, narrative position or storylines.",
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
        let (t2, s2, st2, no, a2, r2, p2) = (title.clone(), input.summary.clone(), status.clone(), input.narrative_order, add.clone(), remove.clone(), primary.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.node(&id)?;
            if let Some(t) = &t2 { w.title(t)?; }
            if let Some(s) = &s2 { w.summary(s)?; }
            if let Some(s) = &st2 { w.status(s)?; }
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
