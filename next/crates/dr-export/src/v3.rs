//! Manuscript conversion for format-5 projects (`kernel-v5.md` §3, M41 T3b):
//!
//! - **Book-prose mode** (`options.chapters == None`, 「只导成书正文」): reads
//!   `BookStructureV3::book_sequence()`, taking each entry with at least one
//!   `in_book` prose module once, in book sequence order (`depth = None`).
//! - **Tree-selection mode** (`options.chapters == Some(ids)`, 「自己勾」): walks
//!   the live residence tree (`BookStructureV3::children_of`) in preorder,
//!   exporting **all content** of every ticked entry in active-template module
//!   order (`Prose` whether `in_book` or not, `Fields`, `KeyValue`, `Media`,
//!   `Patches`, `PlotGrid`, `Relations`; `Children` and `Members` are structural
//!   views storing no data and are skipped) and preserving tree hierarchy via
//!   `Section::Chapter::depth`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use dr_doc::{
    prose::{BorrowedProse, FileEmbedLook},
    v3::{BookStructureV3, BookViewV3, BorrowedBookV3},
};
use dr_model::{
    DocId,
    id::{AssetId, BookId, CommentId, EntryId, EntryTemplateId, ModuleId, RelationTypeId},
    kind::{AssetKind, EntityKind, RelationOrientation},
    shared::{Asset, EntityRef, KvEntry, Relation},
    v3::{
        CommentV3, Entry as ModelEntry, EntryTemplate, FieldDef, FieldType, FieldValue, MediaItem,
        ModuleKind, PatchV3, PlotGridV3, RelationTypeV3,
    },
};
use dr_store::{OpenDoc, asset::Variant};
use dr_workspace::Workspace;

use crate::manuscript::{Align, Block, Cover, Run};
use crate::{ExportError, Labels, Manuscript, Options, Result, Section};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub mark: Option<String>,
    /// Current book-prose modules only (`in_book = true`). Retained content stays in the book file.
    pub prose: Vec<DocId>,
}

/// One live entry in the project's residence tree (`BookStructureV3::children_of`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeNode {
    pub id: String,
    pub title: String,
    pub mark: Option<String>,
    pub color: Option<String>,
    pub level: bool,
    pub children: Vec<TreeNode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outline {
    pub book: String,
    pub title: String,
    pub has_book: bool,
    pub entries: Vec<Entry>,
    pub tree: Vec<TreeNode>,
}

impl Outline {
    /// Share the legacy picker layout without assigning built-in acts to v5 levels.
    pub fn picker(&self) -> crate::Outline {
        crate::Outline {
            book: self.book.clone(),
            title: self.title.clone(),
            has_book: self.has_book,
            acts: Vec::new(),
            chapters: self
                .entries
                .iter()
                .map(|entry| crate::ChapterEntry {
                    id: entry.id.clone(),
                    title: entry.title.clone(),
                    status: String::new(),
                    act: None,
                })
                .collect(),
        }
    }

    /// Every entry id in `self.tree` in residence-tree preorder.
    pub fn tree_ids(&self) -> Vec<String> {
        fn collect(nodes: &[TreeNode], out: &mut Vec<String>) {
            for n in nodes {
                out.push(n.id.clone());
                collect(&n.children, out);
            }
        }
        let mut out = Vec::new();
        collect(&self.tree, &mut out);
        out
    }
}

fn invalid(e: impl ToString) -> ExportError {
    ExportError::Invalid(e.to_string())
}

fn build_tree(
    structure: &BookStructureV3,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    parent: Option<&EntryId>,
) -> Vec<TreeNode> {
    structure
        .children_of(parent)
        .into_iter()
        .map(|entry| {
            let tpl = entry.effective_template(templates);
            let children = if entry.is_level() {
                build_tree(structure, templates, Some(&entry.id))
            } else {
                Vec::new()
            };
            TreeNode {
                id: entry.id.to_string(),
                title: entry.title.clone(),
                mark: entry.effective_mark(templates).map(str::to_owned),
                color: tpl.and_then(|t| t.color.clone()),
                level: entry.is_level(),
                children,
            }
        })
        .collect()
}

/// Version dispatch for hosts which also check book format.
pub fn is_book(ws: &Workspace, book: &str) -> Result<bool> {
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(dr_doc::v3::is_book_doc)
        .map_err(invalid)
}

