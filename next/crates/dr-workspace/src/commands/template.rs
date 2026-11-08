//! Field templates (字段模版): the fields every new storyline starts with
//! (the book's storyline template, on Project Home) and the fields every new
//! element of a category starts with (the category's template). The 0.1
//! interface's rules (`KvEditor`, `useStoryline`, `useBookElement`):
//!
//! - A template is copied when the storyline or element is created (new
//!   field ids, same order); changing the template later never changes
//!   existing ones, and moving an element to another category does not
//!   apply that category's template.
//! - A field is a key and a value (the value is a default or a hint),
//!   neither trimmed; keys may repeat; only a field with both empty is
//!   refused (0.1 dropped it on save).
//! - The 0.1 Agent could change only a category's template, by replacing the
//!   whole list and trimming keys; F3 has the interface's per-field commands
//!   for both templates.
//!
//! **Body templates**: a category's element template (要素模版), the body
//! its new elements start with, and a storyline's chapter template (章节模版),
//! the body new chapters whose main storyline it is start with. Each is a
//! prose document of its own (dr-doc's `template:category:<id>` /
//! `template:storyline:<id>`), so two devices editing a template merge like
//! any page, and an editor opens it like any page (`*.document` registers
//! it and returns its id).
//!
//! - A new element with a category and no text, and a new chapter with a
//!   storyline and no text, start with a copy of the template (dr-doc's
//!   `insert_copy`: paragraph attributes, marks, entity links, tables), made
//!   from a detached copy taken on the template's holder thread. Changing a
//!   template later never changes existing pages.
//! - `*.body` reads a template as paragraphs, each body text or an H1/H2/H3
//!   heading (the 0.1 template editor had nothing else; tables are left
//!   out); `*.set_body` writes it whole, keeping the paragraphs it shares at
//!   the start and at the end, and is undone by restoring the document's
//!   version before.
//! - The 0.1 fields (`element_template`, `chapter_template`: editor JSON)
//!   are only read: until a template document is registered, the field is
//!   the template. M10 writes the field into the document when it imports
//!   an old library; `*.document` and `*.set_body` do it for a library that
//!   still has only the field. A registered document wins, even emptied.
//! - A template document stays when its category or storyline is deleted
//!   for good (purges are undone by restoring the book entity), like every
//!   other page's prose; storage drops prose without an owner.

use dr_doc::prose::{BorrowedProse, ProseReader, ProseTxn, ProseView};
use dr_model::DocId;
use dr_model::book::KvEntry;
use dr_model::id::{CategoryId, KvEntryId, TemplateOwner};
use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::dto::FieldInfo;
use crate::naming::{Place, pos_for};
use crate::registry::Registry;
use crate::workspace::ProseSlot;

pub(crate) fn register(r: &mut Registry) {
    r.add::<CategoryTemplateBody>()
        .add::<CategoryTemplateSetBody>()
        .add::<CategoryTemplateDocument>()
        .add::<ChapterTemplateBody>()
        .add::<ChapterTemplateSetBody>()
        .add::<ChapterTemplateDocument>()
        .add::<StorylineTemplateList>()
        .add::<StorylineTemplatePut>()
        .add::<StorylineTemplateRemove>()
        .add::<CategoryTemplateList>()
        .add::<CategoryTemplatePut>()
        .add::<CategoryTemplateRemove>();
}

/// Copies of `template` with new ids, in the same order: what a new
/// storyline or element starts with.
pub(crate) fn copied(template: &[KvEntry]) -> Vec<KvEntry> {
    template
        .iter()
        .map(|e| KvEntry {
            id: KvEntryId::new_v7(),
            key: e.key.clone(),
            value: e.value.clone(),
            pos: e.pos.clone(),
        })
        .collect()
}

fn live_category(slot: &BookSlot, id: &str) -> Result<dr_model::book::Category> {
    categories(slot)
        .iter()
        .find(|c| c.id.as_str() == id && c.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| WsError::not_found("category", id))
}

/// A field to add or change in a template.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TemplateFieldIn {
    pub book: String,
    /// The category, for a category's template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The field to change; omitted, or an id not in the template: a new
    /// field (with that id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub key: String,
    /// A default or a hint, copied into new storylines or elements.
    #[serde(default)]
    pub value: String,
    /// Where it goes (a new field goes last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

