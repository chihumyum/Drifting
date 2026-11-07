//! The authored rows of one 0.1 book → its schema v2 book document
//! (`loro-schema.md` "书目文档"), through dr-doc's typed writers only. The
//! table-by-table mapping is in `docs/rust-rewrite/modules/m10-import.md`.
//!
//! What cannot be copied as is:
//!
//! - plain lists (storylines, patches, materials, key/value lists) get
//!   fractional position keys from their 0.1 rank; plot-grid rows and
//!   columns keep their 0.1 `position_key` verbatim;
//! - key/value entries (`entity_kv_entry`) have no order column: the order
//!   is their owner's `*_kv_json` projection;
//! - retired values go through `dr_model::legacy`; projected TODOs get
//!   their deterministic ids (computed by the caller, [`Inputs::projected`]);
//! - comment, patch and material-description bodies are plain text in
//!   schema v2 (F1 待协调 4): their formatting is counted and their JSON
//!   kept in the receipt.

use std::collections::{BTreeMap, HashMap, HashSet};

use dr_doc::Anchor;
use dr_doc::book::{BookTxn, generic_relation_type_id};
use dr_model::book::{Asset, EntityRef, KvEntry, canonical_symmetric};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::pos::{PosKey, keys_between};
use dr_model::{Day, legacy};
use serde_json::Value;

use crate::anchors;
use crate::handoff::BookSettings;
use crate::legacy::{BookRows, KvRow, ProjectRow, TreeRow};
use crate::prose::{BlockSpan, Notes};
use crate::time::{parse_iso, parse_opt};
use dr_doc::Result;

/// What the book writer needs from the prose side.
pub struct Inputs<'a> {
    pub book: &'a BookId,
    pub project: &'a ProjectRow,
    pub rows: &'a BookRows,
    pub settings: Option<&'a BookSettings>,
    /// Projected TODOs: old id → (new id, kind, document, block).
    pub projected: &'a HashMap<String, (CommentId, ProjectionKind, dr_model::DocId, BlockId)>,
    /// Anchors made on the imported prose documents, by comment or patch id.
    pub anchors: &'a HashMap<String, Anchor>,
    /// Where an old block id went (any document of the book).
    pub span: &'a dyn Fn(&str) -> Option<BlockSpan>,
}

/// The original editor JSON of bodies schema v2 keeps as plain text, for
/// the receipt: (collection, id, field, JSON).
pub type Originals = Vec<(&'static str, String, &'static str, String)>;

fn id<T>(parse: impl Fn(&str) -> std::result::Result<T, IdError>, s: &str) -> Option<T> {
    parse(s).ok()
}

/// Fresh position keys for `n` items in order.
pub(crate) fn ranks(n: usize) -> Vec<PosKey> {
    keys_between(None, None, n)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|k| PosKey::parse(&k).ok())
        .collect()
}

/// Plain text of an editor JSON body (blocks joined with `\n`, hard breaks
/// as `\n`), and whether it held more than plain paragraphs.
pub fn plain_text(json: &str) -> (String, bool) {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return (json.trim().to_string(), false);
    };
    let mut blocks: Vec<String> = Vec::new();
    let mut rich = false;
    fn walk(n: &Value, out: &mut Vec<String>, rich: &mut bool, depth: usize) {
        let kind = n.get("type").and_then(Value::as_str).unwrap_or("");
        let content = n.get("content").and_then(Value::as_array);
        let inline = content.is_some_and(|c| {
            c.iter().all(|x| {
                x.get("text").is_some()
                    || x.get("type").and_then(Value::as_str) == Some("hardBreak")
            })
        });
        if kind != "doc" && kind != "paragraph" {
            *rich = true;
        }
        if kind != "doc" && (inline || content.is_none()) {
            let mut s = String::new();
            for x in content.into_iter().flatten() {
                if x.get("marks")
                    .and_then(Value::as_array)
                    .is_some_and(|m| !m.is_empty())
                {
                    *rich = true;
                }
                match x.get("text").and_then(Value::as_str) {
                    Some(t) => s.push_str(t),
                    None => s.push('\n'),
                }
            }
            out.push(s);
            return;
        }
        let _ = depth;
        for c in content.into_iter().flatten() {
            walk(c, out, rich, depth + 1);
        }
    }
    walk(&v, &mut blocks, &mut rich, 0);
    if v.get("type").and_then(Value::as_str) != Some("doc")
        && v.as_object().is_some_and(|o| !o.is_empty())
    {
        rich = true;
    }
    (blocks.join("\n"), rich)
}

