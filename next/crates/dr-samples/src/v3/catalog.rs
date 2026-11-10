//! Replay a typed legacy catalog into a v3 writer. Used on each historical
//! metadata version as well as the current state; no v2 catalog is stored.

use std::collections::{BTreeMap, BTreeSet};

use dr_doc::import_v1::BookView;
use dr_doc::v3::novel::*;
use dr_doc::v3::{BookTxnV3, BookViewV3};
use dr_doc::{Anchor, DocError, Result};
use dr_model::id::*;
use dr_model::import_v1::{EntityRef, canonical_symmetric};
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::v3::*;

use super::*;

pub(crate) fn invalid(message: impl Into<String>) -> DocError {
    DocError::Loro(loro::LoroError::ArgErr(message.into().into()))
}

/// The mapping's required templates. Unused built-in leaf templates are
/// harmless, but default category entries must never be added on import.
fn templates(
    source: &BookView<'_>,
    choices: &MappingChoices,
    manuscript: &EntryId,
) -> Result<Vec<EntryTemplate>> {
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
        if category.template_fields.iter().any(|f| !f.value.is_empty()) {
            return Err(invalid("v3 field default-value writer is not available"));
        }
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
    if let Some(choice) = &choices.unaffiliated {
        all.push(choice.template.clone());
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
            return Err(invalid(format!("v3 entry id collision: {id}")));
        }
        let index = self.sibling.entry(parent.cloned()).or_default();
        let old = self.txn.view().entry(id);
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
            w.title(title)?
                .template(Some(template))?
                .overrides(None)?
                .primary(None)?
                .layout(&EntryLayout::default())?
                .created_at(None)?
                .updated_at(None)?
                .deleted_at(None)?;
            w
        } else {
            self.txn
                .entries()
                .create_at(id, parent, *index, title, Some(template))?
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

fn restrictions(kinds: &[EntityKind]) -> Vec<EntityKind> {
    kinds
        .iter()
        .map(map_kind)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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

/// Copy the source catalog. Anchors must already refer to the target prose
/// documents (the importer writes there directly; sample conversion remakes
/// anchors by resolving their exact source ranges).
pub fn sync_catalog(
    txn: &mut BookTxnV3<'_>,
    source: &BookView<'_>,
    choices: &MappingChoices,
) -> Result<()> {
    if choices.act_binding.as_ref().is_some_and(|choice| {
        choice.relation_type.locked || choice.relation_type.system_key.is_some()
    }) {
        return Err(invalid(
            "act binding choice cannot change a locked/system relation type",
        ));
    }
    let pending = choices.pending(source);
    if !pending.is_empty() {
        return Err(invalid(format!("unresolved v3 mapping: {pending:?}")));
    }
    let roots = roots(txn)?;
    let meta = source.meta();
    txn.meta()
        .name(&meta.name)?
        .summary(&meta.summary)?
        .created_at(meta.created_at)?
        .deleted_at(meta.deleted_at)?
        .word_target(meta.word_target_set)?
        .daily_word_target(meta.daily_word_target_set)?
        .project_template(Some(&ProjectTemplateRef {
            id: NOVEL_PROJECT_TEMPLATE_ID.into(),
            version: NOVEL_PROJECT_TEMPLATE_VERSION,
        }))?;
    let resolved_choices = choices.resolved_roots(
        [
            &roots.manuscript,
            &roots.ideas,
            &roots.elements,
            &roots.storylines,
        ],
        source,
    )?;
    let choices = &resolved_choices;
    for template in templates(source, choices, &roots.manuscript)? {
        txn.template(&template.id)?.set_full(&template)?;
    }

    let categories = source.categories();
    let nodes = source.nodes();
    let storylines = source.storylines();
    let acts = source.acts();
    let existing = txn.view().entries_raw();
    // Synthetic entries are new entries, too. Reuse them during metadata
    // replay by their source meaning, and generate UUIDv7 on first creation.
    let unaffiliated = choices.unaffiliated.as_ref().map(|choice| {
        existing
            .iter()
            .find(|e| {
                e.template.as_ref() == Some(&choice.template.id)
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
    let mut entries = Entries {
        txn,
        wanted: BTreeSet::new(),
        sibling: BTreeMap::new(),
    };
    entries.put(&roots.manuscript, None, "书稿", &tid(TPL_MANUSCRIPT))?;
    entries.put(&roots.ideas, None, "构想", &tid(TPL_IDEAS))?;
    entries.put(&roots.elements, None, "要素", &tid(TPL_ELEMENTS))?;
    entries.put(&roots.storylines, None, "故事线", &tid(TPL_STORYLINES))?;

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
        w.board_pos(Some((n.x, n.y)))?;
    }
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
        w.grid_pos(category.grid_x.zip(category.grid_y))?
            .deleted_at(category.deleted_at)?
            .overrides(Some(&LevelSettingsOverride {
                default_template: Some(Some(template.clone())),
                allow: Some(vec![template, tid(TPL_GROUP)]),
                ..Default::default()
            }))?;
        let members: Vec<_> = source
            .elements()
            .into_iter()
            .filter(|e| e.category.as_ref() == Some(&category.id))
            .collect();
        let groups: BTreeSet<_> = members
            .iter()
            .filter_map(|e| e.group_name.clone())
            .collect();
        let mut group_ids = BTreeMap::new();
        for name in groups {
            let group = existing
                .iter()
                .find(|e| {
                    e.parent.as_ref() == Some(&id)
                        && e.template.as_ref() == Some(&tid(TPL_GROUP))
                        && e.title == name
                })
                .map_or_else(EntryId::new_v7, |e| e.id.clone());
            entries.put(&group, Some(&id), &name, &tid(TPL_GROUP))?;
            group_ids.insert(name, group);
        }
        for element in members {
            let parent = element
                .group_name
                .as_ref()
                .map(|g| group_ids[g].clone())
                .unwrap_or_else(|| id.clone());
            let w = entries.put(
                &eid(element.id.as_str()),
                Some(&parent),
                &element.name,
                &category_template(category.id.as_str()),
            )?;
            w.created_at(element.created_at)?
                .deleted_at(element.deleted_at)?
                .relation_pin(element.relate_pin)?;
            text(&w, "summary", &element.summary)?;
            w.set_field(
                &mid(MOD_FIELDS),
                "aliases",
                Some(&FieldValue::List(element.aliases.iter().cloned().collect())),
            )?;
            if let Some(portrait) = &element.portrait {
                text(&w, "portrait", portrait.as_str())?;
            }
            for kv in &element.facts {
                if let Some(field) = category.template_fields.iter().find(|f| f.key == kv.key) {
                    text(&w, field.id.as_str(), &kv.value)?;
                } else {
                    w.put_kv(&mid(MOD_KV), kv)?;
                }
            }
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
                default_template: Some(Some(default.clone())),
                allow: Some(vec![tid(TPL_CHAPTER), tid(TPL_IDEA), default]),
                ..Default::default()
            }))?;
        }
        for kv in &storyline.facts {
            w.put_kv(&mid(MOD_KV), kv)?;
        }
    }
    let needs_unaffiliated = nodes
        .iter()
        .any(|n| n.narrative_order.is_some() && n.storylines.is_empty());
    if needs_unaffiliated {
        let choice = choices.unaffiliated.as_ref().unwrap();
        entries.put(
            unaffiliated.as_ref().unwrap(),
            choice.parent.as_ref(),
            "未归属",
            &choice.template.id,
        )?;
    }
    entries.finish()?;

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
    let positions = crate::build::positions(storylines.len() + usize::from(needs_unaffiliated));
    for (i, s) in storylines.iter().enumerate() {
        if s.deleted_at.is_none() {
            view.put_lane(&eid(s.id.as_str()), Some(&positions[i]))?;
        }
    }
    if needs_unaffiliated {
        view.put_lane(unaffiliated.as_ref().unwrap(), positions.last())?;
    }
    for n in &nodes {
        let id = eid(n.id.as_str());
        for host in &n.storylines {
            txn.put_membership(&eid(host.as_str()), &id, None, None)?;
        }
        if n.storylines.is_empty() && n.narrative_order.is_some() {
            txn.put_membership(unaffiliated.as_ref().unwrap(), &id, None, None)?;
        }
        // Preserve None: a secondary membership never becomes primary.
        txn.entries().entry(&id)?.primary(
            n.primary_storyline
                .as_ref()
                .map(|s| eid(s.as_str()))
                .as_ref(),
        )?;
        if let Some(at) = n.narrative_order {
            view.put_placement(&id, at, None)?;
        }
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
    for pin in source.time_pins() {
        view.put_pin(&TimelinePin {
            id: pin.id,
            at: pin.narrative_order,
            label: pin.label,
            color: None,
            entry: pin.drift.as_ref().map(|d| eid(d.as_str())),
        })?;
    }
    copy_rest(txn, source, choices)?;
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
) -> Result<()> {
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
    let map = |r: &EntityRef| {
        let mut new = map_ref(r);
        if r.kind == EntityKind::Comment
            && let Some(id) = comment_ids.get(&r.id)
        {
            new.id = id.to_string();
        }
        new
    };
    for rt in source.relation_types() {
        if rt.locked || rt.system_key.is_some() {
            continue;
        }
        let restriction = choices
            .relation_templates
            .get(&rt.id)
            .cloned()
            .unwrap_or_default();
        txn.relation_type(&rt.id)?
            .name(&rt.name)?
            .description(&rt.description)?
            .orientation(&rt.orientation)?
            .source_role(&rt.source_role)?
            .target_role(&rt.target_role)?
            .color(rt.color.as_deref())?
            .source_kinds(&restrictions(&rt.source_kinds))?
            .target_kinds(&restrictions(&rt.target_kinds))?
            .source_templates(&restriction.source)?
            .target_templates(&restriction.target)?;
    }
    let symmetric: BTreeSet<_> = source
        .relation_types()
        .into_iter()
        .filter(|r| r.orientation == RelationOrientation::Symmetric)
        .map(|r| r.id)
        .collect();
    for relation in source.relations_raw() {
        let from = map(&relation.from);
        let to = map(&relation.to);
        let (from, to) = if symmetric.contains(&relation.relation_type) {
            canonical_symmetric(from, to)
        } else {
            (from, to)
        };
        txn.relation(&relation.id)?
            .ends(&from, &to)?
            .relation_type(&relation.relation_type)?
            .created_at(relation.created_at)?;
    }
    for act in source.acts().into_iter().filter(|a| a.drift.is_some()) {
        let choice = choices.act_binding.as_ref().unwrap();
        let rt = &choice.relation_type;
        txn.relation_type(&rt.id)?
            .name(&rt.name)?
            .description(&rt.description)?
            .orientation(&rt.orientation)?
            .source_role(&rt.source_role)?
            .target_role(&rt.target_role)?
            .color(rt.color.as_deref())?
            .source_kinds(&rt.source_kinds)?
            .target_kinds(&rt.target_kinds)?
            .source_templates(&rt.source_templates)?
            .target_templates(&rt.target_templates)?;
        let act_ref = EntityRef::new(EntityKind::Entry, act.id.as_str());
        let idea_ref = EntityRef::new(EntityKind::Entry, act.drift.as_ref().unwrap().as_str());
        let (a, b) = if choice.act_is_source {
            (act_ref, idea_ref)
        } else {
            (idea_ref, act_ref)
        };
        let (a, b) = if rt.orientation == RelationOrientation::Symmetric {
            canonical_symmetric(a, b)
        } else {
            (a, b)
        };
        txn.relation(
            &RelationId::parse(&format!("import-act-binding-{}", act.id))
                .map_err(|e| invalid(e.to_string()))?,
        )?
        .ends(&a, &b)?
        .relation_type(&rt.id)?;
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
    for comment in source.comments() {
        let w = if let (Some(projection), Some(target)) = (&comment.projection, &comment.target) {
            let old = target_doc(target);
            let new = old
                .as_ref()
                .map(|id| prose_id(source.book_id(), id))
                .ok_or_else(|| invalid("projected TODO without prose target"))?;
            let (_, w) = txn.projected_todo(&projection.kind, &new, &projection.block)?;
            w
        } else {
            txn.comment(&comment.id)?
        };
        w.kind(&comment.kind)?
            .target(comment.target.as_ref().map(map).as_ref())?
            .module(comment.target.as_ref().and_then(target_module).as_ref())?
            .target_block(comment.target_block.as_ref())?
            .anchor(comment.anchor.as_ref().and_then(Anchor::decode).as_ref())?
            .quote(comment.quote.as_deref())?
            .snapshots(&comment.snapshots)?
            .region(comment.region.as_ref())?
            .author_kind(&comment.author_kind)?
            .author(comment.author.as_deref())?
            .author_name(comment.author_name.as_deref())?
            .body(&comment.body)?
            .status(&comment.status)?
            .priority(comment.priority.as_ref())?
            .source(&comment.source)?
            .metadata(comment.metadata.as_deref())?
            .agent_conversation(comment.agent_conversation.as_deref())?
            .resolved_at(comment.resolved_at)?
            .created_at(comment.created_at)?
            .updated_at(comment.updated_at)?;
    }
    for folder in source.material_folders() {
        if !txn
            .view()
            .material_folders()
            .iter()
            .any(|f| f.id == folder.id)
        {
            txn.material_folders().create(
                folder.id.as_str(),
                folder.parent.as_ref().map(MaterialFolderId::as_str),
                &folder.name,
            )?;
        }
    }
    for material in source.materials() {
        let w = txn.material(&material.id)?;
        w.title(&material.title)?
            .kind(&material.kind)?
            .asset(material.asset.as_ref())?
            .folder(material.folder.as_ref())?
            .task_todos(material.task_todos)?
            .provenance(material.provenance.as_deref())?
            .description(&material.description)?;
        if let Some(pos) = material.pos {
            w.pos(&pos)?;
        }
    }
    for asset in source.assets() {
        txn.put_asset(&asset)?;
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
            .target(memory.target.as_ref().map(map_ref).as_ref())?
            .target_block(memory.target_block.as_ref())?
            .source(&memory.source)?
            .origin_ref(memory.origin_ref.as_deref())?
            .status(&memory.status)?
            .supersedes(memory.supersedes.as_ref())?
            .deleted_at(memory.deleted_at)?;
    }
    for day in source.writing_days() {
        txn.writing_day(&day.device, &day.day, day.words)?;
    }
    Ok(())
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
    match target.kind {
        EntityKind::Node | EntityKind::Element => Some(mid(MOD_PROSE)),
        EntityKind::Storyline | EntityKind::Category => Some(mid(MOD_ABOUT)),
        _ => None,
    }
}

/// Validate raw writes, rather than relying on tolerant readers that could
/// hide an invalid imported relationship or timeline position.
pub fn validate(view: &BookViewV3<'_>) -> std::result::Result<(), String> {
    let entries = view.entries_map();
    let templates = view.templates_map();
    let check = |result: std::result::Result<(), dr_model::check::Violation>| {
        result.map_err(|v| format!("{v:?}"))
    };
    for template in templates.values() {
        check(check_template_modules(&template.kind, &template.modules))?;
    }
    for relation_type in view.relation_types() {
        for template in relation_type
            .source_templates
            .iter()
            .chain(&relation_type.target_templates)
        {
            check(check_entry_template(&templates, Some(template)))?;
        }
        if relation_type
            .source_kinds
            .iter()
            .chain(&relation_type.target_kinds)
            .any(|kind| {
                !matches!(
                    kind,
                    EntityKind::Entry
                        | EntityKind::Material
                        | EntityKind::Comment
                        | EntityKind::Patch
                )
            })
        {
            return Err(format!(
                "relation type {} has an unknown v3 endpoint kind",
                relation_type.id
            ));
        }
    }
    for entry in entries.values() {
        check(check_entry_move(&entries, &entry.id, entry.parent.as_ref()))?;
        check(check_entry_template(&templates, entry.template.as_ref()))?;
        if !entry.is_trashed() {
            check(check_level_allows_template(
                entry.parent.as_ref(),
                entry.template.as_ref(),
                &entries,
                &templates,
            ))?;
            let hosts: Vec<_> = view
                .memberships_raw()
                .iter()
                .filter(|m| m.member == entry.id)
                .map(|m| m.host.clone())
                .collect();
            check(check_autolink_name_unique(
                Some(&entry.id),
                entry.parent.as_ref(),
                &hosts,
                entry.is_leaf(&templates),
                &entry.title,
                &entry.aliases(&templates).into_iter().collect::<Vec<_>>(),
                &view.memberships_raw(),
                &entries,
                &templates,
            ))?;
            let declared_manuscript = entry
                .overrides
                .as_ref()
                .and_then(|s| s.is_manuscript)
                .or_else(|| {
                    entry
                        .effective_template(&templates)
                        .and_then(|t| t.settings.is_manuscript)
                })
                .unwrap_or(false);
            check(check_manuscript_no_nest(
                &entry.id,
                declared_manuscript,
                &entries,
                &templates,
            ))?;
            if entry.is_level(&templates) {
                let settings = view.level_settings(Some(&entry.id));
                check(check_entry_template(
                    &templates,
                    settings.default_template.as_ref(),
                ))?;
                if settings.default_template.is_some()
                    && !settings.allows_template(settings.default_template.as_ref())
                {
                    return Err(format!(
                        "level {} rejects its own default template",
                        entry.id
                    ));
                }
                for template in &settings.allow {
                    check(check_entry_template(&templates, Some(template)))?;
                }
                if let Some(home) = &settings.home {
                    check(check_parent_is_level(Some(home), &entries, &templates))?;
                }
            }
        }
    }
    for membership in view.memberships_raw() {
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
                &view.memberships_raw(),
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
    if view.relations_raw().len() != view.relations().len() {
        return Err("v3 relation constraints reject an imported endpoint".into());
    }
    if !view.repair_plan().is_empty() {
        return Err("v3 import requires a repair; source must be reviewed".into());
    }
    Ok(())
}