/// The entry `input` asks for, given the template as it is.
fn entry_for(list: &[KvEntry], input: &TemplateFieldIn) -> Result<(KvEntry, Option<KvEntry>)> {
    if input.key.trim().is_empty() && input.value.trim().is_empty() {
        return Err(WsError::invalid("a template field needs a key or a value"));
    }
    // An id that is not there makes a field with that id (a removal's undo).
    let existing = input
        .id
        .as_ref()
        .and_then(|id| list.iter().find(|f| f.id.as_str() == id).cloned());
    let id = match (&existing, &input.id) {
        (Some(f), _) => f.id.clone(),
        (None, Some(id)) => pid::<KvEntryId>("template field", id)?,
        (None, None) => KvEntryId::new_v7(),
    };
    let others: Vec<(String, Option<PosKey>)> = list
        .iter()
        .filter(|f| f.id != id)
        .map(|f| (f.id.to_string(), f.pos.clone()))
        .collect();
    let pos = match (&input.pos, &input.place, &existing) {
        (Some(p), _, _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
        (None, Some(place), _) => Some(pos_for(&others, place)?),
        (None, None, Some(f)) => f.pos.clone(),
        (None, None, None) => Some(pos_for(&others, &Place::Last)?),
    };
    Ok((
        KvEntry {
            id,
            key: input.key.clone(),
            value: input.value.clone(),
            pos,
        },
        existing,
    ))
}

/// The inverse of a put: put back the old field, or remove the new one.
fn put_undo(
    cx: &Cx<'_>,
    input: &TemplateFieldIn,
    entry: &KvEntry,
    old: Option<KvEntry>,
    remove: &'static str,
) {
    match old {
        Some(old) => cx.undo_with(Invocation::new(
            if input.category.is_some() {
                "category_template.put"
            } else {
                "storyline_template.put"
            },
            TemplateFieldIn {
                book: input.book.clone(),
                category: input.category.clone(),
                id: Some(old.id.to_string()),
                key: old.key,
                value: old.value,
                place: None,
                pos: old.pos.map(|p| p.to_string()),
            },
        )),
        None => cx.undo_with(Invocation::new(
            remove,
            TemplateFieldRef {
                book: input.book.clone(),
                category: input.category.clone(),
                id: entry.id.to_string(),
            },
        )),
    }
}

/// One field of a template.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TemplateFieldRef {
    pub book: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub id: String,
}

// ---- the book's storyline template ---------------------------------------------

op! {
    StorylineTemplateList = "storyline_template.list", Read, Shared,
    "List the fields every new storyline starts with, in order.",
    fn(cx, input: BookIn) -> Vec<FieldInfo> {
        let slot = cx.book(&input.book)?;
        Ok(meta(&slot).storyline_template.iter().map(FieldInfo::from).collect())
    }
}

op! {
    StorylineTemplatePut = "storyline_template.put", Write, Book,
    "Add a field to the storyline template or change one (key, value, position). Existing storylines keep their fields.",
    fn(cx, input: TemplateFieldIn) -> Done {
        let slot = cx.book(&input.book)?;
        if input.category.is_some() {
            return Err(WsError::invalid("the storyline template belongs to the book; leave out category"));
        }
        let (entry, old) = entry_for(&meta(&slot).storyline_template, &input)?;
        let e2 = entry.clone();
        cx.write_book(&slot, move |txn| { txn.meta().put_storyline_template_field(&e2)?; Ok(()) })?;
        cx.effect(if old.is_some() { EffectAction::Updated } else { EffectAction::Created }, "template_field", entry.id.as_str(), Some(&entry.key));
        put_undo(cx, &input, &entry, old, "storyline_template.remove");
        Ok(Done { id: entry.id.to_string() })
    }
}

