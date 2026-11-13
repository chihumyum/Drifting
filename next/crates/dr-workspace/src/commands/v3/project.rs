//! Project definition (`project.get` / `project.update`), left-sidebar tabs
//! (`tab.*`), book sequence (`book.sequence`), shared project facts and
//! Project Memory.
use super::*;
use crate::dto::{FieldInfo, MemoryInfo, Target};
use crate::naming::{Place, pos_for};
use dr_model::kind::{MemoryKind, MemorySource, MemoryStatus};
use dr_model::pos::PosKey;
use dr_model::shared::KvEntry;
pub(crate) fn register(r: &mut Registry) {
    r.add::<ProjectGet>()
        .add::<ProjectUpdate>()
        .add::<TabPut>()
        .add::<TabRemove>()
        .add::<TabMove>()
        .add::<BookSequence>()
        .add::<FactList>()
        .add::<FactPut>()
        .add::<FactRemove>()
        .add::<MemoryList>()
        .add::<MemoryAdd>()
        .add::<MemoryUpdate>()
        .add::<MemoryRemove>()
        .add::<MemoryRestore>();
}

// ---- project definition, tabs & book sequence -------------------------------

pub(super) fn validate_project_template(
    mut raw: types::ProjectTemplate,
) -> Result<m::ProjectTemplate> {
    if let Some(book) = &mut raw.project.book {
        if book.word_target_set.is_none() {
            book.word_target_set = book.word_target;
        }
        if book.daily_word_target_set.is_none() {
            book.daily_word_target_set = book.daily_word_target;
        }
    }
    let mut pt: m::ProjectTemplate = convert(raw)?;
    let mut templates = BTreeMap::new();
    for tpl in &mut pt.templates {
        name_ok(&tpl.name)?;
        tpl.name = tpl.name.trim().to_owned();
        if tpl.deleted_at.is_some() {
            return Err(WsError::invalid(
                "template in project template cannot be trashed",
            ));
        }
        for module in &mut tpl.modules {
            for field in &mut module.config.defs {
                if matches!(field.default_value, Some(m::FieldValue::Null)) {
                    field.default_value = None;
                }
            }
        }
        if tpl.settings.display.as_ref().is_some_and(|d| !d.is_known())
            || tpl
                .settings
                .format_shortcuts
                .as_ref()
                .is_some_and(|f| !f.is_known())
        {
            return Err(WsError::invalid("unknown level display or formatting mode"));
        }
        let mut mod_ids = BTreeSet::new();
        for module in &tpl.modules {
            name_ok(&module.name)?;
            if !module.kind.is_known() || !mod_ids.insert(&module.id) {
                return Err(WsError::invalid("unknown or duplicate module"));
            }
            let mut fields = BTreeSet::new();
            for field in &module.config.defs {
                name_ok(&field.name)?;
                if field.options.iter().collect::<BTreeSet<_>>().len() != field.options.len() {
                    return Err(WsError::invalid("duplicate field option"));
                }
                if field.id.is_empty() || !fields.insert(&field.id) || !field.field_type.is_known()
                {
                    return Err(WsError::invalid("invalid field definition"));
                }
            }
            for field in [
                &module.config.aliases_field,
                &module.config.color_field,
                &module.config.status_field,
                &module.config.summary_field,
                &module.config.portrait_field,
            ]
            .into_iter()
            .flatten()
            {
                if !fields.contains(field) {
                    return Err(WsError::invalid("module role names an undefined field"));
                }
            }
            if module.config.default_rows == 0 || module.config.default_cols == 0 {
                return Err(WsError::invalid("plot dimensions must be positive"));
            }
        }
        if templates.insert(tpl.id.clone(), tpl.clone()).is_some() {
            return Err(WsError::invalid(
                "duplicate template id in project template",
            ));
        }
    }
    for tpl in templates.values() {
        for module in &tpl.modules {
            for field in &module.config.defs {
                if let Some(target) = &field.target_template {
                    m::check_entry_template(&templates, Some(target))?;
                }
            }
        }
    }
    let mut entries = BTreeMap::new();
    for seed in &mut pt.entries {
        name_ok(&seed.title)?;
        seed.title = seed.title.trim().to_owned();
        m::check_entry_template(&templates, seed.template.as_ref())?;
        let e = m::Entry {
            id: seed.id.clone(),
            parent: seed.parent.clone(),
            pos: String::new(),
            title: seed.title.clone(),
            template: seed.template.clone(),
            level: seed.level,
            overrides: seed.overrides.clone(),
            fields: seed.fields.clone(),
            kv: BTreeMap::new(),
            primary: None,
            layout: Default::default(),
            created_at: None,
            updated_at: None,
            deleted_at: None,
            name_conflict: None,
        };
        if entries.insert(seed.id.clone(), e).is_some() {
            return Err(WsError::invalid(
                "duplicate seed entry id in project template",
            ));
        }
    }
    for seed in &pt.entries {
        m::check_parent_is_level(seed.parent.as_ref(), &entries)?;
        m::check_entry_move(&entries, &seed.id, seed.parent.as_ref())?;
        if let Some(ov) = &seed.overrides {
            if ov.display.as_ref().is_some_and(|d| !d.is_known())
                || ov.format_shortcuts.as_ref().is_some_and(|f| !f.is_known())
            {
                return Err(WsError::invalid("unknown level display or formatting mode"));
            }
            if let Some(Some(tid)) = &ov.default_template {
                m::check_entry_template(&templates, Some(tid))?;
            }
            if let Some(Some(hid)) = &ov.home
                && !entries.get(hid).is_some_and(|e| e.is_level())
            {
                return Err(WsError::invalid(
                    "home must be a seed entry with its switch on",
                ));
            }
        }
    }
    for tpl in templates.values() {
        if let Some(Some(tid)) = &tpl.settings.default_template {
            m::check_entry_template(&templates, Some(tid))?;
        }
        if let Some(Some(hid)) = &tpl.settings.home
            && !entries.get(hid).is_some_and(|e| e.is_level())
        {
            return Err(WsError::invalid(
                "template home must be a seed entry with its switch on",
            ));
        }
    }
    let mut views = BTreeMap::new();
    for view in &mut pt.views {
        name_ok(&view.name)?;
        view.name = view.name.trim().to_owned();
        if view.deleted_at.is_some() {
            return Err(WsError::invalid(
                "view in project template cannot be trashed",
            ));
        }
        let mut lanes = BTreeSet::new();
        for lane in &view.lanes {
            m::check_timeline_lane(&lane.entry, &entries, &templates)?;
            if !lanes.insert(&lane.entry) {
                return Err(WsError::invalid("duplicate lane in project template view"));
            }
        }
        if views.insert(view.id.clone(), view.clone()).is_some() {
            return Err(WsError::invalid("duplicate view id in project template"));
        }
    }
    if let Some(book) = &pt.project.book {
        if [book.word_target_set, book.daily_word_target_set]
            .into_iter()
            .flatten()
            .any(|n| n < 0)
        {
            return Err(WsError::invalid("a word target cannot be negative"));
        }
        m::check_book_root(&book.root, &entries, &templates, &views)?;
    }
    let has_book = pt.project.book.is_some();
    let mut tab_ids = BTreeSet::new();
    let default_positions = if pt.project.tabs.iter().any(|t| t.pos.is_none()) {
        let mut chain = Vec::with_capacity(pt.project.tabs.len());
        let mut cur = PosKey::first();
        for _ in 0..pt.project.tabs.len() {
            chain.push(cur.clone());
            cur = cur.after();
        }
        chain
    } else {
        Vec::new()
    };
    for (idx, tab) in pt.project.tabs.iter_mut().enumerate() {
        name_ok(&tab.name)?;
        tab.name = tab.name.trim().to_owned();
        if !tab_ids.insert(tab.id.clone()) {
            return Err(WsError::invalid("duplicate tab id in project template"));
        }
        if tab.pos.is_none() {
            tab.pos = default_positions.get(idx).cloned();
        }
        m::check_tab_mount(&tab.mount, has_book, &entries, &views)?;
    }
    BookGraphV3 {
        entries,
        templates,
        memberships: Vec::new(),
    }
    .check_against(&BookGraphV3 {
        entries: BTreeMap::new(),
        templates: BTreeMap::new(),
        memberships: Vec::new(),
    })?;
    Ok(pt)
}