pub fn outline(ws: &Workspace, book: &str) -> Result<Outline> {
    let id = BookId::parse(book).map_err(invalid)?;
    ws.library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid(
                    "the manuscript requires a book of the current format",
                ));
            }
            let borrowed = BorrowedBookV3::new(doc, &id).map_err(invalid)?;
            let view = borrowed.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                return Err(ExportError::NotFound(format!("book {id}")));
            }
            let structure = view.structure_snapshot();
            let has_book = structure.project().book.is_some();
            let templates = structure.templates_map();
            let entries: Vec<Entry> = structure
                .book_sequence()
                .into_iter()
                .filter(|e| !e.prose.is_empty())
                .map(|e| Entry {
                    id: e.entry.id.to_string(),
                    title: e.entry.title.clone(),
                    mark: e.entry.effective_mark(templates).map(str::to_owned),
                    prose: e.prose.iter().map(|p| p.doc.clone()).collect(),
                })
                .collect();
            let tree = build_tree(&structure, templates, None);
            Ok(Outline {
                book: id.to_string(),
                title: meta.name,
                has_book,
                entries,
                tree,
            })
        })
        .map_err(invalid)?
}

enum ModulePart {
    Prose(DocId),
    Blocks(Vec<Block>),
    Asset { asset: AssetId, caption: String },
}

struct SectionPlan {
    title: String,
    depth: Option<u8>,
    parts: Vec<ModulePart>,
}

struct TreeContext {
    live_entries: HashMap<EntryId, String>,
    live_assets: Arc<HashMap<AssetId, Asset>>,
    patches: HashMap<(EntryId, ModuleId), Vec<PatchV3>>,
    plot_grids: HashMap<(EntryId, ModuleId), PlotGridV3>,
    relation_types: HashMap<RelationTypeId, RelationTypeV3>,
    relations: Vec<Relation>,
    all_patches: HashMap<String, PatchV3>,
    comments: HashMap<String, CommentV3>,
}

fn plain_run(text: impl Into<String>) -> Run {
    Run {
        text: text.into(),
        ..Run::default()
    }
}

fn bold_run(text: impl Into<String>) -> Run {
    Run {
        text: text.into(),
        bold: true,
        ..Run::default()
    }
}

fn clamp_caption(caption: &str) -> String {
    let line = crate::convert::one_line(caption);
    if line.chars().count() <= 2_000 {
        line
    } else {
        line.chars().take(2_000).collect()
    }
}