op! {
    StorylineTemplateRemove = "storyline_template.remove", Write, Book,
    "Remove a field from the storyline template. Existing storylines keep theirs.",
    fn(cx, input: TemplateFieldRef) -> Done {
        let slot = cx.book(&input.book)?;
        let old = meta(&slot).storyline_template.iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("template field", &input.id))?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.meta().remove_storyline_template_field(&id)?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "template_field", &input.id, Some(&old.key));
        cx.undo_with(Invocation::new("storyline_template.put", TemplateFieldIn {
            book: input.book.clone(), category: None, id: Some(input.id.clone()), key: old.key, value: old.value,
            place: None, pos: old.pos.map(|p| p.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

// ---- a category's element template ------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CategoryIn {
    pub book: String,
    pub category: String,
}

op! {
    CategoryTemplateList = "category_template.list", Read, Shared,
    "List the fields every new element of a category starts with, in order.",
    fn(cx, input: CategoryIn) -> Vec<FieldInfo> {
        let slot = cx.book(&input.book)?;
        Ok(live_category(&slot, &input.category)?.template_fields.iter().map(FieldInfo::from).collect())
    }
}

op! {
    CategoryTemplatePut = "category_template.put", Write, Book,
    "Add a field to a category's template or change one (key, value, position). Existing elements keep their fields.",
    fn(cx, input: TemplateFieldIn) -> Done {
        let slot = cx.book(&input.book)?;
        let cat_id = input.category.clone().ok_or_else(|| WsError::invalid("category is required"))?;
        let cat = live_category(&slot, &cat_id)?;
        let (entry, old) = entry_for(&cat.template_fields, &input)?;
        let (c2, e2) = (cat.id.clone(), entry.clone());
        cx.write_book(&slot, move |txn| { txn.category(&c2)?.put_template_field(&e2)?; Ok(()) })?;
        cx.effect(if old.is_some() { EffectAction::Updated } else { EffectAction::Created }, "template_field", entry.id.as_str(), Some(&entry.key));
        put_undo(cx, &input, &entry, old, "category_template.remove");
        Ok(Done { id: entry.id.to_string() })
    }
}

op! {
    CategoryTemplateRemove = "category_template.remove", Write, Book,
    "Remove a field from a category's template. Existing elements keep theirs.",
    fn(cx, input: TemplateFieldRef) -> Done {
        let slot = cx.book(&input.book)?;
        let cat_id = input.category.clone().ok_or_else(|| WsError::invalid("category is required"))?;
        let cat = live_category(&slot, &cat_id)?;
        let old = cat.template_fields.iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("template field", &input.id))?;
        let (c2, id): (CategoryId, KvEntryId) = (cat.id.clone(), old.id.clone());
        cx.write_book(&slot, move |txn| { txn.category(&c2)?.remove_template_field(&id)?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "template_field", &input.id, Some(&old.key));
        cx.undo_with(Invocation::new("category_template.put", TemplateFieldIn {
            book: input.book.clone(), category: Some(cat_id), id: Some(input.id.clone()), key: old.key, value: old.value,
            place: None, pos: old.pos.map(|p| p.to_string()),
        }));
        Ok(Done { id: input.id })
    }
}

// ---- body templates ------------------------------------------------------------------

/// One paragraph of a body template.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateParagraph {
    /// 1, 2 or 3 for H1/H2/H3; omitted for body text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<u8>,
    #[serde(default)]
    pub text: String,
}

/// A body template's paragraphs, read from its stored editor JSON (the 0.1
/// format; anything else, or `{}`, is no template). Headings keep their
/// level, other blocks (quotes, list items, code) read as body text, hard
/// breaks as spaces.
pub fn body_of(json: Option<&str>) -> Vec<TemplateParagraph> {
    fn text(v: &serde_json::Value, out: &mut String) {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                out.push_str(v.get("text").and_then(|t| t.as_str()).unwrap_or_default())
            }
            Some("hardBreak") => out.push(' '),
            _ => {
                for c in v
                    .get("content")
                    .and_then(|c| c.as_array())
                    .into_iter()
                    .flatten()
                {
                    text(c, out);
                }
            }
        }
    }
    fn blocks(v: &serde_json::Value, out: &mut Vec<TemplateParagraph>) {
        for b in v
            .get("content")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("heading") => {
                    let level = b
                        .get("attrs")
                        .and_then(|a| a.get("level"))
                        .and_then(|l| l.as_u64())
                        .map(|l| l.clamp(1, 3) as u8);
                    let mut t = String::new();
                    text(b, &mut t);
                    out.push(TemplateParagraph {
                        heading: level,
                        text: t,
                    });
                }
                Some("paragraph") | Some("codeBlock") => {
                    let mut t = String::new();
                    text(b, &mut t);
                    out.push(TemplateParagraph {
                        heading: None,
                        text: t,
                    });
                }
                Some("horizontalRule") => {}
                // Quotes and lists hold blocks of their own.
                _ => blocks(b, out),
            }
        }
    }
    let Some(v) = json.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    blocks(&v, &mut out);
    out
}