/// Order key/value rows the way their owner's projection lists them.
fn kv_ordered(rows: Vec<&KvRow>, projection: &str, notes: &mut Notes) -> Vec<KvEntry> {
    let listed: Vec<(String, String)> = serde_json::from_str::<Value>(projection)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            Some((
                e.get("key")?.as_str()?.to_string(),
                e.get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect();
    let mut left: Vec<&KvRow> = rows;
    let mut ordered: Vec<&KvRow> = Vec::new();
    for (k, v) in &listed {
        let at = left
            .iter()
            .position(|r| &r.key == k && &r.value == v)
            .or_else(|| left.iter().position(|r| &r.key == k));
        if let Some(i) = at {
            ordered.push(left.remove(i));
        }
    }
    if !left.is_empty() && !listed.is_empty() {
        notes.add("kv-order-not-in-projection");
    }
    left.sort_by(|a, b| a.id.cmp(&b.id));
    ordered.extend(left);
    let keys = ranks(ordered.len());
    ordered
        .into_iter()
        .zip(keys)
        .filter_map(|(r, pos)| {
            Some(KvEntry {
                id: KvEntryId::parse(&r.id).ok()?,
                key: r.key.clone(),
                value: r.value.clone(),
                pos: Some(pos),
            })
        })
        .collect()
}

/// The key/value rows of one owner and namespace.
fn kv_rows<'r>(rows: &'r BookRows, owner_kind: &str, owner: &str, ns: &str) -> Vec<&'r KvRow> {
    rows.kv
        .iter()
        .filter(|k| k.owner_kind == owner_kind && k.owner_id == owner && k.namespace == ns)
        .collect()
}

/// One owner's key/value list exactly as [`write`] writes it (the snapshot
/// history replay puts it back after the historical lists, `meta.rs`).
pub(crate) fn kv_list(
    rows: &BookRows,
    owner_kind: &str,
    owner: &str,
    ns: &str,
    projection: &str,
) -> Vec<KvEntry> {
    kv_ordered(
        kv_rows(rows, owner_kind, owner, ns),
        projection,
        &mut Notes::default(),
    )
}

fn entity(kind: &str, id: &str, comments: &HashMap<String, CommentId>) -> EntityRef {
    let kind = legacy::entity_kind(kind);
    let id = match (&kind, comments.get(id)) {
        (EntityKind::Comment, Some(new)) => new.as_str().to_string(),
        _ => id.to_string(),
    };
    EntityRef::new(kind, id)
}

/// Build a tree (idea groups, material folders) parent first; a node whose
/// parent is missing or part of a cycle goes to the root, as 0.1 shows it.
fn tree_order(rows: &[TreeRow], notes: &mut Notes, what: &str) -> Vec<(TreeRow, Option<String>)> {
    let ids: HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let mut placed: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut pending: Vec<&TreeRow> = rows.iter().collect();
    loop {
        let before = pending.len();
        pending.retain(|r| {
            let parent = r.parent.as_deref().filter(|p| ids.contains(p));
            if parent.is_none_or(|p| placed.contains(p)) {
                placed.insert(r.id.clone());
                out.push(((*r).clone(), parent.map(str::to_string)));
                false
            } else {
                true
            }
        });
        if pending.is_empty() || pending.len() == before {
            break;
        }
    }
    for r in pending {
        notes.add(format!("{what}-cycle-to-root"));
        out.push((r.clone(), None));
    }
    for r in rows {
        if r.parent.as_deref().is_some_and(|p| !ids.contains(p)) {
            notes.add(format!("{what}-missing-parent-to-root"));
        }
    }
    out
}

