//! Project definition (`project.get` / `project.update`), left-sidebar tabs
//! (`tab.*`), book sequence (`book.sequence`), shared project facts and
//! Project Memory.
use super::book::BookUpdateIn;
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
        .add::<TabSelect>()
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
        if let Some(mark) = &tpl.mark
            && !m::is_valid_mark(mark)
        {
            return Err(WsError::invalid(
                "mark must be a sand mark name or a single character",
            ));
        }
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
        if let Some(mark) = &seed.mark
            && !m::is_valid_mark(mark)
        {
            return Err(WsError::invalid(
                "mark must be a sand mark name or a single character",
            ));
        }
        m::check_entry_template(&templates, seed.template.as_ref())?;
        let e = m::Entry {
            id: seed.id.clone(),
            parent: seed.parent.clone(),
            pos: String::new(),
            title: seed.title.clone(),
            mark: seed.mark.clone(),
            template: seed.template.clone(),
            level: seed.level,
            overrides: seed.overrides.clone(),
            fields: seed.fields.clone(),
            kv: BTreeMap::new(),
            media: BTreeMap::new(),
            arrangements: BTreeMap::new(),
            primary: None,
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
    let mut checked_tabs: Vec<m::ProjectTab> = Vec::with_capacity(pt.project.tabs.len());
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
        if !tab_ids.insert(tab.id.clone()) {
            return Err(WsError::invalid("duplicate tab id in project template"));
        }
        if tab.pos.is_none() {
            tab.pos = default_positions.get(idx).cloned();
        }
        m::check_tab_mount(&tab.mount, has_book, &entries, &templates, &views)?;
        m::check_tab_mount_once(&checked_tabs, &tab.mount)?;
        checked_tabs.push(tab.clone());
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

/// What a tab is called, for a command's effect: the title of the entry or
/// the name of the view it mounts; `None` for the root and the book sequence
/// (the page names those, 「全部」 and 「成书」) and for an entry or view the
/// book does not have.
fn mount_name(v: &dr_doc::v3::BookViewV3<'_>, mount: &m::TabMount) -> Option<String> {
    match mount {
        m::TabMount::Entry { entry } => v.entry(entry).map(|e| e.title),
        m::TabMount::View { view } => v
            .timeline_views_raw()
            .into_iter()
            .find(|tv| &tv.id == view)
            .map(|tv| tv.name),
        m::TabMount::Root | m::TabMount::Book => None,
    }
}

op! {
    ProjectGet = "project.get", Read, Shared,
    "Read the project definition: template source, Agent instructions, book switch/start/word targets, the left-sidebar tabs (「全部」 always among them) and the tab the project is on.",
    fn(cx, input: BookIn) -> types::Project {
        let slot = cx.book_v3(&input.book)?;
        let s = slot.reader_v3.view().structure_snapshot();
        let stored = cx.workspace().stored_tab(slot.book.as_str())?;
        Ok(types::Project::of(&s).with_selected_tab(stored))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProjectUpdateIn {
    pub book: String,
    /// The project's name (as `book.update` sets it); omit to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The project's profile (as `book.update` sets it); omit to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
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
    "Update the project definition: Agent instructions, whether the project has a book, the book start, and word targets; with the project's name and profile, all in one undoable write.",
    fn(cx, input: ProjectUpdateIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        if let Some(n) = &input.name {
            name_ok(n)?;
        }
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

        let meta = v.meta();
        let name = input
            .name
            .as_ref()
            .map(|n| n.trim().to_owned())
            .filter(|n| *n != meta.name);
        let summary = input.summary.clone().filter(|s| *s != meta.summary);
        let agent_changed = next_agent != proj.agent;
        let book_changed = next_book != proj.book;
        let meta_changed = name.is_some() || summary.is_some();
        if !agent_changed && !book_changed && !meta_changed {
            cx.undo_nothing();
            return Ok(Done { id: input.book });
        }

        let mut replaced = Vec::new();
        let mut undo_keys = Vec::new();
        if name.is_some() {
            replaced.push(rec(CollectionV3::Meta, "name"));
        }
        if summary.is_some() {
            replaced.push(rec(CollectionV3::Meta, "summary"));
        }
        let old_meta = BookUpdateIn {
            book: input.book.clone(),
            name: name.as_ref().map(|_| meta.name.clone()),
            summary: summary.as_ref().map(|_| meta.summary.clone()),
        };
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
                replaced.push(rec(CollectionV3::Project, "book").at(["root"]));
                undo_keys.push(key("project", "book/root"));
            }
            if wt_ch {
                replaced.push(rec(CollectionV3::Project, "book").at(["word_target"]));
                undo_keys.push(key("project", "book/word_target"));
            }
            if dwt_ch {
                replaced.push(rec(CollectionV3::Project, "book").at(["daily_word_target"]));
                undo_keys.push(key("project", "book/daily_word_target"));
            }
        } else if book_changed {
            replaced.push(rec(CollectionV3::Project, "book"));
            undo_keys.push(key("project", "book"));
        }

        let (new_name, new_summary) = (name.clone(), summary.clone());
        let (_, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |txn| {
            if let Some(n) = &new_name {
                txn.meta().name(n)?;
            }
            if let Some(s) = &new_summary {
                txn.meta().summary(s)?;
            }
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
        if !undo_keys.is_empty() {
            undo(cx, &slot, &at, undo_keys);
            cx.effect(EffectAction::Updated, "project", &input.book, None);
        }
        if meta_changed {
            cx.undo_with(Invocation::new("book.update", old_meta));
            cx.effect(EffectAction::Updated, "book", &input.book, name.as_deref());
        }
        Ok(Done { id: input.book })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TabPutIn {
    pub book: String,
    /// What the new tab mounts: an entry with its level switch or
    /// 「收别处的条目」 on, a view, or the book sequence (the root is
    /// always mounted, on 「全部」). A tab is called what it mounts.
    pub mount: types::TabMount,
    /// Where the tab goes (last by default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
}

op! {
    TabPut = "tab.put", Write, Book,
    "Add a left-sidebar tab that mounts a level entry, a view or the book sequence; one thing is mounted on one tab.",
    fn(cx, input: TabPutIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let proj = v.project();
        let mount: m::TabMount = convert(&input.mount)?;
        let entries = v.entries_map();
        let templates = v.templates_map();
        let views: BTreeMap<TimelineViewId, m::TimelineView> = v
            .timeline_views_raw()
            .into_iter()
            .map(|tv| (tv.id.clone(), tv))
            .collect();
        m::check_tab_mount(&mount, proj.book.is_some(), &entries, &templates, &views)?;
        m::check_tab_mount_once(&proj.tabs, &mount)?;
        let id = TabId::new_v7();
        let others: Vec<(String, Option<PosKey>)> = proj
            .tabs
            .iter()
            .map(|t| (t.id.to_string(), t.pos.clone()))
            .collect();
        let pos = Some(pos_for(&others, input.place.as_ref().unwrap_or(&Place::Last))?);
        let name = mount_name(&v, &mount);
        let tab = m::ProjectTab {
            id: id.clone(),
            pos,
            mount,
        };
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |txn| {
            txn.project().put_tab(&tab)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("project", format!("tabs/{id}"))]);
        cx.effect(EffectAction::Created, "tab", id.as_str(), name.as_deref());
        Ok(Done { id: id.to_string() })
    }
}

op! {
    TabRemove = "tab.remove", Write, Book,
    "Remove a left-sidebar tab (not what it mounts); 「全部」 stays.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let old = v
            .project()
            .tabs
            .into_iter()
            .find(|t| t.id.as_str() == input.id)
            .ok_or_else(|| WsError::not_found("tab", &input.id))?;
        m::check_tab_removable(&old)?;
        // A stored repeat of the same mount (two devices mounted it at once)
        // goes with it, or it would show up in its place (`TAB-MOUNT-ONCE`).
        let ids: Vec<TabId> = v
            .stored_tabs()
            .into_iter()
            .filter(|t| t.id == old.id || t.mount == old.mount)
            .map(|t| t.id)
            .collect();
        let name = mount_name(&v, &old.mount);
        let replaced = Replaces::records(
            ids.iter()
                .map(|id| rec(CollectionV3::Project, "tabs").at([id.as_str()])),
        );
        let keys = ids
            .iter()
            .map(|id| key("project", format!("tabs/{id}")))
            .collect();
        let (_, at) = cx.write_book_v3(&slot, replaced, move |txn| {
            for id in &ids {
                txn.project().remove_tab(id)?;
            }
            Ok(())
        })?;
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Purged, "tab", &input.id, name.as_deref());
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
    "Change a left-sidebar tab's position (「全部」 included).",
    fn(cx, input: TabMoveIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let proj = v.project();
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
        let name = mount_name(&v, &tab.mount);
        // The whole record is written: 「全部」 read in but not stored is
        // stored now, under its fixed id, so two devices that each move it
        // write one record.
        let replaced = Replaces::records([rec(CollectionV3::Project, "tabs").at([id.as_str()])]);
        let (_, at) = cx.write_book_v3(&slot, replaced, move |txn| {
            txn.project().put_tab(&tab)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("project", format!("tabs/{}", input.id))]);
        cx.effect(EffectAction::Updated, "tab", &input.id, name.as_deref());
        Ok(Done { id: input.id })
    }
}

op! {
    TabSelect = "tab.select", Write, Book,
    "Remember the left-sidebar tab the project is on, for every device (kept in `layout:<book>`; not undoable; leaves the book document untouched).",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let tab = slot
            .reader_v3
            .view()
            .project()
            .tabs
            .into_iter()
            .find(|t| t.id.as_str() == input.id)
            .ok_or_else(|| WsError::not_found("tab", &input.id))?;
        let unchanged =
            cx.workspace().stored_tab(slot.book.as_str())?.as_deref() == Some(tab.id.as_str());
        if !unchanged {
            cx.write_layout(&slot.book, move |txn| {
                txn.set_tab(Some(&tab.id))?;
                Ok(())
            })?;
        }
        cx.irreversible();
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