/// `paragraphs` as an editor JSON document (the format 0.1 stored).
pub fn body_json(paragraphs: &[TemplateParagraph]) -> String {
    let content: Vec<serde_json::Value> = paragraphs
        .iter()
        .map(|p| {
            let inner: Vec<serde_json::Value> = if p.text.is_empty() {
                Vec::new()
            } else {
                vec![serde_json::json!({"type": "text", "text": p.text})]
            };
            match p.heading {
                Some(level) => serde_json::json!({"type": "heading", "attrs": {"level": level}, "content": inner}),
                None => serde_json::json!({"type": "paragraph", "content": inner}),
            }
        })
        .collect();
    serde_json::json!({"type": "doc", "content": content}).to_string()
}

/// Write `paragraphs` into a fresh prose document (step 2 of the write
/// order), headings included.
pub(crate) fn seed_body(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    doc: &dr_model::DocId,
    paragraphs: &[TemplateParagraph],
) -> Result<()> {
    cx.create_prose(book, doc)?;
    let slot = cx.prose(doc)?;
    let text: Vec<String> = paragraphs
        .iter()
        .map(|p| p.text.replace(['\n', '\u{FFFC}'], " "))
        .collect();
    let text = text.join("\n");
    let levels: Vec<Option<u8>> = paragraphs.iter().map(|p| p.heading).collect();
    cx.write_prose(&slot, move |txn| {
        let end = txn.view().len().saturating_sub(1);
        txn.insert_paragraphs(end, &text)?;
        let starts: Vec<usize> = txn.view().paragraphs().map(|p| p.range.start).collect();
        for (at, level) in starts.into_iter().zip(levels) {
            let h = match level {
                Some(1) => Some(dr_model::prose::Heading::H1),
                Some(2) => Some(dr_model::prose::Heading::H2),
                Some(3) => Some(dr_model::prose::Heading::H3),
                _ => None,
            };
            if h.is_some() {
                txn.set_heading(at, h)?;
            }
        }
        Ok(())
    })?;
    Ok(())
}

/// What a new page starts from: `owner`'s template document (dr-doc's
/// `template:` documents), or the 0.1 field when the library has none yet.
pub(crate) enum Template {
    /// A detached copy of the template document, taken on its holder
    /// thread, so a template being edited is never copied half-way.
    Doc(DocId, loro::LoroDoc),
    /// The 0.1 editor JSON (`element_template` / `chapter_template`), as
    /// paragraphs.
    Legacy(Vec<TemplateParagraph>),
}

/// `owner`'s template document, when it is registered.
fn template_slot(cx: &Cx<'_>, owner: &TemplateOwner) -> Result<Option<Arc<ProseSlot>>> {
    let doc = owner.doc_id();
    if cx
        .workspace()
        .library()
        .doc_info(&doc.to_string())?
        .is_none()
    {
        return Ok(None);
    }
    Ok(Some(cx.prose(&doc)?))
}

/// A template document that holds nothing: one empty paragraph.
pub(crate) fn blank(view: &ProseView<'_>) -> bool {
    view.len() <= 1
}

/// The paragraphs of a template document (tables and other embeds left
/// out); none when it is blank.
fn paragraphs_of(view: &ProseView<'_>) -> Vec<TemplateParagraph> {
    if blank(view) {
        return Vec::new();
    }
    view.paragraphs()
        .filter(|p| !p.runs.iter().any(|r| r.marks.embed.is_some()))
        .map(|p| TemplateParagraph {
            heading: p.attrs.heading.map(|h| h.level() as u8),
            text: p.text(),
        })
        .collect()
}

/// `owner`'s template as paragraphs: its document when it has one (the
/// document wins even when emptied), else the 0.1 field `legacy`.
fn read_body(
    cx: &Cx<'_>,
    owner: &TemplateOwner,
    legacy: Option<&str>,
) -> Result<Vec<TemplateParagraph>> {
    Ok(match template_slot(cx, owner)? {
        Some(slot) => paragraphs_of(&slot.reader.view()),
        None => body_of(legacy),
    })
}

