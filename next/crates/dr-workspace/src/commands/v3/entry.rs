pub use super::novel_book::ProjectCreate;
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
        .add::<EntrySetLevel>();
}

/// A new, empty entry: no fields, rows or layout yet.
pub(super) fn new_entry(
    id: EntryId,
    parent: Option<EntryId>,
    title: String,
    template: Option<EntryTemplateId>,
    level: bool,
) -> m::Entry {
    m::Entry {
        id,
        parent,
        pos: String::new(),
        title,
        template,
        level,
        overrides: None,
        fields: BTreeMap::new(),
        kv: BTreeMap::new(),
        primary: None,
        layout: Default::default(),
        created_at: Some(now()),
        updated_at: None,
        deleted_at: None,
        name_conflict: None,
    }
}

/// What lies below `id` in `v`, if it is a live entry whose switch is on.
pub(super) fn below(v: &dr_doc::v3::BookStructureV3, id: &EntryId) -> Option<Box<types::Below>> {
    let settings = v.level_settings(id)?;
    Some(Box::new(types::Below {
        settings: (&settings.settings).into(),
        sources: settings
            .sources
            .iter()
            .map(|(k, s)| (k.clone(), s.into()))
            .collect(),
        children: v
            .children_of(Some(id))
            .into_iter()
            .map(Into::into)
            .collect(),
        members: v.members_of(id).into_iter().map(Into::into).collect(),
    }))
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
    /// Give every listed entry whose switch is on what lies below it
    /// (resolved settings and their sources, children, members), all from
    /// one consistent read of the book.
    #[serde(default)]
    pub below: bool,
}
op! {
    EntryList = "entry.list", Read, Shared, "Find entries, or list the entries living under one in manuscript order; with below, each listed entry whose switch is on carries its resolved settings, children and members.",
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
                .map(|e| {
                    let mut out: types::Entry = e.into();
                    if input.below {
                        out.below = below(&v, &e.id);
                    }
                    out
                })
                .collect(),
        )
    }
}
op! {
    EntryGet = "entry.get", Read, Shared, "Read an entry including retained module values; an entry whose switch is on also carries what lies below it (resolved settings and their sources, children, members).",
    fn(cx,input:EntityIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let id = pid("entry", &input.id)?;
        let e = view
            .entry(&id)
            .ok_or_else(|| WsError::not_found("entry", &input.id))?;
        let mut out: types::Entry = (&e).into();
        if e.is_level() && !e.is_trashed() {
            out.below = below(&view.structure_snapshot(), &id);
        }
        Ok(out)
    }
}

