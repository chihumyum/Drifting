//! Replay a typed legacy catalog into a v3 writer. Used on each historical
//! metadata version as well as the current state; no v2 catalog is stored.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::import_v1::BookView;
use dr_doc::v3::novel::*;
use dr_doc::v3::{BookTxnV3, BookViewV3};
use dr_doc::{Anchor, DocError, Result};
use dr_model::id::*;
use dr_model::import_v1::{EntityRef, MaterialKind, NodeId};
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::v3::*;

use super::*;

/// The left-bar tab an import gives the 「文本素材」 level (one per book, so a
/// replayed catalog finds it again).
pub const TEXT_MATERIALS_TAB: &str = "tab-text-materials";

pub(crate) fn invalid(message: impl Into<String>) -> DocError {
    DocError::Loro(loro::LoroError::ArgErr(message.into().into()))
}

/// The mapping's required templates. Unused built-in entry templates are
/// harmless, but default category entries must never be added on import.
fn templates(source: &BookView<'_>, manuscript: &EntryId) -> Result<Vec<EntryTemplate>> {
    let mut all = novel_project_templates();
    let base_element = all
        .iter()
        .find(|t| t.id.as_str() == TPL_ELEMENT)
        .unwrap()
        .clone();
    let chapter = all
        .iter()
        .find(|t| t.id.as_str() == TPL_CHAPTER)
        .unwrap()
        .clone();
    for tpl in &mut all {
        if tpl.id.as_str() == TPL_STORYLINE {
            tpl.settings.home = Some(Some(manuscript.clone()));
            tpl.modules
                .iter_mut()
                .find(|m| m.id.as_str() == MOD_KV)
                .unwrap()
                .config
                .initial_kv = source.meta().storyline_template;
        }
    }
    for category in source.categories() {
        let mut tpl = base_element.clone();
        tpl.id = category_template(category.id.as_str());
        tpl.name = category.name;
        tpl.color = Some(category.color);
        let module = tpl
            .modules
            .iter_mut()
            .find(|m| m.id.as_str() == MOD_FIELDS)
            .unwrap();
        // Template row ids are stable even when names are edited in history.
        module
            .config
            .defs
            .extend(category.template_fields.iter().map(|f| FieldDef {
                id: f.id.to_string(),
                name: f.key.clone(),
                field_type: FieldType::Text,
                options: vec![],
                target_template: None,
                default_value: (!f.value.is_empty()).then(|| FieldValue::Text(f.value.clone())),
                pos: f.pos.clone(),
            }));
        all.push(tpl);
    }
    for storyline in source
        .storylines()
        .into_iter()
        .filter(|s| has_body(s.chapter_template.as_deref()))
    {
        let mut tpl = chapter.clone();
        tpl.id = storyline_template(storyline.id.as_str());
        tpl.name = storyline.name;
        all.push(tpl);
    }
    if source
        .materials()
        .iter()
        .any(|m| m.kind == MaterialKind::Text && !m.task_todos)
    {
        let mut tpl = all
            .iter()
            .find(|t| t.id.as_str() == TPL_NOTE)
            .unwrap()
            .clone();
        tpl.id = plain_note_template();
        tpl.modules
            .iter_mut()
            .find(|m| m.id.as_str() == MOD_PROSE)
            .unwrap()
            .config
            .task_todos = false;
        all.push(tpl);
    }
    let mut unique = BTreeMap::new();
    for template in all {
        if let Some(old) = unique.insert(template.id.clone(), template.clone())
            && old != template
        {
            return Err(invalid(format!("template id collision: {}", template.id)));
        }
    }
    Ok(unique.into_values().collect())
}

fn has_body(json: Option<&str>) -> bool {
    fn nonempty(v: &serde_json::Value) -> bool {
        v.get("text")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
            || matches!(
                v.get("type").and_then(|v| v.as_str()),
                Some("table" | "materialEmbed" | "hardBreak")
            )
            || v.get("content")
                .and_then(|v| v.as_array())
                .is_some_and(|a| a.iter().any(nonempty))
    }
    json.and_then(|j| serde_json::from_str(j).ok())
        .is_some_and(|v| nonempty(&v))
}

/// Entry update clears stale fields and KV rows, so replaying an old
/// metadata point and then restoring the current point is lossless.
struct Entries<'a, 'b> {
    txn: &'a mut BookTxnV3<'b>,
    wanted: BTreeSet<EntryId>,
    sibling: BTreeMap<Option<EntryId>, usize>,
}

impl Entries<'_, '_> {
    fn put(
        &mut self,
        id: &EntryId,
        parent: Option<&EntryId>,
        title: &str,
        template: &EntryTemplateId,
    ) -> Result<dr_doc::v3::write::EntryWriterV3> {
        if !self.wanted.insert(id.clone()) {
            return Err(invalid(format!("entry id collision: {id}")));
        }
        let index = self.sibling.entry(parent.cloned()).or_default();
        // The switch starts from the template, as for a new entry.
        let level = self.txn.view().template(template).is_some_and(|t| t.level);
        let old = self.txn.view().entry_raw(id);
        let w = if let Some(old) = old {
            self.txn.entries().move_to_at(id, parent, *index)?;
            let w = self.txn.entries().entry(id)?;
            for (module, fields) in &old.fields {
                for key in fields.keys() {
                    w.set_field(module, key, None)?;
                }
            }
            for (module, rows) in &old.kv {
                for row in rows {
                    w.remove_kv(module, &row.id)?;
                }
            }
            for (module, items) in &old.media {
                for item in items {
                    w.remove_media(module, &item.id)?;
                }
            }
            w.title(title)?
                .template(Some(template))?
                .level(level)?
                .overrides(None)?
                .primary(None)?
                .mark(None)?
                .created_at(None)?
                .updated_at(None)?
                .deleted_at(None)?;
            w
        } else {
            self.txn
                .entries()
                .create_at(id, parent, *index, title, Some(template), level)?
        };
        *index += 1;
        Ok(w)
    }

    fn finish(self) -> Result<()> {
        // Only this in-memory adapter owns this document. Remove derived
        // groups no longer used by the current metadata version, after all
        // surviving children have moved to their current homes.
        let stale: Vec<_> = self
            .txn
            .view()
            .entries_raw()
            .into_iter()
            .filter(|e| !self.wanted.contains(&e.id))
            .map(|e| e.id)
            .collect();
        for id in stale {
            if self.txn.view().entry(&id).is_some() {
                self.txn.entries().purge_subtree(&id)?;
            }
        }
        Ok(())
    }
}

fn text(w: &dr_doc::v3::write::EntryWriterV3, key: &str, value: &str) -> Result<()> {
    w.set_field(&mid(MOD_FIELDS), key, Some(&FieldValue::Text(value.into())))?;
    Ok(())
}

/// The asset library's folders and the files' places, rebuilt from 0.1
/// (`kernel-v5.md` §6, §13): every material folder that holds an image or a
/// PDF, directly or through its child folders, becomes an asset folder with
/// the same id, name and nesting, in the source order; a file lives in the
/// folder of its first material that has one, in the materials' order. A
/// folder holding notes as well is rebuilt here and as a level under
/// 「文本素材」 alike.
#[derive(Debug, Default)]
pub struct FileFolders {
    pub folders: Vec<dr_model::shared::AssetFolder>,
    pub places: BTreeMap<AssetId, (Option<AssetFolderId>, PosKey)>,
}