/// Whether `owner` has a template a new page would start from.
pub(crate) fn has_template(
    cx: &Cx<'_>,
    owner: &TemplateOwner,
    legacy: Option<&str>,
) -> Result<bool> {
    Ok(match template_slot(cx, owner)? {
        Some(slot) => {
            let has = !blank(&slot.reader.view());
            cx.workspace().inner.seen_template(&slot.doc, has);
            has
        }
        None => !body_of(legacy).is_empty(),
    })
}

/// `owner`'s template, or `None` when it is empty.
pub(crate) fn template_of(
    cx: &Cx<'_>,
    owner: &TemplateOwner,
    legacy: Option<&str>,
) -> Result<Option<Template>> {
    match template_slot(cx, owner)? {
        Some(slot) => {
            if blank(&slot.reader.view()) {
                return Ok(None);
            }
            let copy = slot.handle.read(|d| d.fork())?;
            Ok(Some(Template::Doc(slot.doc.clone(), copy)))
        }
        None => {
            let p = body_of(legacy);
            Ok((!p.is_empty()).then_some(Template::Legacy(p)))
        }
    }
}

/// Start new page `doc` from `template` (step 2 of the write order): a
/// template document is copied whole with dr-doc's `insert_copy` (headings
/// and other paragraph attributes, marks, entity links, tables); the 0.1
/// field's paragraphs are written as text and H1/H2/H3.
pub(crate) fn apply_template(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    doc: &DocId,
    template: Template,
) -> Result<()> {
    match template {
        Template::Legacy(p) => seed_body(cx, book, doc, &p),
        Template::Doc(from, copy) => {
            cx.create_prose(book, doc)?;
            let slot = cx.prose(doc)?;
            cx.write_prose(&slot, move |txn| {
                let reader = ProseReader::from_loro(from, &copy)?;
                txn.insert_copy(0, &reader.view())?;
                Ok(())
            })
        }
    }
}

/// A paragraph as `set_body` compares it: (heading, text); an embed reads
/// as U+FFFC, which no input text has.
fn shape(view: &ProseView<'_>) -> Vec<(Option<u8>, String, std::ops::Range<usize>)> {
    if blank(view) {
        return Vec::new();
    }
    view.paragraphs()
        .map(|p| {
            (
                p.attrs.heading.map(|h| h.level() as u8),
                p.text(),
                p.range.clone(),
            )
        })
        .collect()
}

/// Make the template document hold exactly `new`: the paragraphs it shares
/// at the start and at the end stay as they are (ids, marks, links), the
/// ones between are replaced, so two devices changing different ends of a
/// template merge. A document left with nothing is one empty paragraph.
fn replace_paragraphs(txn: &mut ProseTxn<'_>, new: &[TemplateParagraph]) -> Result<()> {
    let old = shape(&txn.view());
    let want: Vec<(Option<u8>, String)> = new.iter().map(|p| (p.heading, p.text.clone())).collect();
    let same = |o: &(Option<u8>, String, std::ops::Range<usize>), w: &(Option<u8>, String)| {
        o.0 == w.0 && o.1 == w.1
    };
    let (n, m) = (old.len(), want.len());
    let mut k = 0;
    while k < n.min(m) && same(&old[k], &want[k]) {
        k += 1;
    }
    let mut s = 0;
    while s < n.min(m) - k && same(&old[n - 1 - s], &want[m - 1 - s]) {
        s += 1;
    }
    if k == n && k == m {
        return Ok(());
    }
    let joined = want[k..m - s]
        .iter()
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let inserting = m - s > k;
    if s > 0 {
        // Whole paragraphs out, the new ones in front of the shared end.
        let at = old[k].2.start;
        if n - s > k {
            txn.delete(at..old[n - s].2.start)?;
        }
        if inserting {
            txn.insert_paragraphs(at, &format!("{joined}\n"))?;
        }
    } else if k > 0 {
        // From the end of the shared start to the end of the text.
        let at = old[k - 1].2.end;
        if n > k {
            txn.delete(at..old[n - 1].2.end)?;
        }
        if inserting {
            txn.insert_paragraphs(at, &format!("\n{joined}"))?;
        }
    } else {
        if n > 0 {
            txn.delete(0..old[n - 1].2.end)?;
        }
        if inserting {
            txn.insert_paragraphs(0, &joined)?;
        }
    }
    let heading_of = |i: usize| {
        want.get(i).and_then(|(h, _)| match h {
            Some(1) => Some(dr_model::prose::Heading::H1),
            Some(2) => Some(dr_model::prose::Heading::H2),
            Some(3) => Some(dr_model::prose::Heading::H3),
            _ => None,
        })
    };
    // The new paragraphs carry nothing of the ones they replaced; a kept
    // empty paragraph next to them may have lost its heading to a split.
    let now: Vec<(usize, Option<dr_model::prose::Heading>)> = txn
        .view()
        .paragraphs()
        .map(|p| (p.range.start, p.attrs.heading))
        .collect();
    let fresh = if m == 0 { 0..1 } else { k..m - s };
    for (i, (at, heading)) in now.into_iter().enumerate() {
        if fresh.contains(&i) {
            txn.set_block_attrs(
                at,
                &dr_model::prose::BlockAttrs {
                    heading: heading_of(i),
                    ..Default::default()
                },
            )?;
        } else if heading != heading_of(i) && i < m {
            txn.set_heading(at, heading_of(i))?;
        }
    }
    Ok(())
}