fn format_number(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < (i64::MAX as f64) {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

fn entry_display_title(raw: &str, labels: &Labels) -> String {
    let clean = crate::convert::one_line(raw);
    if clean.is_empty() {
        labels.untitled_chapter.clone()
    } else {
        clean
    }
}

fn render_fields_module(
    entry: &ModelEntry,
    module_id: &ModuleId,
    defs: &[FieldDef],
    ctx: &TreeContext,
    labels: &Labels,
    parts: &mut Vec<ModulePart>,
) {
    let Some(values) = entry.fields.get(module_id) else {
        return;
    };
    let mut seen: HashSet<&str> = HashSet::new();
    let mut rows: Vec<Vec<Vec<Run>>> = Vec::new();
    let mut push_field = |label: &str, field_type: Option<&FieldType>, val: &FieldValue| {
        let label_clean = crate::convert::one_line(label);
        let field_name = if label_clean.is_empty() {
            String::from("—")
        } else {
            label_clean
        };
        match (field_type, val) {
            (_, FieldValue::Null) => {}
            (Some(FieldType::Image), FieldValue::Text(raw)) => {
                let Ok(asset_id) = AssetId::parse(raw.trim()) else {
                    return;
                };
                let Some(asset) = ctx.live_assets.get(&asset_id) else {
                    return;
                };
                match asset.kind {
                    AssetKind::Image => {
                        if !rows.is_empty() {
                            parts.push(ModulePart::Blocks(vec![Block::Table {
                                rows: std::mem::take(&mut rows),
                            }]));
                        }
                        parts.push(ModulePart::Asset {
                            asset: asset_id,
                            caption: field_name,
                        });
                    }
                    AssetKind::Pdf => {
                        let name = crate::convert::one_line(&asset.name);
                        let shown = if name.is_empty() {
                            asset_id.to_string()
                        } else {
                            name
                        };
                        rows.push(vec![vec![bold_run(field_name)], vec![plain_run(shown)]]);
                    }
                    _ => {}
                }
            }
            (Some(FieldType::EntityRef), FieldValue::Text(raw)) => {
                let Ok(target_id) = EntryId::parse(raw.trim()) else {
                    return;
                };
                let Some(target_title) = ctx.live_entries.get(&target_id) else {
                    return;
                };
                let shown = entry_display_title(target_title, labels);
                rows.push(vec![vec![bold_run(field_name)], vec![plain_run(shown)]]);
            }
            (_, FieldValue::Text(raw)) => {
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    rows.push(vec![
                        vec![bold_run(field_name)],
                        vec![plain_run(trimmed.replace('\r', ""))],
                    ]);
                }
            }
            (_, FieldValue::Number(n)) if n.is_finite() => {
                rows.push(vec![
                    vec![bold_run(field_name)],
                    vec![plain_run(format_number(*n))],
                ]);
            }
            (_, FieldValue::Number(_)) => {}
            (_, FieldValue::Bool(b)) => {
                rows.push(vec![
                    vec![bold_run(field_name)],
                    vec![plain_run(if *b { "☑" } else { "☐" })],
                ]);
            }
            (_, FieldValue::List(items)) => {
                let non_empty: Vec<&str> = items
                    .iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !non_empty.is_empty() {
                    rows.push(vec![
                        vec![bold_run(field_name)],
                        vec![plain_run(non_empty.join(", "))],
                    ]);
                }
            }
        }
    };

    for def in defs {
        seen.insert(def.id.as_str());
        if let Some(val) = values.get(&def.id) {
            let label = if def.name.trim().is_empty() {
                &def.id
            } else {
                &def.name
            };
            push_field(label, Some(&def.field_type), val);
        }
    }
    for (key, val) in values {
        if !seen.contains(key.as_str()) {
            push_field(key, None, val);
        }
    }
    if !rows.is_empty() {
        parts.push(ModulePart::Blocks(vec![Block::Table { rows }]));
    }
}

fn render_kv_module(rows_in: &[KvEntry], parts: &mut Vec<ModulePart>) {
    let rows: Vec<Vec<Vec<Run>>> = rows_in
        .iter()
        .filter(|r| !r.key.trim().is_empty() || !r.value.trim().is_empty())
        .map(|r| {
            vec![
                vec![bold_run(r.key.trim())],
                vec![plain_run(r.value.trim().replace('\r', ""))],
            ]
        })
        .collect();
    if !rows.is_empty() {
        parts.push(ModulePart::Blocks(vec![Block::Table { rows }]));
    }
}

fn render_media_module(items: &[MediaItem], parts: &mut Vec<ModulePart>) {
    for item in items {
        parts.push(ModulePart::Asset {
            asset: item.asset.clone(),
            caption: item.caption.clone(),
        });
    }
}

fn render_patches_module(patches: &[PatchV3], parts: &mut Vec<ModulePart>) {
    let mut blocks = Vec::new();
    for patch in patches {
        let title = patch.title.as_deref().map(str::trim).unwrap_or("");
        let quote = patch.source_text.as_deref().map(str::trim).unwrap_or("");
        let body = patch.body.trim();
        if title.is_empty() && quote.is_empty() && body.is_empty() {
            continue;
        }
        if !title.is_empty() {
            blocks.push(Block::Paragraph {
                runs: vec![bold_run(crate::convert::one_line(title))],
                align: Align::Left,
                indent: 0,
            });
        }
        if !quote.is_empty() {
            let quote_paras: Vec<Block> = quote
                .split('\n')
                .map(|l| l.trim_end_matches('\r'))
                .filter(|l| !l.trim().is_empty())
                .map(|l| Block::Paragraph {
                    runs: vec![plain_run(l)],
                    align: Align::Justify,
                    indent: 0,
                })
                .collect();
            if !quote_paras.is_empty() {
                blocks.push(Block::Quote {
                    blocks: quote_paras,
                });
            }
        }
        if !body.is_empty() {
            for line in body.split('\n').map(|l| l.trim_end_matches('\r')) {
                if line.trim().is_empty() {
                    continue;
                }
                blocks.push(Block::Paragraph {
                    runs: vec![plain_run(line)],
                    align: Align::Justify,
                    indent: 0,
                });
            }
        }
    }
    if !blocks.is_empty() {
        parts.push(ModulePart::Blocks(blocks));
    }
}

fn render_plot_grid_module(grid: &PlotGridV3, parts: &mut Vec<ModulePart>) {
    if grid.rows.is_empty() || grid.cols.is_empty() {
        return;
    }
    let has_content = grid.cells.values().any(|s| !s.trim().is_empty());
    if !has_content {
        return;
    }
    let mut rows: Vec<Vec<Vec<Run>>> = Vec::with_capacity(grid.rows.len() + 1);
    let mut header: Vec<Vec<Run>> = Vec::with_capacity(grid.cols.len() + 1);
    header.push(Vec::new());
    for col in &grid.cols {
        header.push(vec![bold_run(crate::convert::one_line(&col.label))]);
    }
    rows.push(header);
    for row in &grid.rows {
        let mut out_row: Vec<Vec<Run>> = Vec::with_capacity(grid.cols.len() + 1);
        out_row.push(vec![bold_run(crate::convert::one_line(&row.label))]);
        for col in &grid.cols {
            let text = grid
                .cells
                .get(&(row.id.clone(), col.id.clone()))
                .map(|s| s.trim().replace('\r', ""))
                .unwrap_or_default();
            if text.is_empty() {
                out_row.push(Vec::new());
            } else {
                out_row.push(vec![plain_run(text)]);
            }
        }
        rows.push(out_row);
    }
    parts.push(ModulePart::Blocks(vec![Block::Table { rows }]));
}

fn counterpart_label(end: &EntityRef, ctx: &TreeContext, labels: &Labels) -> Option<String> {
    match end.kind {
        EntityKind::Entry => {
            let id = EntryId::parse(&end.id).ok()?;
            let title = ctx.live_entries.get(&id)?;
            Some(entry_display_title(title, labels))
        }
        EntityKind::Asset => {
            let id = AssetId::parse(&end.id).ok()?;
            let asset = ctx.live_assets.get(&id)?;
            let name = crate::convert::one_line(&asset.name);
            Some(if name.is_empty() {
                id.to_string()
            } else {
                name
            })
        }
        EntityKind::Patch => {
            let patch = ctx.all_patches.get(&end.id)?;
            let text = patch
                .title
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or(patch.body.as_str());
            let clean = crate::convert::one_line(text);
            Some(if clean.is_empty() {
                end.id.clone()
            } else {
                clean
            })
        }
        EntityKind::Comment => {
            let comment = ctx.comments.get(&end.id)?;
            let clean = crate::convert::one_line(&comment.body);
            Some(if clean.is_empty() {
                end.id.clone()
            } else {
                clean
            })
        }
        _ => None,
    }
}

fn render_relations_module(
    entry_id: &EntryId,
    ctx: &TreeContext,
    labels: &Labels,
    parts: &mut Vec<ModulePart>,
) {
    let self_ref = EntityRef::new(EntityKind::Entry, entry_id.to_string());
    let mut rows: Vec<Vec<Vec<Run>>> = Vec::new();
    for rel in &ctx.relations {
        let (outgoing, other) = if rel.from == self_ref {
            (true, &rel.to)
        } else if rel.to == self_ref {
            (false, &rel.from)
        } else {
            continue;
        };
        let Some(target) = counterpart_label(other, ctx, labels) else {
            continue;
        };
        let role = ctx
            .relation_types
            .get(&rel.relation_type)
            .map(|rt| {
                let candidate = match rt.orientation {
                    RelationOrientation::Symmetric => rt.name.as_str(),
                    _ if outgoing => {
                        if rt.target_role.trim().is_empty() {
                            rt.name.as_str()
                        } else {
                            rt.target_role.as_str()
                        }
                    }
                    _ => {
                        if rt.source_role.trim().is_empty() {
                            rt.name.as_str()
                        } else {
                            rt.source_role.as_str()
                        }
                    }
                };
                crate::convert::one_line(candidate)
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| rel.relation_type.to_string());
        rows.push(vec![vec![bold_run(role)], vec![plain_run(target)]]);
    }
    if !rows.is_empty() {
        parts.push(ModulePart::Blocks(vec![Block::Table { rows }]));
    }
}

fn collect_entry_all_content(
    entry: &ModelEntry,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    ctx: &TreeContext,
    labels: &Labels,
) -> Vec<ModulePart> {
    let mut parts = Vec::new();
    if let Some(tpl) = entry.effective_template(templates) {
        for module in &tpl.modules {
            match module.kind {
                ModuleKind::Prose => {
                    if let Ok(doc) = DocId::parse(&format!("body:{}/{}", entry.id, module.id)) {
                        parts.push(ModulePart::Prose(doc));
                    }
                }
                ModuleKind::Fields => {
                    render_fields_module(
                        entry,
                        &module.id,
                        &module.config.defs,
                        ctx,
                        labels,
                        &mut parts,
                    );
                }
                ModuleKind::KeyValue => {
                    if let Some(rows) = entry.kv.get(&module.id) {
                        render_kv_module(rows, &mut parts);
                    }
                }
                ModuleKind::Media => {
                    if let Some(items) = entry.media.get(&module.id) {
                        render_media_module(items, &mut parts);
                    }
                }
                ModuleKind::Patches => {
                    if let Some(list) = ctx.patches.get(&(entry.id.clone(), module.id.clone())) {
                        render_patches_module(list, &mut parts);
                    }
                }
                ModuleKind::PlotGrid => {
                    if let Some(grid) = ctx.plot_grids.get(&(entry.id.clone(), module.id.clone())) {
                        render_plot_grid_module(grid, &mut parts);
                    }
                }
                ModuleKind::Relations => {
                    render_relations_module(&entry.id, ctx, labels, &mut parts);
                }
                // `Children` and `Members` are structural UI views storing no data on the entry.
                ModuleKind::Children | ModuleKind::Members | ModuleKind::Other(_) => {}
            }
        }
    } else {
        for module_id in entry.fields.keys() {
            render_fields_module(entry, module_id, &[], ctx, labels, &mut parts);
        }
        for rows in entry.kv.values() {
            render_kv_module(rows, &mut parts);
        }
        for items in entry.media.values() {
            render_media_module(items, &mut parts);
        }
    }
    parts
}

#[allow(clippy::too_many_arguments)]
fn walk_selected_tree(
    structure: &BookStructureV3,
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    parent: Option<&EntryId>,
    depth: usize,
    selected: &HashSet<&str>,
    ctx: &TreeContext,
    labels: &Labels,
    plans: &mut Vec<SectionPlan>,
) {
    for entry in structure.children_of(parent) {
        if selected.contains(entry.id.as_str()) {
            plans.push(SectionPlan {
                title: entry_display_title(&entry.title, labels),
                depth: Some(depth.min(u8::MAX as usize) as u8),
                parts: collect_entry_all_content(entry, templates, ctx, labels),
            });
        }
        if entry.is_level() {
            walk_selected_tree(
                structure,
                templates,
                Some(&entry.id),
                depth + 1,
                selected,
                ctx,
                labels,
                plans,
            );
        }
    }
}

fn load_tree_context(view: &BookViewV3, live_assets: Arc<HashMap<AssetId, Asset>>) -> TreeContext {
    let live_entries: HashMap<EntryId, String> = view
        .entries_raw()
        .into_iter()
        .filter(|e| !e.is_trashed())
        .map(|e| (e.id, e.title))
        .collect();
    let mut patches: HashMap<(EntryId, ModuleId), Vec<PatchV3>> = HashMap::new();
    let mut all_patches: HashMap<String, PatchV3> = HashMap::new();
    for p in view.patches() {
        all_patches.insert(p.id.to_string(), p.clone());
        patches
            .entry((p.entry.clone(), p.module.clone()))
            .or_default()
            .push(p);
    }
    let plot_grids: HashMap<(EntryId, ModuleId), PlotGridV3> = view
        .plot_grids()
        .into_iter()
        .map(|g| ((g.entry.clone(), g.module.clone()), g))
        .collect();
    let relation_types: HashMap<RelationTypeId, RelationTypeV3> = view
        .relation_types()
        .into_iter()
        .map(|rt| (rt.id.clone(), rt))
        .collect();
    let relations = view.relations();
    let comments: HashMap<String, CommentV3> = view
        .comments()
        .into_iter()
        .map(|c| (c.id.to_string(), c))
        .collect();
    TreeContext {
        live_entries,
        live_assets,
        patches,
        plot_grids,
        relation_types,
        relations,
        all_patches,
        comments,
    }
}

fn resolve_asset_block(
    asset_id: &AssetId,
    caption: &str,
    live_assets: &HashMap<AssetId, Asset>,
    image_cache: &Mutex<HashMap<AssetId, Option<Cover>>>,
    lib: &dr_store::Library,
    book_key: &str,
) -> Option<Block> {
    let asset = live_assets.get(asset_id)?;
    match asset.kind {
        AssetKind::Pdf => {
            let name = crate::convert::one_line(&asset.name);
            let base = if name.is_empty() {
                asset_id.to_string()
            } else {
                name
            };
            let cap = crate::convert::one_line(caption);
            let line = if cap.is_empty() {
                base
            } else {
                format!("{base} — {cap}")
            };
            Some(Block::Paragraph {
                runs: vec![plain_run(line)],
                align: Align::Left,
                indent: 0,
            })
        }
        AssetKind::Image => {
            let cached = image_cache
                .lock()
                .ok()
                .and_then(|guard| guard.get(asset_id).cloned());
            let cover = match cached {
                Some(found) => found,
                None => {
                    let loaded = lib
                        .asset(asset_id.as_str(), Variant::Source)
                        .ok()
                        .flatten()
                        .filter(|rec| rec.book_id == book_key)
                        .and_then(|rec| crate::cover::inline_image_from_path(&rec.path).ok());
                    if let Ok(mut guard) = image_cache.lock() {
                        guard.insert(asset_id.clone(), loaded.clone());
                    }
                    loaded
                }
            }?;
            Some(Block::Image {
                media_type: cover.media_type,
                data: cover.data,
                width: cover.width,
                height: cover.height,
                caption: clamp_caption(caption),
            })
        }
        _ => None,
    }
}

struct ManuscriptPlan {
    book_title: String,
    done_todos: Arc<HashSet<CommentId>>,
    live_assets: Arc<HashMap<AssetId, Asset>>,
    plans: Vec<SectionPlan>,
}

/// Reads a manuscript from `book`:
///
/// - When `options.chapters` is `None` (「只导成书正文」), exports
///   `BookStructureV3::book_sequence()` (`in_book` prose modules only, flat
///   book order). Returns [`ExportError::NoChapters`] when `成书` is disabled
///   or no book-sequence entry carries `in_book` prose.
/// - When `options.chapters` is `Some(ids)` (「自己勾」), walks the live
///   residence tree (`BookStructureV3::children_of`) in preorder regardless of
///   whether `成书` is enabled, exporting **all content** of each ticked entry
///   with its residence-tree depth (`Section::Chapter::depth`).
#[allow(clippy::too_many_arguments)]
pub fn read_manuscript(
    ws: &Workspace,
    book: &str,
    options: &Options,
    labels: &Labels,
    locale: &str,
    preferred_font: Option<String>,
    now: SystemTime,
) -> Result<Manuscript> {
    let book_id = BookId::parse(book).map_err(invalid)?;
    let selected_opt = options.chapters.clone();
    let labels_for_doc = labels.clone();
    let ManuscriptPlan {
        book_title,
        done_todos,
        live_assets,
        plans,
    } = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(invalid)?
        .read(move |doc| {
            if !dr_doc::v3::is_book_doc(doc) {
                return Err(invalid(
                    "the manuscript requires a book of the current format",
                ));
            }
            let borrowed = BorrowedBookV3::new(doc, &book_id).map_err(invalid)?;
            let view = borrowed.view();
            let meta = view.meta();
            if meta.deleted_at.is_some() {
                return Err(ExportError::NotFound(format!("book {book_id}")));
            }
            let structure = view.structure_snapshot();
            let has_book = structure.project().book.is_some();
            let done: Arc<HashSet<CommentId>> = Arc::new(
                view.comments()
                    .into_iter()
                    .filter(|c| c.is_done())
                    .map(|c| c.id)
                    .collect(),
            );
            let assets: Arc<HashMap<AssetId, Asset>> = Arc::new(
                view.assets()
                    .into_iter()
                    .map(|a| (a.id.clone(), a))
                    .collect(),
            );
            let plans = match selected_opt.as_ref() {
                None => {
                    if !has_book {
                        return Err(ExportError::NoChapters);
                    }
                    let seq: Vec<SectionPlan> = structure
                        .book_sequence()
                        .into_iter()
                        .filter(|e| !e.prose.is_empty())
                        .map(|e| SectionPlan {
                            title: entry_display_title(&e.entry.title, &labels_for_doc),
                            depth: None,
                            parts: e
                                .prose
                                .iter()
                                .map(|p| ModulePart::Prose(p.doc.clone()))
                                .collect(),
                        })
                        .collect();
                    if seq.is_empty() {
                        return Err(ExportError::NoChapters);
                    }
                    seq
                }
                Some(ids) => {
                    let selected: HashSet<&str> = ids.iter().map(String::as_str).collect();
                    if selected.is_empty() {
                        return Err(ExportError::NoChapters);
                    }
                    let ctx = load_tree_context(&view, Arc::clone(&assets));
                    let mut out = Vec::new();
                    walk_selected_tree(
                        &structure,
                        structure.templates_map(),
                        None,
                        0,
                        &selected,
                        &ctx,
                        &labels_for_doc,
                        &mut out,
                    );
                    if out.is_empty() {
                        return Err(ExportError::NoChapters);
                    }
                    out
                }
            };
            Ok::<_, ExportError>(ManuscriptPlan {
                book_title: meta.name,
                done_todos: done,
                live_assets: assets,
                plans,
            })
        })
        .map_err(invalid)??;

    let image_cache: Arc<Mutex<HashMap<AssetId, Option<Cover>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let stored: HashSet<_> = ws
        .library()
        .docs(Some(book), None)
        .map_err(invalid)?
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    let mut sections = Vec::with_capacity(plans.len());
    for plan in plans {
        let mut blocks = Vec::new();
        for part in plan.parts {
            match part {
                ModulePart::Blocks(extra) => blocks.extend(extra),
                ModulePart::Asset { asset, caption } => {
                    if let Some(block) = resolve_asset_block(
                        &asset,
                        &caption,
                        &live_assets,
                        &image_cache,
                        ws.library(),
                        book,
                    ) {
                        blocks.push(block);
                    }
                }
                ModulePart::Prose(doc) => {
                    let id = doc.to_string();
                    if !stored.contains(&id) {
                        continue;
                    }
                    let done_todos = Arc::clone(&done_todos);
                    let live_assets = Arc::clone(&live_assets);
                    let image_cache = Arc::clone(&image_cache);
                    let lib = ws.library().clone();
                    let book_key = book.to_owned();
                    let handle = match ws.library().open_doc(&id, OpenDoc::Existing) {
                        Ok(h) => h,
                        Err(dr_store::StoreError::NotFound(_)) => continue,
                        Err(e) => return Err(invalid(e)),
                    };
                    let prose_blocks = handle
                        .read(move |loro| {
                            let prose = BorrowedProse::new(loro, &doc).map_err(invalid)?;
                            let resolve_asset =
                                |asset_id: &AssetId, look: &FileEmbedLook| -> Option<Block> {
                                    // Prose PDF embeds always export a single filename line
                                    // (look.caption is empty on PDF embeds, kept clean here).
                                    let asset = live_assets.get(asset_id)?;
                                    let cap = if asset.kind == AssetKind::Pdf {
                                        ""
                                    } else {
                                        look.caption.as_str()
                                    };
                                    resolve_asset_block(
                                        asset_id,
                                        cap,
                                        &live_assets,
                                        &image_cache,
                                        &lib,
                                        &book_key,
                                    )
                                };
                            Ok::<_, ExportError>(crate::convert::blocks_with_context(
                                &prose.view(),
                                Some(&done_todos),
                                Some(&resolve_asset),
                            ))
                        })
                        .map_err(invalid)??;
                    blocks.extend(prose_blocks);
                }
            }
        }
        sections.push(Section::Chapter {
            title: plan.title,
            show_title: options.chapter_titles,
            depth: plan.depth,
            blocks,
        });
    }
    let title = options.title.trim();
    Ok(Manuscript {
        title: if title.is_empty() {
            book_title.trim().to_owned()
        } else {
            title.to_owned()
        },
        author: options.author.trim().to_owned(),
        identifier: book.to_owned(),
        modified: crate::timestamp(now),
        locale: locale.to_owned(),
        preferred_font: preferred_font.filter(|f| !f.trim().is_empty()),
        cover: options.cover.clone(),
        sections,
    })
}