pub fn file_folders(
    folders: &[dr_model::import_v1::MaterialFolder],
    materials: &[dr_model::import_v1::Material],
) -> FileFolders {
    use dr_model::import_v1::{MaterialFolder, MaterialFolderId};
    let by_id: BTreeMap<&MaterialFolderId, &MaterialFolder> =
        folders.iter().map(|f| (&f.id, f)).collect();
    let folder_id = |f: &MaterialFolderId| AssetFolderId::parse(f.as_str()).ok();
    let mut wanted: BTreeSet<&MaterialFolderId> = BTreeSet::new();
    let mut first: BTreeMap<&AssetId, Option<&MaterialFolderId>> = BTreeMap::new();
    for m in materials.iter().filter(|m| m.kind != MaterialKind::Text) {
        let Some(asset) = &m.asset else {
            continue;
        };
        let folder = m
            .folder
            .as_ref()
            .filter(|f| by_id.contains_key(f) && folder_id(f).is_some());
        if let Some(f) = folder {
            let mut cur = Some(f);
            while let Some(fid) = cur {
                if !wanted.insert(fid) {
                    break;
                }
                cur = by_id.get(fid).and_then(|mf| mf.parent.as_ref());
            }
        }
        match first.get(asset) {
            Some(Some(_)) => continue,
            Some(None) if folder.is_none() => continue,
            _ => {}
        }
        first.insert(asset, folder);
    }
    fn next_key<K: Ord + Clone>(last: &mut BTreeMap<K, PosKey>, at: &K) -> PosKey {
        let key = last.get(at).map_or_else(PosKey::first, PosKey::after);
        last.insert(at.clone(), key.clone());
        key
    }
    let mut out = FileFolders::default();
    let mut last_folder: BTreeMap<Option<AssetFolderId>, PosKey> = BTreeMap::new();
    for f in folders.iter().filter(|f| wanted.contains(&f.id)) {
        let Some(id) = folder_id(&f.id) else {
            continue;
        };
        let parent = f
            .parent
            .as_ref()
            .filter(|p| wanted.contains(p))
            .and_then(folder_id);
        out.folders.push(dr_model::shared::AssetFolder {
            id,
            name: f.name.clone(),
            pos: Some(next_key(&mut last_folder, &parent)),
            parent,
            deleted_at: None,
            trashed_with: None,
        });
    }
    let mut last_file: BTreeMap<Option<AssetFolderId>, PosKey> = BTreeMap::new();
    for m in materials.iter().filter(|m| m.kind != MaterialKind::Text) {
        let Some(asset) = &m.asset else {
            continue;
        };
        if out.places.contains_key(asset) {
            continue;
        }
        let folder = first.get(asset).copied().flatten().and_then(folder_id);
        let pos = next_key(&mut last_file, &folder);
        out.places.insert(asset.clone(), (folder, pos));
    }
    out
}

/// Every 0.1 `material_folder` holding a text material directly or via child
/// folders (`kernel-v5.md` §13).
pub fn note_material_folder_ids(
    folders: &[dr_model::import_v1::MaterialFolder],
    materials: &[dr_model::import_v1::Material],
) -> BTreeSet<dr_model::import_v1::MaterialFolderId> {
    let by_id: BTreeMap<
        &dr_model::import_v1::MaterialFolderId,
        &dr_model::import_v1::MaterialFolder,
    > = folders.iter().map(|f| (&f.id, f)).collect();
    let mut out = BTreeSet::new();
    for m in materials {
        if m.kind != MaterialKind::Text {
            continue;
        }
        let mut cur = m.folder.as_ref();
        let mut seen = BTreeSet::new();
        while let Some(fid) = cur {
            let Some(f) = by_id.get(fid) else {
                break;
            };
            if !seen.insert(fid.clone()) {
                break;
            }
            out.insert(fid.clone());
            cur = f.parent.as_ref();
        }
    }
    out
}

/// Import replaces the default categories with the source categories. After
/// initialization, look up just the four roots by template: the novel helper
/// also requires its default categories, which no longer belong in this book.
struct Roots {
    manuscript: EntryId,
    ideas: EntryId,
    elements: EntryId,
    storylines: EntryId,
    narrative_view: TimelineViewId,
}

fn roots(txn: &mut BookTxnV3<'_>) -> Result<Roots> {
    if txn.view().entries_raw().is_empty() {
        let ids = apply_novel_project_template(txn)?;
        return Ok(Roots {
            manuscript: ids.manuscript,
            ideas: ids.ideas,
            elements: ids.elements,
            storylines: ids.storylines,
            narrative_view: ids.narrative_view,
        });
    }
    let view = txn.view();
    let root = |template| {
        view.root_entry_by_template(&tid(template))
            .map(|e| e.id)
            .ok_or_else(|| invalid(format!("missing imported root template {template}")))
    };
    let views = view.timeline_views_raw();
    if views.len() != 1 {
        return Err(invalid("imported catalog must have one narrative view"));
    }
    Ok(Roots {
        manuscript: root(TPL_MANUSCRIPT)?,
        ideas: root(TPL_IDEAS)?,
        elements: root(TPL_ELEMENTS)?,
        storylines: root(TPL_STORYLINES)?,
        narrative_view: views[0].id.clone(),
    })
}

enum PlannedActTarget {
    ReusedIdea {
        idea_id: NodeId,
        keep_existing_placement: bool,
    },
    SyntheticEntry {
        name: String,
        color: Option<String>,
        shared_idea_split: bool,
    },
}

struct PlannedAct {
    target: PlannedActTarget,
    /// `[min_at, max_end]` computed from live placed chapters in this act.
    interval: Option<(f64, f64)>,
}

fn plan_act_track(source: &BookView<'_>) -> Option<Vec<PlannedAct>> {
    let acts = source.acts();
    if acts.is_empty() {
        return None;
    }
    let live_drifts: BTreeMap<NodeId, _> = source
        .drifts()
        .into_iter()
        .map(|n| (n.id.clone(), n))
        .collect();
    let mut intervals: Vec<Option<(f64, f64)>> = vec![None; acts.len()];
    for ch in source.chapters() {
        let Some(idx) = acts.iter().rposition(|a| {
            a.start_order.is_none()
                || a.start_order
                    .zip(ch.book_order)
                    .is_some_and(|(a, n)| a <= n)
        }) else {
            continue;
        };
        if let Some(at) = ch.narrative_order {
            let end = at + DEFAULT_PLACEMENT_SPAN;
            intervals[idx] = Some(match intervals[idx] {
                Some((min_at, max_end)) => (min_at.min(at), max_end.max(end)),
                None => (at, end),
            });
        }
    }
    let mut used_ideas = BTreeSet::new();
    let mut planned = Vec::with_capacity(acts.len());
    for (act, interval) in acts.into_iter().zip(intervals) {
        let target = if let Some(drift_id) = &act.drift
            && let Some(idea) = live_drifts.get(drift_id)
        {
            if used_ideas.insert(drift_id.clone()) {
                PlannedActTarget::ReusedIdea {
                    idea_id: drift_id.clone(),
                    keep_existing_placement: idea.narrative_order.is_some(),
                }
            } else {
                PlannedActTarget::SyntheticEntry {
                    name: act.name,
                    color: act.color,
                    shared_idea_split: true,
                }
            }
        } else {
            PlannedActTarget::SyntheticEntry {
                name: act.name,
                color: act.color,
                shared_idea_split: false,
            }
        };
        planned.push(PlannedAct { target, interval });
    }
    Some(planned)
}