/// Write one book. Returns the original JSON of bodies kept as plain text.
pub fn write(txn: &mut BookTxn<'_>, inp: &Inputs<'_>, notes: &mut Notes) -> Result<Originals> {
    let r = inp.rows;
    let mut originals: Originals = Vec::new();
    let book = inp.book;
    let new_comment_ids: HashMap<String, CommentId> = inp
        .projected
        .iter()
        .map(|(old, (new, ..))| (old.clone(), new.clone()))
        .collect();
    let block = |old: Option<&str>| -> Option<BlockId> {
        let old = old.filter(|s| !s.is_empty())?;
        match (inp.span)(old) {
            Some(s) => s.first.or_else(|| BlockId::parse(old).ok()),
            None => BlockId::parse(old).ok(),
        }
    };

    // The book.
    let kv_of = |owner_kind: &str, owner: &str, ns: &str| kv_rows(r, owner_kind, owner, ns);
    {
        let m = txn.meta();
        m.name(&inp.project.name)?
            .summary(&inp.project.summary)?
            .created_at(parse_iso(&inp.project.created_at))?
            .deleted_at(parse_opt(inp.project.deleted_at.as_deref()))?;
        if let Some(s) = inp.settings {
            if s.word_target.is_some() {
                m.word_target(s.word_target)?;
            }
            if s.daily_word_target.is_some() {
                m.daily_word_target(s.daily_word_target)?;
            }
        }
        for e in kv_ordered(
            kv_of("project", &inp.project.id, "storyline-template"),
            &r.project_template_kv_json,
            notes,
        ) {
            m.put_storyline_template_field(&e)?;
        }
    }
    for e in kv_ordered(
        kv_of("project", &inp.project.id, "facts"),
        &r.project_kv_json,
        notes,
    ) {
        txn.put_fact(&e)?;
    }

    // Idea groups, then material folders.
    for (g, parent) in tree_order(&r.groups, notes, "drift-group") {
        let trees = txn.drift_groups();
        trees.create(&g.id, parent.as_deref(), &g.name)?;
        if g.color.is_some() {
            trees.set_color(&g.id, g.color.as_deref())?;
        }
    }
    for (f, parent) in tree_order(&r.folders, notes, "material-folder") {
        txn.material_folders()
            .create(&f.id, parent.as_deref(), &f.name)?;
    }

    // Storylines.
    let storyline_pos = ranks(r.storylines.len());
    for (s, pos) in r.storylines.iter().zip(&storyline_pos) {
        let Some(sid) = id(StorylineId::parse, &s.id) else {
            notes.add("invalid-id");
            continue;
        };
        let w = txn.storyline(&sid)?;
        w.name(&s.name)?
            .color(&s.color)?
            .summary(&s.summary)?
            .pos(pos)?
            .chapter_template(Some(s.template.as_str()).filter(|t| !t.is_empty() && *t != "{}"))?
            .deleted_at(parse_opt(s.deleted_at.as_deref()))?;
        let projection = r
            .storyline_kv_json
            .get(&s.id)
            .map(String::as_str)
            .unwrap_or("[]");
        for e in kv_ordered(kv_of("storyline", &s.id, "facts"), projection, notes) {
            w.put_fact(&e)?;
        }
    }

    // Chapters and ideas.
    let primary: HashMap<&str, &str> = r
        .links
        .iter()
        .filter(|l| l.primary)
        .map(|l| (l.node.as_str(), l.storyline.as_str()))
        .collect();
    for n in &r.nodes {
        let Some(nid) = id(NodeId::parse, &n.id) else {
            notes.add("invalid-id");
            continue;
        };
        let kind = NodeKind::parse(&n.kind);
        let w = txn.node(&nid)?;
        w.kind(&kind)?
            .title(&n.title)?
            .summary(&n.summary)?
            .status(&NodeStatus::parse(&n.status))?
            .x(n.x)?
            .y(n.y)?
            .narrative_order(n.narrative_order)?
            .created_at(parse_iso(&n.created_at))?
            .deleted_at(parse_opt(n.deleted_at.as_deref()))?;
        if kind == NodeKind::Chapter {
            w.book_order(n.book_order)?;
            if n.group.is_some() {
                notes.add("chapter-in-group-dropped");
            }
        } else {
            if n.book_order.is_some() {
                notes.add("idea-book-order-dropped");
            }
            w.group(
                n.group
                    .as_deref()
                    .and_then(|g| DriftGroupId::parse(g).ok())
                    .as_ref(),
            )?;
        }
        for l in r.links.iter().filter(|l| l.node == n.id) {
            if let Some(s) = id(StorylineId::parse, &l.storyline) {
                w.add_storyline(&s)?;
            }
        }
        if let Some(p) = primary
            .get(n.id.as_str())
            .and_then(|s| StorylineId::parse(s).ok())
        {
            w.primary_storyline(Some(&p))?;
        }
    }

    // Acts and time pins.
    for a in &r.acts {
        let Some(aid) = id(ActId::parse, &a.id) else {
            continue;
        };
        txn.act(&aid)?
            .name(&a.name)?
            .color(a.color.as_deref())?
            .start_order(a.start_order)?
            .drift(
                a.drift
                    .as_deref()
                    .and_then(|d| NodeId::parse(d).ok())
                    .as_ref(),
            )?;
    }
    for t in &r.time_pins {
        let Some(tid) = id(TimePinId::parse, &t.id) else {
            continue;
        };
        txn.time_pin(&tid)?
            .narrative_order(t.narrative_order)?
            .label(&t.label)?
            .drift(
                t.drift
                    .as_deref()
                    .and_then(|d| NodeId::parse(d).ok())
                    .as_ref(),
            )?;
    }

    // Categories and elements.
    for c in &r.categories {
        let Some(cid) = id(CategoryId::parse, &c.id) else {
            continue;
        };
        let w = txn.category(&cid)?;
        w.name(&c.name)?
            .color(&c.color)?
            .layout(&CategoryLayout::parse(&c.layout))?
            .grid_x(c.grid_x)?
            .grid_y(c.grid_y)?
            .element_template(
                c.template_json
                    .as_deref()
                    .filter(|t| !t.is_empty() && *t != "{}"),
            )?
            .deleted_at(parse_opt(c.deleted_at.as_deref()))?;
        for e in kv_ordered(
            kv_of("element-category", &c.id, "element-template"),
            &c.template_kv_json,
            notes,
        ) {
            w.put_template_field(&e)?;
        }
    }
    let pins = inp.settings.map(|s| &s.element_pins);
    for e in &r.elements {
        let Some(eid) = id(ElementId::parse, &e.id) else {
            continue;
        };
        let w = txn.element(&eid)?;
        w.name(&e.name)?
            .summary(&e.summary)?
            .category(
                e.category
                    .as_deref()
                    .and_then(|c| CategoryId::parse(c).ok())
                    .as_ref(),
            )?
            .group_name(e.group_name.as_deref())?
            .portrait(
                e.portrait
                    .as_deref()
                    .and_then(|a| AssetId::parse(a).ok())
                    .as_ref(),
            )?
            .created_at(parse_iso(&e.created_at))?
            .deleted_at(parse_opt(e.deleted_at.as_deref()))?;
        let aliases: Vec<String> = serde_json::from_str(&e.aliases_json).unwrap_or_default();
        for a in aliases {
            w.add_alias(&a)?;
        }
        for f in kv_ordered(kv_of("element", &e.id, "facts"), &e.kv_json, notes) {
            w.put_fact(&f)?;
        }
        if let Some(p) = pins.and_then(|p| p.get(&e.id)) {
            w.relate_pin(Some(*p))?;
        }
    }

    // Relation types and relations.
    let generic = generic_relation_type_id(book);
    let colors = inp.settings.map(|s| &s.relation_type_colors);
    let mut orientation: HashMap<&str, RelationOrientation> = HashMap::new();
    for t in &r.relation_types {
        let o = RelationOrientation::parse(&t.orientation);
        orientation.insert(t.id.as_str(), o.clone());
        if t.id == generic.as_str() || t.system_key.as_deref() == Some("generic-association") {
            if colors.is_some_and(|c| c.contains_key(&t.id)) {
                notes.add("built-in-relation-color-dropped");
            }
            continue;
        }
        let Some(tid) = id(RelationTypeId::parse, &t.id) else {
            continue;
        };
        if t.locked || t.system_key.is_some() {
            notes.add("locked-relation-type-imported-unlocked");
        }
        let kinds = |side: &str| -> Vec<EntityKind> {
            r.endpoints
                .iter()
                .filter(|e| e.relation_type == t.id && e.side == side)
                .map(|e| legacy::entity_kind(&e.kind))
                .collect()
        };
        let w = txn.relation_type(&tid)?;
        w.name(&t.name)?
            .description(&t.description)?
            .orientation(&o)?
            .source_role(&t.source_role)?
            .target_role(&t.target_role)?
            .source_kinds(&kinds("source"))?
            .target_kinds(&kinds("target"))?;
        if let Some(c) = colors.and_then(|c| c.get(&t.id)) {
            w.color(Some(c))?;
        }
    }
    for rel in &r.relations {
        let Some(rid) = id(RelationId::parse, &rel.id) else {
            continue;
        };
        let Some(tid) = id(RelationTypeId::parse, &rel.relation_type) else {
            continue;
        };
        let mut from = entity(&rel.from_kind, &rel.from_id, &new_comment_ids);
        let mut to = entity(&rel.to_kind, &rel.to_id, &new_comment_ids);
        if orientation.get(rel.relation_type.as_str()) == Some(&RelationOrientation::Symmetric) {
            let (a, b) = canonical_symmetric(from.clone(), to.clone());
            if a != from {
                notes.add("symmetric-relation-ends-ordered");
            }
            (from, to) = (a, b);
        }
        txn.relation(&rid)?
            .ends(&from, &to)?
            .relation_type(&tid)?
            .created_at(parse_iso(&rel.created_at))?;
    }

    // Plot grids: rows and columns keep their 0.1 position keys.
    for d in &r.plot_docs {
        let Some(chapter) = id(NodeId::parse, &d.node) else {
            continue;
        };
        let w = txn.plot_grid(&chapter)?;
        w.cell_w(d.cell_w)?.cell_h(d.cell_h)?;
        let mut lines = |list: &[crate::legacy::PlotLineRow], row: bool| -> Result<()> {
            let mine: Vec<_> = list.iter().filter(|l| l.document == d.id).collect();
            let valid = mine.iter().all(|l| PosKey::parse(&l.pos).is_ok());
            let fresh = if valid {
                Vec::new()
            } else {
                notes.add("plot-grid-position-key-regenerated");
                let mut sorted = mine.clone();
                sorted.sort_by(|a, b| (a.pos.as_bytes(), &a.id).cmp(&(b.pos.as_bytes(), &b.id)));
                sorted
                    .iter()
                    .zip(ranks(sorted.len()))
                    .map(|(l, k)| (l.id.clone(), k))
                    .collect()
            };
            let fresh: HashMap<String, PosKey> = fresh.into_iter().collect();
            for l in mine {
                let pos = fresh
                    .get(&l.id)
                    .map(|k| k.as_str().to_string())
                    .unwrap_or(l.pos.clone());
                if row {
                    if let Some(rid) = id(PlotRowId::parse, &l.id) {
                        w.row(&rid, &pos, &l.label)?;
                    }
                } else if let Some(cid) = id(PlotColId::parse, &l.id) {
                    w.col(&cid, &pos, &l.label)?;
                }
            }
            Ok(())
        };
        lines(&r.plot_rows, true)?;
        lines(&r.plot_cols, false)?;
        for c in r.plot_cells.iter().filter(|c| c.document == d.id) {
            if let (Some(row), Some(col)) =
                (id(PlotRowId::parse, &c.row), id(PlotColId::parse, &c.col))
            {
                w.cell(&row, &col, Some(&c.value))?;
            }
        }
    }

    // Comments and TODOs.
    let mut conversations: HashMap<&str, String> = HashMap::new();
    for a in &r.comment_actions {
        if legacy::comment_action_survives(&a.kind) {
            let conv = serde_json::from_str::<Value>(&a.payload_json)
                .ok()
                .and_then(|v| {
                    v.get("conversationId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            match conv {
                Some(c) => {
                    conversations.insert(a.comment.as_str(), c);
                }
                None => notes.add("agent-task-action-without-conversation"),
            }
        } else {
            notes.add(format!("comment-action-dropped:{}", a.kind));
        }
    }
    for c in &r.comments {
        let anchor = anchors::parse_anchor(&c.anchor_json);
        let target = match (c.target_kind.as_deref(), c.target_id.as_deref()) {
            (Some(k), Some(i)) if !i.is_empty() => Some(entity(k, i, &new_comment_ids)),
            _ => None,
        };
        let w = match inp.projected.get(&c.id) {
            Some((_, kind, doc, b)) => txn.projected_todo(kind, doc, b)?.1,
            None => {
                let Some(cid) = id(CommentId::parse, &c.id) else {
                    continue;
                };
                let w = txn.comment(&cid)?;
                w.kind(&CommentKind::parse(&c.kind))?
                    .target(target.as_ref())?
                    .target_block(block(c.target_block_id.as_deref()).as_ref())?;
                w
            }
        };
        let (body, rich) = plain_text(&c.body_json);
        if rich {
            notes.add("comment-body-formatting-kept-as-text");
            originals.push(("comments", c.id.clone(), "body", c.body_json.clone()));
        }
        let status = legacy::comment_status(&c.status);
        if c.status == "converted" {
            notes.add("comment-status-converted");
        }
        if c.source == "copilot" || c.author_kind == "copilot" {
            notes.add("comment-copilot-values");
        }
        w.author_kind(&legacy::comment_author_kind(&c.author_kind))?
            .author(c.author_id.as_deref())?
            .author_name(c.author_name.as_deref())?
            .status(&status)?
            .priority(c.priority.as_deref().map(CommentPriority::parse).as_ref())?
            .source(&legacy::comment_source(&c.source))?
            .metadata(c.metadata_json.as_deref())?
            .quote(anchor.quote().as_deref())?
            .agent_conversation(conversations.get(c.id.as_str()).map(String::as_str))?
            .resolved_at(parse_opt(c.resolved_at.as_deref()))?
            .created_at(parse_iso(&c.created_at))?
            .updated_at(parse_iso(&c.updated_at))?
            .body(&body)?;
        let snaps = anchor.snapshots();
        if !snaps.is_empty() {
            w.snapshots(&snaps)?;
        }
        if anchor.region.is_some() {
            w.region(anchor.region.as_ref())?;
        }
        if let Some(a) = inp.anchors.get(&c.id) {
            w.anchor(Some(a))?;
        }
    }

    // Patches.
    let mut by_element: BTreeMap<&str, Vec<&crate::legacy::PatchRow>> = BTreeMap::new();
    for p in &r.patches {
        by_element.entry(p.element.as_str()).or_default().push(p);
    }
    for list in by_element.values() {
        for (p, pos) in list.iter().zip(ranks(list.len())) {
            let (Some(pid), Some(eid)) =
                (id(PatchId::parse, &p.id), id(ElementId::parse, &p.element))
            else {
                continue;
            };
            let (body, rich) = plain_text(&p.content_json);
            if rich {
                notes.add("patch-body-formatting-kept-as-text");
                originals.push(("patches", p.id.clone(), "body", p.content_json.clone()));
            }
            let source_node = p.source_node.as_deref().and_then(|n| NodeId::parse(n).ok());
            let w = txn.patch(&pid)?;
            w.element(&eid)?
                .source_node(source_node.as_ref())?
                .source_block(
                    block(p.source_block.as_deref())
                        .filter(|_| source_node.is_some())
                        .as_ref(),
                )?
                .source_text(p.source_text.as_deref())?
                .invalidated_at(parse_opt(p.invalidated_at.as_deref()))?
                .title(p.title.as_deref())?
                .pos(&pos)?
                .body(&body)?;
            if let Some(a) = inp.anchors.get(&p.id) {
                w.anchor(Some(a))?;
            }
        }
    }

    // Materials and assets.
    for a in &r.assets {
        let Some(aid) = id(AssetId::parse, &a.id) else {
            continue;
        };
        txn.put_asset(&Asset {
            id: aid,
            kind: AssetKind::parse(&a.kind),
            mime: a.mime.clone(),
            size: a.size,
            sha256: a.sha256.clone(),
            width: a.width,
            height: a.height,
        })?;
    }
    for (m, pos) in r.materials.iter().zip(ranks(r.materials.len())) {
        let Some(mid) = id(MaterialId::parse, &m.id) else {
            continue;
        };
        let kind = MaterialKind::parse(&m.kind);
        if !kind.is_known() {
            notes.add(format!("material-kind:{}", m.kind));
        }
        let w = txn.material(&mid)?;
        w.title(&m.title)?
            .kind(&kind)?
            .asset(
                m.asset
                    .as_deref()
                    .and_then(|a| AssetId::parse(a).ok())
                    .as_ref(),
            )?
            .folder(
                m.folder
                    .as_deref()
                    .and_then(|f| MaterialFolderId::parse(f).ok())
                    .as_ref(),
            )?
            .pos(&pos)?
            .task_todos(m.task_todos)?
            .provenance(m.provenance_json.as_deref())?;
        if let Some(notes_json) = m.notes_json.as_deref().filter(|n| !n.trim().is_empty()) {
            let (text, rich) = plain_text(notes_json);
            if rich {
                notes.add("material-description-formatting-kept-as-text");
                originals.push((
                    "materials",
                    m.id.clone(),
                    "description",
                    notes_json.to_string(),
                ));
            }
            w.description(&text)?;
        }
    }

    // Project Memory and writing days.
    for m in &r.memory {
        let Some(mid) = id(MemoryId::parse, &m.id) else {
            continue;
        };
        let target = match (m.target_kind.as_deref(), m.target_id.as_deref()) {
            (Some(k), Some(i)) if !i.is_empty() => Some(entity(k, i, &new_comment_ids)),
            _ => None,
        };
        txn.memory(&mid)?
            .kind(&MemoryKind::parse(&m.kind))?
            .body(&m.body)?
            .target(target.as_ref())?
            .target_block(block(m.target_block.as_deref()).as_ref())?
            .source(&MemorySource::parse(&m.source))?
            .origin_ref(m.origin_ref.as_deref())?
            .status(&MemoryStatus::parse(&m.status))?
            .supersedes(
                m.supersedes
                    .as_deref()
                    .and_then(|s| MemoryId::parse(s).ok())
                    .as_ref(),
            )?
            .deleted_at(parse_opt(m.deleted_at.as_deref()))?;
    }
    for d in &r.writing_days {
        match (DeviceKey::parse(&d.device_key), Day::parse(&d.day)) {
            (Ok(dev), Some(day)) => txn.writing_day(&dev, &day, d.words)?,
            _ => notes.add("writing-day-invalid"),
        }
    }
    Ok(originals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_of_editor_bodies() {
        let (t, rich) = plain_text(
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"一"},{"type":"hardBreak"},{"type":"text","text":"二"}]},{"type":"paragraph"}]}"#,
        );
        assert_eq!(t, "一\n二\n");
        assert!(!rich);
        let (t, rich) = plain_text(
            r#"{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold"}]}]}]}]}]}"#,
        );
        assert_eq!(t, "x");
        assert!(rich);
        assert_eq!(plain_text("{}").0, "");
    }

    #[test]
    fn kv_lists_follow_their_projection() {
        let row = |id: &str, k: &str, v: &str| KvRow {
            id: id.into(),
            owner_kind: "element".into(),
            owner_id: "e".into(),
            namespace: "facts".into(),
            key: k.into(),
            value: v.into(),
        };
        let rows = [
            row("c", "年龄", "60"),
            row("a", "身份", "举人"),
            row("b", "年龄", "61"),
        ];
        let mut notes = Notes::default();
        let out = kv_ordered(
            rows.iter().collect(),
            r#"[{"key":"身份","value":"举人"},{"key":"年龄","value":"61"},{"key":"年龄","value":"60"}]"#,
            &mut notes,
        );
        let ids: Vec<&str> = out.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert!(out.windows(2).all(|w| w[0].pos < w[1].pos));
        assert!(notes.is_empty());
    }

    #[test]
    fn trees_put_orphans_and_cycles_at_the_root() {
        let t = |id: &str, parent: Option<&str>| TreeRow {
            id: id.into(),
            name: id.into(),
            parent: parent.map(str::to_string),
            color: None,
            order: None,
            created_at: String::new(),
        };
        let rows = [
            t("child", Some("root")),
            t("root", None),
            t("x", Some("y")),
            t("y", Some("x")),
            t("lost", Some("gone")),
        ];
        let mut notes = Notes::default();
        let out = tree_order(&rows, &mut notes, "g");
        let pos = |id: &str| out.iter().position(|(r, _)| r.id == id).unwrap();
        assert!(pos("root") < pos("child"));
        assert_eq!(out[pos("lost")].1, None);
        assert_eq!(out[pos("x")].1, None);
        assert_eq!(notes.0["g-cycle-to-root"], 2);
        assert_eq!(notes.0["g-missing-parent-to-root"], 1);
    }
}