/// Where a resolved setting comes from (kept here for callers that name it
/// through this module).
pub use super::types::SettingSource;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateIn {
    pub book: String,
    pub title: String,
    /// The level from which creation is requested; its default template and home apply.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    /// The new entry's switch; the template's default when omitted.
    #[serde(default)]
    pub level: Option<bool>,
    /// Optional explicit initial text by prose module ID; omitted modules copy template prose.
    #[serde(default)]
    pub bodies: BTreeMap<String, String>,
}
op! {
    EntryCreate = "entry.create", Write, Book, "Create an entry with its template, switch, residence, membership and initial module content.",
    fn(cx,input:CreateIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let before = v.graph();
        let context: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        m::check_parent_is_level(context.as_ref(), &before.entries)?;
        let template = input
            .template
            .as_deref()
            .map(|s| pid("template", s))
            .transpose()?
            .or_else(|| {
                m::resolve_level_settings(context.as_ref(), &before.entries, &before.templates)
                    .default_template
            });
        m::check_entry_template(&before.templates, template.as_ref())?;
        let parent =
            m::resolve_new_entry_residence(context.as_ref(), &before.entries, &before.templates);
        m::check_parent_is_level(parent.as_ref(), &before.entries)?;
        let id = EntryId::new_v7();
        name_ok(&input.title)?;
        let level = input.level.unwrap_or_else(|| {
            template
                .as_ref()
                .and_then(|t| before.templates.get(t))
                .is_some_and(|t| t.level)
        });
        let mut e = new_entry(
            id.clone(),
            parent.clone(),
            input.title.trim().into(),
            template.clone(),
            level,
        );
        if let Some(t) = e.effective_template(&before.templates) {
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
        let mut after = before.clone();
        after.entries.insert(id.clone(), e.clone());
        let host = context.filter(|c| Some(c) != parent.as_ref());
        if let Some(h) = &host {
            m::check_membership(h, &id, &after.entries, &after.templates)?;
            after.memberships.push(m::Membership {
                host: h.clone(),
                member: id.clone(),
                pos: None,
                created_at: Some(now()),
            });
            e.primary = Some(h.clone());
        }
        changes_ok(&before, &after)?;
        module::initialize(cx, &slot, &e, &before.templates, &input.bodies)?;
        let saved = e.clone();
        let h = host.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            let w = t.entries().create(
                &saved.id,
                saved.parent.as_ref(),
                &saved.title,
                saved.template.as_ref(),
                saved.level,
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
    EntryUpdate = "entry.update", Write, Book, "Rename an entry, switch its template or change the overrides of what lives below it, without deleting retained content or touching its switch.",
    fn(cx,input:UpdateIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let mut e = live(&v, &input.id)?;
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
            m::check_entry_template(&templates, template.as_ref())?;
            e.template = template;
        }
        if let Some(overrides) = input.overrides {
            if !e.is_level() {
                return Err(WsError::invalid(
                    "only an entry with its switch on has overrides; turn it on first",
                ));
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
        // A layout change alone touches nothing the structural checks read.
        if set.0 || set.1 || set.2 {
            let before = v.graph();
            let mut after = before.clone();
            if let Some(h) = after.entries.get_mut(&e.id) {
                h.title = e.title.clone();
                h.template = e.template.clone();
                h.overrides = e.overrides.clone();
            }
            changes_ok(&before, &after)?;
        }
        if set.1 {
            module::initialize(cx, &slot, &e, &templates, &BTreeMap::new())?;
        }
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
    EntryMove = "entry.move", Write, Book, "Move an entry's residence and manuscript position; the new residence is the root or a live entry whose switch is on.",
    fn(cx,input:MoveIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let e = live(&v, &input.id)?;
        let before = v.graph();
        let parent: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        m::check_entry_move(&before.entries, &e.id, parent.as_ref())?;
        m::check_parent_is_level(parent.as_ref(), &before.entries)?;
        let count = before
            .entries
            .values()
            .filter(|x| x.parent == parent && x.id != e.id)
            .count();
        let index = input.index.unwrap_or(count);
        if index > count {
            return Err(WsError::invalid("index exceeds sibling count"));
        }
        let mut after = before.clone();
        if let Some(h) = after.entries.get_mut(&e.id) {
            h.parent = parent.clone();
        }
        changes_ok(&before, &after)?;
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
    let before = v.graph();
    let mut entries = before.entries.clone();
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
        let after = BookGraphV3 {
            entries,
            ..before.clone()
        };
        changes_ok(&before, &after)?;
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
    EntryTrash="entry.trash",Write,Book,"Trash an entry with what lives under it, keeping entries that only belong to it.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, true)
    }
}
op! {
    EntryRestore="entry.restore",Write,Book,"Restore an entry and what lives under it from trash.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetLevelIn {
    pub book: String,
    pub id: String,
    /// The switch (`层级`): whether entries can live under this one.
    pub level: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetLevelOut {
    pub id: String,
    pub level: bool,
    /// The direct children moved to the root when the switch went off, in
    /// their order (trashed ones included).
    pub moved: Vec<String>,
}
op! {
    EntrySetLevel = "entry.set_level", Write, Book, "Turn an entry's switch for what lives below it on or off. Turning it off moves its direct children (trashed ones included) to the root right after the top-level entry it lives under, each with its subtree, in one commit that one undo reverts; its settings, memberships and swimlane are kept and come back when it is turned on.",
    fn(cx, input: SetLevelIn) -> SetLevelOut {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let e = live(&v, &input.id)?;
        if e.level == input.level {
            cx.undo_nothing();
            return Ok(SetLevelOut {
                id: input.id,
                level: input.level,
                moved: Vec::new(),
            });
        }
        let before = v.graph();
        // Direct children by stored residence, trashed ones included.
        let children: Vec<EntryId> = before
            .entries
            .values()
            .filter(|c| c.parent.as_ref() == Some(&e.id))
            .map(|c| c.id.clone())
            .collect();
        let mut after = before.clone();
        if !input.level {
            for c in &children {
                if let Some(h) = after.entries.get_mut(c) {
                    h.parent = None;
                }
            }
        }
        if let Some(h) = after.entries.get_mut(&e.id) {
            h.level = input.level;
        }
        changes_ok(&before, &after)?;
        // The switch, and when it goes off with entries below, the order of
        // those entries: a caller that read them is held to what it read.
        let mut replaced = vec![rec(CollectionV3::Entries, &e.id).at(["level"])];
        if !input.level && !children.is_empty() {
            replaced.push(dr_doc::v3::RecordKeyV3::children(
                CollectionV3::Entries,
                Some(e.id.as_str()),
            ));
        }
        let id = e.id.clone();
        let level = input.level;
        let (moved, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |t| {
            if level {
                t.entries().entry(&id)?.level(true)?;
                Ok(Vec::new())
            } else {
                Ok(t.entries().switch_level_off(&id)?)
            }
        })?;
        let mut keys = vec![key("entries", &e.id)];
        keys.extend(moved.iter().map(|c| key("entries", c)));
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Updated, "entry", e.id.as_str(), Some(&e.title));
        for c in &moved {
            cx.effect(EffectAction::Moved, "entry", c.as_str(), None);
        }
        Ok(SetLevelOut {
            id: input.id,
            level: input.level,
            moved: moved.iter().map(ToString::to_string).collect(),
        })
    }
}