/// Book-level import report notes produced by the act-track mapping (#22).
pub fn act_import_notes(source: &BookView<'_>) -> BTreeMap<&'static str, usize> {
    let mut out = BTreeMap::new();
    let Some(planned) = plan_act_track(source) else {
        return out;
    };
    let mut shared_split = 0usize;
    let mut kept_placement = 0usize;
    for act in planned {
        match act.target {
            PlannedActTarget::SyntheticEntry {
                shared_idea_split: true,
                ..
            } => shared_split += 1,
            PlannedActTarget::ReusedIdea {
                keep_existing_placement: true,
                ..
            } => kept_placement += 1,
            _ => {}
        }
    }
    if shared_split > 0 {
        out.insert("act-binding-shared-idea-split", shared_split);
    }
    if kept_placement > 0 {
        out.insert("act-binding-kept-existing-placement", kept_placement);
    }
    out
}

fn apply_act_color_if_supported(
    w: &dr_doc::v3::write::EntryWriterV3,
    template: Option<&EntryTemplate>,
    color: Option<&str>,
) -> Result<()> {
    let Some(color) = color.filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let Some(tpl) = template else {
        return Ok(());
    };
    for module in &tpl.modules {
        if module.kind == ModuleKind::Fields
            && let Some(field) = module.config.color_field.as_deref()
        {
            w.set_field(&module.id, field, Some(&FieldValue::Text(color.into())))?;
            break;
        }
    }
    Ok(())
}

/// The prose lines the projected comments of a converted book follow
/// (checklist items and TODO marker lines), by body document and block:
/// each line's text and start and the document's entry links over it. A
/// projected comment takes its words and links from its line, not from its
/// names (`kernel-v5.md` §19), with the rule `comment.project` uses
/// ([`dr_workspace::commands::comment::projected_body`]), so the first
/// projection after an import finds nothing to change.
#[derive(Clone, Debug, Default)]
pub struct ProjectedLines(BTreeMap<(String, BlockId), ProjectedLine>);

#[derive(Clone, Debug)]
struct ProjectedLine {
    text: String,
    start: usize,
    links: Vec<(std::ops::Range<usize>, EntityLinkV3)>,
}

impl ProjectedLines {
    /// The lines of body document `doc` (its final prose `view`) that a
    /// comment can be projected from: every checklist item, and the lines
    /// `marked` names (a TODO marker's).
    pub fn add(
        &mut self,
        doc: &DocId,
        view: &dr_doc::prose::ProseView<'_>,
        marked: impl Fn(&BlockId) -> bool,
    ) {
        let mut links = None;
        for p in view.paragraphs() {
            let Some(block) = p.id.clone() else {
                continue;
            };
            if p.attrs.list != Some(ListKind::Task) && !marked(&block) {
                continue;
            }
            let all = links.get_or_insert_with(|| view.entity_links_v3());
            let range = p.range.clone();
            self.0.insert(
                (doc.to_string(), block),
                ProjectedLine {
                    text: p.text(),
                    start: range.start,
                    links: all
                        .iter()
                        .filter(|(r, _)| r.start < range.end && range.start < r.end)
                        .cloned()
                        .collect(),
                },
            );
        }
    }

    /// The body `comment.project` gives the comment of `kind` projected from
    /// `block` of `doc`, the prose of entry `owner`. `task` is a marker's
    /// words (a checklist item's are its line). `None` when the line is not
    /// known.
    fn body(
        &self,
        doc: &DocId,
        block: &BlockId,
        kind: &ProjectionKind,
        task: &str,
        owner: &str,
    ) -> Option<LinkedText> {
        let line = self.0.get(&(doc.to_string(), block.clone()))?;
        let task = match kind {
            ProjectionKind::NoteTask => line.text.trim(),
            _ => task.trim(),
        };
        Some(dr_workspace::commands::comment::projected_body(
            &line.text,
            line.start,
            task,
            &line.links,
            owner,
        ))
    }
}

/// Copy the source catalog. Anchors must already refer to the target prose
/// documents (the importer writes there directly; sample conversion remakes
/// anchors by resolving their exact source ranges). `lines` are the lines
/// its projected comments follow ([`ProjectedLines`]).
pub fn sync_catalog(
    txn: &mut BookTxnV3<'_>,
    source: &BookView<'_>,
    choices: &MappingChoices,
    lines: &ProjectedLines,
) -> Result<()> {
    sync_catalog_with_relation_times(txn, source, choices, lines, &BTreeMap::new())
}

/// Import replay can supply the source's millisecond timestamps so pairs
/// created in the same second still reach the row planner in source order.
pub fn sync_catalog_with_relation_times(
    txn: &mut BookTxnV3<'_>,
    source: &BookView<'_>,
    choices: &MappingChoices,
    lines: &ProjectedLines,
    relation_times: &BTreeMap<&str, i64>,
) -> Result<()> {
    let pending = choices.pending(source);
    if !pending.is_empty() {
        return Err(invalid(format!("unresolved mapping: {pending:?}")));
    }
    let roots = roots(txn)?;
    let meta = source.meta();
    txn.meta()
        .name(&meta.name)?
        .summary(&meta.summary)?
        .created_at(meta.created_at)?
        .deleted_at(meta.deleted_at)?;
    txn.project()
        .source(Some(&novel_project_template_source()))?
        .book(Some(&ProjectBook {
            word_target_set: meta.word_target_set,
            daily_word_target_set: meta.daily_word_target_set,
        }))?;
    for template in templates(source, &roots.manuscript)? {
        // The 幕 template comes with the novel templates; one the book
        // already has is kept as it is, as before it came with them.
        if template.id.as_str() == TPL_ACT_TRACK && txn.view().template(&template.id).is_some() {
            continue;
        }
        txn.template(&template.id)?.set_full(&template)?;
    }
    let planned_acts = plan_act_track(source);

    let categories = source.categories();
    let nodes = source.nodes();
    let storylines = source.storylines();
    let acts = source.acts();
    let existing = txn.view().entries_raw();
    let needs_unaffiliated = nodes
        .iter()
        .any(|n| !n.is_trashed() && n.narrative_order.is_some() && n.storylines.is_empty());
    // Synthetic entries are new entries, too. Reuse them during metadata
    // replay by their source meaning, and generate UUIDv7 on first creation.
    let unaffiliated = needs_unaffiliated.then(|| {
        existing
            .iter()
            .find(|e| {
                e.parent.as_ref() == Some(&roots.storylines)
                    && e.template.as_ref() == Some(&tid(TPL_STORYLINE))
                    && e.title == "未归属"
                    && !storylines.iter().any(|s| s.id.as_str() == e.id.as_str())
                    && !categories.iter().any(|c| c.id.as_str() == e.id.as_str())
                    && ![
                        &roots.manuscript,
                        &roots.ideas,
                        &roots.elements,
                        &roots.storylines,
                    ]
                    .contains(&&e.id)
            })
            .map_or_else(EntryId::new_v7, |e| e.id.clone())
    });
    let act_track_id = planned_acts.as_ref().map(|_| {
        existing
            .iter()
            .find(|e| {
                e.parent.is_none()
                    && e.template.as_ref() == Some(&tid(TPL_ACT_TRACK))
                    && ![
                        &roots.manuscript,
                        &roots.ideas,
                        &roots.elements,
                        &roots.storylines,
                    ]
                    .contains(&&e.id)
            })
            .map_or_else(EntryId::new_v7, |e| e.id.clone())
    });
    let source_folders = source.material_folders();
    let source_materials = source.materials();
    let note_folders = note_material_folder_ids(&source_folders, &source_materials);
    let has_text_materials = source_materials
        .iter()
        .any(|m| m.kind == MaterialKind::Text);
    let text_materials_root = has_text_materials.then(|| {
        existing
            .iter()
            .find(|e| {
                e.parent.is_none()
                    && e.template.as_ref() == Some(&tid(TPL_GROUP))
                    && e.title == "文本素材"
                    && ![
                        &roots.manuscript,
                        &roots.ideas,
                        &roots.elements,
                        &roots.storylines,
                    ]
                    .contains(&&e.id)
                    && !acts.iter().any(|a| a.id.as_str() == e.id.as_str())
                    && !nodes.iter().any(|n| n.id.as_str() == e.id.as_str())
                    && !note_folders.iter().any(|f| f.as_str() == e.id.as_str())
            })
            .map_or_else(EntryId::new_v7, |e| e.id.clone())
    });
    let existing_acts: Vec<EntryId> = act_track_id
        .as_ref()
        .map(|track_id| {
            existing
                .iter()
                .filter(|e| e.parent.as_ref() == Some(track_id))
                .map(|e| e.id.clone())
                .collect()
        })
        .unwrap_or_default();
    let act_tpl = txn
        .view()
        .template(&tid(TPL_ACT_TRACK))
        .and_then(|t| t.settings.default_template.flatten())
        .unwrap_or_else(|| tid(TPL_IDEA));
    let act_tpl_def = txn.view().template(&act_tpl);
    let mut entries = Entries {
        txn,
        wanted: BTreeSet::new(),
        sibling: BTreeMap::new(),
    };
    entries.put(&roots.manuscript, None, "书稿", &tid(TPL_MANUSCRIPT))?;
    entries.put(&roots.ideas, None, "构想", &tid(TPL_IDEAS))?;
    entries.put(&roots.elements, None, "要素", &tid(TPL_ELEMENTS))?;
    entries.put(&roots.storylines, None, "故事线", &tid(TPL_STORYLINES))?;
    struct ResolvedActEntry {
        entry_id: EntryId,
        interval: Option<(f64, f64)>,
        keep_existing_placement: bool,
    }
    let mut resolved_act_entries: Vec<ResolvedActEntry> = Vec::new();
    if let (Some(track_id), Some(planned)) = (&act_track_id, &planned_acts) {
        entries.put(track_id, None, "幕", &tid(TPL_ACT_TRACK))?;
        let mut synth_idx = 0usize;
        for act in planned {
            match &act.target {
                PlannedActTarget::ReusedIdea {
                    idea_id,
                    keep_existing_placement,
                } => {
                    resolved_act_entries.push(ResolvedActEntry {
                        entry_id: eid(idea_id.as_str()),
                        interval: act.interval,
                        keep_existing_placement: *keep_existing_placement,
                    });
                }
                PlannedActTarget::SyntheticEntry { name, color, .. } => {
                    let act_id = existing_acts
                        .get(synth_idx)
                        .cloned()
                        .unwrap_or_else(EntryId::new_v7);
                    synth_idx += 1;
                    let w = entries.put(&act_id, Some(track_id), name, &act_tpl)?;
                    apply_act_color_if_supported(&w, act_tpl_def.as_ref(), color.as_deref())?;
                    resolved_act_entries.push(ResolvedActEntry {
                        entry_id: act_id,
                        interval: act.interval,
                        keep_existing_placement: false,
                    });
                }
            }
        }
    }

    // Merge act boundaries and root chapters in reading order. Chapters
    // before the first act remain before that act on the manuscript tree.
    let mut manuscript: Vec<(Option<f64>, bool, String)> = acts
        .iter()
        .map(|a| (a.start_order, false, a.id.to_string()))
        .chain(
            nodes
                .iter()
                .filter(|n| n.is_chapter())
                .map(|n| (n.book_order, true, n.id.to_string())),
        )
        .collect();
    manuscript.sort_by(|a, b| {
        // A head act (None) sorts before finite chapters; a chapter without
        // book_order sorts after every finite boundary.
        let key = |v: &(Option<f64>, bool, String)| {
            v.0.unwrap_or(if v.1 {
                f64::INFINITY
            } else {
                f64::NEG_INFINITY
            })
        };
        key(a)
            .total_cmp(&key(b))
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    for (_, chapter, id) in manuscript {
        if !chapter {
            let act = acts.iter().find(|a| a.id.as_str() == id).unwrap();
            let w = entries.put(
                &eid(&id),
                Some(&roots.manuscript),
                &act.name,
                &tid(TPL_GROUP),
            )?;
            w.overrides(Some(&LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_CHAPTER))),
                ..Default::default()
            }))?;
            if let Some(color) = &act.color {
                text(&w, "color", color)?;
            }
        } else {
            let n = nodes.iter().find(|n| n.id.as_str() == id).unwrap();
            let parent = acts
                .iter()
                .rfind(|a| {
                    a.start_order.is_none()
                        || a.start_order.zip(n.book_order).is_some_and(|(a, n)| a <= n)
                })
                .map(|a| eid(a.id.as_str()))
                .unwrap_or_else(|| roots.manuscript.clone());
            let w = entries.put(&eid(&id), Some(&parent), &n.title, &tid(TPL_CHAPTER))?;
            node_fields(&w, n)?;
        }
    }
    // Source tree readers enumerate parents first.
    for group in source.drift_groups() {
        let parent = group
            .parent
            .as_ref()
            .map(|p| eid(p.as_str()))
            .unwrap_or_else(|| roots.ideas.clone());
        let w = entries.put(
            &eid(group.id.as_str()),
            Some(&parent),
            &group.name,
            &tid(TPL_IDEA_GROUP),
        )?;
        if let Some(color) = group.color {
            text(&w, "color", &color)?;
        }
    }
    for n in nodes.iter().filter(|n| n.is_drift()) {
        let parent = n
            .group
            .as_ref()
            .map(|p| eid(p.as_str()))
            .unwrap_or_else(|| roots.ideas.clone());
        let w = entries.put(&eid(n.id.as_str()), Some(&parent), &n.title, &tid(TPL_IDEA))?;
        node_fields(&w, n)?;
    }
    let all_elements = source.elements();
    for category in &categories {
        let id = eid(category.id.as_str());
        let template = category_template(category.id.as_str());
        let w = entries.put(
            &id,
            Some(&roots.elements),
            &category.name,
            &tid(TPL_CATEGORY),
        )?;
        text(&w, "color", &category.color)?;
        w.deleted_at(category.deleted_at)?
            .overrides(Some(&LevelSettingsOverride {
                default_template: Some(Some(template.clone())),
                ..Default::default()
            }))?;
        let members: Vec<_> = all_elements
            .iter()
            .filter(|e| e.category.as_ref() == Some(&category.id))
            .collect();
        let group_ids = element_groups(&mut entries, &existing, &id, &members)?;
        for element in members {
            let parent = element
                .group_name
                .as_ref()
                .map(|g| group_ids[g].clone())
                .unwrap_or_else(|| id.clone());
            put_element(
                &mut entries,
                element,
                &parent,
                &template,
                &category.template_fields,
            )?;
        }
    }
    // Elements without a live category (none, or one in Recently Deleted):
    // 0.1 lists them under 「未分类」 (`leftSidebar.uncategorized`), after
    // the categories; the import adjustment `element-missing-category`.
    let uncategorized: Vec<_> = all_elements
        .iter()
        .filter(|e| e.category.is_none())
        .collect();
    if !uncategorized.is_empty() {
        let id = existing
            .iter()
            .find(|e| {
                e.parent.as_ref() == Some(&roots.elements)
                    && e.template.as_ref() == Some(&tid(TPL_CATEGORY))
                    && e.title == UNCATEGORIZED
                    && !categories.iter().any(|c| c.id.as_str() == e.id.as_str())
            })
            .map_or_else(EntryId::new_v7, |e| e.id.clone());
        let w = entries.put(
            &id,
            Some(&roots.elements),
            UNCATEGORIZED,
            &tid(TPL_CATEGORY),
        )?;
        w.overrides(Some(&LevelSettingsOverride {
            default_template: Some(Some(tid(TPL_ELEMENT))),
            ..Default::default()
        }))?;
        let group_ids = element_groups(&mut entries, &existing, &id, &uncategorized)?;
        for element in uncategorized {
            let parent = element
                .group_name
                .as_ref()
                .map(|g| group_ids[g].clone())
                .unwrap_or_else(|| id.clone());
            put_element(&mut entries, element, &parent, &tid(TPL_ELEMENT), &[])?;
        }
    }
    for storyline in &storylines {
        let w = entries.put(
            &eid(storyline.id.as_str()),
            Some(&roots.storylines),
            &storyline.name,
            &tid(TPL_STORYLINE),
        )?;
        text(&w, "color", &storyline.color)?;
        text(&w, "summary", &storyline.summary)?;
        w.deleted_at(storyline.deleted_at)?;
        if has_body(storyline.chapter_template.as_deref()) {
            let default = storyline_template(storyline.id.as_str());
            w.overrides(Some(&LevelSettingsOverride {
                default_template: Some(Some(default)),
                ..Default::default()
            }))?;
        }
        for kv in &storyline.facts {
            w.put_kv(&mid(MOD_KV), kv)?;
        }
    }
    if let Some(unaffiliated) = &unaffiliated {
        entries.put(
            unaffiliated,
            Some(&roots.storylines),
            "未归属",
            &tid(TPL_STORYLINE),
        )?;
    }
    if let Some(text_root) = &text_materials_root {
        let w = entries.put(text_root, None, "文本素材", &tid(TPL_GROUP))?;
        w.overrides(Some(&LevelSettingsOverride {
            default_template: Some(Some(tid(TPL_NOTE))),
            format_shortcuts: Some(FormatShortcuts::Notes),
            accept: Some(false),
            ..Default::default()
        }))?;
        for folder in &source_folders {
            if !note_folders.contains(&folder.id) {
                continue;
            }
            let parent = folder
                .parent
                .as_ref()
                .filter(|p| note_folders.contains(*p))
                .map(|p| eid(p.as_str()))
                .unwrap_or_else(|| text_root.clone());
            let fw = entries.put(
                &eid(folder.id.as_str()),
                Some(&parent),
                &folder.name,
                &tid(TPL_GROUP),
            )?;
            fw.overrides(Some(&LevelSettingsOverride {
                accept: Some(false),
                ..Default::default()
            }))?;
        }
        for material in &source_materials {
            if material.kind != MaterialKind::Text {
                continue;
            }
            let parent = material
                .folder
                .as_ref()
                .filter(|f| note_folders.contains(*f))
                .map(|f| eid(f.as_str()))
                .unwrap_or_else(|| text_root.clone());
            let tpl = if material.task_todos {
                tid(TPL_NOTE)
            } else {
                plain_note_template()
            };
            entries.put(
                &eid(material.id.as_str()),
                Some(&parent),
                &material.title,
                &tpl,
            )?;
        }
    }
    entries.finish()?;
    // The author's notes have a left-bar tab of their own, or they would be
    // hard to find after the import (`kernel-v5.md` 「替作者定的」).
    if let Some(text_root) = &text_materials_root {
        let id = TabId::parse(TEXT_MATERIALS_TAB).expect("valid tab id");
        let project = txn.view().project();
        if !project.tabs.iter().any(|t| t.id == id) {
            let last = project
                .tabs
                .iter()
                .filter_map(|t| t.pos.as_ref())
                .max()
                .cloned();
            txn.project().put_tab(&ProjectTab {
                id,
                pos: Some(last.map_or_else(PosKey::first, |p| p.after())),
                mount: TabMount::Entry {
                    entry: text_root.clone(),
                },
                gone_title: None,
            })?;
        }
    }

    for m in txn.view().memberships_raw() {
        txn.remove_membership(&m.host, &m.member)?;
    }
    let view = txn.timeline_view(&roots.narrative_view)?;
    view.name("叙事时间线")?.pos(Some(&PosKey::first()))?;
    if let Some(old) = txn
        .view()
        .timeline_views_raw()
        .into_iter()
        .find(|v| v.id == roots.narrative_view)
    {
        for lane in old.lanes {
            view.remove_lane(&lane.entry)?;
        }
        for p in old.placements {
            view.remove_placement(&p.entry)?;
        }
        for pin in old.pins {
            view.remove_pin(&pin.id)?;
        }
    }
    let act_offset = usize::from(act_track_id.is_some());
    let positions =
        crate::build::positions(act_offset + storylines.len() + usize::from(needs_unaffiliated));
    if let Some(track_id) = &act_track_id {
        view.put_lane(track_id, Some(&positions[0]))?
            .set_lane_act_track(track_id, Some(true))?;
    }
    for (i, s) in storylines.iter().enumerate() {
        if s.deleted_at.is_none() {
            view.put_lane(&eid(s.id.as_str()), Some(&positions[act_offset + i]))?;
        }
    }
    if needs_unaffiliated {
        view.put_lane(unaffiliated.as_ref().unwrap(), positions.last())?;
    }
    for n in &nodes {
        let id = eid(n.id.as_str());
        // A chapter or idea in Recently Deleted keeps its storylines, as in
        // 0.1 and as format 5's own trash keeps them: readers leave the
        // membership out until the entry comes back (`V3-MEMBERSHIP-RULES`).
        for host in &n.storylines {
            txn.put_membership(&eid(host.as_str()), &id, None, None)?;
        }
        if !n.is_trashed() {
            if n.storylines.is_empty() && n.narrative_order.is_some() {
                txn.put_membership(unaffiliated.as_ref().unwrap(), &id, None, None)?;
            }
            // A position only on a live lane: a chapter whose storylines are
            // all in Recently Deleted is on none (0.1 showed it under no
            // storyline); it gets one when a storyline comes back.
            let on_live_lane = n.storylines.is_empty()
                || n.storylines.iter().any(|h| {
                    storylines
                        .iter()
                        .any(|s| &s.id == h && s.deleted_at.is_none())
                });
            if let Some(at) = n.narrative_order
                && on_live_lane
            {
                view.put_placement(&id, at, None)?;
            }
        }
        // Preserve None: a secondary membership never becomes primary.
        txn.entries().entry(&id)?.primary(
            n.primary_storyline
                .as_ref()
                .map(|s| eid(s.as_str()))
                .as_ref(),
        )?;
        if let Some(grid) = source.plot_grid(&n.id) {
            let w = txn.plot_grid(&id, &mid(MOD_PLOT_GRID))?;
            w.cell_w(grid.cell_w)?.cell_h(grid.cell_h)?;
            for row in &grid.rows {
                w.row(
                    &row.id,
                    row.pos.as_ref().map_or("a0", PosKey::as_str),
                    &row.label,
                )?;
            }
            for col in &grid.cols {
                w.col(
                    &col.id,
                    col.pos.as_ref().map_or("a0", PosKey::as_str),
                    &col.label,
                )?;
            }
            for ((row, col), body) in &grid.cells {
                w.cell(row, col, Some(body))?;
            }
        }
    }
    if let Some(track_id) = &act_track_id {
        for act_entry in &resolved_act_entries {
            txn.put_membership(track_id, &act_entry.entry_id, None, None)?;
            if !act_entry.keep_existing_placement
                && let Some((min_at, max_end)) = act_entry.interval
            {
                view.put_placement(&act_entry.entry_id, min_at, Some(max_end - min_at))?;
            }
        }
    }
    for pin in source.time_pins() {
        view.put_pin(&TimelinePin {
            id: pin.id,
            at: pin.narrative_order,
            label: pin.label,
            color: None,
            entry: pin.drift.as_ref().map(|d| eid(d.as_str())),
        })?;
    }
    // Every live member of every effective lane in the view gets a finite
    // placement (`VIEW-LANE-MEMBERS-PLACED`), ordered deterministically by
    // 0.1 act order and then 0.1 node order.
    {
        let mut live_lanes = BTreeSet::new();
        if let Some(track_id) = &act_track_id {
            live_lanes.insert(track_id.clone());
        }
        for s in &storylines {
            if s.deleted_at.is_none() {
                live_lanes.insert(eid(s.id.as_str()));
            }
        }
        if needs_unaffiliated && let Some(u) = &unaffiliated {
            live_lanes.insert(u.clone());
        }
        let existing_placements = txn
            .view()
            .timeline_views_raw()
            .into_iter()
            .find(|v| v.id == roots.narrative_view)
            .map(|v| v.placements)
            .unwrap_or_default();
        let mut placed: BTreeSet<EntryId> = existing_placements
            .iter()
            .map(|p| p.entry.clone())
            .collect();
        let mut next_at = dr_model::v3::timeline_scale_end(&existing_placements);
        let w = txn.timeline_view(&roots.narrative_view)?;
        if act_track_id.is_some() {
            for act_entry in &resolved_act_entries {
                if placed.insert(act_entry.entry_id.clone()) {
                    w.put_placement(&act_entry.entry_id, next_at, None)?;
                    next_at += dr_model::v3::PLACEMENT_STEP;
                }
            }
        }
        for n in &nodes {
            if n.is_trashed() {
                continue;
            }
            let id = eid(n.id.as_str());
            let in_live_lane = n
                .storylines
                .iter()
                .any(|h| live_lanes.contains(&eid(h.as_str())))
                || (n.storylines.is_empty() && n.narrative_order.is_some() && needs_unaffiliated);
            if in_live_lane && placed.insert(id.clone()) {
                w.put_placement(&id, next_at, None)?;
                next_at += dr_model::v3::PLACEMENT_STEP;
            }
        }
    }
    copy_rest(txn, source, choices, lines, relation_times)?;
    Ok(())
}