/// Register `owner`'s template document (its genesis is written when it
/// is first opened) and open it.
fn ensure_template(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    owner: &TemplateOwner,
) -> Result<Arc<ProseSlot>> {
    let doc = owner.doc_id();
    cx.create_prose(book, &doc)?;
    cx.prose(&doc)
}

/// The input's paragraphs as stored: a paragraph's text holds no line
/// break or object character.
fn clean(paragraphs: &[TemplateParagraph]) -> Vec<TemplateParagraph> {
    paragraphs
        .iter()
        .map(|p| TemplateParagraph {
            heading: p.heading,
            text: p.text.replace(['\n', '\r', '\u{FFFC}'], " "),
        })
        .collect()
}

/// Write `paragraphs` into `owner`'s template document, registering it
/// first. Returns the document and its version before.
fn write_body(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    owner: &TemplateOwner,
    paragraphs: Vec<TemplateParagraph>,
) -> Result<(DocId, loro::Frontiers)> {
    let slot = ensure_template(cx, book, owner)?;
    let doc = slot.doc.clone();
    let pre = cx.write_prose_raw(&slot, move |d| {
        let pre = d.oplog_frontiers();
        let b = BorrowedProse::new(d, &doc)?;
        let mut txn = b.txn();
        replace_paragraphs(&mut txn, &paragraphs)?;
        Ok(pre)
    })?;
    Ok((slot.doc.clone(), pre))
}

