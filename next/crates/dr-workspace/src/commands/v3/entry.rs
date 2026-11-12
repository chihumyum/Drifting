use super::*;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ProjectCreate>()
        .add::<EntryList>()
        .add::<EntryGet>()
        .add::<EntryCreate>()
        .add::<EntryUpdate>()
        .add::<EntryMove>()
        .add::<EntryTrash>()
        .add::<EntryRestore>()
        .add::<LevelGet>()
        .add::<LevelList>();
}

op! {
    ProjectCreate = "project.create", Write, Library, "Create a v3 project using the novel template.",
    fn(cx, input: super::super::book::BookCreateIn) -> Named {
        name_ok(&input.name)?;
        let id = BookId::new_v7();
        let slot = cx.workspace().book_slot_or_create_v3(&id)?;
        let roots = dr_doc::v3::NovelRootEntries::new();
        for entry in [
            &roots.manuscript,
            &roots.ideas,
            &roots.elements,
            &roots.storylines,
            &roots.cat_character,
            &roots.cat_location,
            &roots.cat_item,
            &roots.cat_organization,
        ] {
            cx.create_prose(&id, &body_id(entry, &m::level_about_module_id()))?;
        }
        let name = input.name.trim().to_string();
        let n = name.clone();
        cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            t.meta()
                .name(&n)?
                .summary(&input.summary)?
                .created_at(Some(now()))?;
            dr_doc::v3::apply_novel_project_template_with(t, roots)?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "book", id.as_str(), Some(&name));
        cx.undo_with(Invocation::new(
            "book.trash",
            BookIn {
                book: id.to_string(),
            },
        ));
        Ok(Named {
            id: id.to_string(),
            name,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {
    pub book: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub query: Option<String>,
}
op! {
    EntryList = "entry.list", Read, Shared, "Find v3 entries or list the children of a level in manuscript order.",
    fn(cx, input: ListIn) -> Vec<types::Entry> {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view().structure_snapshot();
        let p: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        let q = input.query.as_deref().unwrap_or("").to_lowercase();
        Ok(
            v.entries()
                .filter(|e| {
                    (input.all || v.effective_parent(&e.id) == p.as_ref())
                        && (input.trashed || !e.is_trashed())
                        && e.title.to_lowercase().contains(&q)
                })
                .map(Into::into)
                .collect(),
        )
    }
}
op! {
    EntryGet = "entry.get", Read, Shared, "Read a v3 entry including retained module values.",
    fn(cx,input:EntityIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        convert(
            slot.reader_v3
                .view()
                .entry(&pid("entry", &input.id)?)
                .ok_or_else(|| WsError::not_found("entry", &input.id))?,
        )
    }
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct LevelInfo {
    pub settings: types::LevelSettings,
    pub children: Vec<types::Entry>,
    pub members: Vec<types::Entry>,
}
op! {
    LevelGet = "level.get", Read, Shared, "Read resolved v3 level settings, resident children and accepted members.",
    fn(cx,input:EntityIn)->LevelInfo {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view().structure_snapshot();
        let e = v.entry(&pid("entry", &input.id)?).filter(|e|!e.is_trashed()).ok_or_else(||WsError::not_found("entry",&input.id))?;
        let settings=v.level_settings(&e.id).ok_or_else(||WsError::invalid("entry is not a level"))?;
        Ok(LevelInfo {
            settings: convert(&settings.settings)?,
            children: convert(v.children_of(Some(&e.id)))?,
            members: convert(v.members_of(&e.id))?,
        })
    }
}

/// Identical provenance vocabulary to the shell's existing read-only tracing.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettingSource {
    Default,
    Override { entry: String },
    Template { entry: String, template: String },
    Lane { entry: String, template: String },
}

impl From<&m::LevelSettingSource> for SettingSource {
    fn from(s: &m::LevelSettingSource) -> Self {
        match s {
            m::LevelSettingSource::Default => Self::Default,
            m::LevelSettingSource::Override { entry } => Self::Override {
                entry: entry.to_string(),
            },
            m::LevelSettingSource::Template { entry, template } => Self::Template {
                entry: entry.to_string(),
                template: template.to_string(),
            },
            m::LevelSettingSource::Lane { entry, template } => Self::Lane {
                entry: entry.to_string(),
                template: template.to_string(),
            },
        }
    }
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ResolvedLevelInfo {
    pub id: String,
    pub settings: types::LevelSettings,
    pub sources: BTreeMap<String, SettingSource>,
    pub children: Vec<types::Entry>,
    pub members: Vec<types::Entry>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct LevelsInfo {
    /// The book frontier shared by every row, usable with Workspace guards.
    pub version: String,
    /// Live levels in the same manuscript order as entry.list.
    pub levels: Vec<ResolvedLevelInfo>,
}
op! {
    LevelList = "level.list", Read, Shared, "Read every live v3 level with settings, provenance, resident children and accepted members from one consistent book snapshot.",
    fn(cx,input:BookIn)->LevelsInfo {
        let slot=cx.book_v3(&input.book)?;
        let book=slot.book.clone();
        let (v,version)=slot.handle.read(move |doc| -> Result<_> {
            let bb=dr_doc::v3::BorrowedBookV3::new(doc,&book)?;
            Ok((bb.view().structure_snapshot(),frontiers_hex(&doc.state_frontiers())))
        })??;
        let levels = v
            .levels()
            .map(|e| {
                let settings = v.level_settings(&e.id).expect("live level");
                ResolvedLevelInfo {
                    id: e.id.to_string(),
                    settings: (&settings.settings).into(),
                    sources: settings
                        .sources
                        .iter()
                        .map(|(k, s)| (k.clone(), s.into()))
                        .collect(),
                    children: v.children_of(Some(&e.id)).into_iter().map(Into::into).collect(),
                    members: v.members_of(&e.id).into_iter().map(Into::into).collect(),
                }
            })
            .collect();
        Ok(LevelsInfo { version, levels })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateIn {
    pub book: String,
    pub title: String,
    /// The level from which creation is requested; its default template and home apply.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    /// Optional explicit initial text by prose module ID; omitted modules copy template prose.
    #[serde(default)]
    pub bodies: BTreeMap<String, String>,
}
op! {
    EntryCreate = "entry.create", Write, Book, "Create a v3 entry with its template, residence, membership and initial module content.",
    fn(cx,input:CreateIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let mut entries = v.entries_map();
        let templates = v.templates_map();
        let mut memberships = v.memberships_raw();
        let context: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        m::check_parent_is_level(context.as_ref(), &entries, &templates)?;
        let template = input
            .template
            .as_deref()
            .map(|s| pid("template", s))
            .transpose()?
            .or_else(|| v.level_settings(context.as_ref()).default_template);
        m::check_entry_template(&templates, template.as_ref())?;
        let parent = m::resolve_new_entry_residence(context.as_ref(), &entries, &templates);
        m::check_level_allows_template(parent.as_ref(), template.as_ref(), &entries, &templates)?;
        let id = EntryId::new_v7();
        name_ok(&input.title)?;
        let mut e = m::Entry {
            id: id.clone(),
            parent: parent.clone(),
            pos: String::new(),
            title: input.title.trim().into(),
            template: template.clone(),
            overrides: None,
            fields: BTreeMap::new(),
            kv: BTreeMap::new(),
            primary: None,
            layout: Default::default(),
            created_at: Some(now()),
            updated_at: None,
            deleted_at: None,
            name_conflict: None,
        };
        if let Some(t) = e.effective_template(&templates) {
            for module in &t.modules {
                if module.kind == m::ModuleKind::Fields {
                    let mut defaults = BTreeMap::new();
                    for def in &module.config.defs {
                        if let Some(val) = def
                            .default_value
                            .as_ref()
                            .filter(|v| !matches!(v, m::FieldValue::Null))
                        {
                            defaults.insert(def.id.clone(), val.clone());
                        }
                    }
                    if !defaults.is_empty() {
                        e.fields.insert(module.id.clone(), defaults);
                    }
                } else if module.kind == m::ModuleKind::KeyValue {
                    let mut rows = module.config.initial_kv.clone();
                    for row in &mut rows {
                        row.id = KvEntryId::new_v7();
                    }
                    e.kv.insert(module.id.clone(), rows);
                }
            }
        }
        entries.insert(id.clone(), e.clone());
        let host = context.filter(|c| Some(c) != parent.as_ref());
        if let Some(h) = &host {
            m::check_membership(h, &id, &entries, &templates)?;
            memberships.push(m::Membership {
                host: h.clone(),
                member: id.clone(),
                pos: None,
                created_at: Some(now()),
            });
            e.primary = Some(h.clone());
            entries.insert(id.clone(), e.clone());
        }
        graph_ok(&entries, &templates, &memberships)?;
        module::initialize(cx, &slot, &e, &templates, &input.bodies)?;
        let saved = e.clone();
        let h = host.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            let w = t.entries().create(
                &saved.id,
                saved.parent.as_ref(),
                &saved.title,
                saved.template.as_ref(),
            )?;
            w.created_at(saved.created_at)?.primary(h.as_ref())?;
            for (module, fields) in &saved.fields {
                for (field_id, value) in fields {
                    w.set_field(module, field_id, Some(value))?;
                }
            }
            for (module, rows) in &saved.kv {
                for row in rows {
                    w.put_kv(module, row)?;
                }
            }
            if let Some(h) = &h {
                t.put_membership(h, &saved.id, None, Some(now()))?;
            }
            Ok(())
        })?;
        let mut keys = vec![key("entries", &id)];
        if let Some(h) = host {
            keys.push(key("memberships", m::Membership::key(&h, &id)));
        }
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Created, "entry", id.as_str(), Some(&e.title));
        convert(slot.reader_v3.view().entry(&id).expect("created entry"))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub template: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub overrides: Option<Option<types::LevelSettingsOverride>>,
    #[serde(default)]
    pub layout: Option<types::EntryLayout>,
}
op! {
    EntryUpdate = "entry.update", Write, Book, "Rename a v3 entry, switch its template or change level overrides without deleting retained content.",
    fn(cx,input:UpdateIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let mut e = live(&v, &input.id)?;
        let mut entries = v.entries_map();
        let templates = v.templates_map();
        let set = (
            input.title.is_some(),
            input.template.is_some(),
            input.overrides.is_some(),
            input.layout.is_some(),
        );
        if let Some(title) = input.title {
            name_ok(&title)?;
            e.title = title.trim().into();
        }
        if let Some(template) = input.template {
            let template = template
                .as_deref()
                .map(|s| pid("template", s))
                .transpose()?;
            m::check_template_switch(&e.id, template.as_ref(), &entries, &templates)?;
            e.template = template;
        }
        if let Some(overrides) = input.overrides {
            if !e.is_level(&templates) {
                return Err(WsError::invalid("only levels have overrides"));
            }
            e.overrides = overrides.map(convert).transpose()?;
            if let Some(s) = &e.overrides {
                settings_ok(s, &v)?;
            }
        }
        if let Some(layout) = input.layout {
            e.layout = convert(layout)?;
            if e.layout.sanitized() != e.layout {
                return Err(WsError::invalid("layout coordinates must be finite"));
            }
        }
        entries.insert(e.id.clone(), e.clone());
        graph_ok(&entries, &templates, &v.memberships_raw())?;
        module::initialize(cx, &slot, &e, &templates, &BTreeMap::new())?;
        let id = e.id.clone();
        let name = e.title.clone();
        // Only the fields this call names are written, so a concurrent
        // change to another field of the same entry is neither a conflict
        // nor overwritten with the value this command read.
        let replaced = [
            ("title", set.0),
            ("template", set.1),
            ("overrides", set.2),
            ("layout", set.3),
        ]
        .into_iter()
        .filter(|(_, named)| *named)
        .map(|(field, _)| rec(CollectionV3::Entries, &e.id).at([field]));
        let (_, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |t| {
            let w = t.entries().entry(&e.id)?;
            if set.0 {
                w.title(&e.title)?;
            }
            if set.1 {
                w.template(e.template.as_ref())?;
            }
            if set.2 {
                w.overrides(e.overrides.as_ref())?;
            }
            if set.3 {
                w.layout(&e.layout)?;
            }
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), Some(&name));
        Ok(Done { id: input.id })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MoveIn {
    pub book: String,
    pub id: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
}
op! {
    EntryMove = "entry.move", Write, Book, "Move a v3 entry's residence and manuscript position.",
    fn(cx,input:MoveIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let mut e = live(&v, &input.id)?;
        let mut entries = v.entries_map();
        let templates = v.templates_map();
        let parent: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        m::check_entry_move(&entries, &e.id, parent.as_ref())?;
        m::check_level_allows_template(parent.as_ref(), e.template.as_ref(), &entries, &templates)?;
        let count = v
            .entries_raw()
            .iter()
            .filter(|x| x.parent == parent && x.id != e.id)
            .count();
        let index = input.index.unwrap_or(count);
        if index > count {
            return Err(WsError::invalid("index exceeds sibling count"));
        }
        e.parent = parent.clone();
        entries.insert(e.id.clone(), e.clone());
        graph_ok(&entries, &templates, &v.memberships_raw())?;
        let id = e.id.clone();
        // The residence is part of the entry's own record.
        let moved = Replaces::record(CollectionV3::Entries, &e.id);
        let (_, at) = cx.write_book_v3(&slot, moved, move |t| {
            t.entries().move_to_at(&e.id, parent.as_ref(), index)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Moved, "entry", id.as_str(), None);
        Ok(Done { id: input.id })
    }
}
fn trash(cx: &Cx<'_>, input: EntityIn, trashed: bool) -> Result<Done> {
    let slot = cx.book_v3(&input.book)?;
    let v = slot.reader_v3.view();
    let id: EntryId = pid("entry", &input.id)?;
    let mut entries = v.entries_map();
    if !entries.contains_key(&id) {
        return Err(WsError::not_found("entry", &input.id));
    }
    let previous = entries[&id].deleted_at;
    if trashed == previous.is_some() {
        cx.undo_nothing();
        return Ok(Done { id: input.id });
    }
    let stamp = trashed.then(now);
    let mut ids = BTreeSet::from([id]);
    loop {
        let n = ids.len();
        for e in entries.values() {
            if e.deleted_at == previous && e.parent.as_ref().is_some_and(|p| ids.contains(p)) {
                ids.insert(e.id.clone());
            }
        }
        if n == ids.len() {
            break;
        }
    }
    for id in &ids {
        entries.get_mut(id).unwrap().deleted_at = stamp;
    }
    if !trashed {
        graph_ok(&entries, &v.templates_map(), &v.memberships_raw())?;
    }
    let changed = ids.clone();
    // The named entry; the subtree that follows it is planned above.
    let named = rec(CollectionV3::Entries, &input.id).at(["deleted_at"]);
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([named]), move |t| {
        for id in changed {
            t.entries().entry(&id)?.deleted_at(stamp)?;
        }
        Ok(())
    })?;
    undo(
        cx,
        &slot,
        &at,
        ids.iter().map(|id| key("entries", id)).collect(),
    );
    for id in ids {
        cx.effect(
            if trashed {
                EffectAction::Trashed
            } else {
                EffectAction::Restored
            },
            "entry",
            id.as_str(),
            None,
        );
    }
    Ok(Done { id: input.id })
}
op! {
    EntryTrash="entry.trash",Write,Book,"Trash a v3 resident subtree while keeping entries that only belong to its levels.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, true)
    }
}
op! {
    EntryRestore="entry.restore",Write,Book,"Restore a v3 resident subtree from trash.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, false)
    }
}