/// The level 0.1 shows elements without a category under: its own wording
/// (`leftSidebar.uncategorized`), as 「未归属」 and 「文本素材」 are.
pub const UNCATEGORIZED: &str = "未分类";

/// The element groups (0.1's `group_name`) under one category level.
fn element_groups(
    entries: &mut Entries<'_, '_>,
    existing: &[dr_model::v3::Entry],
    home: &EntryId,
    members: &[&dr_model::import_v1::Element],
) -> Result<BTreeMap<String, EntryId>> {
    let groups: BTreeSet<_> = members
        .iter()
        .filter_map(|e| e.group_name.clone())
        .collect();
    let mut group_ids = BTreeMap::new();
    for name in groups {
        let group = existing
            .iter()
            .find(|e| {
                e.parent.as_ref() == Some(home)
                    && e.template.as_ref() == Some(&tid(TPL_GROUP))
                    && e.title == name
            })
            .map_or_else(EntryId::new_v7, |e| e.id.clone());
        entries.put(&group, Some(home), &name, &tid(TPL_GROUP))?;
        group_ids.insert(name, group);
    }
    Ok(group_ids)
}

/// One element. A field takes one value: the first of the element's values
/// under its name (in 0.1's order) fills it, any others stay the element's
/// own key/value rows (the import adjustment
/// `duplicate-value-for-template-field`).
fn put_element(
    entries: &mut Entries<'_, '_>,
    element: &dr_model::import_v1::Element,
    parent: &EntryId,
    template: &EntryTemplateId,
    fields: &[dr_model::import_v1::KvEntry],
) -> Result<()> {
    let w = entries.put(
        &eid(element.id.as_str()),
        Some(parent),
        &element.name,
        template,
    )?;
    w.created_at(element.created_at)?
        .deleted_at(element.deleted_at)?;
    text(&w, "summary", &element.summary)?;
    w.set_field(
        &mid(MOD_FIELDS),
        "aliases",
        Some(&FieldValue::List(element.aliases.iter().cloned().collect())),
    )?;
    if let Some(portrait) = &element.portrait {
        text(&w, "portrait", portrait.as_str())?;
    }
    let mut filled = BTreeSet::new();
    for kv in &element.facts {
        match fields.iter().find(|f| f.key == kv.key) {
            Some(field) if filled.insert(field.id.clone()) => {
                text(&w, field.id.as_str(), &kv.value)?;
            }
            _ => {
                w.put_kv(&mid(MOD_KV), kv)?;
            }
        }
    }
    Ok(())
}