/// `*.set_body` for `owner` (its 0.1 field `legacy`): write `paragraphs`
/// into its template document; undone by restoring the document's version
/// before. Returns whether anything changed.
fn set_body(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    owner: &TemplateOwner,
    legacy: Option<&str>,
    paragraphs: &[TemplateParagraph],
) -> Result<bool> {
    if paragraphs
        .iter()
        .any(|p| p.heading.is_some_and(|h| !(1..=3).contains(&h)))
    {
        return Err(WsError::invalid("headings are H1, H2 or H3"));
    }
    let asked = clean(paragraphs);
    if clean(&read_body(cx, owner, legacy)?) == asked {
        cx.undo_nothing();
        return Ok(false);
    }
    let (doc, pre) = write_body(cx, book, owner, asked)?;
    cx.effect(EffectAction::Updated, "prose", doc.to_string(), None);
    cx.undo_with(Invocation::new(
        "prose.restore",
        super::prose::ProseRestoreIn {
            doc: doc.to_string(),
            at: crate::naming::frontiers_hex(&pre),
        },
    ));
    Ok(true)
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct TemplateDoc {
    /// The template's prose document (`template:category:<id>` or
    /// `template:storyline:<id>`), to open in an editor.
    pub doc: String,
}

// ---- a category's element template ------------------------------------------------

op! {
    CategoryTemplateBody = "category_template.body", Read, Shared,
    "Read a category's element template: the paragraphs (body text or H1/H2/H3) its new elements start with.",
    fn(cx, input: CategoryIn) -> Vec<TemplateParagraph> {
        let slot = cx.book(&input.book)?;
        let cat = live_category(&slot, &input.category)?;
        read_body(cx, &TemplateOwner::Category(cat.id.clone()), cat.element_template.as_deref())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetBodyIn {
    pub book: String,
    pub category: String,
    /// The whole template; empty removes it.
    pub paragraphs: Vec<TemplateParagraph>,
}

op! {
    CategoryTemplateSetBody = "category_template.set_body", Write, Book,
    "Replace a category's element template (the body its new elements start with; empty removes it). Existing elements keep their bodies.",
    fn(cx, input: SetBodyIn) -> Done {
        let slot = cx.book(&input.book)?;
        let cat = live_category(&slot, &input.category)?;
        let owner = TemplateOwner::Category(cat.id.clone());
        if set_body(cx, &slot.book, &owner, cat.element_template.as_deref(), &input.paragraphs)? {
            cx.effect(EffectAction::Updated, "category", cat.id.as_str(), Some(&cat.name));
        }
        Ok(Done { id: input.category })
    }
}

op! {
    CategoryTemplateDocument = "category_template.document", Write, Book,
    "Make sure a category's element template has its own prose document and return its id, for an editor to open (the template is then edited like any page).",
    fn(cx, input: CategoryIn) -> TemplateDoc {
        let slot = cx.book(&input.book)?;
        let cat = live_category(&slot, &input.category)?;
        let owner = TemplateOwner::Category(cat.id.clone());
        let doc = open_template(cx, &slot.book, &owner, cat.element_template.as_deref())?;
        Ok(TemplateDoc { doc })
    }
}

/// `*.document`: the template document, registered; a library whose template
/// is still only the 0.1 field gets it written into the document first, so
/// the editor opens what new pages copy.
fn open_template(
    cx: &Cx<'_>,
    book: &dr_model::id::BookId,
    owner: &TemplateOwner,
    legacy: Option<&str>,
) -> Result<String> {
    let doc = owner.doc_id().to_string();
    if template_slot(cx, owner)?.is_some() {
        cx.undo_nothing();
        return Ok(doc);
    }
    // Not a step of the author's: no effect, nothing to undo (undoing it
    // would leave an empty document in front of the 0.1 field).
    let old = body_of(legacy);
    if old.is_empty() {
        ensure_template(cx, book, owner)?;
    } else {
        write_body(cx, book, owner, clean(&old))?;
    }
    cx.undo_nothing();
    Ok(doc)
}

// ---- a storyline's chapter template -------------------------------------------------

fn live_storyline(slot: &BookSlot, id: &str) -> Result<dr_model::book::Storyline> {
    storylines(slot)
        .iter()
        .find(|s| s.id.as_str() == id && s.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| WsError::not_found("storyline", id))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct StorylineIn {
    pub book: String,
    pub storyline: String,
}

op! {
    ChapterTemplateBody = "chapter_template.body", Read, Shared,
    "Read a storyline's chapter template: the paragraphs (body text or H1/H2/H3) a new chapter whose main storyline it is starts with.",
    fn(cx, input: StorylineIn) -> Vec<TemplateParagraph> {
        let slot = cx.book(&input.book)?;
        let line = live_storyline(&slot, &input.storyline)?;
        read_body(cx, &TemplateOwner::Storyline(line.id.clone()), line.chapter_template.as_deref())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetChapterTemplateIn {
    pub book: String,
    pub storyline: String,
    /// The whole template; empty removes it.
    pub paragraphs: Vec<TemplateParagraph>,
}

op! {
    ChapterTemplateSetBody = "chapter_template.set_body", Write, Book,
    "Replace a storyline's chapter template (the body new chapters on it start with; empty removes it). Existing chapters keep their text.",
    fn(cx, input: SetChapterTemplateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let line = live_storyline(&slot, &input.storyline)?;
        let owner = TemplateOwner::Storyline(line.id.clone());
        if set_body(cx, &slot.book, &owner, line.chapter_template.as_deref(), &input.paragraphs)? {
            cx.effect(EffectAction::Updated, "storyline", line.id.as_str(), Some(&line.name));
        }
        Ok(Done { id: input.storyline })
    }
}

op! {
    ChapterTemplateDocument = "chapter_template.document", Write, Book,
    "Make sure a storyline's chapter template has its own prose document and return its id, for an editor to open.",
    fn(cx, input: StorylineIn) -> TemplateDoc {
        let slot = cx.book(&input.book)?;
        let line = live_storyline(&slot, &input.storyline)?;
        let owner = TemplateOwner::Storyline(line.id.clone());
        let doc = open_template(cx, &slot.book, &owner, line.chapter_template.as_deref())?;
        Ok(TemplateDoc { doc })
    }
}