fn read_project_dto(s: &dr_doc::v3::BookStructureV3) -> types::Project {
    let p = s.project();
    let book_root_valid = p
        .book
        .as_ref()
        .is_none_or(|b| s.is_valid_book_root(&b.root));
    let tabs = p
        .tabs
        .iter()
        .map(|t| types::ProjectTab {
            id: t.id.to_string(),
            name: t.name.clone(),
            pos: t.pos.as_ref().map(|k| k.as_str().to_owned()),
            mount: (&t.mount).into(),
            mount_valid: s.is_valid_tab_mount(&t.mount),
        })
        .collect();
    types::Project {
        source: p.source.as_ref().map(Into::into),
        agent: p.agent.as_ref().map(Into::into),
        book: p.book.as_ref().map(Into::into),
        book_root_valid,
        tabs,
    }
}

op! {
    ProjectGet = "project.get", Read, Shared,
    "Read the project definition: template source, Agent instructions, book switch/start/word targets, and left-sidebar tabs.",
    fn(cx, input: BookIn) -> types::Project {
        let slot = cx.book_v3(&input.book)?;
        let s = slot.reader_v3.view().structure_snapshot();
        Ok(read_project_dto(&s))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectUpdateIn {
    pub book: String,
    /// Project-level Agent instructions (`None` = keep, `Some(None)` = clear, `Some(Some(cfg))` = set).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub agent: Option<Option<types::TemplateAgentConfig>>,
    /// Turn the book (`成书`) on (`Some(true)`) or off (`Some(false)`). Omit to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_book: Option<bool>,
    /// Book sequence start (`成书起点`). Required when turning `has_book` from off to on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<types::BookRoot>,
    /// Whole-book word target: omit to keep, `0` to turn off, `null` to restore default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub word_target: Option<Option<i64>>,
    /// Daily word target: omit to keep, `0` to turn off, `null` to restore default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub daily_word_target: Option<Option<i64>>,
}

op! {
    ProjectUpdate = "project.update", Write, Book,
    "Update the project definition: Agent instructions, whether the project has a book, the book start, and word targets.",
    fn(cx, input: ProjectUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        if [input.word_target, input.daily_word_target]
            .into_iter()
            .flatten()
            .flatten()
            .any(|n| n < 0)
        {
            return Err(WsError::invalid("a word target cannot be negative"));
        }
        let v = slot.reader_v3.view();
        let proj = v.project();
        let entries = v.entries_map();
        let templates = v.templates_map();
        let views: BTreeMap<TimelineViewId, m::TimelineView> = v
            .timeline_views_raw()
            .into_iter()
            .map(|tv| (tv.id.clone(), tv))
            .collect();

        let next_agent: Option<m::TemplateAgentConfig> = match &input.agent {
            None => proj.agent.clone(),
            Some(None) => None,
            Some(Some(cfg)) => Some(convert(cfg)?),
        };

        let next_book: Option<m::ProjectBook> = match input.has_book {
            Some(false) => {
                if input.root.is_some()
                    || input.word_target.is_some()
                    || input.daily_word_target.is_some()
                {
                    return Err(WsError::invalid(
                        "cannot set book root or word targets while turning the book off",
                    ));
                }
                None
            }
            Some(true) | None => match &proj.book {
                Some(cur) => {
                    let root = match &input.root {
                        Some(r) => {
                            let r: m::BookRoot = convert(r)?;
                            m::check_book_root(&r, &entries, &templates, &views)?;
                            r
                        }
                        None => cur.root.clone(),
                    };
                    Some(m::ProjectBook {
                        root,
                        word_target_set: input.word_target.unwrap_or(cur.word_target_set),
                        daily_word_target_set: input
                            .daily_word_target
                            .unwrap_or(cur.daily_word_target_set),
                    })
                }
                None => {
                    if input.has_book == Some(true) || input.root.is_some() {
                        let Some(r) = &input.root else {
                            return Err(WsError::invalid(
                                "enabling the book requires a book root",
                            ));
                        };
                        let r: m::BookRoot = convert(r)?;
                        m::check_book_root(&r, &entries, &templates, &views)?;
                        Some(m::ProjectBook {
                            root: r,
                            word_target_set: input.word_target.flatten(),
                            daily_word_target_set: input.daily_word_target.flatten(),
                        })
                    } else if input.word_target.is_some() || input.daily_word_target.is_some() {
                        return Err(WsError::invalid("project has no book enabled"));
                    } else {
                        None
                    }
                }
            },
        };

        let agent_changed = next_agent != proj.agent;
        let book_changed = next_book != proj.book;
        if !agent_changed && !book_changed {
            cx.undo_nothing();
            return Ok(Done { id: input.book });
        }

        let mut replaced = Vec::new();
        let mut undo_keys = Vec::new();
        if agent_changed {
            replaced.push(rec(CollectionV3::Project, "agent"));
            undo_keys.push(key("project", "agent"));
        }
        let book_sub_changes = match (&proj.book, &next_book) {
            (Some(cur), Some(next)) if book_changed => Some((
                cur.root != next.root,
                cur.word_target_set != next.word_target_set,
                cur.daily_word_target_set != next.daily_word_target_set,
            )),
            _ => None,
        };
        if let Some((root_ch, wt_ch, dwt_ch)) = book_sub_changes {
            if root_ch {
                replaced.push(rec(CollectionV3::Project, "book/root"));
                undo_keys.push(key("project", "book/root"));
            }
            if wt_ch {
                replaced.push(rec(CollectionV3::Project, "book/word_target"));
                undo_keys.push(key("project", "book/word_target"));
            }
            if dwt_ch {
                replaced.push(rec(CollectionV3::Project, "book/daily_word_target"));
                undo_keys.push(key("project", "book/daily_word_target"));
            }
        } else if book_changed {
            replaced.push(rec(CollectionV3::Project, "book"));
            undo_keys.push(key("project", "book"));
        }

        let (_, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |txn| {
            let w = txn.project();
            if agent_changed {
                w.agent(next_agent.as_ref())?;
            }
            if let (Some((root_ch, wt_ch, dwt_ch)), Some(next)) =
                (book_sub_changes, next_book.as_ref())
            {
                if root_ch {
                    w.book_root(&next.root)?;
                }
                if wt_ch {
                    w.book_word_target(next.word_target_set)?;
                }
                if dwt_ch {
                    w.book_daily_word_target(next.daily_word_target_set)?;
                }
            } else if book_changed {
                w.book(next_book.as_ref())?;
            }
            Ok(())
        })?;
        undo(cx, &slot, &at, undo_keys);
        cx.effect(EffectAction::Updated, "project", &input.book, None);
        Ok(Done { id: input.book })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TabPutIn {
    pub book: String,
    /// Existing tab id to update; omitted to create a new tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Tab display name (required on create; omit on update to keep).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Target mounted on this tab (required on create; omit on update to keep).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount: Option<types::TabMount>,
    /// Where the tab goes (a new tab goes last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
}

op! {
    TabPut = "tab.put", Write, Book,
    "Create or edit a left-sidebar tab (root, level entry, view or book sequence).",
    fn(cx, input: TabPutIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let proj = v.project();
        let existing = match &input.id {
            Some(id) => Some(
                proj.tabs
                    .iter()
                    .find(|t| t.id.as_str() == id)
                    .cloned()
                    .ok_or_else(|| WsError::not_found("tab", id))?,
            ),
            None => None,
        };
        let id: TabId = match &existing {
            Some(t) => t.id.clone(),
            None => TabId::new_v7(),
        };
        let name = match (&input.name, &existing) {
            (Some(n), _) => {
                name_ok(n)?;
                n.trim().to_owned()
            }
            (None, Some(t)) => t.name.clone(),
            (None, None) => return Err(WsError::invalid("tab name is required")),
        };
        let mount = match (&input.mount, &existing) {
            (Some(m_in), _) => {
                let mount: m::TabMount = convert(m_in)?;
                let entries = v.entries_map();
                let views: BTreeMap<TimelineViewId, m::TimelineView> = v
                    .timeline_views_raw()
                    .into_iter()
                    .map(|tv| (tv.id.clone(), tv))
                    .collect();
                m::check_tab_mount(&mount, proj.book.is_some(), &entries, &views)?;
                mount
            }
            (None, Some(t)) => t.mount.clone(),
            (None, None) => return Err(WsError::invalid("tab mount is required")),
        };
        let others: Vec<(String, Option<PosKey>)> = proj
            .tabs
            .iter()
            .filter(|t| t.id != id)
            .map(|t| (t.id.to_string(), t.pos.clone()))
            .collect();
        let pos = match (&input.place, &existing) {
            (Some(place), _) => Some(pos_for(&others, place)?),
            (None, Some(t)) => t.pos.clone(),
            (None, None) => Some(pos_for(&others, &Place::Last)?),
        };
        let tab = m::ProjectTab {
            id: id.clone(),
            name,
            pos,
            mount,
        };
        let t2 = tab.clone();
        let replaced = Replaces::records(
            existing
                .iter()
                .map(|t| rec(CollectionV3::Project, "tabs").at([t.id.as_str()])),
        );
        let (_, at) = cx.write_book_v3(&slot, replaced, move |txn| {
            txn.project().put_tab(&t2)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("project", format!("tabs/{id}"))]);
        match existing {
            Some(_) => cx.effect(EffectAction::Updated, "tab", id.as_str(), Some(&tab.name)),
            None => cx.effect(EffectAction::Created, "tab", id.as_str(), Some(&tab.name)),
        }
        Ok(Named {
            id: id.to_string(),
            name: tab.name,
        })
    }
}

op! {
    TabRemove = "tab.remove", Write, Book,
    "Remove a left-sidebar tab.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = slot
            .reader_v3
            .view()
            .project()
            .tabs
            .into_iter()
            .find(|t| t.id.as_str() == input.id)
            .ok_or_else(|| WsError::not_found("tab", &input.id))?;
        let id = old.id.clone();
        let replaced = Replaces::records([rec(CollectionV3::Project, "tabs").at([id.as_str()])]);
        let (_, at) = cx.write_book_v3(&slot, replaced, move |txn| {
            txn.project().remove_tab(&id)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("project", format!("tabs/{}", input.id))]);
        cx.effect(EffectAction::Purged, "tab", &input.id, Some(&old.name));
        Ok(Done { id: input.id })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TabMoveIn {
    pub book: String,
    pub id: String,
    pub place: Place,
}

op! {
    TabMove = "tab.move", Write, Book,
    "Change a left-sidebar tab's position.",
    fn(cx, input: TabMoveIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let proj = slot.reader_v3.view().project();
        let mut tab = proj
            .tabs
            .iter()
            .find(|t| t.id.as_str() == input.id)
            .cloned()
            .ok_or_else(|| WsError::not_found("tab", &input.id))?;
        let others: Vec<(String, Option<PosKey>)> = proj
            .tabs
            .iter()
            .filter(|t| t.id != tab.id)
            .map(|t| (t.id.to_string(), t.pos.clone()))
            .collect();
        tab.pos = Some(pos_for(&others, &input.place)?);
        let id = tab.id.clone();
        let name = tab.name.clone();
        let replaced = Replaces::records([rec(CollectionV3::Project, "tabs").at([id.as_str()])]);
        let (_, at) = cx.write_book_v3(&slot, replaced, move |txn| {
            txn.project().put_tab(&tab)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("project", format!("tabs/{}", input.id))]);
        cx.effect(EffectAction::Updated, "tab", &input.id, Some(&name));
        Ok(Done { id: input.id })
    }
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BookSequenceIn {
    pub book: String,
    /// Optional start override (e.g. for whole-book view or previewing a start).
    /// When omitted, reads from `project.book.root` (empty when `project.book` is off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<types::BookRoot>,
    /// When `true` (default), include only prose modules with `in_book == true` and number entries.
    /// Set `false` for whole-book view (`整书视图`) to include all prose modules along the walk.
    #[serde(default = "default_true")]
    pub in_book_only: bool,
}

op! {
    BookSequence = "book.sequence", Read, Shared,
    "Read the ordered book sequence and 1-based chapter ordinals from the project's book start (or an explicit start).",
    fn(cx, input: BookSequenceIn) -> types::BookSequenceOut {
        let slot = cx.book_v3(&input.book)?;
        let s = slot.reader_v3.view().structure_snapshot();
        let has_book = s.project().book.is_some();
        let chosen: Option<m::BookRoot> = match &input.root {
            Some(r) => Some(convert(r)?),
            None => s.project().book.as_ref().map(|b| b.root.clone()),
        };
        let (root_valid, seq) = match &chosen {
            Some(r) => (
                s.is_valid_book_root(r),
                s.sequence(r, input.in_book_only).unwrap_or_default(),
            ),
            None => (true, Vec::new()),
        };
        Ok(types::BookSequenceOut {
            has_book,
            root: chosen.as_ref().map(Into::into),
            root_valid,
            entries: seq.iter().map(Into::into).collect(),
        })
    }
}
// ---- project facts ----------------------------------------------------------

op! {
    FactList = "fact.list", Read, Shared,
    "List the book's project facts (项目设定), in order.",
    fn(cx, input: BookIn) -> Vec<FieldInfo> {
        let slot = cx.book_v3(&input.book)?;
        Ok(slot.reader_v3.view().facts().iter().map(FieldInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FactPutIn {
    pub book: String,
    /// The fact to change; omitted: a new fact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub key: String,
    pub value: String,
    /// Where it goes (a new fact goes last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    /// An exact position key (undo uses it); wins over `place`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
}

op! {
    FactPut = "fact.put", Write, Book,
    "Add a project fact or change one (key, value, position).",
    fn(cx, input: FactPutIn) -> Named {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.key)?;
        let list = slot.reader_v3.view().facts();
        let existing = match &input.id {
            Some(id) => Some(list.iter().find(|f| f.id.as_str() == id)
                .cloned().ok_or_else(|| WsError::not_found("fact", id))?),
            None => None,
        };
        let id: KvEntryId = match &existing { Some(f) => f.id.clone(), None => KvEntryId::new_v7() };
        let others: Vec<(String, Option<PosKey>)> = list.iter()
            .filter(|f| f.id != id).map(|f| (f.id.to_string(), f.pos.clone())).collect();
        let pos = match (&input.pos, &input.place, &existing) {
            (Some(p), _, _) => Some(PosKey::parse(p).map_err(|e| WsError::invalid(e.to_string()))?),
            (None, Some(place), _) => Some(pos_for(&others, place)?),
            (None, None, Some(f)) => f.pos.clone(),
            (None, None, None) => Some(pos_for(&others, &Place::Last)?),
        };
        let entry = KvEntry { id: id.clone(), key: input.key.trim().to_string(), value: input.value.clone(), pos };
        let e2 = entry.clone();
        let replaced = Replaces::records(existing.iter().map(|f| rec(CollectionV3::Facts, &f.id)));
        let (_,at)=cx.write_book_v3(&slot, replaced, move |txn| { txn.put_fact(&e2)?; Ok(()) })?;
        undo(cx,&slot,&at,vec![key("facts",&id)]);
        match existing {
            Some(_) => {
                cx.effect(EffectAction::Updated, "fact", id.as_str(), Some(&entry.key));

            }
            None => {
                cx.effect(EffectAction::Created, "fact", id.as_str(), Some(&entry.key));

            }
        }
        Ok(Named { id: id.to_string(), name: entry.key })
    }
}

op! {
    FactRemove = "fact.remove", Write, Book,
    "Remove a project fact.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = slot.reader_v3.view().facts().iter().find(|f| f.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("fact", &input.id))?;
        let id = old.id.clone();
        let (_,at)=cx.write_book_v3(&slot, Replaces::record(CollectionV3::Facts, &id), move |txn| { txn.remove_fact(&id)?; Ok(()) })?;
        undo(cx,&slot,&at,vec![key("facts",&input.id)]);
        cx.effect(EffectAction::Purged, "fact", &input.id, Some(&old.key));

        Ok(Done { id: input.id })
    }
}

// ---- Project Memory -----------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MemoryListIn {
    pub book: String,
    /// Include removed entries.
    #[serde(default)]
    pub removed: bool,
}

op! {
    MemoryList = "memory.list", Read, Shared,
    "List the book's Project Memory entries.",
    fn(cx, input: MemoryListIn) -> Vec<MemoryInfo> {
        let slot = cx.book_v3(&input.book)?;
        Ok(slot.reader_v3.view().memory().iter().filter(|m| input.removed || m.deleted_at.is_none())
            .map(MemoryInfo::from).collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MemoryAddIn {
    pub book: String,
    pub body: String,
    /// `preference`, `veto` or `directive` (default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_block: Option<String>,
}

fn memory_kind(k: Option<&str>) -> Result<MemoryKind> {
    let k = MemoryKind::parse(k.unwrap_or("directive"));
    if k.is_known() {
        Ok(k)
    } else {
        Err(WsError::invalid(format!(
            "unknown memory kind {:?}",
            k.as_str()
        )))
    }
}

op! {
    MemoryAdd = "memory.add", Write, Book,
    "Add a Project Memory entry (plain text; takes effect at once).",
    fn(cx, input: MemoryAddIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.body)?;
        let kind = memory_kind(input.kind.as_deref())?;
        let target = input.target.as_ref().map(|t| t.to_ref());
        if let Some(t) = &target && !slot.reader_v3.view().entity_exists(t) {return Err(WsError::not_found("memory target",&t.id));};
        let block = input.target_block.as_deref().map(|b| pid::<BlockId>("block", b)).transpose()?;
        let id = MemoryId::new_v7();
        let source = if matches!(cx.actor(), crate::Actor::Agent { .. }) { MemorySource::Agent } else { MemorySource::Author };
        let (i2, body) = (id.clone(), input.body.clone());
        let (_,at)=cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            txn.memory(&i2)?.kind(&kind)?.body(&body)?.target(target.as_ref())?
                .target_block(block.as_ref())?.source(&source)?.status(&MemoryStatus::Active)?;
            Ok(())
        })?;
        undo(cx,&slot,&at,vec![key("memory",&id)]);
        cx.effect(EffectAction::Created, "memory", id.as_str(), None);

        Ok(Done { id: id.to_string() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MemoryUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `active` or `dismissed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

op! {
    MemoryUpdate = "memory.update", Write, Book,
    "Change a Project Memory entry's text, kind or status.",
    fn(cx, input: MemoryUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let old = slot.reader_v3.view().memory().iter().find(|m| m.id.as_str() == input.id).cloned()
            .ok_or_else(|| WsError::not_found("memory", &input.id))?;
        if let Some(b) = &input.body { name_ok(b)?; }
        let kind = input.kind.as_deref().map(|k| memory_kind(Some(k))).transpose()?;
        let status = input.status.as_deref().map(MemoryStatus::parse);
        if let Some(s) = &status && !s.is_known() {
            return Err(WsError::invalid(format!("unknown memory status {:?}", s.as_str())));
        }
        let (id, body) = (old.id.clone(), input.body.clone());
        let (_,at)=cx.write_book_v3(&slot, Replaces::record(CollectionV3::Memory, &id), move |txn| {
            let w = txn.memory(&id)?;
            if let Some(b) = &body { w.body(b)?; }
            if let Some(k) = &kind { w.kind(k)?; }
            if let Some(s) = &status { w.status(s)?; }
            Ok(())
        })?;
        undo(cx,&slot,&at,vec![key("memory",&input.id)]);
        cx.effect(EffectAction::Updated, "memory", &input.id, None);

        Ok(Done { id: input.id })
    }
}

fn memory_removed(cx: &Cx<'_>, input: &EntityIn, removed: bool) -> Result<Done> {
    let slot = cx.book_v3(&input.book)?;
    let id: MemoryId = slot
        .reader_v3
        .view()
        .memory()
        .iter()
        .find(|m| m.id.as_str() == input.id)
        .map(|m| m.id.clone())
        .ok_or_else(|| WsError::not_found("memory", &input.id))?;
    let at = removed.then(now);
    let flag = rec(CollectionV3::Memory, &id).at(["deleted_at"]);
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([flag]), move |txn| {
        txn.memory(&id)?.deleted_at(at)?;
        Ok(())
    })?;
    undo(cx, &slot, &at, vec![key("memory", &input.id)]);
    if removed {
        cx.effect(EffectAction::Trashed, "memory", &input.id, None);
    } else {
        cx.effect(EffectAction::Restored, "memory", &input.id, None);
    }
    Ok(Done {
        id: input.id.clone(),
    })
}

op! {
    MemoryRemove = "memory.remove", Write, Book,
    "Remove a Project Memory entry (kept as removed; restorable).",
    fn(cx, input: EntityIn) -> Done { memory_removed(cx, &input, true) }
}

op! {
    MemoryRestore = "memory.restore", Write, Book,
    "Bring back a removed Project Memory entry.",
    fn(cx, input: EntityIn) -> Done { memory_removed(cx, &input, false) }
}