fn node_fields(
    w: &dr_doc::v3::write::EntryWriterV3,
    node: &dr_model::import_v1::Node,
) -> Result<()> {
    text(w, "summary", &node.summary)?;
    text(w, "status", node.status.as_str())?;
    w.created_at(node.created_at)?.deleted_at(node.deleted_at)?;
    Ok(())
}

fn copy_rest(
    txn: &mut BookTxnV3<'_>,
    source: &BookView<'_>,
    choices: &MappingChoices,
    lines: &ProjectedLines,
    relation_times: &BTreeMap<&str, i64>,
) -> Result<()> {
    let folders = source.material_folders();
    let materials = source.materials();
    let materials_by_id: BTreeMap<&str, &dr_model::import_v1::Material> =
        materials.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut first_title_by_asset: BTreeMap<&AssetId, &str> = BTreeMap::new();
    for m in &materials {
        if let Some(asset) = &m.asset
            && !m.title.is_empty()
        {
            first_title_by_asset
                .entry(asset)
                .or_insert(m.title.as_str());
        }
    }
    let files = file_folders(&folders, &materials);
    let wanted_folders: BTreeSet<_> = files.folders.iter().map(|f| f.id.clone()).collect();
    for old in txn.view().asset_folders_raw() {
        if !wanted_folders.contains(&old.id) {
            txn.purge(dr_doc::v3::CollectionV3::AssetFolders, old.id.as_str())?;
        }
    }
    for f in &files.folders {
        txn.asset_folder(&f.id)?
            .name(&f.name)?
            .parent(f.parent.as_ref())?
            .pos(f.pos.as_ref())?
            .deleted_at(f.deleted_at)?;
    }
    let wanted_assets: BTreeSet<_> = source.assets().into_iter().map(|a| a.id).collect();
    for old in txn.view().assets_raw() {
        if !wanted_assets.contains(&old.id) {
            txn.purge(dr_doc::v3::CollectionV3::Assets, old.id.as_str())?;
        }
    }
    for mut asset in source.assets() {
        if asset.name.is_empty() {
            asset.name = first_title_by_asset
                .get(&asset.id)
                .copied()
                .unwrap_or_default()
                .to_string();
        }
        if asset.folder.is_none()
            && asset.pos.is_none()
            && let Some((folder, pos)) = files.places.get(&asset.id)
        {
            asset.folder = folder.clone();
            asset.pos = Some(pos.clone());
        }
        txn.put_asset(&asset)?;
        txn.asset(&asset.id)?
            .name(&asset.name)?
            .folder(asset.folder.as_ref())?
            .pos(asset.pos.as_ref())?
            .deleted_at(asset.deleted_at)?;
    }

    let comment_ids: BTreeMap<_, _> = source
        .comments()
        .iter()
        .filter_map(|c| {
            let projection = c.projection.as_ref()?;
            let doc = target_doc(c.target.as_ref()?)?;
            Some((
                c.id.to_string(),
                CommentId::for_projection(
                    &projection.kind,
                    &prose_id(source.book_id(), &doc),
                    &projection.block,
                ),
            ))
        })
        .collect();
    let map = |r: &EntityRef| -> Option<EntityRef> {
        if r.kind == EntityKind::Material {
            if let Some(m) = materials_by_id.get(r.id.as_str())
                && m.kind != MaterialKind::Text
            {
                return m
                    .asset
                    .as_ref()
                    .map(|a| EntityRef::new(EntityKind::Asset, a.as_str()));
            }
            return Some(EntityRef::new(EntityKind::Entry, &r.id));
        }
        let mut new = map_ref(r);
        if r.kind == EntityKind::Comment
            && let Some(id) = comment_ids.get(&r.id)
        {
            new.id = id.to_string();
        }
        Some(new)
    };
    const ASSOCIATION_NAME: &str = "关联";
    let mut directions = BTreeMap::new();
    let mut built_in_types = BTreeSet::new();
    let mut association_type = None;
    for rt in source.relation_types() {
        if rt.system_key == Some(SystemRelationKey::GenericAssociation) {
            built_in_types.insert(rt.id);
            continue;
        }
        let direction = match rt.orientation {
            RelationOrientation::Symmetric => RelationDirection::Symmetric,
            _ => RelationDirection::Directed,
        };
        directions.insert(rt.id.clone(), direction);
        if rt.normalized_name == ASSOCIATION_NAME {
            association_type = Some(rt.id.clone());
        }
        txn.relation_type(&rt.id)?
            .name(&rt.name)?
            .description(&LinkedText::plain(rt.description))?
            .direction(direction)?;
    }
    let entry_ids: BTreeSet<_> = txn.view().entries_raw().into_iter().map(|e| e.id).collect();
    let entry_end = |target: &EntityRef| {
        EntryId::parse(&target.id)
            .ok()
            .filter(|id| entry_ids.contains(id))
    };
    let mut wanted: BTreeMap<RelationTypeId, Vec<RelationRow>> = BTreeMap::new();
    let mut source_pairs = source.relations_raw();
    source_pairs.sort_by_cached_key(|pair| {
        let ms = relation_times
            .get(pair.id.as_str())
            .copied()
            .or_else(|| pair.created_at.map(|ts| ts.0.saturating_mul(1000)));
        (ms, pair.id.clone())
    });
    for pair in source_pairs {
        let built_in = built_in_types.contains(&pair.relation_type);
        if !built_in && !directions.contains_key(&pair.relation_type) {
            continue;
        }
        // Sample recipes still use the isolated source catalog; file/comment
        // endpoints in it have no row in the project.
        let (Some(from), Some(to)) = (map(&pair.from), map(&pair.to)) else {
            continue;
        };
        if from.kind != EntityKind::Entry || to.kind != EntityKind::Entry {
            continue;
        }
        let (Some(mut left), Some(mut right)) = (entry_end(&from), entry_end(&to)) else {
            return Err(invalid("source relation references a missing entry"));
        };
        if left == right {
            return Err(invalid("source relation references the same entry twice"));
        }
        let relation_type = if built_in {
            if pair.to.kind == EntityKind::Material && pair.from.kind != EntityKind::Material {
                std::mem::swap(&mut left, &mut right);
            }
            if association_type.is_none() {
                // Reuse the ordinary type already written by an earlier
                // historical version of this catalog.
                let id = txn
                    .view()
                    .relation_types_raw()
                    .into_iter()
                    .find(|t| t.normalized_name == ASSOCIATION_NAME)
                    .map_or_else(RelationTypeId::new_v7, |t| t.id);
                let direction = RelationDirection::Directed;
                txn.relation_type(&id)?
                    .name(ASSOCIATION_NAME)?
                    .description(&LinkedText::default())?
                    .direction(direction)?;
                directions.insert(id.clone(), direction);
                association_type = Some(id);
            }
            association_type.clone().expect("association type")
        } else {
            pair.relation_type
        };
        let Some(&direction) = directions.get(&relation_type) else {
            continue;
        };
        let rows = wanted.entry(relation_type.clone()).or_default();
        match plan_relation_pair(rows, direction, &left, &right) {
            PairPlacement::Existing(_) => {}
            PairPlacement::Add(id, side, entry) => {
                let row = rows
                    .iter_mut()
                    .find(|row| row.id == id)
                    .expect("planned row");
                match side {
                    RelationSide::Left => row.left.insert(entry),
                    RelationSide::Right => row.right.insert(entry),
                };
            }
            PairPlacement::NewRow => rows.push(RelationRow {
                id: pair.id,
                relation_type,
                left: BTreeSet::from([left]),
                right: BTreeSet::from([right]),
                created_at: pair.created_at,
            }),
        }
    }
    let old_rows: BTreeMap<_, _> = txn
        .view()
        .relations_raw()
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    let wanted: BTreeMap<_, _> = wanted
        .into_values()
        .flatten()
        .map(|row| (row.id.clone(), row))
        .collect();
    for row in wanted.values() {
        let writer = txn.relation_row(&row.id)?;
        writer
            .relation_type(&row.relation_type)?
            .created_at(row.created_at)?;
        if let Some(old) = old_rows.get(&row.id) {
            for entry in old
                .left
                .union(&old.right)
                .filter(|entry| !row.contains(entry))
            {
                writer.remove_member(entry)?;
            }
        }
        for entry in &row.left {
            writer.member(RelationSide::Left, entry)?;
        }
        for entry in &row.right {
            writer.member(RelationSide::Right, entry)?;
        }
    }
    for id in old_rows.keys().filter(|id| !wanted.contains_key(*id)) {
        txn.purge(dr_doc::v3::CollectionV3::Relations, id.as_str())?;
    }
    for patch in source.patches() {
        txn.patch(&patch.id)?
            .entry(&eid(patch.element.as_str()))?
            .module(&mid(MOD_PATCHES))?
            .source_entry(patch.source_node.as_ref().map(|n| eid(n.as_str())).as_ref())?
            .source_module(patch.source_node.as_ref().map(|_| mid(MOD_PROSE)).as_ref())?
            .source_block(patch.source_block.as_ref())?
            .source_text(patch.source_text.as_deref())?
            .anchor(patch.anchor.as_ref().and_then(Anchor::decode).as_ref())?
            .invalidated_at(patch.invalidated_at)?
            .title(patch.title.as_deref())?
            .body(&patch.body)?;
        if let Some(pos) = patch.pos {
            txn.patch(&patch.id)?.pos(&pos)?;
        }
    }
    // Comments link names by one matcher for this revision of the book: its
    // names do not change while the comments are written.
    let names = choices
        .auto_entity_links
        .then(|| dr_workspace::autolink::book_text_matcher(&txn.view()));
    for comment in source.comments() {
        let origin = match &comment.projection {
            Some(p) => match &p.kind {
                ProjectionKind::Marker => CommentOrigin::Marker,
                ProjectionKind::NoteTask => CommentOrigin::Task,
                ProjectionKind::Other(o) => CommentOrigin::parse(o),
            },
            None => match comment.author_kind {
                CommentAuthorKind::Ai => CommentOrigin::Agent,
                CommentAuthorKind::External => CommentOrigin::Reader,
                _ => CommentOrigin::Manual,
            },
        };
        let material_whole =
            comment.metadata.as_deref() == Some(r#"{"drImportV1":"material-comment"}"#);
        let (module, part) = match &comment.target {
            Some(t) if t.kind == EntityKind::Material => match materials_by_id.get(t.id.as_str()) {
                Some(m) if m.kind != MaterialKind::Text => (
                    None,
                    comment.region.map(|region| CommentPart::Region { region }),
                ),
                _ if material_whole => (None, None),
                _ => (Some(mid(MOD_PROSE)), None),
            },
            other => (other.as_ref().and_then(target_module), None),
        };
        let mut line_body = None;
        let w = if let (Some(projection), Some(target)) = (&comment.projection, &comment.target) {
            let old = target_doc(target);
            let new = old
                .as_ref()
                .map(|id| prose_id(source.book_id(), id))
                .ok_or_else(|| invalid("projected TODO without prose target"))?;
            let owner = match &new {
                DocId::Body(body) => body.entry().as_str(),
                other => other.entity_id(),
            };
            // A projected comment follows its line: its links are the line's,
            // or none when the line is not known (never its names).
            line_body = Some(
                lines
                    .body(
                        &new,
                        &projection.block,
                        &projection.kind,
                        &comment.body,
                        owner,
                    )
                    .unwrap_or_else(|| LinkedText::plain(comment.body.clone())),
            );
            let (_, w) = txn.projected_todo(&projection.kind, &new, &projection.block)?;
            w
        } else {
            txn.comment(&comment.id)?
        };
        let mapped_comment_target = comment.target.as_ref().and_then(|t| {
            if t.kind == EntityKind::Material
                && let Some(m) = materials_by_id.get(t.id.as_str())
                && m.kind != MaterialKind::Text
            {
                let asset_id = m.asset.as_ref().map_or(t.id.as_str(), AssetId::as_str);
                return Some(EntityRef::new(EntityKind::Asset, asset_id));
            }
            map(t)
        });
        let kept_metadata = (!material_whole)
            .then_some(comment.metadata.as_deref())
            .flatten();
        let owner = mapped_comment_target
            .as_ref()
            .filter(|t| t.kind == EntityKind::Entry)
            .and_then(|t| EntryId::parse(&t.id).ok());
        let linked = match line_body {
            Some(body) => body,
            None => dr_workspace::autolink::plan_book_text(
                &txn.view(),
                owner.as_ref(),
                names.as_ref(),
                None,
                &comment.body.into(),
            )
            .map_err(|error| invalid(error.to_string()))?,
        };
        w.origin(&origin)?
            .target(mapped_comment_target.as_ref())?
            .module(module.as_ref())?
            .part(part.as_ref())?
            .target_block(comment.target_block.as_ref())?
            .anchor(comment.anchor.as_ref().and_then(Anchor::decode).as_ref())?
            .quote(comment.quote.as_deref())?
            .snapshots(&comment.snapshots)?
            .author_kind(&comment.author_kind)?
            .author(comment.author.as_deref())?
            .author_name(comment.author_name.as_deref())?
            .linked_body(&linked)?
            .status(&comment.status)?
            .source(&comment.source)?
            .metadata(kept_metadata)?
            .agent_conversation(comment.agent_conversation.as_deref())?
            .resolved_at(comment.resolved_at)?
            .created_at(comment.created_at)?
            .updated_at(comment.updated_at)?;
    }
    let wanted: BTreeSet<_> = source.facts().iter().map(|f| f.id.clone()).collect();
    for old in txn.view().facts() {
        if !wanted.contains(&old.id) {
            txn.remove_fact(&old.id)?;
        }
    }
    for fact in source.facts() {
        txn.put_fact(&fact)?;
    }
    for memory in source.memory() {
        txn.memory(&memory.id)?
            .kind(&memory.kind)?
            .body(&memory.body)?
            .target(memory.target.as_ref().and_then(&map).as_ref())?
            .target_block(memory.target_block.as_ref())?
            .source(&memory.source)?
            .origin_ref(memory.origin_ref.as_deref())?
            .status(&memory.status)?
            .supersedes(memory.supersedes.as_ref())?
            .deleted_at(memory.deleted_at)?;
    }
    Ok(())
}

/// The three documents beside a converted book (`kernel-v5.md` §10): its
/// writing days copied from the source catalog, an empty checkpoints document
/// (a 0.1 library has no entry checkpoints), and its canvas coordinates in
/// `layout:<book>`. All three are written by the deterministic import peer of
/// their own id, so the same source gives the same bytes on every device and on
/// a resumed import.
pub fn side_documents(
    book: &BookId,
    source: &BookView<'_>,
    target: &BookViewV3<'_>,
    ts: i64,
) -> Result<(
    dr_doc::side::StatsDoc,
    dr_doc::side::CheckpointsDoc,
    dr_doc::side::LayoutDoc,
)> {
    use dr_doc::peer::import_peer;
    let stats_id = dr_model::DocId::Stats(book.clone()).to_string();
    let mut stats = dr_doc::side::StatsDoc::create(book.clone(), import_peer(&stats_id))?;
    let days = source.writing_days();
    if !days.is_empty() {
        let (r, _) = stats.edit_at(dr_model::Origin::Import, Some(ts), |t| {
            for day in &days {
                t.writing_day(&day.device, &day.day, day.words)?;
            }
            Ok(())
        });
        r?;
    }
    let points_id = dr_model::DocId::Checkpoints(book.clone()).to_string();
    let checkpoints = dr_doc::side::CheckpointsDoc::create(book.clone(), import_peer(&points_id))?;
    let layout_id = dr_model::DocId::Layout(book.clone()).to_string();
    let mut layout = dr_doc::side::LayoutDoc::create(book.clone(), import_peer(&layout_id))?;
    let raw_entries = target.entries_map();
    let mut pending_pos: Vec<(String, EntryId, f64, f64)> = Vec::new();
    for n in source.nodes().into_iter().filter(|n| n.is_drift()) {
        let id = eid(n.id.as_str());
        let scope = raw_entries
            .get(&id)
            .and_then(|e| e.parent.as_ref().map(|p| p.as_str()))
            .unwrap_or("root");
        pending_pos.push((format!("{scope}/board"), id, n.x, n.y));
    }
    for category in source.categories() {
        if let Some((gx, gy)) = category.grid_x.zip(category.grid_y) {
            let id = eid(category.id.as_str());
            let scope = raw_entries
                .get(&id)
                .and_then(|e| e.parent.as_ref().map(|p| p.as_str()))
                .unwrap_or("root");
            pending_pos.push((format!("{scope}/grid"), id, gx as f64, gy as f64));
        }
    }
    for element in source.elements() {
        if let Some((px, py)) = element.relate_pin {
            let id = eid(element.id.as_str());
            if raw_entries.contains_key(&id) {
                pending_pos.push(("root/relation_graph".into(), id, px, py));
            }
        }
    }
    if !pending_pos.is_empty() {
        let (r, _) = layout.edit_at(dr_model::Origin::Import, Some(ts), |t| {
            for (scope_mode, id, x, y) in &pending_pos {
                t.put_position(scope_mode, id, *x, *y)?;
            }
            Ok(())
        });
        r?;
    }
    Ok((stats, checkpoints, layout))
}

pub(crate) fn target_doc(target: &EntityRef) -> Option<DocId> {
    let prefix = match target.kind {
        EntityKind::Node => "node",
        EntityKind::Element => "element",
        EntityKind::Category => "category",
        EntityKind::Storyline => "storyline",
        EntityKind::Material => "material",
        _ => return None,
    };
    DocId::parse(&format!("{prefix}:{}", target.id)).ok()
}

fn target_module(target: &EntityRef) -> Option<ModuleId> {
    default_link_module(&target.kind)
}

/// Validate raw writes, rather than relying on tolerant readers that could
/// hide an invalid imported relationship or timeline position.
pub fn validate(view: &BookViewV3<'_>) -> std::result::Result<(), String> {
    let entries = view.entries_map();
    let templates = view.templates_map();
    let memberships = view.memberships_raw();
    let check = |result: std::result::Result<(), dr_model::check::Violation>| {
        result.map_err(|v| format!("{v:?}"))
    };
    let mut names = BTreeSet::new();
    for relation in view.relation_types_raw() {
        if !names.insert(relation.normalized_name) {
            return Err("duplicate normalized relation name".into());
        }
    }
    for entry in entries.values() {
        check(check_entry_move(&entries, &entry.id, entry.parent.as_ref()))?;
        check(check_entry_template(&templates, entry.template.as_ref()))?;
        if !entry.is_trashed() {
            // A live entry lives at the root or under a live entry whose
            // switch is on.
            check(check_parent_is_level(entry.parent.as_ref(), &entries))?;
            if entry.has_below(&templates) {
                let settings = resolve_level_settings(Some(&entry.id), &entries, &templates);
                check(check_entry_template(
                    &templates,
                    settings.default_template.as_ref(),
                ))?;
                if let Some(home) = &settings.home {
                    check(check_parent_is_level(Some(home), &entries))?;
                }
            }
        }
    }
    // The whole book against an empty one: no duplicate auto-link name and
    // no nested manuscript at all.
    let none = BTreeMap::new();
    check(check_new_violations(
        BookGraph {
            entries: &none,
            templates: &templates,
        },
        BookGraph {
            entries: &entries,
            templates: &templates,
        },
    ))?;
    for membership in &memberships {
        // Kept for an entry in Recently Deleted (either end), read as
        // absent until it comes back: the state format 5's own trash leaves.
        if [&membership.member, &membership.host]
            .iter()
            .any(|id| entries.get(*id).is_some_and(|e| e.is_trashed()))
        {
            continue;
        }
        check(check_membership(
            &membership.host,
            &membership.member,
            &entries,
            &templates,
        ))?;
    }
    for timeline in view.timeline_views_raw() {
        for lane in &timeline.lanes {
            check(check_timeline_lane(&lane.entry, &entries, &templates))?;
        }
        for placement in &timeline.placements {
            check(check_timeline_placement_in_lane(
                &timeline,
                &placement.entry,
                &memberships,
                &entries,
                &templates,
            ))?;
        }
        for pin in &timeline.pins {
            if let Some(entry) = &pin.entry {
                check(check_timeline_target_live(entry, &entries))?;
            }
        }
    }
    for row in view.relations_raw() {
        if row.left.is_empty()
            || row.right.is_empty()
            || row
                .left
                .union(&row.right)
                .any(|id| !entries.contains_key(id))
            || view.relation_type_raw(&row.relation_type).is_none()
        {
            return Err("invalid imported relation row".into());
        }
    }
    if !view.repair_plan().is_empty() {
        return Err("import requires a repair; source must be reviewed".into());
    }
    Ok(())
}
